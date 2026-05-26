# Pokemon Buylist Shopify POC

This workspace contains a Proof of Concept for a Shopify buylist tool that:

- Lets customers search Pokemon cards from TCGDex
- Reads market value from TCGDex card data when available
- Offers 85% buy-in pricing
- Builds a buylist basket with quantity and subtotal
- Uses client-side caching and debounced search to keep API calls low

## Files

- `index.html`: Standalone preview page
- `assets/css/styles.css`: Card-binder-inspired styling
- `assets/js/app.js`: App orchestration and UI flow
- `assets/js/core/catalog-helpers.js`: Catalog normalization and card image helpers
- `assets/js/core/pricing.js`: Condition and pricing helpers
- `assets/js/ui/basket-ui.js`: Basket row UI component builder
- `shopify-section-buylist.liquid`: Shopify section scaffold

## Run locally

Open `index.html` in a browser.

If your browser blocks CORS for local file access, run a small static server in this folder and open the served URL.

## Shopify integration notes

1. Upload `assets/css/styles.css` as `buylist-styles.css`
2. Upload `assets/js/core/catalog-helpers.js` as `buylist-core-catalog-helpers.js`
3. Upload `assets/js/core/pricing.js` as `buylist-core-pricing.js`
4. Upload `assets/js/ui/basket-ui.js` as `buylist-ui-basket.js`
5. Upload `assets/js/app.js` as `buylist-app.js`
6. Add `shopify-section-buylist.liquid` into your theme `sections` folder
7. Add the section in Theme Editor

## API usage strategy (minimal calls)

- Debounced card search (400ms)
- At least 2 characters required before searching
- Response cache per query (memory + localStorage with TTL)
- In-flight request deduplication to avoid duplicate requests
- Card detail fetched only if market value is missing from search payload

## Important

TCGDex data shape may vary by language/endpoint version. The adapter in `assets/js/app.js` includes safe fallbacks for extracting market values.
