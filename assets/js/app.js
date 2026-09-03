(() => {
  const API_BASE = "https://api.tcgdex.net/v2/en";
  const ASSET_BASE = "https://assets.tcgdex.net/en";
  const DEFAULT_VENDOR_EMAIL = "vendor@example.com";
  const PHOTO_THRESHOLD_EUR = 5;
  const catalogHelpers = window.BuylistCatalogHelpers || {};
  const pricingHelpers = window.BuylistPricing || {};
  const basketUiHelpers = window.BuylistBasketUI || {};

  const {
    deriveSerieId,
    normalizeText,
    isIgnoredPocketSet,
    toAssetBase,
    buildImageCandidates,
    buildAssetImage,
    isDigitalOnlyCard,
    extractMarketPrice,
    extractPricingUnit
  } = catalogHelpers;

  const {
    CONDITION_PROFILES,
    normalizeConditionKey,
    conditionLabel,
    conditionValuePrice,
    cashOfferByCondition,
    storeCreditByCondition,
    defectsForCondition
  } = pricingHelpers;

  const {
    createBasketItemElement
  } = basketUiHelpers;

  if (!CONDITION_PROFILES || !normalizeText || !buildImageCandidates || !createBasketItemElement) {
    throw new Error("Missing buylist helper scripts. Ensure core and ui helper scripts are loaded before app.js.");
  }
  const CATALOG_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
  const SETS_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
  const CARD_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
  const PAGE_SIZE = 60;
  const HYDRATE_LIMIT = 60;

  const rootEl = document.querySelector("[data-buylist-root]");
  const searchInput = document.getElementById("card-search");
  const setFilterEl = document.getElementById("set-filter");
  const sortFieldEl = document.getElementById("sort-field");
  const sortDirectionEl = document.getElementById("sort-direction");
  const groupBySetEl = document.getElementById("group-by-set");
  const sortRowEl = document.getElementById("card-sort-row");
  const clearSearchBtn = document.getElementById("clear-search");
  const changeSetBtn = document.getElementById("change-set");
  const openCartBtn = document.getElementById("open-cart");
  const closeCartBtn = document.getElementById("close-cart");
  const cartDrawerEl = document.getElementById("cart-drawer");
  const cartOverlayEl = document.getElementById("cart-overlay");
  const quickOfferEl = document.getElementById("quick-offer");
  const statusEl = document.getElementById("search-status");
  const loadingVisualEl = document.getElementById("loading-visual");
  const loadingLabelEl = document.getElementById("loading-label");
  const loadingPercentEl = document.getElementById("loading-percent");
  const loadingBarEl = document.getElementById("loading-bar");
  const catalogCountEl = document.getElementById("catalog-count");
  const resultsEl = document.getElementById("search-results");
  const resultsSentinelEl = document.getElementById("results-sentinel");
  const basketEl = document.getElementById("basket-items");
  const sumMarketEl = document.getElementById("sum-market");
  const sumValueEl = document.getElementById("sum-value");
  const sumCashEl = document.getElementById("sum-cash");
  const sumCreditEl = document.getElementById("sum-credit");
  const resetBasketBtn = document.getElementById("reset-basket");
  const sendOfferEmailBtn = document.getElementById("send-offer-email");
  const generatePdfReportBtn = document.getElementById("generate-pdf-report");
  const sellerNameEl = document.getElementById("seller-name");
  const sellerEmailEl = document.getElementById("seller-email");
  const photoRequirementNoteEl = document.getElementById("photo-requirement-note");
  const offerSpecEl = document.getElementById("offer-spec");
  const vendorEmailNoteEl = document.getElementById("vendor-email-note");
  const setGridEl = document.getElementById("set-grid");
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
  let currentRenderToken = 0;
  let loadedSetId = "";
  let allSets = [];
  let conditionModalEl = null;
  let conditionModalRows = new Map();
  let conditionModalDefectsEl = null;
  let statusToastEl = null;
  let statusToastTimer = null;

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

  function ensureStatusToast() {
    if (statusToastEl) return statusToastEl;

    const toast = document.createElement("div");
    toast.className = "status-toast hidden";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("aria-atomic", "true");
    document.body.appendChild(toast);

    statusToastEl = toast;
    return statusToastEl;
  }

  function showStatusToast(message) {
    const text = String(message || "").trim();
    if (!text) return;

    const toast = ensureStatusToast();
    toast.textContent = text;
    toast.classList.remove("hidden");
    toast.classList.add("visible");

    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
    }

    statusToastTimer = setTimeout(() => {
      toast.classList.remove("visible");
      toast.classList.add("hidden");
    }, 2600);
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
    showStatusToast(text);

    if (statusEl) {
      statusEl.textContent = "";
    }

    if (isCatalogReady) {
      setLoadingVisual(false, "", 100);
    }
  }

  function setLoadingVisual(isActive, label = "", progress = 0) {
    if (!loadingVisualEl) return;

    loadingVisualEl.classList.toggle("hidden", !isActive);
    loadingVisualEl.setAttribute("aria-busy", isActive ? "true" : "false");

    if (resultsEl) {
      resultsEl.classList.toggle("loading-active", isActive);
    }

    const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));

    if (loadingLabelEl && label) {
      loadingLabelEl.textContent = label;
    }
    if (loadingPercentEl) {
      loadingPercentEl.textContent = `${normalizedProgress}%`;
    }
    if (loadingBarEl) {
      loadingBarEl.style.width = `${normalizedProgress}%`;
      const track = loadingBarEl.parentElement;
      if (track) {
        track.setAttribute("aria-valuenow", String(normalizedProgress));
      }
    }
  }

  function ensureConditionMatrixModal() {
    if (conditionModalEl) return conditionModalEl;

    const overlay = document.createElement("div");
    overlay.className = "condition-modal-overlay hidden";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");

    const dialog = document.createElement("div");
    dialog.className = "condition-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Card condition matrix");

    const head = document.createElement("div");
    head.className = "condition-modal-head";

    const title = document.createElement("h3");
    title.textContent = "Condition Value Matrix";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ghost condition-modal-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeConditionMatrixModal();
    });

    head.append(title, closeBtn);

    const tableWrap = document.createElement("div");
    tableWrap.className = "condition-modal-table-wrap";

    const table = document.createElement("table");
    table.className = "condition-modal-table";

    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Card State</th><th>% Value</th><th>Cash</th><th>Store Credit</th><th>Defects</th></tr>";

    const tbody = document.createElement("tbody");
    for (const [key, profile] of Object.entries(CONDITION_PROFILES)) {
      const tr = document.createElement("tr");
      tr.dataset.condition = key;
      tr.innerHTML = [
        `<td>${profile.label}</td>`,
        `<td>${Math.round(profile.valuePct * 100)}%</td>`,
        `<td>${Math.round(profile.valuePct * profile.cashPctOfValue * 100)}%</td>`,
        `<td>${Math.round(profile.valuePct * profile.creditPctOfValue * 100)}%</td>`,
        `<td>${profile.defects}</td>`
      ].join("");
      conditionModalRows.set(key, tr);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    tableWrap.appendChild(table);

    conditionModalDefectsEl = document.createElement("p");
    conditionModalDefectsEl.className = "condition-modal-focus";

    dialog.append(head, tableWrap, conditionModalDefectsEl);
    overlay.appendChild(dialog);

    dialog.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeConditionMatrixModal();
      }
    });

    document.body.appendChild(overlay);
    conditionModalEl = overlay;
    return conditionModalEl;
  }

  function openConditionMatrixModal(conditionKey) {
    const normalized = normalizeConditionKey(conditionKey);
    const modal = ensureConditionMatrixModal();

    for (const [key, row] of conditionModalRows.entries()) {
      row.classList.toggle("active", key === normalized);
    }

    if (conditionModalDefectsEl) {
      conditionModalDefectsEl.textContent = `${conditionLabel(normalized)} defects: ${defectsForCondition(normalized)}`;
    }

    modal.hidden = false;
    modal.classList.remove("hidden");
    modal.style.display = "grid";
    modal.setAttribute("aria-hidden", "false");
  }

  function closeConditionMatrixModal() {
    if (!conditionModalEl) return;
    conditionModalEl.hidden = true;
    conditionModalEl.classList.add("hidden");
    conditionModalEl.style.display = "none";
    conditionModalEl.setAttribute("aria-hidden", "true");
  }

  function isConditionMatrixModalOpen() {
    return Boolean(conditionModalEl && !conditionModalEl.classList.contains("hidden"));
  }

  function getVendorEmail() {
    const fromData = rootEl ? String(rootEl.getAttribute("data-vendor-email") || "").trim() : "";
    return fromData || DEFAULT_VENDOR_EMAIL;
  }

  function keySets() {
    return "tcgdex:sets:v1";
  }

  function keySetCards(setId) {
    return `tcgdex:set:${String(setId || "").trim().toLowerCase()}:cards:v1`;
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

  function initialsFromSetName(name) {
    const words = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (!words.length) return "PK";
    return words.map((word) => word[0]?.toUpperCase() || "").join("") || "PK";
  }

  function buildSetSymbolCandidates(setItem) {
    const candidates = [];
    const setId = setItem?.id || "";
    const serieId = deriveSerieId(setId);

    function addAssetVariants(src) {
      if (!src) return;

      const trimmed = String(src).trim();
      if (!trimmed) return;

      const isFileWithExtension = /\.(png|webp|jpg|jpeg|svg)(\?.*)?$/i.test(trimmed);
      if (isFileWithExtension) {
        candidates.push(trimmed);
        return;
      }

      candidates.push(`${trimmed}.png`);
      candidates.push(`${trimmed}.webp`);
      candidates.push(`${trimmed}.jpg`);
      candidates.push(`${trimmed}/logo.png`);
      candidates.push(`${trimmed}/logo.webp`);
      candidates.push(`${trimmed}/symbol.png`);
      candidates.push(`${trimmed}/symbol.webp`);
    }

    const fromApi = [setItem?.symbol, setItem?.logo].filter(Boolean);
    for (const src of fromApi) {
      addAssetVariants(src);
    }

    if (serieId && setId) {
      const root = `${ASSET_BASE}/${serieId}/${setId}`;
      addAssetVariants(`${root}/symbol`);
      addAssetVariants(`${root}/logo`);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  function bindSetSymbolWithFallback(imageEl, setItem, fallbackEl) {
    if (!imageEl) return;

    const candidates = buildSetSymbolCandidates(setItem);
    if (!candidates.length) {
      imageEl.classList.add("hidden");
      if (fallbackEl) {
        fallbackEl.textContent = initialsFromSetName(setItem?.name || setItem?.id);
        fallbackEl.classList.remove("hidden");
      }
      return;
    }

    let index = 0;
    imageEl.alt = `${setItem?.name || setItem?.id || "Set"} symbol`;
    imageEl.referrerPolicy = "no-referrer";
    imageEl.onerror = () => {
      index += 1;
      if (index < candidates.length) {
        imageEl.src = candidates[index];
      } else {
        imageEl.classList.add("hidden");
        if (fallbackEl) {
          fallbackEl.textContent = initialsFromSetName(setItem?.name || setItem?.id);
          fallbackEl.classList.remove("hidden");
        }
      }
    };
    imageEl.onload = () => {
      imageEl.classList.remove("hidden");
      if (fallbackEl) {
        fallbackEl.classList.add("hidden");
      }
    };
    imageEl.src = candidates[0];
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
      imageCandidates: buildImageCandidates({ ...card, setId, setName }, ASSET_BASE),
      image: buildAssetImage({ ...card, setId, setName }, ASSET_BASE),
      rarity: card.rarity || "",
      market,
      priceResolved: Number.isFinite(market) && market > 0,
      unit: extractPricingUnit(card)
    };
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
        name: set.name || set.id || "",
        symbol: set.symbol || set.images?.symbol || "",
        logo: set.logo || set.images?.logo || ""
      }))
      .filter((set) => !isIgnoredPocketSet(set))
      .filter((set) => set.id && set.name)
      .sort((a, b) => a.name.localeCompare(b.name));
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

  async function loadCardsForSet(setId, setName = "") {
    const safeSetId = String(setId || "").trim();
    if (!safeSetId) return [];

    const storageKey = keySetCards(safeSetId);
    const storageHit = cacheRead(storageKey, CATALOG_CACHE_TTL_MS);
    if (storageHit && storageHit.length) {
      return storageHit;
    }

    const setPayload = await dedupedFetch(`${API_BASE}/sets/${encodeURIComponent(safeSetId)}`);
    const cards = normalizeSetCardsPayload(setPayload, { id: safeSetId, name: setName || safeSetId });
    cacheWrite(storageKey, cards);
    return cards;
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
        imageCandidates: buildImageCandidates(json, ASSET_BASE),
        image: buildAssetImage(json, ASSET_BASE),
        priceResolved: true,
        source: "tcgdex"
      };

      const sdkCard = typeof window.getTCGDXCard === "function" ? await window.getTCGDXCard(cardId) : null;
      if (sdkCard) {
        const sdkImageUrl = typeof sdkCard?.getImageURL === "function" ? sdkCard.getImageURL("low", "webp") : sdkCard?.image || "";

        detail.name = sdkCard?.name || detail.name;
        detail.set = sdkCard?.set || detail.set || {};
        detail.setId = sdkCard?.set?.id || detail.setId || detail.set?.id || "";
        detail.setName = sdkCard?.set?.name || detail.setName || detail.set?.name || "";
        detail.image = sdkImageUrl || detail.image;
        detail.imageCandidates = sdkImageUrl ? [sdkImageUrl] : detail.imageCandidates;
        detail.market = extractMarketPrice(sdkCard) || detail.market;
        detail.unit = extractPricingUnit(sdkCard) || detail.unit;
        detail.pricing = {
          ...(detail.pricing || {}),
          ...(sdkCard?.pricing || {})
        };
        detail.source = "tcgdex-sdk";
      }

      cardCache.set(cardId, { ts: now(), value: detail });
      cacheWrite(storageKey, detail);
      return detail;
    } catch {
      return null;
    }
  }

  function getRowPhotoFiles(row) {
    const existing = basket.get(row.cardId);
    return Array.isArray(existing?.photos) ? existing.photos : [];
  }

  function getPhotoRequiredRows(rows) {
    return rows.filter((row) => Number(row.market) >= PHOTO_THRESHOLD_EUR);
  }

  function hasRequiredPhotos(rows) {
    const requiredRows = getPhotoRequiredRows(rows);
    if (!requiredRows.length) return true;
    return requiredRows.every((row) => getRowPhotoFiles(row).length > 0);
  }

  function updatePhotoRequirementHint(rows) {
    if (!photoRequirementNoteEl) return;
    const requiredRows = getPhotoRequiredRows(rows);
    const requiredCount = requiredRows.length;
    const rowsWithPhotos = requiredRows.filter((row) => getRowPhotoFiles(row).length > 0).length;
    const missingRows = requiredCount - rowsWithPhotos;

    if (!requiredCount) {
      photoRequirementNoteEl.textContent = "No per-card photo upload required based on current card values.";
      return;
    }

    if (missingRows <= 0) {
      photoRequirementNoteEl.textContent = `All required photos are uploaded (${requiredCount}/${requiredCount} cards at ${fmtEUR.format(PHOTO_THRESHOLD_EUR)}+).`;
      return;
    }

    photoRequirementNoteEl.textContent = `${requiredCount} card(s) require photos (value >= ${fmtEUR.format(PHOTO_THRESHOLD_EUR)}). Missing photos on ${missingRows} card(s).`;
  }

  function openMailDraft(to, subject, lines) {
    const body = lines.join("\n");
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function cardMeta(card) {
    const parts = [];
    if (card.localId) parts.push(`#${card.localId}`);
    if (card.setName) parts.push(card.setName);
    return parts.join(" • ");
  }

  function setFilterText(card) {
    return normalizeText([
      card.name || "",
      card.setName || "",
      card.setId || "",
      card.localId || "",
      card.id || "",
      card.dexNumber || ""
    ].join(" "));
  }

  function getSearchValue() {
    return searchInput ? searchInput.value : "";
  }

  function clearCardResults() {
    activeCards = [];
    renderedCardCount = 0;
    if (resultsEl) {
      resultsEl.innerHTML = "";
    }
    updateCatalogCount(0, 0);
  }

  function setSearchText(setItem) {
    return normalizeText(`${setItem?.name || ""} ${setItem?.id || ""}`);
  }

  function renderSetGrid(query = "") {
    if (!setGridEl) return;

    const q = normalizeText(query);
    const activeSet = getActiveSetFilter();
    const sets = Array.isArray(allSets) ? allSets : [];
    const filteredSets = !q
      ? sets
      : sets.filter((setItem) => setSearchText(setItem).includes(q));

    setGridEl.innerHTML = "";

    if (!filteredSets.length) {
      const empty = document.createElement("p");
      empty.className = "set-grid-empty";
      empty.textContent = "No sets match your search.";
      setGridEl.appendChild(empty);
      updateCatalogCount(0, sets.length);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const setItem of filteredSets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "set-tile ghost";
      btn.dataset.setId = setItem.id;
      btn.setAttribute("aria-pressed", setItem.id === activeSet ? "true" : "false");
      if (setItem.id === activeSet) {
        btn.classList.add("active");
      }

      const media = document.createElement("span");
      media.className = "set-tile-media";

      const symbolImg = document.createElement("img");
      symbolImg.className = "set-tile-symbol hidden";

      const fallbackBadge = document.createElement("span");
      fallbackBadge.className = "set-tile-fallback hidden";

      bindSetSymbolWithFallback(symbolImg, setItem, fallbackBadge);
      media.append(symbolImg, fallbackBadge);

      const title = document.createElement("strong");
      title.textContent = setItem.name || setItem.id;

      const meta = document.createElement("small");
      meta.textContent = setItem.id;

      btn.append(media, title, meta);
      btn.addEventListener("click", async () => {
        if (setFilterEl) {
          setFilterEl.value = setItem.id;
        }
        await handleSetSelection(setItem.id);
      });
      fragment.appendChild(btn);
    }

    setGridEl.appendChild(fragment);
    updateCatalogCount(filteredSets.length, sets.length);
  }

  function updateStepView() {
    const hasSet = Boolean(getActiveSetFilter());

    if (setGridEl) {
      setGridEl.classList.toggle("hidden", hasSet);
    }
    if (resultsEl) {
      resultsEl.classList.toggle("hidden", !hasSet);
    }
    if (resultsSentinelEl) {
      resultsSentinelEl.classList.toggle("hidden", !hasSet);
    }
    if (changeSetBtn) {
      changeSetBtn.classList.toggle("hidden", !hasSet);
    }
    if (sortRowEl) {
      sortRowEl.classList.toggle("hidden", !hasSet);
    }
    if (searchInput) {
      searchInput.placeholder = hasSet
        ? "Search cards in selected set..."
        : "Search sets: Scarlet & Violet, Obsidian Flames, 151...";
    }
  }

  function cardDomKey(card) {
    return `${card.id || ""}|${card.setId || ""}|${card.localId || ""}`;
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
        offer.textContent = `Cash (Near Mint): ${fmtEUR.format(cashOfferByCondition(card.market, "near_mint"))}`;
      } else if (card.priceResolved) {
        market.textContent = "Market: no data";
        offer.textContent = "Cash: unavailable";
      } else {
        market.textContent = "Market: unavailable";
        offer.textContent = "Cash: pending value";
      }
    }

    if (addBtn) {
      addBtn.addEventListener("click", () => addCardToBasket(card));
    }

    if (root) {
      root.dataset.cardId = card.id;
      root.dataset.cardKey = cardDomKey(card);
    }
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

    hydrateVisiblePrices(nextCards, lastQuery, getActiveSetFilter(), currentRenderToken).catch(() => {
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

  function populateSetFilterOptions(sets) {
    if (!setFilterEl) return;

    const current = setFilterEl.value;
    const options = (Array.isArray(sets) ? sets : [])
      .map((set) => ({
        id: set.id,
        name: set.name || set.id,
        symbol: set.symbol || "",
        logo: set.logo || ""
      }))
      .filter((set) => set.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    allSets = options;

    setFilterEl.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a set first";
    setFilterEl.appendChild(placeholder);

    for (const optionData of options) {
      const option = document.createElement("option");
      option.value = optionData.id;
      option.textContent = optionData.name;
      setFilterEl.appendChild(option);
    }

    const validIds = new Set(options.map((option) => option.id));
    if (current && validIds.has(current)) {
      setFilterEl.value = current;
    } else {
      setFilterEl.value = "";
    }

    renderSetGrid(getSearchValue());
    updateStepView();
  }

  async function handleSetSelection(setId) {
    const activeSetId = String(setId || "").trim();

    if (!activeSetId) {
      loadedSetId = "";
      catalog = [];
      clearCardResults();
      renderSetGrid(getSearchValue());
      updateStepView();
      setStatus("Please choose a set to load cards.");
      return;
    }

    updateStepView();

    if (loadedSetId === activeSetId && catalog.length) {
      runSearchFlow(getSearchValue());
      return;
    }

    const setLabel = setFilterEl
      ? (setFilterEl.options[setFilterEl.selectedIndex]?.text || activeSetId)
      : activeSetId;

    setLoadingVisual(true, `Loading ${setLabel}...`, 25);
    setStatus(`Loading cards for ${setLabel}...`);

    try {
      const cards = await withRetry(() => loadCardsForSet(activeSetId, setLabel), 2, 400);
      catalog = cards;
      loadedSetId = activeSetId;

      if (!catalog.length) {
        clearCardResults();
        setStatus(`No cards found for ${setLabel}.`);
        setLoadingVisual(false, "", 100);
        return;
      }

      setLoadingVisual(false, "", 100);
      runSearchFlow(getSearchValue());
      renderSetGrid(getSearchValue());
      updateStepView();
      setStatus(`Loaded ${catalog.length} card(s) from ${setLabel}.`);
    } catch {
      catalog = [];
      clearCardResults();
      setLoadingVisual(false, "", 0);
      renderSetGrid(getSearchValue());
      updateStepView();
      setStatus(`Could not load cards for ${setLabel}. Please try another set.`);
    }
  }

  function bindImageWithFallback(imageEl, card, cardRoot) {
    if (!imageEl) return;

    const candidates = Array.isArray(card.imageCandidates) && card.imageCandidates.length
      ? card.imageCandidates
      : buildImageCandidates(card, ASSET_BASE);

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
      condition: normalizeConditionKey(row.condition),
      market: row.market,
      value: conditionValuePrice(row.market, row.condition),
      cash: cashOfferByCondition(row.market, row.condition),
      credit: storeCreditByCondition(row.market, row.condition),
      subtotalValue: conditionValuePrice(row.market, row.condition) * row.quantity,
      subtotalCash: cashOfferByCondition(row.market, row.condition) * row.quantity,
      subtotalCredit: storeCreditByCondition(row.market, row.condition) * row.quantity,
      photoFiles: Array.isArray(row.photos) ? row.photos : [],
      photoCount: Array.isArray(row.photos) ? row.photos.length : 0
    }));
  }

  function updateBasketRow(cardId, updater) {
    const existing = basket.get(cardId);
    if (!existing) return;
    updater(existing);
    renderBasket();
  }

  function renderBasket() {
    if (!basketEl || !sumMarketEl || !sumValueEl || !sumCashEl || !sumCreditEl) return;

    basketEl.innerHTML = "";

    const rows = basketRows();
    let marketTotal = 0;
    let valueTotal = 0;
    let cashTotal = 0;
    let creditTotal = 0;

    for (const row of rows) {
      marketTotal += row.market * row.quantity;
      valueTotal += row.subtotalValue;
      cashTotal += row.subtotalCash;
      creditTotal += row.subtotalCredit;

      const li = createBasketItemElement({
        row,
        fmtEUR,
        photoThreshold: PHOTO_THRESHOLD_EUR,
        conditionProfiles: CONDITION_PROFILES,
        normalizeConditionKey,
        openConditionMatrixModal,
        onUpdate: updateBasketRow,
        onRemove: (cardId) => {
          basket.delete(cardId);
          renderBasket();
        }
      });
      basketEl.appendChild(li);
    }

    sumMarketEl.textContent = fmtEUR.format(marketTotal);
    sumValueEl.textContent = fmtEUR.format(valueTotal);
    sumCashEl.textContent = fmtEUR.format(cashTotal);
    sumCreditEl.textContent = fmtEUR.format(creditTotal);

    if (openCartBtn) {
      const countText = `Basket (${basketItemCount()})`;
      const labelEl = openCartBtn.querySelector(".floating-cart-label");
      if (labelEl) {
        labelEl.textContent = countText;
      } else {
        openCartBtn.textContent = countText;
      }
    }
    if (quickOfferEl) {
      quickOfferEl.textContent = `Cash total: ${fmtEUR.format(cashTotal)}`;
    }

    if (vendorEmailNoteEl) {
      vendorEmailNoteEl.textContent = `CB email: ${getVendorEmail()}`;
    }

    updatePhotoRequirementHint(rows);
  }

  async function addCardToBasketNow(card) {
    setStatus(`Adding ${card.name}...`);

    let market = card.market;
    if (!Number.isFinite(market) || market <= 0) {
      const detail = await getCardDetails(card.id);
      market = detail?.market || 0;
      card.priceResolved = true;

      if (detail?.name) {
        card.name = detail.name;
      }
      if (detail?.setId || detail?.set?.id) {
        card.setId = detail.setId || detail.set?.id || card.setId;
      }
      if (detail?.setName || detail?.set?.name) {
        card.setName = detail.setName || detail.set?.name || card.setName;
      }
      if (detail?.localId || detail?.number) {
        card.localId = detail.localId || detail.number || card.localId;
      }
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
        condition: "near_mint",
        photos: [],
        quantity: 1,
        market
      });
    }

    renderBasket();
    setStatus(`${card.name} added at ${fmtEUR.format(cashOfferByCondition(market, "near_mint"))} cash each (Near Mint).`);
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

  async function hydrateVisiblePrices(cards, queryAtStart, setAtStart, renderTokenAtStart) {
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

        if (detail?.name) {
          card.name = detail.name;
        }
        if (detail?.setId || detail?.set?.id) {
          card.setId = detail.setId || detail.set?.id || card.setId;
        }
        if (detail?.setName || detail?.set?.name) {
          card.setName = detail.setName || detail.set?.name || card.setName;
        }
        if (detail?.localId || detail?.number) {
          card.localId = detail.localId || detail.number || card.localId;
        }
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

    if (
      currentRenderToken === renderTokenAtStart &&
      lastQuery === queryAtStart &&
      getActiveSetFilter() === setAtStart
    ) {
      const filtered = catalog.filter((card) => {
        const matchesText = !lastQuery || setFilterText(card).includes(lastQuery);
        const matchesSet = !setAtStart || card.setId === setAtStart;
        return matchesText && matchesSet;
      });

      const sorted = sortCards(filtered);
      if (isGroupBySet()) {
        renderGroupedBySet(sorted);
        updateCatalogCount(sorted.length, sorted.length);
      } else {
        for (const card of cards) {
          const key = cardDomKey(card);
          const nodes = resultsEl ? resultsEl.querySelectorAll(`[data-card-key="${key}"]`) : [];
          for (const node of nodes) {
            const titleEl = node.querySelector(".result-title");
            const metaEl = node.querySelector(".result-meta");
            const imageEl = node.querySelector(".result-image");
            const marketEl = node.querySelector(".market");
            const offerEl = node.querySelector(".offer");

            if (titleEl) {
              titleEl.textContent = card.name || titleEl.textContent;
            }
            if (metaEl) {
              metaEl.textContent = cardMeta(card);
            }
            if (imageEl) {
              bindImageWithFallback(imageEl, card, node);
            }
            if (!marketEl || !offerEl) continue;
            if (Number.isFinite(card.market) && card.market > 0) {
              marketEl.textContent = `Market: ${fmtEUR.format(card.market)}`;
              offerEl.textContent = `Cash (Near Mint): ${fmtEUR.format(cashOfferByCondition(card.market, "near_mint"))}`;
            }
          }
        }
      }
    }
  }

  function runSearchFlow(query) {
    if (!isCatalogReady) {
      setStatus("Cards are still loading. Please wait...");
      return;
    }

    const activeSet = getActiveSetFilter();
    if (!activeSet) {
      clearCardResults();
      renderSetGrid(query);
      updateStepView();
      return;
    }

    updateStepView();

    const q = String(query || "").trim();
    const qNormalized = normalizeText(q);
    const renderToken = ++currentRenderToken;
    lastQuery = qNormalized;

    const filtered = catalog.filter((card) => {
      const matchText = !qNormalized || setFilterText(card).includes(qNormalized);
      const matchSet = card.setId === activeSet;
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

    if (isGroupBySet()) {
      hydrateVisiblePrices(sorted, qNormalized, activeSet, renderToken).catch(() => {
        // Best-effort hydration only.
      });
    }
  }

  function debounceSearch() {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
      const value = getSearchValue();
      if (!getActiveSetFilter()) {
        renderSetGrid(value);
        return;
      }
      runSearchFlow(value);
    }, 250);
  }

  function runSearchFromInput() {
    runSearchFlow(getSearchValue());
  }

  function sellerContext() {
    return {
      vendorEmail: getVendorEmail(),
      sellerName: sellerNameEl ? sellerNameEl.value.trim() : "",
      sellerEmail: sellerEmailEl ? sellerEmailEl.value.trim() : "",
      specification: offerSpecEl ? offerSpecEl.value.trim() : "",
      submittedAt: new Date().toISOString()
    };
  }

  function escapeReportHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapePdfText(value) {
    return String(value || "")
      .replace(/€/g, "EUR ")
      .replace(/£/g, "GBP ")
      .replace(/\$/g, "USD ")
      .replace(/¥/g, "JPY ")
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "?")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/\u2028/g, " ")
      .replace(/\u2029/g, " ");
  }

  function triggerFileDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const href = document.createElement("a");
    href.href = url;
    href.download = filename;
    document.body.appendChild(href);
    href.click();
    href.remove();
    setTimeout(() => URL.revokeObjectURL(url), 50);
  }

  async function loadPdfLogo() {
    try {
      const response = await fetch("./assets/card-binder-logo.avif");
      const imageBlob = await response.blob();
      const imageUrl = URL.createObjectURL(imageBlob);
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      URL.revokeObjectURL(imageUrl);

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      const pixelData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      const alpha = new Uint8Array(canvas.width * canvas.height);
      for (let pixel = 0, color = 0, mask = 0; pixel < pixelData.length; pixel += 4) {
        rgb[color] = pixelData[pixel];
        rgb[color + 1] = pixelData[pixel + 1];
        rgb[color + 2] = pixelData[pixel + 2];
        alpha[mask] = pixelData[pixel + 3];
        color += 3;
        mask += 1;
      }
      return {
        rgb,
        alpha,
        width: canvas.width,
        height: canvas.height
      };
    } catch (error) {
      return null;
    }
  }

  function pdfStringToBytes(value) {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index) & 0xff;
    }
    return bytes;
  }

  function bytesToPdfString(bytes) {
    let value = "";
    const chunkSize = 8192;
    for (let start = 0; start < bytes.length; start += chunkSize) {
      value += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
    }
    return value;
  }

  function buildSimplePdf(rows, context, logo) {
    const pageWidth = 842;
    const pageHeight = 595;
    const marginX = 36;
    const marginRight = 36;
    const contentWidth = pageWidth - marginX - marginRight;
    const submittedDate = new Date(context.submittedAt || Date.now()).toLocaleString();
    const totals = {
      market: rows.reduce((sum, row) => sum + row.market * row.quantity, 0),
      value: rows.reduce((sum, row) => sum + row.subtotalValue, 0),
      cash: rows.reduce((sum, row) => sum + row.subtotalCash, 0),
      credit: rows.reduce((sum, row) => sum + row.subtotalCredit, 0)
    };
    const colors = {
      ink: "0.12 0.12 0.12",
      muted: "0.35 0.35 0.35",
      accent: "0.72 0.38 0.08",
      white: "1 1 1",
      header: "0.10 0.10 0.10",
      pale: "0.97 0.95 0.91",
      line: "0.78 0.75 0.69"
    };
    const pages = [];
    let commands = "";
    let y = pageHeight - 36;

    const text = (value, x, baseline, size = 8, font = "F1", color = colors.ink) => {
      commands += `${color} rg\nBT\n/${font} ${size} Tf\n${x} ${baseline} Td\n(${escapePdfText(value)}) Tj\nET\n`;
    };
    const wrapped = (value, maxChars) => {
      const words = String(value || "").split(/\s+/);
      const lines = [];
      let line = "";
      for (const word of words) {
        if ((line + " " + word).trim().length > maxChars && line) {
          lines.push(line);
          line = word;
        } else {
          line = (line + " " + word).trim();
        }
      }
      if (line) lines.push(line);
      return lines;
    };
    const rect = (x, top, width, height, fill, stroke = null) => {
      commands += `${fill} rg\n${x} ${top - height} ${width} ${height} re f\n`;
      if (stroke) {
        commands += `${stroke} RG\n${x} ${top - height} ${width} ${height} re S\n`;
      }
    };
    const line = (x1, y1, x2, y2, color = colors.line) => {
      commands += `${color} RG\n${x1} ${y1} m ${x2} ${y2} l S\n`;
    };
    const finishPage = () => {
      line(marginX, 28, pageWidth - marginRight, 28, colors.line);
      text("Card-Binder.com | Preliminary purchase report", marginX, 17, 6.5, "F1", colors.muted);
      pages.push(commands);
      commands = "";
    };
    const startPage = (pageNumber) => {
      y = pageHeight - 36;
      if (logo) {
        commands += `q\n128 0 0 22 ${marginX} ${y - 20} cm\n/Im1 Do\nQ\n`;
        text("PURCHASE AGREEMENT", marginX + 144, y - 15, 20, "F2", colors.ink);
      } else {
        text("CARD-BINDER.com", marginX, y, 10, "F2", colors.accent);
        text("PURCHASE AGREEMENT", marginX, y - 15, 20, "F2", colors.ink);
      }
      text(`Report ${pageNumber}`, pageWidth - 92, y - 2, 8, "F1", colors.muted);
      line(marginX, y - 25, pageWidth - marginRight, y - 25, colors.accent);
      y -= 42;
    };

    startPage(1);
    rect(marginX, y, contentWidth, 52, colors.pale, colors.line);
    text(`Seller: ${context.sellerName || "Not provided"}`, marginX + 12, y - 16, 9, "F2");
    text(`Email: ${context.sellerEmail || "Not provided"}`, marginX + 12, y - 31, 8, "F1", colors.muted);
    text(`Prepared: ${submittedDate}`, marginX + 350, y - 16, 9, "F2");
    text(`Vendor: ${context.vendorEmail || "Not provided"}`, marginX + 350, y - 31, 8, "F1", colors.muted);
    y -= 68;

    const columns = [
      ["#", 22], ["Card", 110], ["Set", 100], ["No.", 42], ["Condition", 58],
      ["Market", 48], ["Value", 48], ["Cash", 48], ["Credit", 48], ["Qty", 28],
      ["Value total", 58], ["Cash total", 58], ["Credit total", 58]
    ];
    const rowHeight = 28;
    const headerHeight = 25;
    const drawTableHeader = () => {
      rect(marginX, y, contentWidth, headerHeight, colors.accent);
      let x = marginX + 4;
      for (const [label, width] of columns) {
        text(label, x, y - 16, 6.5, "F2", "1 1 1");
        x += width;
      }
      y -= headerHeight;
    };
    const drawRow = (row, index) => {
      if (y < 94) {
        finishPage();
        startPage(pages.length + 1);
        drawTableHeader();
      }
      if (index % 2 === 0) rect(marginX, y, contentWidth, rowHeight, colors.pale);
      const values = [
        String(index + 1), row.name, row.setName || "n/a", row.localId || "n/a", conditionLabel(row.condition),
        fmtEUR.format(row.market), fmtEUR.format(row.value), fmtEUR.format(row.cash), fmtEUR.format(row.credit),
        String(row.quantity), fmtEUR.format(row.subtotalValue), fmtEUR.format(row.subtotalCash), fmtEUR.format(row.subtotalCredit)
      ];
      let x = marginX + 4;
      values.forEach((value, valueIndex) => {
        const width = columns[valueIndex][1];
        const valueLines = wrapped(value, Math.max(6, Math.floor(width / 4.3))).slice(0, 2);
        valueLines.forEach((valueLine, lineIndex) => text(valueLine, x, y - 11 - (lineIndex * 9), 6.2, "F1"));
        x += width;
      });
      line(marginX, y - rowHeight, pageWidth - marginRight, y - rowHeight);
      y -= rowHeight;
    };

    drawTableHeader();
    rows.forEach(drawRow);

    if (y < 190) {
      finishPage();
      startPage(pages.length + 1);
    }
    const totalsTop = y - 8;
    rect(marginX, totalsTop, 300, 88, colors.pale, colors.line);
    text("PAYOUT SUMMARY", marginX + 12, totalsTop - 18, 9, "F2", colors.accent);
    text(`Estimated market total: ${fmtEUR.format(totals.market)}`, marginX + 12, totalsTop - 35, 8, "F1");
    text(`Condition-adjusted value: ${fmtEUR.format(totals.value)}`, marginX + 12, totalsTop - 48, 8, "F1");
    text(`Cash payout: ${fmtEUR.format(totals.cash)}`, marginX + 12, totalsTop - 61, 8, "F2");
    text(`Store credit: ${fmtEUR.format(totals.credit)}`, marginX + 12, totalsTop - 74, 8, "F2");

    const legal = "This purchase report is a preliminary valuation and negotiation document only. The seller confirms that the cards listed are owned by the seller and that the listed conditions and photo evidence are accurate to the best of the seller's knowledge. Final acceptance, payout, and settlement remain subject to verification, inspection, and separate written agreement between both parties.";
    const legalLines = wrapped(legal, 145);
    let legalY = totalsTop - 18;
    legalLines.forEach((legalLine, index) => text(legalLine, marginX + 330, legalY - (index * 10), 7, "F1", colors.muted));
    const signatureTop = 112;
    text("SIGNATURES", marginX, signatureTop, 9, "F2", colors.accent);
    text("Seller signature", marginX, signatureTop - 18, 8, "F2");
    line(marginX, signatureTop - 27, marginX + 250, signatureTop - 27, colors.ink);
    text("Buyer / authorized representative", marginX + 330, signatureTop - 18, 8, "F2");
    line(marginX + 330, signatureTop - 27, pageWidth - marginRight, signatureTop - 27, colors.ink);
    text(`Specification notes: ${context.specification || "No additional specification provided."}`, marginX, signatureTop - 48, 7, "F1", colors.muted);
    finishPage();

    const fontObject = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    const boldFontObject = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
    const objects = [];
    const pageIds = [];
    const contentIds = [];
    const catalogId = 1;
    const pagesId = 2;
    objects.push(null, null);
    const fontId = objects.push(fontObject);
    const boldFontId = objects.push(boldFontObject);
    let imageId = null;
    let imageMaskId = null;
    if (logo) {
      imageMaskId = objects.length + 1;
      objects.push(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${logo.alpha.length} >>\nstream\n${bytesToPdfString(logo.alpha)}\nendstream`);
      imageId = objects.length + 1;
      objects.push(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${imageMaskId} 0 R /Length ${logo.rgb.length} >>\nstream\n${bytesToPdfString(logo.rgb)}\nendstream`);
    }
    pages.forEach((pageContent) => {
      contentIds.push(objects.length + 1);
      objects.push(`<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`);
      pageIds.push(objects.length + 1);
      objects.push(null);
    });
    const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`;
    pageIds.forEach((pageId, index) => {
      const imageResource = imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : "";
      objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >>${imageResource} >> /Contents ${contentIds[index]} 0 R >>`;
    });
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const byteXrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index < offsets.length; index += 1) {
      pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${byteXrefOffset}\n%%EOF`;
    return new Blob([pdfStringToBytes(pdf)], { type: "application/pdf" });
  }

  async function savePurchasePdf(rows, context) {
    const logo = await loadPdfLogo();
    const blob = buildSimplePdf(rows, context, logo);
    const fileName = `purchase-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.pdf`;
    triggerFileDownload(fileName, blob);
    window.__lastPurchasePdf = { fileName, size: blob.size };
  }

  function buildPrintableReportHtml(rows, context) {
    const totalMarket = rows.reduce((sum, row) => sum + row.market * row.quantity, 0);
    const totalValue = rows.reduce((sum, row) => sum + row.subtotalValue, 0);
    const totalCash = rows.reduce((sum, row) => sum + row.subtotalCash, 0);
    const totalCredit = rows.reduce((sum, row) => sum + row.subtotalCredit, 0);
    const submittedDate = new Date(context.submittedAt || Date.now()).toLocaleString();
    const lines = rows.map((row, index) => {
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeReportHtml(row.name)}</td>
          <td>${escapeReportHtml(row.setName || "n/a")}</td>
          <td>${escapeReportHtml(row.localId || "n/a")}</td>
          <td>${escapeReportHtml(conditionLabel(row.condition))}</td>
          <td>${fmtEUR.format(row.market)}</td>
          <td>${fmtEUR.format(row.value)}</td>
          <td>${fmtEUR.format(row.cash)}</td>
          <td>${fmtEUR.format(row.credit)}</td>
          <td>${row.quantity}</td>
          <td>${fmtEUR.format(row.subtotalValue)}</td>
          <td>${fmtEUR.format(row.subtotalCash)}</td>
          <td>${fmtEUR.format(row.subtotalCredit)}</td>
        </tr>`;
    }).join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Card Binder Purchase Agreement</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 24px;
      color: #1c1c1c;
      background: #ffffff;
    }
    .report {
      max-width: 1100px;
      margin: 0 auto;
      border: 1px solid #d5d5d5;
      padding: 28px;
      background: #fffdf9;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      border-bottom: 2px solid #b86d17;
      padding-bottom: 12px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 28px;
      color: #623300;
    }
    .subtitle {
      margin: 0;
      color: #666;
      font-size: 12px;
    }
    .doc-code {
      text-align: right;
      font-size: 12px;
      color: #444;
      line-height: 1.5;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 20px;
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #bcbcbc;
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f3f1ec;
    }
    .totals {
      margin-top: 16px;
      display: grid;
      gap: 6px;
      font-size: 13px;
      padding: 10px 0;
      border-top: 1px solid #e0d8ca;
    }
    .legal {
      margin-top: 18px;
      font-size: 11px;
      line-height: 1.6;
      color: #404040;
      border-top: 1px solid #e0d8ca;
      padding-top: 12px;
    }
    .signature-grid {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      font-size: 12px;
    }
    .signature-line {
      border-bottom: 1px solid #222;
      min-height: 24px;
      width: 100%;
      margin-top: 4px;
    }
    .notes {
      margin-top: 14px;
      font-size: 12px;
    }
    @page {
      size: A4 portrait;
      margin: 12mm;
    }
  </style>
</head>
<body>
  <div class="report">
    <div class="header-row">
      <div>
        <h1>Card Binder Purchase Agreement</h1>
        <p class="subtitle">Preliminary sale report and valuation sheet for trading cards.</p>
      </div>
      <div class="doc-code">
        <div><strong>Prepared:</strong> ${escapeReportHtml(submittedDate)}</div>
        <div><strong>Contact:</strong> ${escapeReportHtml(context.vendorEmail || "Not provided")}</div>
      </div>
    </div>

    <div class="meta">
      <div><strong>Seller / Customer Name:</strong> ${escapeReportHtml(context.sellerName || "Not provided")}</div>
      <div><strong>Seller / Customer Email:</strong> ${escapeReportHtml(context.sellerEmail || "Not provided")}</div>
      <div><strong>Buyer / Trade Desk:</strong> Card Binder Trade Desk</div>
      <div><strong>Reference:</strong> ${escapeReportHtml(context.vendorEmail || "Not provided")}</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Card</th>
          <th>Set</th>
          <th>Card No</th>
          <th>Condition</th>
          <th>Market</th>
          <th>Value</th>
          <th>Cash</th>
          <th>Credit</th>
          <th>Qty</th>
          <th>Value Total</th>
          <th>Cash Total</th>
          <th>Credit Total</th>
        </tr>
      </thead>
      <tbody>${lines}</tbody>
    </table>

    <div class="totals">
      <div><strong>Estimated market total:</strong> ${fmtEUR.format(totalMarket)}</div>
      <div><strong>Condition-adjusted value total:</strong> ${fmtEUR.format(totalValue)}</div>
      <div><strong>Cash payout total:</strong> ${fmtEUR.format(totalCash)}</div>
      <div><strong>Store credit payout total:</strong> ${fmtEUR.format(totalCredit)}</div>
    </div>

    <div class="legal">
      <strong>Legal / disclosure notice:</strong>
      This purchase report is a preliminary valuation and negotiation document only. The seller confirms that the cards listed in this report are owned by the seller, that the listed conditions and attached photo evidence are accurate to the best of the seller's knowledge, and that all information supplied is provided for review and pricing purposes only. No payment obligation, sale commitment, or transfer of ownership is created by this document unless and until the buyer confirms acceptance in writing. Final acceptance, payout, and settlement remain subject to verification, inspection, and separate written agreement between both parties.
    </div>

    <div class="signature-grid">
      <div>
        <strong>Seller signature</strong>
        <div class="signature-line"></div>
        <div class="notes">Printed name: ${escapeReportHtml(context.sellerName || "Not provided")}</div>
      </div>
      <div>
        <strong>Buyer / authorized representative</strong>
        <div class="signature-line"></div>
        <div class="notes">Printed name: Card Binder Trade Desk</div>
      </div>
    </div>

    <div class="legal">
      <strong>Additional terms:</strong>
      Any buyer request for additional inspection, photos, or authentication services will be handled separately. The report should be preserved with the transaction record. By signing below, the seller acknowledges the stated card condition, dispute process, and pricing summary as submitted for review.
    </div>

    <div class="notes"><strong>Specification notes:</strong> ${escapeReportHtml(context.specification || "No additional specification provided.")}</div>
  </div>
</body>
</html>`;
  }

  function formatRequestLines(rows) {
    return rows.map((row, index) => {
      return [
        `${index + 1}. ${row.name}`,
        `   Qty: ${row.quantity}`,
        `   Set: ${row.setName || "n/a"}`,
        `   Card No: ${row.localId || "n/a"}`,
        `   Condition: ${conditionLabel(row.condition)}`,
        `   Market each: ${fmtEUR.format(row.market)}`,
        `   Value each: ${fmtEUR.format(row.value)}`,
        `   Cash each: ${fmtEUR.format(row.cash)}`,
        `   Store credit each: ${fmtEUR.format(row.credit)}`,
        `   Photos attached: ${row.photoCount || 0}`,
        `   Value subtotal: ${fmtEUR.format(row.subtotalValue)}`,
        `   Cash subtotal: ${fmtEUR.format(row.subtotalCash)}`,
        `   Store credit subtotal: ${fmtEUR.format(row.subtotalCredit)}`
      ].join("\n");
    });
  }

  function wireEvents() {
    if (searchInput) {
      searchInput.addEventListener("input", debounceSearch);
    }

    if (setFilterEl) {
      setFilterEl.addEventListener("change", async () => {
        await handleSetSelection(setFilterEl.value);
      });
    }

    if (changeSetBtn) {
      changeSetBtn.addEventListener("click", async () => {
        if (setFilterEl) {
          setFilterEl.value = "";
        }
        if (searchInput) {
          searchInput.value = "";
        }
        await handleSetSelection("");
      });
    }

    if (sortFieldEl) {
      sortFieldEl.addEventListener("change", runSearchFromInput);
    }

    if (sortDirectionEl) {
      sortDirectionEl.addEventListener("change", runSearchFromInput);
    }

    if (groupBySetEl) {
      groupBySetEl.addEventListener("change", runSearchFromInput);
    }

    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        if (searchInput) searchInput.value = "";
        if (sortFieldEl) sortFieldEl.value = "name";
        if (sortDirectionEl) sortDirectionEl.value = "asc";
        if (groupBySetEl) groupBySetEl.checked = false;
        runSearchFromInput();
        setStatus("Filters cleared.");
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
        if (isConditionMatrixModalOpen()) {
          closeConditionMatrixModal();
          return;
        }
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

    if (generatePdfReportBtn) {
      generatePdfReportBtn.addEventListener("click", async () => {
        const rows = basketRows();
        if (!rows.length) {
          setStatus("Add at least one card first.");
          return;
        }

        if (!hasRequiredPhotos(rows)) {
          setStatus("Upload photos for cards worth €5+ before generating the PDF report.");
          return;
        }

        const context = sellerContext();
        generatePdfReportBtn.disabled = true;
        await savePurchasePdf(rows, context);
        generatePdfReportBtn.disabled = false;
        setStatus("PDF report downloaded.");
      });
    }

    if (sendOfferEmailBtn) {
      sendOfferEmailBtn.addEventListener("click", () => {
        const rows = basketRows();
        if (!rows.length) {
          setStatus("Add at least one card first.");
          return;
        }

        if (!hasRequiredPhotos(rows)) {
          setStatus("Upload photos for cards worth €5+ before sending the purchase request.");
          return;
        }

        const context = sellerContext();
        const lines = formatRequestLines(rows);
        const totalMarket = rows.reduce((sum, row) => sum + row.market * row.quantity, 0);
        const totalValue = rows.reduce((sum, row) => sum + row.subtotalValue, 0);
        const totalCash = rows.reduce((sum, row) => sum + row.subtotalCash, 0);
        const totalCredit = rows.reduce((sum, row) => sum + row.subtotalCredit, 0);
        const photoSummaryLines = getPhotoRequiredRows(rows).map((row) => {
          const files = getRowPhotoFiles(row);
          const names = files.map((file) => file.name);
          return `${row.name} (${row.setName || "n/a"} #${row.localId || "n/a"}): ${names.length ? names.join(", ") : "NO PHOTOS"}`;
        });

        const subject = `Pokemon Card Purchase Request - ${context.sellerName || "Customer"}`;
        const bodyLines = [
          "Hello CB,",
          "",
          "I would like to submit this purchase request for Pokemon cards.",
          "",
          `Customer name: ${context.sellerName || "not provided"}`,
          `Customer email: ${context.sellerEmail || "not provided"}`,
          `Submitted at: ${context.submittedAt}`,
          "",
          "Cards and submitted condition:",
          ...lines,
          "",
          `Estimated market total: ${fmtEUR.format(totalMarket)}`,
          `Condition-adjusted value total: ${fmtEUR.format(totalValue)}`,
          `Cash payout total: ${fmtEUR.format(totalCash)}`,
          `Store credit payout total: ${fmtEUR.format(totalCredit)}`,
          "",
          "Per-card photo upload (value >= €5):",
          photoSummaryLines.length ? photoSummaryLines.map((line) => `- ${line}`).join("\n") : "No cards require photos.",
          "",
          "Specification:",
          context.specification || "No additional specification provided.",
          "",
          "Next step: CB reviews values and sends a counter-offer.",
          ""
        ];

        openMailDraft(context.vendorEmail, subject, bodyLines);
        setStatus(`Purchase request draft opened for ${context.vendorEmail}.`);
      });
    }
  }

  async function init() {
    wireEvents();
    setupInfiniteScroll();
    renderBasket();
    setCartOpen(false);
    setControlsDisabled(true);
    setLoadingVisual(true, "Loading sets...", 10);

    const loadedSets = await withRetry(() => loadSets(), 3, 400);
    if (!loadedSets.length) {
      setLoadingVisual(false, "", 0);
      setStatus("Could not load sets from TCGDex.");
      updateCatalogCount(0, 0);
      setControlsDisabled(false);
      return;
    }

    populateSetFilterOptions(loadedSets);
    catalog = [];
    clearCardResults();
    isCatalogReady = true;
    setControlsDisabled(false);
    setLoadingVisual(false, "", 100);
    renderSetGrid("");
    updateStepView();
    setStatus("Choose a set to start browsing cards.");
  }

  init();
})();
