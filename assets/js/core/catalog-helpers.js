(() => {
  const IGNORED_POCKET_SET_NAMES = new Set([
    "paradox drive",
    "pulsing aura",
    "mega shine",
    "paldean wonders",
    "fantastical parade",
    "crimson blaze",
    "mega rising",
    "deluxe pack ex",
    "secluded springs",
    "wisdom of sea and sky",
    "eevee grove",
    "extradimensional crisis",
    "celestial guardians",
    "shining revelry",
    "triumphant light",
    "space-time smackdown",
    "mythical island",
    "genetic apex",
    "promo-a",
    "promo-b"
  ]);

  function deriveSerieId(setId) {
    if (!setId) return "";
    const match = String(setId).toLowerCase().match(/^([a-z]+)/);
    return match ? match[1] : "";
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isIgnoredPocketText(value) {
    const text = normalizeText(value);
    return text.includes("pokemon trading card game pocket")
      || text.includes("trading card game pocket")
      || text.includes(" tcgp")
      || text.startsWith("tcgp")
      || text.includes("pocket");
  }

  function isIgnoredPocketSet(set) {
    const id = set?.id || "";
    const name = set?.name || "";
    const normalizedName = normalizeText(name);
    return isIgnoredPocketText(id)
      || isIgnoredPocketText(name)
      || IGNORED_POCKET_SET_NAMES.has(normalizedName);
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

  function buildImageCandidates(card, assetBase) {
    const candidates = [];

    const baseFromImage = toAssetBase(card?.image || "");
    const setId = card?.setId || card?.set?.id || "";
    const localId = card?.localId || card?.number || "";
    const serieId = deriveSerieId(setId);
    const computedBase = serieId && setId && localId
      ? `${assetBase}/${serieId}/${setId}/${encodeURIComponent(localId)}`
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

  function buildAssetImage(card, assetBase) {
    const candidates = buildImageCandidates(card, assetBase);
    return candidates[0] || toFastImageFromBase(card?.image || "");
  }

  function isDigitalOnlyCard(card) {
    const setName = normalizeText(card?.set?.name || card?.setName || "");
    const setId = normalizeText(card?.set?.id || card?.setId || "");
    const cardId = normalizeText(card?.id || "");
    const category = normalizeText(card?.category || "");
    const pocketSignals = [setName, setId, cardId, category].join(" ");
    return pocketSignals.includes("pocket")
      || pocketSignals.includes("tcgp")
      || IGNORED_POCKET_SET_NAMES.has(setName);
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

  window.BuylistCatalogHelpers = {
    IGNORED_POCKET_SET_NAMES,
    deriveSerieId,
    normalizeText,
    isIgnoredPocketText,
    isIgnoredPocketSet,
    toFastImageFromBase,
    toAssetBase,
    buildImageCandidates,
    buildAssetImage,
    isDigitalOnlyCard,
    extractMarketPrice,
    extractPricingUnit
  };
})();