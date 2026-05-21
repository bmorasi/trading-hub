# Pokemon Buylist Shopify POC

This workspace contains a Proof of Concept for a Shopify buylist tool that:

- Lets customers search Pokemon cards from TCGDex
- Reads market value from TCGDex card data when available
- Offers 85% buy-in pricing
- Builds a buylist basket with quantity and subtotal
- Uses client-side caching and debounced search to keep API calls low

## Files

- `index.html`: Standalone preview page
- `styles.css`: Card-binder-inspired styling
- `app.js`: TCGDex API adapter, cache, pricing, and UI logic
- `shopify-section-buylist.liquid`: Shopify section scaffold

## Run locally

Open `index.html` in a browser.

If your browser blocks CORS for local file access, run a small static server in this folder and open the served URL.

## Shopify integration notes

1. Upload `styles.css` as `assets/buylist-poc.css`
2. Upload `app.js` as `assets/buylist-poc.js`
3. Add `shopify-section-buylist.liquid` into your theme `sections` folder
4. Add the section in Theme Editor

## API usage strategy (minimal calls)

- Debounced card search (400ms)
- At least 2 characters required before searching
- Response cache per query (memory + localStorage with TTL)
- In-flight request deduplication to avoid duplicate requests
- Card detail fetched only if market value is missing from search payload

## Important

TCGDex data shape may vary by language/endpoint version. The adapter in `app.js` includes safe fallbacks for extracting market values.
