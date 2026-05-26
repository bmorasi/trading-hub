(() => {
  function createBasketItemElement(options) {
    const {
      row,
      fmtEUR,
      photoThreshold,
      conditionProfiles,
      normalizeConditionKey,
      openConditionMatrixModal,
      onUpdate,
      onRemove
    } = options;

    const li = document.createElement("li");
    li.className = "basket-item";

    const main = document.createElement("div");
    main.className = "basket-main";

    const meta = [row.setName, row.localId ? `#${row.localId}` : "", row.dexNumber ? `Dex ${row.dexNumber}` : ""]
      .filter(Boolean)
      .join(" • ");

    main.innerHTML = `<strong>${row.name}</strong><br><small>${meta}</small><br><small>Value: ${fmtEUR.format(row.value)} | Cash: ${fmtEUR.format(row.cash)} | Credit: ${fmtEUR.format(row.credit)}</small>`;

    if (Number(row.market) >= photoThreshold) {
      const photoRow = document.createElement("div");
      photoRow.className = "basket-photo-row";

      const photoInput = document.createElement("input");
      photoInput.type = "file";
      photoInput.accept = "image/*";
      photoInput.multiple = true;
      photoInput.className = "basket-photo-input";

      const photoBtn = document.createElement("button");
      photoBtn.type = "button";
      photoBtn.className = "ghost basket-photo-btn";
      photoBtn.textContent = row.photoCount > 0 ? `Update photos (${row.photoCount})` : "Upload photos (€5+)";
      photoBtn.addEventListener("click", () => {
        photoInput.click();
      });

      const photoMeta = document.createElement("small");
      photoMeta.className = "basket-photo-meta";
      if (row.photoCount > 0) {
        const names = row.photoFiles.slice(0, 2).map((file) => file.name).join(", ");
        const suffix = row.photoCount > 2 ? ` +${row.photoCount - 2} more` : "";
        photoMeta.textContent = `Attached: ${names}${suffix}`;
      } else {
        photoMeta.textContent = "Photo required for this card.";
      }

      photoInput.addEventListener("change", () => {
        onUpdate(row.cardId, (existing) => {
          existing.photos = photoInput.files ? [...photoInput.files] : [];
        });
      });

      photoRow.append(photoBtn, photoMeta, photoInput);
      main.appendChild(photoRow);
    }

    const conditionSelect = document.createElement("select");
    conditionSelect.className = "condition-select";
    for (const [key, profile] of Object.entries(conditionProfiles)) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${profile.label} (${Math.round(profile.valuePct * 100)}% value)`;
      conditionSelect.appendChild(option);
    }

    conditionSelect.value = row.condition;
    conditionSelect.addEventListener("change", () => {
      onUpdate(row.cardId, (existing) => {
        existing.condition = normalizeConditionKey(conditionSelect.value);
      });
    });

    const defectsHelpBtn = document.createElement("button");
    defectsHelpBtn.type = "button";
    defectsHelpBtn.className = "ghost defects-help-btn";
    defectsHelpBtn.textContent = "?";
    defectsHelpBtn.title = "Show defects guidance";
    defectsHelpBtn.addEventListener("click", () => {
      openConditionMatrixModal(conditionSelect.value);
    });

    const conditionCell = document.createElement("div");
    conditionCell.className = "condition-cell";
    conditionCell.append(conditionSelect, defectsHelpBtn);

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "1";
    qtyInput.value = String(row.quantity);
    qtyInput.className = "qty";
    qtyInput.addEventListener("input", () => {
      onUpdate(row.cardId, (existing) => {
        existing.quantity = Math.max(1, Number(qtyInput.value) || 1);
      });
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      onRemove(row.cardId);
    });

    li.append(main, conditionCell, qtyInput, remove);
    return li;
  }

  window.BuylistBasketUI = {
    createBasketItemElement
  };
})();