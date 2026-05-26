(() => {
  const CONDITION_PROFILES = {
    near_mint: {
      label: "Near Mint",
      valuePct: 1,
      cashPctOfValue: 0.75,
      creditPctOfValue: 0.9,
      defects: "None"
    },
    excellent: {
      label: "Excellent",
      valuePct: 0.75,
      cashPctOfValue: 0.56,
      creditPctOfValue: 0.68,
      defects: "Whitening and scratches"
    },
    good: {
      label: "Good",
      valuePct: 0.5,
      cashPctOfValue: 0.38,
      creditPctOfValue: 0.45,
      defects: "Multiple spots of whitening and scratches"
    },
    poor: {
      label: "Poor",
      valuePct: 0.1,
      cashPctOfValue: 0.08,
      creditPctOfValue: 0.09,
      defects: "Bending, scratches, water damage, etc."
    }
  };

  function baseMarketValue(market) {
    if (!Number.isFinite(market) || market <= 0) return 0;
    return market;
  }

  function normalizeConditionKey(raw) {
    const key = String(raw || "near_mint").trim();
    return CONDITION_PROFILES[key] ? key : "near_mint";
  }

  function conditionLabel(conditionKey) {
    const key = normalizeConditionKey(conditionKey);
    return CONDITION_PROFILES[key]?.label || CONDITION_PROFILES.near_mint.label;
  }

  function conditionProfile(conditionKey) {
    const key = normalizeConditionKey(conditionKey);
    return CONDITION_PROFILES[key] || CONDITION_PROFILES.near_mint;
  }

  function conditionValuePrice(market, conditionKey) {
    const profile = conditionProfile(conditionKey);
    return baseMarketValue(market) * profile.valuePct;
  }

  function cashOfferByCondition(market, conditionKey) {
    const profile = conditionProfile(conditionKey);
    return conditionValuePrice(market, conditionKey) * profile.cashPctOfValue;
  }

  function storeCreditByCondition(market, conditionKey) {
    const profile = conditionProfile(conditionKey);
    return conditionValuePrice(market, conditionKey) * profile.creditPctOfValue;
  }

  function defectsForCondition(conditionKey) {
    return conditionProfile(conditionKey).defects;
  }

  window.BuylistPricing = {
    CONDITION_PROFILES,
    baseMarketValue,
    normalizeConditionKey,
    conditionLabel,
    conditionProfile,
    conditionValuePrice,
    cashOfferByCondition,
    storeCreditByCondition,
    defectsForCondition
  };
})();