# Pokemon Buylist Shopify POC

This workspace contains a Proof of Concept for a Shopify buylist tool that:

- Lets customers search Pokemon cards from TCGDex
- Prices cards from Cardmarket (EUR) data in TCGDex: the middle value of trend, 7-day and 30-day average
- Prices each card by condition, with a cash and a store-credit payout (see below)
- Builds a buylist basket with quantity and subtotal, and requires photos for cards worth €5 or more
- Sends the purchase request by email and can generate a PDF report
- Uses client-side caching and debounced search to keep API calls low

## Payout by condition

Defined in `assets/js/core/pricing.js`. Value is a share of the market price; payouts are a share of that value.

| Condition | Value | Payout | Store credit |
|---|---|---|---|
| Near Mint | 100% | 75% | 90% |
| Excellent | 75% | 56% | 68% |
| Good | 50% | 38% | 45% |
| Poor | 10% | 8% | 9% |

## Files

- `index.html`: Standalone preview page
- `assets/css/styles.css`: Card-binder-inspired styling
- `assets/js/app.js`: App orchestration and UI flow
- `assets/js/tcgdx-client.js`: TCGDex SDK fallback for card details (ES module)
- `assets/js/buylist-widget.js`: Single-script loader for script injection
- `assets/js/core/catalog-helpers.js`: Catalog normalization and card image helpers
- `assets/js/core/pricing.js`: Condition and pricing helpers
- `assets/js/ui/basket-ui.js`: Basket row UI component builder
- `shopify-section-buylist.liquid`: Shopify section scaffold

## Cardmarket price file

TCGdex sometimes links several versions of a card (for example a special art) to
one Cardmarket listing. The app leaves those unpriced unless
`assets/data/cardmarket-prices.json` has a price for them.

```
node scripts/build-cardmarket-prices.mjs
```

- Needs Node 18 or newer, no packages. It covers sets released in the last 365 days; use `--sets=me06` to choose.
- `.github/workflows/cardmarket-prices.yml` runs it daily, commits the file and asks GitHub Pages to rebuild the site.
- The app ignores a file older than 3 days.
- Standalone page and widget: the file is found next to the scripts. Shopify: host it publicly (CORS allowed) and enter its address in the section setting "Cardmarket price file URL".
- Before publishing these prices, confirm with Cardmarket that this use of their data is allowed.

## Run locally

Open `index.html` in a browser.

If your browser blocks CORS for local file access, run a small static server in this folder and open the served URL.

## Shopify integration notes

1. Upload `assets/css/styles.css` as `buylist-styles.css`
2. Upload `assets/card-binder-logo.avif` as `buylist-logo.avif`
3. Upload `assets/js/tcgdx-client.js` as `buylist-tcgdx-client.js`
4. Upload `assets/js/core/catalog-helpers.js` as `buylist-core-catalog-helpers.js`
5. Upload `assets/js/core/pricing.js` as `buylist-core-pricing.js`
6. Upload `assets/js/ui/basket-ui.js` as `buylist-ui-basket.js`
7. Upload `assets/js/app.js` as `buylist-app.js`
8. Add `shopify-section-buylist.liquid` into your theme `sections` folder
9. Add the section in Theme Editor

## Script injection

For a storefront script-injection tool, host the project folder on a public HTTPS URL and add only this script tag:

```html
<script src="https://your-domain.example/assets/js/buylist-widget.js" defer></script>
```

The widget creates its own markup, loads the stylesheet and application files relative to that script URL, and uses the existing `card-binder-logo.avif` asset. Keep the `assets` folder structure unchanged when publishing it. The host must allow cross-origin requests for the JavaScript, CSS, logo, and TCGDex API calls.

## API usage strategy (minimal calls)

- Debounced card search (400ms)
- At least 2 characters required before searching
- Response cache per query (memory + localStorage with TTL)
- In-flight request deduplication to avoid duplicate requests
- Card detail fetched only if market value is missing from search payload

## Important

The price rule is `extractMarketPrice` in `assets/js/core/catalog-helpers.js`. Cards without usable Cardmarket data show no price.
