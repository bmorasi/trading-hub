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

  function median(values) {
    const sorted = values.map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // Market value in EUR, from Cardmarket only.
  // - The middle value of trend, 7-day and 30-day average, so one unusual sale or
  //   spike does not set the price. The all-time "avg" is used only if those are missing.
  // - Never "low" (the cheapest listing, whatever its state) and never TCGplayer (USD).
  // - The "-holo" figures price the foil version of a card that also has a normal one,
  //   so they are used only for cards that have no normal version.
  function extractMarketPrice(card) {
    const prices = card?.pricing?.cardmarket;
    if (!prices || (prices.unit && prices.unit !== "EUR")) return null;

    const fromSuffix = (suffix) => median([
      prices[`trend${suffix}`],
      prices[`avg7${suffix}`],
      prices[`avg30${suffix}`]
    ]) || median([prices[`avg${suffix}`]]);

    const price = fromSuffix("") || (card?.variants?.normal === false ? fromSuffix("-holo") : null);
    return price ? Math.round(price * 100) / 100 : null;
  }

  function extractPricingUnit() {
    return "EUR";
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