// Builds assets/data/cardmarket-prices.json: prices for the card versions that
// TCGdex links to a shared Cardmarket listing, taken from Cardmarket's public
// price guide and product list.
//
//   node scripts/build-cardmarket-prices.mjs                 sets from the last 365 days
//   node scripts/build-cardmarket-prices.mjs --sets=me06,me05
//
// Cardmarket lists every version of a card separately but without card numbers.
// Same-name versions are matched in order: lowest listing number to lowest card
// number. A group is priced only if every check in matchGroup() passes; otherwise
// its cards stay unpriced in the app.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "assets", "data", "cardmarket-prices.json");
const TCGDEX = "https://api.tcgdex.net/v2";
const CARDMARKET = "https://downloads.s3.cardmarket.com/productCatalog";
const DEFAULT_DAYS = 365;
// Accepted range for (Cardmarket EUR / TCGplayer USD), checked once either is above 5.
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;

// Use the same price rule as the website.
const window = {};
new Function("window", await readFile(join(ROOT, "assets", "js", "core", "catalog-helpers.js"), "utf8"))(window);
const { extractMarketPrice } = window.BuylistCatalogHelpers;

async function getJson(url, init, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${url}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

const byNumber = (a, b) => String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true });
const baseName = (productName) => productName.replace(/ \[.*$/, "");
const listingOf = (card) => card.pricing?.cardmarket?.idProduct;

function usdPrice(card) {
  const prices = card.pricing?.tcgplayer;
  return prices?.holofoil?.marketPrice || prices?.normal?.marketPrice || null;
}

async function selectSetIds() {
  const requested = process.argv.find((arg) => arg.startsWith("--sets="));
  if (requested) return requested.slice("--sets=".length).split(",").filter(Boolean);

  const json = await getJson(`${TCGDEX}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ sets { id releaseDate } }" })
  });
  const since = new Date(Date.now() - DEFAULT_DAYS * 86400000).toISOString().slice(0, 10);
  return json.data.sets.filter((set) => set.releaseDate >= since).map((set) => set.id);
}

async function loadSetCards(setId) {
  const set = await getJson(`${TCGDEX}/en/sets/${encodeURIComponent(setId)}`);
  const cards = [];
  for (let start = 0; start < (set.cards || []).length; start += 10) {
    cards.push(...await Promise.all(set.cards.slice(start, start + 10)
      .map((card) => getJson(`${TCGDEX}/en/cards/${encodeURIComponent(card.id)}`))));
  }
  return cards;
}

// Returns the prices for one group of same-name cards, or a reason to price none.
function matchGroup(cards, listings, priceById) {
  if (listings.length !== cards.length) return { reason: "listing count differs from card count" };

  const prices = [];
  for (const [index, card] of cards.entries()) {
    const listing = listings[index];
    const linked = listingOf(card);
    const isShared = cards.filter((other) => listingOf(other) === linked).length > 1;
    // A card TCGdex links on its own must land on that same listing.
    if (linked && !isShared && linked !== listing.idProduct) return { reason: "order contradicts a TCGdex link" };

    const guide = priceById.get(listing.idProduct);
    const price = extractMarketPrice({ variants: card.variants, pricing: { cardmarket: guide } });
    const usd = usdPrice(card);
    if (price && usd && Math.max(price, usd) > 5) {
      const ratio = price / usd;
      if (ratio < MIN_RATIO || ratio > MAX_RATIO) return { reason: "price far from the US price" };
    }
    if (price) prices.push([card.id, { price, idProduct: listing.idProduct }]);
  }
  return { prices };
}

const [catalog, guide, setIds] = await Promise.all([
  getJson(`${CARDMARKET}/productList/products_singles_6.json`),
  getJson(`${CARDMARKET}/priceGuide/price_guide_6.json`),
  selectSetIds()
]);
if (!catalog.products?.length || !guide.priceGuides?.length) {
  throw new Error("Cardmarket files are empty or have changed shape; price file left as it was.");
}

const productById = new Map(catalog.products.map((product) => [product.idProduct, product]));
const priceById = new Map(guide.priceGuides.map((entry) => [entry.idProduct, entry]));
const prices = {};
let unmatched = 0;

for (const setId of setIds) {
  const cards = await loadSetCards(setId);

  // The set's Cardmarket expansion is the one most of its linked cards belong to.
  const counts = new Map();
  for (const card of cards) {
    const expansion = productById.get(listingOf(card))?.idExpansion;
    if (expansion) counts.set(expansion, (counts.get(expansion) || 0) + 1);
  }
  const expansion = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!expansion) continue;

  const groups = new Map();
  for (const card of cards) {
    if (!groups.has(card.name)) groups.set(card.name, []);
    groups.get(card.name).push(card);
  }

  for (const [name, group] of groups) {
    const linked = group.map(listingOf).filter(Boolean);
    if (new Set(linked).size === linked.length) continue; // nothing shared, TCGdex is used as is

    group.sort(byNumber);
    const listings = catalog.products
      .filter((product) => product.idExpansion === expansion && baseName(product.name) === name)
      .sort((a, b) => a.idProduct - b.idProduct);
    const result = matchGroup(group, listings, priceById);
    if (result.reason) {
      unmatched += 1;
      console.log(`${setId} ${name}: not priced (${result.reason})`);
      continue;
    }
    Object.assign(prices, Object.fromEntries(result.prices));
  }
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  priceGuideDate: guide.createdAt,
  currency: "EUR",
  prices
}, null, 1)}\n`);
console.log(`${Object.keys(prices).length} card prices written from ${setIds.length} sets; ${unmatched} groups left unpriced.`);
