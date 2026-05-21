(() => {
  const API_BASE = "https://api.tcgdex.net/v2/en";
  const ASSET_BASE = "https://assets.tcgdex.net/en";
  const DEFAULT_VENDOR_EMAIL = "vendor@example.com";
  const BUY_RATIO = 0.85;
  const CATALOG_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
  const SETS_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
  const CARD_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
  const CATALOG_SIZE = 120;
  const PAGE_SIZE = 60;
  const HYDRATE_LIMIT = 60;

  const rootEl = document.querySelector("[data-buylist-root]");
  const searchInput = document.getElementById("card-search");
  const setFilterEl = document.getElementById("set-filter");
  const sortFieldEl = document.getElementById("sort-field");
  const sortDirectionEl = document.getElementById("sort-direction");
  const groupBySetEl = document.getElementById("group-by-set");
  const clearSearchBtn = document.getElementById("clear-search");
  const openCartBtn = document.getElementById("open-cart");
  const closeCartBtn = document.getElementById("close-cart");
  const cartDrawerEl = document.getElementById("cart-drawer");
  const cartOverlayEl = document.getElementById("cart-overlay");
  const quickOfferEl = document.getElementById("quick-offer");
  const statusEl = document.getElementById("search-status");
  const catalogCountEl = document.getElementById("catalog-count");
  const resultsEl = document.getElementById("search-results");
  const resultsSentinelEl = document.getElementById("results-sentinel");
  const basketEl = document.getElementById("basket-items");
  const sumMarketEl = document.getElementById("sum-market");
  const sumOfferEl = document.getElementById("sum-offer");
  const payloadEl = document.getElementById("payload-preview");
  const resetBasketBtn = document.getElementById("reset-basket");
  const submitBtn = document.getElementById("submit-buylist");
  const sendOfferEmailBtn = document.getElementById("send-offer-email");
  const sellerNameEl = document.getElementById("seller-name");
  const sellerEmailEl = document.getElementById("seller-email");
  const offerSpecEl = document.getElementById("offer-spec");
  const vendorEmailNoteEl = document.getElementById("vendor-email-note");
  const resultTemplate = document.getElementById("result-item-template");

  const cardCache = new Map();
  const inFlight = new Map();
  const basket = new Map();
  const addQueue = [];
  const priceHydrating = new Set();
  let catalog = [];
  let activeCards = [];
  let renderedCardCount = 0;
  let observer = null;
  let lastQuery = "";
  let searchTimer = null;
  let isProcessingAddQueue = false;
  let isCatalogReady = false;

  const fmtEUR = new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  });

  function now() {
    return Date.now();
  }

  function delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function setControlsDisabled(disabled) {
    const controls = [
      searchInput,
      setFilterEl,
      sortFieldEl,
      sortDirectionEl,
      groupBySetEl,
      clearSearchBtn,
      openCartBtn
    ];
    for (const control of controls) {
      if (!control) continue;
      control.disabled = disabled;
    }
  }

  async function withRetry(fn, attempts = 3, waitMs = 350) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (i < attempts - 1) {
          await delay(waitMs);
        }
      }
    }
    throw lastError;
  }

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  function getVendorEmail() {
    const fromData = rootEl ? String(rootEl.getAttribute("data-vendor-email") || "").trim() : "";
    return fromData || DEFAULT_VENDOR_EMAIL;
  }

  function keyCatalog() {
    return "tcgdex:catalog:v4";
  }

  function keySets() {
    return "tcgdex:sets:v1";
  }

  function keyCard(id) {
    return `tcgdex:c:${id}`;
  }

  function cacheRead(key, ttlMs) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.ts !== "number") return null;
      if (now() - parsed.ts > ttlMs) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  function cacheWrite(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: now(), value }));
    } catch {
      // Ignore quota/private mode issues in POC.
    }
  }

  function deriveSerieId(setId) {
    if (!setId) return "";
    const match = String(setId).toLowerCase().match(/^([a-z]+)/);
    return match ? match[1] : "";
  }

  function toFastImageFromBase(base) {
    if (!base || typeof base !== "string") return "";
    const cleanBase = base.replace(/\/(high|low)\.(png|webp|jpg)$/i, "");
    return `${cleanBase}/low.webp`;
  }

  function toAssetBase(base) {
    if (!base || typeof base !== "string") return "";
    return base.replace(/\/(high|low)\.(png|webp|jpg)$/i, "");
  }

  function buildImageCandidates(card) {
    const candidates = [];

    const baseFromImage = toAssetBase(card?.image || "");
    const setId = card?.setId || card?.set?.id || "";
    const localId = card?.localId || card?.number || "";
    const serieId = deriveSerieId(setId);
    const computedBase = serieId && setId && localId
      ? `${ASSET_BASE}/${serieId}/${setId}/${encodeURIComponent(localId)}`
      : "";

    const bases = [baseFromImage, computedBase].filter(Boolean);
    for (const base of bases) {
      candidates.push(`${base}/low.webp`);
      candidates.push(`${base}/low.jpg`);
      candidates.push(`${base}/high.webp`);
      candidates.push(`${base}/high.jpg`);
    }

    return [...new Set(candidates)];
  }

  function buildAssetImage(card) {
    const candidates = buildImageCandidates(card);
    return candidates[0] || toFastImageFromBase(card?.image || "");
  }

  function isDigitalOnlyCard(card) {
    const setName = String(card?.set?.name || card?.setName || "").toLowerCase();
    const setId = String(card?.set?.id || card?.setId || "").toLowerCase();
    const cardId = String(card?.id || "").toLowerCase();
    const category = String(card?.category || "").toLowerCase();
    const pocketSignals = [setName, setId, cardId, category].join(" ");
    return pocketSignals.includes("pocket") || pocketSignals.includes("tcgp");
  }

  function extractMarketPrice(card) {
    const candidates = [
      card?.pricing?.cardmarket?.avg,
      card?.pricing?.cardmarket?.trend,
      card?.pricing?.cardmarket?.low,
      card?.pricing?.cardmarket?.avg7,
      card?.pricing?.cardmarket?.avg30,
      card?.pricing?.cardmarket?.["avg-holo"],
      card?.pricing?.cardmarket?.["trend-holo"],
      card?.pricing?.cardmarket?.["low-holo"],
      card?.cardmarket?.prices?.averageSellPrice,
      card?.cardmarket?.prices?.trendPrice,
      card?.cardmarket?.avg,
      card?.prices?.cardmarket?.avg,
      card?.prices?.cardmarket?.trend,
      card?.prices?.cardmarket?.low,
      card?.prices?.cardmarket,
      card?.prices?.market,
      card?.market,
      card?.price
    ];

    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function extractPricingUnit(card) {
    return card?.pricing?.cardmarket?.unit || card?.prices?.cardmarket?.unit || "EUR";
  }

  function normalizeCardRecord(card, fallbackSet = null) {
    const fallbackSetId = fallbackSet?.id || "";
    const fallbackSetName = fallbackSet?.name || "";
    const setId = card.set?.id || card.setId || fallbackSetId;
    const setName = card.set?.name || card.setName || card.extension || fallbackSetName || setId;

    const market = extractMarketPrice(card);

    return {
      id: card.id || card.cardId || "",
      localId: card.localId || card.number || "",
      name: card.name || card.enName || "Unknown card",
      dexNumber: Number(Array.isArray(card.dexId) ? card.dexId[0] : card.dexId) || 0,
      setId,
      setName,
      imageCandidates: buildImageCandidates({ ...card, setId, setName }),
      image: buildAssetImage({ ...card, setId, setName }),
      rarity: card.rarity || "",
      market,
      priceResolved: Number.isFinite(market) && market > 0,
      unit: extractPricingUnit(card)
    };
  }

  function normalizeSearchPayload(data) {
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.cards)
      ? data.cards
      : Array.isArray(data?.results)
      ? data.results
      : [];

    return arr
      .slice(0, CATALOG_SIZE)
      .filter((card) => !isDigitalOnlyCard(card))
      .map((card) => normalizeCardRecord(card))
      .filter((card) => card.id);
  }

  function normalizeSetCardsPayload(setPayload, setInfo) {
    const arr = Array.isArray(setPayload?.cards)
      ? setPayload.cards
      : Array.isArray(setPayload)
      ? setPayload
      : [];

    return arr
      .filter((card) => !isDigitalOnlyCard({ ...card, set: { id: setInfo.id, name: setInfo.name } }))
      .map((card) => normalizeCardRecord(card, setInfo))
      .filter((card) => card.id);
  }

  function normalizeSetsPayload(data) {
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.sets)
      ? data.sets
      : Array.isArray(data?.results)
      ? data.results
      : [];

    return arr
      .map((set) => ({
        id: set.id || "",
        name: set.name || set.id || ""
      }))
      .filter((set) => set.id && set.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function enrichCatalogWithSets(cards, sets) {
    if (!Array.isArray(cards) || !cards.length) return cards;

    const setMap = new Map((Array.isArray(sets) ? sets : []).map((set) => [set.id, set.name]));
    return cards
      .map((card) => {
        const resolvedSetName = setMap.get(card.setId) || card.setName || (card.setId ? `Set ${card.setId}` : "");
        const imageCandidates = Array.isArray(card.imageCandidates) && card.imageCandidates.length
          ? card.imageCandidates
          : buildImageCandidates(card);

        return {
          ...card,
          setName: resolvedSetName,
          imageCandidates,
          image: imageCandidates[0] || card.image || ""
        };
      })
      .filter((card) => {
        return Boolean(card.id);
      });
  }

  async function dedupedFetch(url, init = {}) {
    const key = `${url}|${init.method || "GET"}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = fetch(url, init)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  }

  async function loadCatalog() {
    const storageHit = cacheRead(keyCatalog(), CATALOG_CACHE_TTL_MS);
    if (storageHit && storageHit.length) {
      return storageHit;
    }

    const endpoints = [
      `${API_BASE}/cards?itemsPerPage=${CATALOG_SIZE}&page=1`,
      `${API_BASE}/cards`
    ];

    for (const url of endpoints) {
      try {
        const json = await dedupedFetch(url);
        const normalized = normalizeSearchPayload(json);
        if (normalized.length) {
          cacheWrite(keyCatalog(), normalized);
          return normalized;
        }
      } catch {
        // Try next endpoint format.
      }
    }

    return [];
  }

  async function loadCatalogBySets(sets) {
    const storageHit = cacheRead(keyCatalog(), CATALOG_CACHE_TTL_MS);
    if (storageHit && storageHit.length > CATALOG_SIZE) {
      return storageHit;
    }

    const deduped = new Map();
    const safeSets = Array.isArray(sets) ? sets : [];

    for (let i = 0; i < safeSets.length; i += 1) {
      const set = safeSets[i];
      const setId = set?.id;
      if (!setId) continue;

      try {
        const setPayload = await dedupedFetch(`${API_BASE}/sets/${encodeURIComponent(setId)}`);
        const cards = normalizeSetCardsPayload(setPayload, { id: set.id, name: set.name });
        for (const card of cards) {
          if (!deduped.has(card.id)) {
            deduped.set(card.id, card);
          }
        }
      } catch {
        // Skip failing set and continue; fallback loader below can still fill base data.
      }

      if ((i + 1) % 8 === 0 || i === safeSets.length - 1) {
        setStatus(`Loading cards by sets: ${i + 1}/${safeSets.length}`);
      }
    }

    if (!deduped.size) {
      const fallback = await loadCatalog();
      if (fallback.length) {
        cacheWrite(keyCatalog(), fallback);
      }
      return fallback;
    }

    const merged = [...deduped.values()];
    cacheWrite(keyCatalog(), merged);
    return merged;
  }

  async function loadSets() {
    const storageHit = cacheRead(keySets(), SETS_CACHE_TTL_MS);
    if (storageHit && storageHit.length) {
      return storageHit;
    }

    const endpoints = [
      `${API_BASE}/sets`,
      `${API_BASE}/sets?itemsPerPage=250`
    ];

    for (const url of endpoints) {
      try {
        const json = await dedupedFetch(url);
        const normalized = normalizeSetsPayload(json);
        if (normalized.length) {
          cacheWrite(keySets(), normalized);
          return normalized;
        }
      } catch {
        // Try next endpoint format.
      }
    }

    return [];
  }

  async function getCardDetails(cardId) {
    if (!cardId) return null;

    const memHit = cardCache.get(cardId);
    if (memHit && now() - memHit.ts < CARD_CACHE_TTL_MS) {
      return memHit.value;
    }

    const storageKey = keyCard(cardId);
    const storageHit = cacheRead(storageKey, CARD_CACHE_TTL_MS);
    if (storageHit) {
      cardCache.set(cardId, { ts: now(), value: storageHit });
      return storageHit;
    }

    try {
      const json = await dedupedFetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`);
      const detail = {
        ...json,
        market: extractMarketPrice(json),
        unit: extractPricingUnit(json),
        imageCandidates: buildImageCandidates(json),
        image: buildAssetImage(json),
        priceResolved: true
      };
      cardCache.set(cardId, { ts: now(), value: detail });
      cacheWrite(storageKey, detail);
      return detail;
    } catch {
      return null;
    }
  }

  function offerPrice(market) {
    if (!Number.isFinite(market) || market <= 0) return 0;
    return market * BUY_RATIO;
  }

  function cardMeta(card) {
    const parts = [];
    if (card.localId) parts.push(`#${card.localId}`);
    if (card.setName) parts.push(card.setName);
    return parts.join(" • ");
  }

  function cardFilterText(card) {
    return `${card.name} ${card.localId} ${card.setName} ${card.dexNumber || ""}`.toLowerCase();
  }

  function currentSortField() {
    return sortFieldEl ? sortFieldEl.value : "name";
  }

  function currentSortDirection() {
    return sortDirectionEl ? sortDirectionEl.value : "asc";
  }

  function isGroupBySet() {
    return Boolean(groupBySetEl && groupBySetEl.checked);
  }

  function compareCards(a, b, field, direction) {
    let diff = 0;
    if (field === "dex") {
      const aDex = Number(a.dexNumber) || 0;
      const bDex = Number(b.dexNumber) || 0;
      diff = aDex - bDex;
      if (diff === 0) diff = a.name.localeCompare(b.name);
    } else if (field === "price") {
      const aPrice = Number(a.market) || 0;
      const bPrice = Number(b.market) || 0;
      diff = aPrice - bPrice;
      if (diff === 0) diff = a.name.localeCompare(b.name);
    } else if (field === "set") {
      diff = (a.setName || "").localeCompare(b.setName || "");
      if (diff === 0) diff = a.name.localeCompare(b.name);
    } else {
      diff = a.name.localeCompare(b.name);
      if (diff === 0) diff = (a.setName || "").localeCompare(b.setName || "");
    }

    return direction === "desc" ? -diff : diff;
  }

  function sortCards(cards) {
    const field = currentSortField();
    const direction = currentSortDirection();
    return [...cards].sort((a, b) => compareCards(a, b, field, direction));
  }

  function appendCardNode(card, container) {
    const fragment = resultTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".result-item");
    const image = fragment.querySelector(".result-image");
    const title = fragment.querySelector(".result-title");
    const meta = fragment.querySelector(".result-meta");
    const market = fragment.querySelector(".market");
    const offer = fragment.querySelector(".offer");
    const addBtn = fragment.querySelector(".add-btn");

    if (image) {
      bindImageWithFallback(image, card, root);
    }

    if (title) title.textContent = card.name;
    if (meta) meta.textContent = cardMeta(card);

    if (market && offer) {
      if (Number.isFinite(card.market) && card.market > 0) {
        market.textContent = `Market: ${fmtEUR.format(card.market)}`;
        offer.textContent = `Offer: ${fmtEUR.format(offerPrice(card.market))}`;
      } else if (card.priceResolved) {
        market.textContent = "Market: no data";
        offer.textContent = "Offer: unavailable";
      } else {
        market.textContent = "Market: unavailable";
        offer.textContent = "Offer: pending value";
      }
    }

    if (addBtn) {
      addBtn.addEventListener("click", () => addCardToBasket(card));
    }

    if (root) root.dataset.cardId = card.id;
    container.appendChild(fragment);
  }

  function setupInfiniteScroll() {
    if (!resultsSentinelEl || typeof IntersectionObserver === "undefined") return;
    if (observer) {
      observer.disconnect();
    }

    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (isGroupBySet()) continue;
        appendNextPage();
      }
    }, {
      root: null,
      rootMargin: "450px 0px",
      threshold: 0
    });

    observer.observe(resultsSentinelEl);
  }

  function appendNextPage() {
    if (!resultsEl || !resultTemplate || !activeCards.length || isGroupBySet()) return;

    const start = renderedCardCount;
    const end = Math.min(start + PAGE_SIZE, activeCards.length);
    if (start >= end) return;

    let grid = resultsEl.querySelector(".results-grid");
    if (!grid) {
      resultsEl.innerHTML = "";
      grid = document.createElement("div");
      grid.className = "results-grid";
      resultsEl.appendChild(grid);
    }

    const nextCards = activeCards.slice(start, end);
    for (const card of nextCards) {
      appendCardNode(card, grid);
    }

    renderedCardCount = end;
    updateCatalogCount(renderedCardCount, activeCards.length);

    hydrateVisiblePrices(nextCards, lastQuery, getActiveSetFilter()).catch(() => {
      // Best-effort hydration only.
    });
  }

  function basketItemCount() {
    let total = 0;
    for (const row of basket.values()) {
      total += row.quantity;
    }
    return total;
  }

  function setCartOpen(isOpen) {
    if (!cartDrawerEl || !cartOverlayEl) return;
    cartDrawerEl.classList.toggle("hidden", !isOpen);
    cartOverlayEl.classList.toggle("hidden", !isOpen);
    cartDrawerEl.setAttribute("aria-hidden", isOpen ? "false" : "true");
  }

  function getActiveSetFilter() {
    return setFilterEl ? setFilterEl.value.trim() : "";
  }

  function populateSetFilterOptions(cards, sets) {
    if (!setFilterEl) return;

    const current = setFilterEl.value;
    const catalogSetMap = new Map();
    for (const card of cards) {
      if (card.setId) {
        catalogSetMap.set(card.setId, card.setName || card.setId);
      }
    }

    const source = Array.isArray(sets) && sets.length
      ? sets.filter((set) => catalogSetMap.has(set.id))
      : [...catalogSetMap.entries()].map(([id, name]) => ({ id, name }));

    const options = source
      .map((set) => ({
        id: set.id,
        name: set.name || catalogSetMap.get(set.id) || set.id
      }))
      .filter((set) => set.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    setFilterEl.innerHTML = "";

    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All sets";
    setFilterEl.appendChild(all);

    for (const optionData of options) {
      const option = document.createElement("option");
      option.value = optionData.id;
      option.textContent = optionData.name;
      setFilterEl.appendChild(option);
    }

    const validIds = new Set(options.map((option) => option.id));
    if (current && validIds.has(current)) {
      setFilterEl.value = current;
    }
  }

  function bindImageWithFallback(imageEl, card, cardRoot) {
    if (!imageEl) return;

    const candidates = Array.isArray(card.imageCandidates) && card.imageCandidates.length
      ? card.imageCandidates
      : buildImageCandidates(card);

    if (!candidates.length) {
      imageEl.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='300'%3E%3Crect width='100%25' height='100%25' fill='%23eee4d2'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%236a584a' font-family='sans-serif' font-size='14'%3ENo image%3C/text%3E%3C/svg%3E";
      return;
    }

    let index = 0;
    imageEl.loading = "lazy";
    imageEl.decoding = "async";
    imageEl.referrerPolicy = "no-referrer";
    imageEl.alt = card.name;
    imageEl.onerror = () => {
      index += 1;
      if (index < candidates.length) {
        imageEl.src = candidates[index];
      } else {
        imageEl.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='300'%3E%3Crect width='100%25' height='100%25' fill='%23eee4d2'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%236a584a' font-family='sans-serif' font-size='14'%3EImage unavailable%3C/text%3E%3C/svg%3E";
      }
    };
    imageEl.src = candidates[0];
  }

  function renderSearchResults(cards) {
    if (!resultsEl || !resultTemplate) return;

    resultsEl.innerHTML = "";
    if (!cards.length) return;

    activeCards = [...cards];
    renderedCardCount = 0;
    appendNextPage();
  }

  function renderGroupedBySet(cards) {
    if (!resultsEl || !resultTemplate) return;
    resultsEl.innerHTML = "";
    if (!cards.length) return;

    const groups = new Map();
    for (const card of cards) {
      const key = card.setName || "Unknown Set";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }

    const setNames = [...groups.keys()].sort((a, b) => {
      const diff = a.localeCompare(b);
      return currentSortDirection() === "desc" ? -diff : diff;
    });

    for (const setName of setNames) {
      const section = document.createElement("div");
      section.className = "set-group";

      const title = document.createElement("h3");
      title.className = "set-group-title";
      title.textContent = setName;

      const list = document.createElement("div");
      list.className = "results-grid";

      const sortedCards = sortCards(groups.get(setName));
      for (const card of sortedCards) {
        appendCardNode(card, list);
      }

      section.append(title, list);
      resultsEl.appendChild(section);
    }
  }

  function updateCatalogCount(visible, total) {
    if (!catalogCountEl) return;
    catalogCountEl.textContent = `${visible} shown of ${total}`;
  }

  function basketRows() {
    return [...basket.values()].map((row) => ({
      cardId: row.cardId,
      name: row.name,
      localId: row.localId,
      setName: row.setName,
      dexNumber: row.dexNumber,
      quantity: row.quantity,
      market: row.market,
      offer: offerPrice(row.market),
      subtotalOffer: offerPrice(row.market) * row.quantity
    }));
  }

  function renderBasket() {
    if (!basketEl || !sumMarketEl || !sumOfferEl || !payloadEl) return;

    basketEl.innerHTML = "";

    const rows = basketRows();
    let marketTotal = 0;
    let offerTotal = 0;

    for (const row of rows) {
      marketTotal += row.market * row.quantity;
      offerTotal += row.subtotalOffer;

      const li = document.createElement("li");
      li.className = "basket-item";

      const main = document.createElement("div");
      const meta = [row.setName, row.localId ? `#${row.localId}` : "", row.dexNumber ? `Dex ${row.dexNumber}` : ""]
        .filter(Boolean)
        .join(" • ");
      main.innerHTML = `<strong>${row.name}</strong><br><small>${meta}</small><br><small>${fmtEUR.format(row.offer)} each</small>`;

      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = "1";
      qtyInput.value = String(row.quantity);
      qtyInput.className = "qty";
      qtyInput.addEventListener("input", () => {
        const nextQty = Math.max(1, Number(qtyInput.value) || 1);
        const existing = basket.get(row.cardId);
        if (!existing) return;
        existing.quantity = nextQty;
        renderBasket();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        basket.delete(row.cardId);
        renderBasket();
      });

      li.append(main, qtyInput, remove);
      basketEl.appendChild(li);
    }

    sumMarketEl.textContent = fmtEUR.format(marketTotal);
    sumOfferEl.textContent = fmtEUR.format(offerTotal);

    if (openCartBtn) {
      openCartBtn.textContent = `Open Buylist (${basketItemCount()})`;
    }
    if (quickOfferEl) {
      quickOfferEl.textContent = `Offer total: ${fmtEUR.format(offerTotal)}`;
    }

    payloadEl.textContent = JSON.stringify(
      {
        source: "shopify-buylist-poc",
        currency: "EUR",
        buyRatio: BUY_RATIO,
        lines: rows,
        totals: {
          market: Number(marketTotal.toFixed(2)),
          offer: Number(offerTotal.toFixed(2))
        }
      },
      null,
      2
    );

    if (vendorEmailNoteEl) {
      vendorEmailNoteEl.textContent = `Vendor email: ${getVendorEmail()}`;
    }
  }

  async function addCardToBasketNow(card) {
    setStatus(`Adding ${card.name}...`);

    let market = card.market;
    if (!Number.isFinite(market) || market <= 0) {
      const detail = await getCardDetails(card.id);
      market = detail?.market || 0;
      card.priceResolved = true;
      if (detail?.imageCandidates?.length) {
        card.imageCandidates = detail.imageCandidates;
      }
      if ((!card.image || !card.image.length) && detail?.image) {
        card.image = detail.image;
      }
    }

    if (!Number.isFinite(market) || market <= 0) {
      setStatus(`No market value found for ${card.name}.`);
      return;
    }

    const existing = basket.get(card.id);
    if (existing) {
      existing.quantity += 1;
      existing.market = market;
    } else {
      basket.set(card.id, {
        cardId: card.id,
        name: card.name,
        localId: card.localId,
        setName: card.setName,
        dexNumber: card.dexNumber,
        quantity: 1,
        market
      });
    }

    renderBasket();
    setStatus(`${card.name} added at ${fmtEUR.format(offerPrice(market))} offer each.`);
  }

  async function processAddQueue() {
    if (isProcessingAddQueue) return;
    isProcessingAddQueue = true;

    while (addQueue.length) {
      const card = addQueue.shift();
      try {
        await addCardToBasketNow(card);
      } catch {
        setStatus(`Could not add ${card?.name || "card"}. Please try again.`);
      }
    }

    isProcessingAddQueue = false;
  }

  function addCardToBasket(card) {
    addQueue.push(card);
    if (addQueue.length > 1 || isProcessingAddQueue) {
      setStatus(`Queued ${card.name}. Processing ${addQueue.length} item(s)...`);
    }
    processAddQueue();
  }

  async function hydrateVisiblePrices(cards, queryAtStart, setAtStart) {
    const missing = cards.filter(
      (card) => (!Number.isFinite(card.market) || card.market <= 0) && !priceHydrating.has(card.id)
    );
    if (!missing.length) return;

    const toHydrate = missing.slice(0, HYDRATE_LIMIT);
    for (const card of toHydrate) {
      priceHydrating.add(card.id);
    }

    await Promise.allSettled(
      toHydrate.map(async (card) => {
        const detail = await getCardDetails(card.id);
        card.priceResolved = true;
        if (!detail) return;

        if (Number.isFinite(detail.market) && detail.market > 0) {
          card.market = detail.market;
          card.unit = detail.unit || card.unit;
        }
        if (detail?.imageCandidates?.length) {
          card.imageCandidates = detail.imageCandidates;
          card.image = detail.imageCandidates[0] || card.image;
        }
        if (!card.image && detail.image) {
          card.image = detail.image;
        }
      })
    );

    for (const card of toHydrate) {
      priceHydrating.delete(card.id);
    }

    if (lastQuery === queryAtStart && getActiveSetFilter() === setAtStart) {
      const filtered = catalog.filter((card) => {
        const matchesText = !lastQuery || cardFilterText(card).includes(lastQuery.toLowerCase());
        const matchesSet = !setAtStart || card.setId === setAtStart;
        return matchesText && matchesSet;
      });

      const sorted = sortCards(filtered);
      if (isGroupBySet()) {
        renderGroupedBySet(sorted);
        updateCatalogCount(sorted.length, sorted.length);
      } else {
        for (const card of cards) {
          const nodes = resultsEl ? resultsEl.querySelectorAll(`[data-card-id="${card.id}"]`) : [];
          for (const node of nodes) {
            const marketEl = node.querySelector(".market");
            const offerEl = node.querySelector(".offer");
            if (!marketEl || !offerEl) continue;
            if (Number.isFinite(card.market) && card.market > 0) {
              marketEl.textContent = `Market: ${fmtEUR.format(card.market)}`;
              offerEl.textContent = `Offer: ${fmtEUR.format(offerPrice(card.market))}`;
            }
          }
        }
      }
    }
  }

  function runSearchFlow(query) {
    if (!isCatalogReady) {
      setStatus("Still loading cards. Please wait...");
      return;
    }

    const q = query.trim();
    lastQuery = q;
    const activeSet = getActiveSetFilter();

    const filtered = catalog.filter((card) => {
      const matchText = !q || cardFilterText(card).includes(q.toLowerCase());
      const matchSet = !activeSet || card.setId === activeSet;
      return matchText && matchSet;
    });

    const sorted = sortCards(filtered);
    if (isGroupBySet()) {
      activeCards = [...sorted];
      renderedCardCount = sorted.length;
      renderGroupedBySet(sorted);
      updateCatalogCount(sorted.length, sorted.length);
    } else {
      renderSearchResults(sorted);
      updateCatalogCount(renderedCardCount, sorted.length);
    }

    const parts = [];
    if (q) parts.push(`text "${q}"`);
    if (activeSet && setFilterEl) {
      const label = setFilterEl.options[setFilterEl.selectedIndex]?.text || activeSet;
      parts.push(`set "${label}"`);
    }
    parts.push(`${currentSortField()} ${currentSortDirection()}`);
    if (isGroupBySet()) parts.push("grouped by sets");
    setStatus(`Filtering local catalog${parts.length ? ` by ${parts.join(" + ")}` : ""}.`);

    if (isGroupBySet()) {
      hydrateVisiblePrices(sorted, q, activeSet).catch(() => {
        // Best-effort hydration only.
      });
    }
  }

  function debounceSearch() {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
      runSearchFlow(searchInput ? searchInput.value : "");
    }, 250);
  }

  function wireEvents() {
    if (searchInput) {
      searchInput.addEventListener("input", debounceSearch);
    }

    if (setFilterEl) {
      setFilterEl.addEventListener("change", () => {
        runSearchFlow(searchInput ? searchInput.value : "");
      });
    }

    if (sortFieldEl) {
      sortFieldEl.addEventListener("change", () => {
        runSearchFlow(searchInput ? searchInput.value : "");
      });
    }

    if (sortDirectionEl) {
      sortDirectionEl.addEventListener("change", () => {
        runSearchFlow(searchInput ? searchInput.value : "");
      });
    }

    if (groupBySetEl) {
      groupBySetEl.addEventListener("change", () => {
        runSearchFlow(searchInput ? searchInput.value : "");
      });
    }

    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        if (searchInput) searchInput.value = "";
        if (setFilterEl) setFilterEl.value = "";
        if (sortFieldEl) sortFieldEl.value = "name";
        if (sortDirectionEl) sortDirectionEl.value = "asc";
        if (groupBySetEl) groupBySetEl.checked = false;
        runSearchFlow("");
        setStatus("Filter cleared.");
        if (searchInput) searchInput.focus();
      });
    }

    if (openCartBtn) {
      openCartBtn.addEventListener("click", () => {
        setCartOpen(true);
      });
    }

    if (closeCartBtn) {
      closeCartBtn.addEventListener("click", () => {
        setCartOpen(false);
      });
    }

    if (cartOverlayEl) {
      cartOverlayEl.addEventListener("click", () => {
        setCartOpen(false);
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setCartOpen(false);
      }
    });

    if (resetBasketBtn) {
      resetBasketBtn.addEventListener("click", () => {
        basket.clear();
        renderBasket();
        setStatus("Basket reset.");
      });
    }

    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        const rows = basketRows();
        if (!rows.length) {
          setStatus("Add at least one card first.");
          return;
        }
        setStatus("POC payload generated. Ready to send to Shopify cart/note endpoint.");
      });
    }

    if (sendOfferEmailBtn) {
      sendOfferEmailBtn.addEventListener("click", () => {
        const rows = basketRows();
        if (!rows.length) {
          setStatus("Add at least one card first.");
          return;
        }

        const vendorEmail = getVendorEmail();
        const sellerName = sellerNameEl ? sellerNameEl.value.trim() : "";
        const sellerEmail = sellerEmailEl ? sellerEmailEl.value.trim() : "";
        const specification = offerSpecEl ? offerSpecEl.value.trim() : "";

        const lines = rows.map((row, index) => {
          return [
            `${index + 1}. ${row.name}`,
            `   Qty: ${row.quantity}`,
            `   Set: ${row.setName || "n/a"}`,
            `   Card No: ${row.localId || "n/a"}`,
            `   Dex: ${row.dexNumber || "n/a"}`,
            `   Card ID: ${row.cardId}`,
            `   Market: ${fmtEUR.format(row.market)}`,
            `   Offer each (85%): ${fmtEUR.format(row.offer)}`,
            `   Offer subtotal: ${fmtEUR.format(row.subtotalOffer)}`
          ].join("\n");
        });

        const totalMarket = rows.reduce((sum, row) => sum + row.market * row.quantity, 0);
        const totalOffer = rows.reduce((sum, row) => sum + row.subtotalOffer, 0);
        const dateIso = new Date().toISOString();

        const subject = `Pokemon Buylist Offer - ${sellerName || "Seller"}`;
        const body = [
          "Hello,",
          "",
          "I would like to submit the following Pokemon cards for your buylist offer.",
          "",
          `Seller Name: ${sellerName || "not provided"}`,
          `Seller Email: ${sellerEmail || "not provided"}`,
          `Submitted At: ${dateIso}`,
          "",
          "Comprehensive Card List:",
          ...lines,
          "",
          `Estimated Market Total: ${fmtEUR.format(totalMarket)}`,
          `Requested Offer Total (85%): ${fmtEUR.format(totalOffer)}`,
          "",
          "Specification:",
          specification || "No additional specification provided.",
          "",
          "Thank you."
        ].join("\n");

        window.location.href = `mailto:${vendorEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        setStatus(`Draft email opened for ${vendorEmail}.`);
      });
    }
  }

  async function init() {
    wireEvents();
    setupInfiniteScroll();
    renderBasket();
    setCartOpen(false);
    setControlsDisabled(true);
    setStatus("Loading cards from TCGDex sets...");

    const loadedSets = await withRetry(() => loadSets(), 3, 400);
    const loadedCatalog = await withRetry(() => loadCatalogBySets(loadedSets), 2, 500);
    catalog = enrichCatalogWithSets(loadedCatalog, loadedSets);

    if (!catalog.length) {
      setStatus("Could not load cards from TCGDex.");
      updateCatalogCount(0, 0);
      setControlsDisabled(false);
      return;
    }

    populateSetFilterOptions(catalog, loadedSets);
    isCatalogReady = true;
    setControlsDisabled(false);
    runSearchFlow("");
    setStatus(`Cards loaded (${catalog.length}). Search now filters locally without extra API calls.`);
  }

  init();
})();
