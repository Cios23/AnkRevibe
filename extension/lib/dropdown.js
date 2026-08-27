// Driving Poshmark's category picker.
//
// CONFIRMED STRUCTURE (live screenshot): it is a single nested text list,
// not three independent dropdowns. Opening it shows departments (Women, Men,
// Girls, Boys...); clicking one REPLACES the list with that department's
// categories (Bags, Dresses, Accessories...); clicking a category replaces it
// again with subcategories (Belts, Hair Accessories...). Every level is plain
// clickable text rows.
//
// Two consequences drive this file:
//
//   1. The panel is opened ONCE and then navigated. An earlier version here
//      opened a separate container per tier, which cannot work against a
//      list that drills down in place.
//   2. Between levels the list re-renders, so the next match must wait for
//      the options to actually CHANGE. Matching immediately would read the
//      stale list and, since department and category names can repeat
//      ("Accessories" appears under several departments), could click the
//      wrong row while looking correct.
//
// The tree itself is never hardcoded. Whatever path lib/crosslist computes
// is what gets navigated.
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
   * A "contains" match is accepted ONLY when exactly one option contains the
   * text. With two candidates there is no way to tell which was meant, and
   * picking either silently files the listing under a category nobody chose.
   */
  function chooseOption(optionTexts, wanted) {
    const target = normalise(wanted);
    if (!target) return { index: -1, reason: "no-target" };

    const options = optionTexts.map(normalise);

    const exact = options.indexOf(target);
    if (exact >= 0) return { index: exact, reason: "exact" };

    // Our table says "Tees - Short Sleeve"; the live row may punctuate or
    // space it differently.
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
      candidates: optionTexts.slice(0, 30),
    };
  }

  /**
   * The clickable text rows currently showing.
   *
   * Deliberately broad: the rows are plain text, so rather than guess one
   * class name this collects likely row elements and keeps those that have
   * their own short text and no nested row inside them - which is what a
   * leaf row looks like regardless of markup.
   */
  function visibleRows(root) {
    const scope = root && root.isConnected ? root : document;
    const candidates = Array.from(
      scope.querySelectorAll(
        'li, [role="option"], [role="menuitem"], button, a, div, span'
      )
    );

    const rows = [];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      // A category row is a short label, not a paragraph or a container
      // holding the whole list.
      if (!text || text.length > 60) continue;
      // Skip anything that merely wraps another row with identical text.
      const child = Array.from(el.children).find(
        (c) => (c.textContent || "").trim() === text
      );
      if (child) continue;
      rows.push({ el, text });
    }

    // De-duplicate by text, keeping the innermost occurrence.
    const seen = new Set();
    return rows.filter((r) => {
      const key = normalise(r.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Cheap fingerprint of the currently visible rows. */
  function rowSignature(rows) {
    return rows.map((r) => normalise(r.text)).join("|");
  }

  /**
   * Wait until the visible rows differ from `previous`.
   *
   * This is the step that makes nested navigation safe. Without it the next
   * level is matched against the list that is still on screen, and since
   * names repeat across departments ("Accessories" under Women and Men),
   * a stale match can click a plausible-looking wrong row.
   */
  async function waitForRowsToChange(root, previous, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await wait(120);
      const rows = visibleRows(root);
      if (rows.length && rowSignature(rows) !== previous) return rows;
    }
    return null;
  }

  /**
   * Navigate a nested category list: open once, then click each level.
   *
   * Returns a per-level trace, and on failure reports the rows the list was
   * actually offering - which is what turns a wrong name in our mapping
   * table into a one-line fix rather than a mystery.
   */
  async function selectNestedPath(container, path, options = {}) {
    const openDelay = options.openDelay ?? 700;
    const settleDelay = options.settleDelay ?? 500;

    if (!container) return { ok: false, reason: "no-container" };
    if (!Array.isArray(path) || path.length === 0) {
      return { ok: false, reason: "no-path" };
    }

    // Open the picker. The trigger is usually the container itself.
    const trigger =
      container.querySelector(
        'input, [role="combobox"], [role="button"], button'
      ) || container;
    trigger.click();
    await wait(openDelay);

    const trace = [];

    for (let level = 0; level < path.length; level++) {
      const wanted = path[level];
      if (wanted == null) continue;

      let rows = visibleRows(container);
      if (!rows.length) {
        // Some builds render the panel in a portal outside the container.
        rows = visibleRows(document);
      }

      if (!rows.length) {
        return { ok: false, reason: "no-rows", level, wanted, trace };
      }

      const before = rowSignature(rows);
      const choice = chooseOption(
        rows.map((r) => r.text),
        wanted,
      );

      if (choice.index < 0) {
        return {
          ok: false,
          reason: choice.reason,
          level,
          wanted,
          offered: choice.candidates ?? rows.map((r) => r.text).slice(0, 30),
          trace,
        };
      }

      rows[choice.index].el.click();
      trace.push({ level, wanted, matched: rows[choice.index].text, how: choice.reason });

      // The last click makes the selection; there is no next list to wait
      // for, and the panel usually closes.
      if (level === path.length - 1) {
        await wait(settleDelay);
        break;
      }

      const next = await waitForRowsToChange(container, before);
      if (!next) {
        return {
          ok: false,
          reason: "list-did-not-advance",
          level,
          wanted,
          matched: trace[trace.length - 1].matched,
          trace,
        };
      }
    }

    return { ok: true, trace };
  }

  globalThis.AnkDropdown = {
    chooseOption,
    visibleRows,
    rowSignature,
    selectNestedPath,
  };
})();
