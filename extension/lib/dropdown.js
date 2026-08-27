// Driving a Vue-rendered custom dropdown.
//
// Poshmark's category selectors are NOT native <select> elements - they are
// Vue components rendering a list of divs. That matters: setNativeValue and
// the input/change events that work for text fields do nothing here, because
// there is no form control to set. The only way in is to click the thing
// open and click the option.
//
// Confirmed containers (observed, not guessed):
//   div.listing-editor__category-container.listing-editor__input--half.va--t
//   div.listing-editor__subcategory-container.listing-editor__input--half.va--t
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const normalise = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  /**
   * Pick the option matching `wanted`, in decreasing confidence.
   *
   * Exact first. A "contains" match is accepted ONLY when exactly one option
   * contains the text - with two candidates there is no way to tell which
   * was meant, and picking either would silently miscategorise the listing.
   */
  function chooseOption(optionTexts, wanted) {
    const target = normalise(wanted);
    if (!target) return { index: -1, reason: "no-target" };

    const options = optionTexts.map(normalise);

    const exact = options.indexOf(target);
    if (exact >= 0) return { index: exact, reason: "exact" };

    // Poshmark writes "Tees - Short Sleeve"; punctuation and spacing vary.
    const loose = (s) => s.replace(/[^a-z0-9]/g, "");
    const looseTarget = loose(target);
    const looseHits = [];
    options.forEach((o, i) => {
      if (loose(o) === looseTarget) looseHits.push(i);
    });
    if (looseHits.length === 1) return { index: looseHits[0], reason: "loose" };

    const containsHits = [];
    options.forEach((o, i) => {
      if (o.includes(target) || target.includes(o)) containsHits.push(i);
    });
    if (containsHits.length === 1) {
      return { index: containsHits[0], reason: "contains" };
    }

    return {
      index: -1,
      reason: containsHits.length > 1 ? "ambiguous" : "no-match",
      candidates: optionTexts.slice(0, 25),
    };
  }

  /** Option nodes inside an opened dropdown. */
  function optionNodes(container) {
    const selectors = [
      '[role="option"]',
      ".dropdown__menu__item",
      ".dropdown__selector__item",
      "li",
      ".listing-editor__option",
    ];
    for (const selector of selectors) {
      const found = Array.from(container.querySelectorAll(selector)).filter(
        isVisible
      );
      if (found.length) return found;
    }
    return [];
  }

  /**
   * Open a dropdown and select one option.
   *
   * Returns a result rather than throwing, and on failure reports what the
   * dropdown actually offered - which is what turns a wrong category name in
   * our mapping table into a one-line fix.
   */
  async function selectFromDropdown(container, wanted, options = {}) {
    const openDelay = options.openDelay ?? 700;
    const settleDelay = options.settleDelay ?? 600;

    if (!container) return { ok: false, reason: "no-container", wanted };

    const trigger =
      container.querySelector(
        'input, [role="combobox"], [role="button"], button, .dropdown__selector'
      ) || container;
    trigger.click();
    await wait(openDelay);

    let nodes = optionNodes(container);
    if (!nodes.length) {
      // Some builds render the menu in a portal outside the container.
      nodes = Array.from(
        document.querySelectorAll('[role="listbox"] [role="option"]')
      ).filter(isVisible);
    }

    if (!nodes.length) {
      return { ok: false, reason: "no-options", wanted };
    }

    const texts = nodes.map((n) => (n.textContent || "").trim());
    const choice = chooseOption(texts, wanted);

    if (choice.index < 0) {
      // Close the menu again so a failed step does not leave the form open
      // over the next field.
      trigger.click();
      return {
        ok: false,
        reason: choice.reason,
        wanted,
        offered: choice.candidates ?? texts.slice(0, 25),
      };
    }

    nodes[choice.index].click();
    await wait(settleDelay);
    return { ok: true, matched: texts[choice.index], how: choice.reason };
  }

  globalThis.AnkDropdown = {
    chooseOption,
    selectFromDropdown,
    optionNodes,
  };
})();
