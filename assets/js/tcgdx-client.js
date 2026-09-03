import TCGdex from "https://esm.sh/@tcgdex/sdk";

const tcgdex = new TCGdex("en");

async function getCard(cardId) {
  const id = String(cardId || "").trim();
  if (!id) return null;

  try {
    const card = await tcgdex.card.get(id);
    return card || null;
  } catch (error) {
    console.warn("TCGdex SDK card lookup failed:", error);
    return null;
  }
}

window.TCGDEX = tcgdex;
window.getTCGDXCard = getCard;
