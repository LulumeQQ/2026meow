// 此為一次性爬蟲；之後若需更新商品資料，手動執行 `node scripts/scrape-family.mjs` 即可
//
// 需求：Node.js 18+、cheerio（npm install）
// 執行方式：node scripts/scrape-family.mjs
// 輸出：repo 根目錄的 family-products.json

import { load } from 'cheerio';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'family-products.json');

const BASE_URL = 'https://foodsafety.family.com.tw/Web_FFD_2022/';
const CATEGORY_LIST_URL = BASE_URL + 'Category.aspx';
const PRODUCT_LIST_URL = BASE_URL + 'ProductList.aspx';
const MAX_CATEGORY_NAME_LENGTH = 30;

/** 隨機延遲 200~500ms，避免對對方造成負擔 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function randomDelay() {
  return sleep(200 + Math.floor(Math.random() * 300));
}

/**
 * 帶 retry 的 fetch（最多 3 次）
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
  const MAX_RETRIES = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; nutrition-scraper/1.0)',
          ...(options.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`  [attempt ${attempt}/${MAX_RETRIES}] ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

/** 從首頁取得所有分類 id / name */
async function fetchCategories() {
  console.log('取得分類列表…');
  const res = await fetchWithRetry(CATEGORY_LIST_URL);
  const html = await res.text();
  const $ = load(html);
  const categories = [];

  // 常見分類連結 pattern：Category.aspx?category=NNN 或 ?cid=NNN 等
  $('a[href*="Category.aspx"], a[href*="ProductList.aspx"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) return;
    // 嘗試解析 category 參數
    const m = href.match(/[?&](?:category|cid|cat)=([^&]+)/i);
    if (m) {
      const catId = decodeURIComponent(m[1]);
      if (!categories.find(c => c.id === catId)) {
        categories.push({ id: catId, name });
      }
    }
  });

  // 若解析不到分類，回傳空陣列（之後會 fallback 到直接搜全品項）
  return categories;
}

/** 解析單一商品詳情頁，回傳 nutrition 物件 */
async function fetchProductDetail(detailUrl) {
  await randomDelay();
  let html;
  try {
    const res = await fetchWithRetry(detailUrl);
    html = await res.text();
  } catch {
    return {};
  }
  const $ = load(html);

  /**
   * 從表格或文字中取出數值
   * @param {string} label
   * @returns {number|null}
   */
  function extractNum(label) {
    const text = $('body').text();
    const re = new RegExp(label + '[\\s：:]*([\\d.]+)', 'i');
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  }

  return {
    calories: extractNum('熱量') ?? extractNum('Calories'),
    protein:  extractNum('蛋白質') ?? extractNum('Protein'),
    fat:      extractNum('脂肪') ?? extractNum('Fat'),
    carbs:    extractNum('碳水化合物') ?? extractNum('Carbohydrate'),
    sodium:   extractNum('鈉') ?? extractNum('Sodium'),
    serving:  $('td:contains("每份"), td:contains("每份重量")').next().text().trim() || null,
  };
}

/**
 * 取得指定分類（或無分類）的所有商品，走訪所有分頁
 * @param {{ id?: string, name?: string }} category
 * @returns {Promise<object[]>}
 */
async function fetchProductsInCategory(category) {
  const products = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ page: String(page) });
    if (category.id) params.set('category', category.id);
    const listUrl = `${PRODUCT_LIST_URL}?${params}`;

    console.log(`  分類「${category.name || '全部'}」第 ${page} 頁…`);
    await randomDelay();

    let html;
    try {
      const res = await fetchWithRetry(listUrl);
      html = await res.text();
    } catch (err) {
      console.warn(`  無法取得 ${listUrl}: ${err.message}`);
      break;
    }

    const $ = load(html);

    // 嘗試多種常見 selector
    const itemSelectors = [
      '.product-item', '.item', 'li.product', '.pro-item',
      '.product_list li', 'table.list tr:not(:first-child)',
      '.foodItem', '.food-item',
    ];
    let items = $();
    for (const sel of itemSelectors) {
      const found = $(sel);
      if (found.length > 0) { items = found; break; }
    }

    if (items.length === 0) {
      // 若找不到商品列表，可能已到最後一頁或頁面結構不符
      break;
    }

    for (const el of items.toArray()) {
      const node = $(el);
      const name = (
        node.find('.name, .product-name, h3, .title, td:first-child').first().text() ||
        node.text()
      ).trim().replace(/\s+/g, ' ');

      if (!name || name.length < 2) continue;

      // 嘗試取得詳情頁連結
      const linkEl = node.find('a[href*="ProductDetail"], a[href*="Detail"]').first();
      const relHref = linkEl.attr('href') || '';
      const detailUrl = relHref ? new URL(relHref, BASE_URL).href : null;

      // 先從列表頁文字抓快速資訊
      const text = node.text();
      const calMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:大卡|kcal|Kcal|卡路里)/i);
      const proMatch = text.match(/蛋白[質]?\s*[：:]\s*(\d+(?:\.\d+)?)/i);

      let nutrition = {
        calories: calMatch ? parseFloat(calMatch[1]) : null,
        protein:  proMatch ? parseFloat(proMatch[1]) : null,
        fat: null, carbs: null, sodium: null, serving: null,
      };

      // 若列表頁缺資料且有詳情頁，去詳情頁補齊
      if ((nutrition.calories === null || nutrition.protein === null) && detailUrl) {
        const detail = await fetchProductDetail(detailUrl);
        nutrition = { ...nutrition, ...detail };
      }

      products.push({
        name,
        category: category.name || null,
        ...nutrition,
        url: detailUrl,
      });
    }

    // 判斷是否還有下一頁
    const hasNextPage =
      $('a:contains("下一頁"), a.next, a[href*="page=' + (page + 1) + '"]').length > 0 ||
      $('a').filter((_, a) => $(a).text().includes(String(page + 1))).length > 0;

    if (!hasNextPage) break;
    page++;
  }

  return products;
}

async function main() {
  console.log('=== 全家便利商店食品安全網 商品爬蟲 ===');
  console.log(`來源：${BASE_URL}`);
  console.log('');

  const allProducts = [];

  // 1. 嘗試取得分類列表
  let categories = [];
  try {
    categories = await fetchCategories();
  } catch (err) {
    console.warn('無法取得分類，將嘗試直接爬全品項', err.message);
  }

  if (categories.length > 0) {
    console.log(`找到 ${categories.length} 個分類`);
    for (const cat of categories) {
      const items = await fetchProductsInCategory(cat);
      console.log(`  → ${cat.name}: ${items.length} 筆`);
      allProducts.push(...items);
    }
  } else {
    // Fallback：直接從 ProductList.aspx 走訪所有分頁
    console.log('改以全品項分頁模式爬取…');
    const items = await fetchProductsInCategory({ name: null });
    allProducts.push(...items);
  }

  // 去重（以 name + category 為 key）
  const seen = new Set();
  const deduped = allProducts.filter(p => {
    const key = `${p.category}|${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const output = {
    updated_at: new Date().toISOString(),
    source: BASE_URL,
    count: deduped.length,
    products: deduped,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log('');
  console.log(`✅ 完成！共 ${deduped.length} 筆商品，已寫入 family-products.json`);
}

main().catch(err => {
  console.error('❌ 爬蟲執行失敗：', err);
  process.exit(1);
});
