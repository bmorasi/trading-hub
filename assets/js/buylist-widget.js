(() => {
  const script = document.currentScript;
  const baseUrl = new URL("../", script.src);
  const rootId = "card-binder-buylist-widget";

  if (document.getElementById(rootId)) return;

  const root = document.createElement("div");
  root.id = rootId;
  root.innerHTML = `
    <div class="grain"></div>
    <div class="buylist-shell" data-buylist-root data-vendor-email="vendor@example.com">
      <header class="hero">
        <img class="brand-logo" src="${new URL("../card-binder-logo.avif", baseUrl)}" alt="Card-Binder.com" />
        <p class="eyebrow">Card Binder Trade Desk</p>
        <h1>Pokemon Buylist</h1>
        <p class="hero-copy">Value is based on Cardmarket and payout is calculated by card condition.</p>
        <div class="hero-seal" aria-hidden="true">CB Flow</div>
      </header>
      <section class="panel search-panel">
        <label for="card-search" class="label">Search sets or cards</label>
        <div class="search-row">
          <input id="card-search" type="text" placeholder="Search sets first, then cards in the selected set..." autocomplete="off" />
          <select id="set-filter" aria-label="Filter by set"><option value="">All sets</option></select>
          <button id="clear-search" type="button" class="ghost">Clear</button>
          <button id="change-set" type="button" class="ghost hidden">Back to Sets</button>
        </div>
        <div id="set-grid" class="set-grid" aria-live="polite"></div>
        <div class="row-inline"><p class="hint">Images: low.webp from TCGDex for fastest load.</p><p id="catalog-count" class="hint count">0 shown of 0</p></div>
        <div id="card-sort-row" class="sort-row">
          <label for="sort-field" class="sr-label">Sort</label>
          <select id="sort-field" aria-label="Sort field"><option value="name">Card Name</option><option value="dex">Pokedex Number</option><option value="price">Price</option><option value="set">Set Name</option></select>
          <select id="sort-direction" aria-label="Sort direction"><option value="asc">Ascending</option><option value="desc">Descending</option></select>
          <label class="group-toggle" for="group-by-set"><input id="group-by-set" type="checkbox" /> Group by Sets</label>
        </div>
        <div class="action-row"><span id="quick-offer" class="quick-offer">Cash total: EUR 0.00</span></div>
        <div id="search-status" class="status" aria-live="polite"></div>
        <div id="loading-visual" class="loading-visual" aria-live="polite" aria-busy="true">
          <div class="loading-head"><span class="loading-spinner" aria-hidden="true"></span><strong id="loading-label">Loading catalog...</strong><span id="loading-percent" class="loading-percent">0%</span></div>
          <div class="loading-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="loading-bar" class="loading-bar"></div></div>
          <div class="loading-skeleton-grid" aria-hidden="true"><div class="loading-skeleton-card"></div><div class="loading-skeleton-card"></div><div class="loading-skeleton-card"></div><div class="loading-skeleton-card"></div><div class="loading-skeleton-card"></div><div class="loading-skeleton-card"></div></div>
        </div>
        <div id="search-results" class="results-shell" aria-live="polite"></div>
        <div id="results-sentinel" class="results-sentinel" aria-hidden="true"></div>
      </section>
    </div>
    <div id="cart-overlay" class="cart-overlay hidden"></div>
    <aside id="cart-drawer" class="cart-drawer hidden" aria-hidden="true">
      <section class="panel basket-panel">
        <div class="basket-head"><h2>Purchase Basket</h2><div class="basket-head-actions"><button id="reset-basket" type="button" class="ghost">Reset</button><button id="close-cart" type="button" class="ghost">Close</button></div></div>
        <ul id="basket-items" class="basket-items"></ul>
        <div class="summary"><div><span>Estimated market value</span><strong id="sum-market">EUR 0.00</strong></div><div><span>Condition-adjusted value</span><strong id="sum-value">EUR 0.00</strong></div><div><span>Cash payout</span><strong id="sum-cash">EUR 0.00</strong></div><div><span>Store credit payout</span><strong id="sum-credit">EUR 0.00</strong></div></div>
        <div class="email-panel"><label for="seller-name">Customer Name</label><input id="seller-name" type="text" placeholder="Full name" /><label for="seller-email">Customer Email</label><input id="seller-email" type="email" placeholder="customer@example.com" /><p id="photo-requirement-note" class="hint">Upload photos directly on each basket card worth EUR 5 or more.</p><label for="offer-spec">Specification</label><textarea id="offer-spec" rows="4" placeholder="Condition notes, shipping details, payout preference, etc."></textarea></div>
        <div class="email-actions"><button id="send-offer-email" class="submit-btn" type="button">Send Purchase Request to CB</button><button id="generate-pdf-report" class="ghost" type="button">Generate PDF Report</button></div>
        <p id="vendor-email-note" class="hint"></p>
      </section>
    </aside>
    <button id="open-cart" type="button" class="floating-cart-btn" aria-label="Open basket"><span class="floating-cart-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M3 5h2l2.2 10.2A2 2 0 0 0 9.16 17h8.55a2 2 0 0 0 1.95-1.55L21 8H7.1"></path><circle cx="10" cy="20" r="1.6"></circle><circle cx="18" cy="20" r="1.6"></circle></svg></span><span class="floating-cart-label">Basket (0)</span></button>
    <template id="result-item-template"><li class="result-item"><div class="result-media"><img class="result-image" alt="" loading="lazy" /><div class="price-row"><span class="market"></span><span class="offer"></span></div></div><div class="result-main"><h3 class="result-title"></h3><p class="result-meta"></p></div><button class="add-btn" type="button">Add</button></li></template>
  `;
  document.body.appendChild(root);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("css/styles.css", baseUrl);
  document.head.appendChild(stylesheet);

  const loadScript = (src, module = false) => new Promise((resolve, reject) => {
    const element = document.createElement("script");
    if (module) element.type = "module";
    element.src = new URL(src, baseUrl);
    element.onload = resolve;
    element.onerror = reject;
    document.head.appendChild(element);
  });

  loadScript("js/tcgdx-client.js", true)
    .then(() => loadScript("js/core/catalog-helpers.js"))
    .then(() => loadScript("js/core/pricing.js"))
    .then(() => loadScript("js/ui/basket-ui.js"))
    .then(() => loadScript("js/app.js"))
    .catch((error) => {
      console.error("Card Binder widget failed to load:", error);
      const status = root.querySelector("#search-status");
      if (status) status.textContent = "The buylist could not be loaded. Please try again later.";
    });
})();
