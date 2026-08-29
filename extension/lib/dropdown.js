// Driving Poshmark's category picker.
//
// CONFIRMED STRUCTURE (live page): a single nested text list, not three
// independent dropdowns. Opening it shows departments (Women, Men, Girls,
// Boys...); clicking one REPLACES the list with that department's categories;
// clicking a category replaces it again with subcategories.
//
// CONFIRMED TRIGGER: the control is
//   <div aria-haspopup="true" tabindex="0" data-test="dropdown" class="dropdown d--b">
// - a div, not an input or a button. Clicking its wrapper does nothing at
// all, and a picker that never opened is indistinguishable from one with no
// options unless the driver says which element it clicked.
//
// CONFIRMED ROW SELECTOR: .dropdown__link.dropdown__menu__item
// The current selection is reflected in a `selectedvalue` attribute on the
// outer container and in the trigger's visible span text.
//
// Three things follow, and each was a bug before they were known:
//
//   1. The panel is opened ONCE and navigated. Opening a separate container
//      per tier cannot work against a list that drills down in place.
//   2. Between levels the list re-renders, so the next match must wait for
//      the rows to actually CHANGE. Names repeat across departments
//      ("Accessories" under both Women and Men), so matching a stale list
//      can click a plausible-looking wrong row.
//   3. Rows are matched by their real class, not by guessing across every
//      div and span. The generic guess also swept up "Select Category" -
//      the field's own closed-state label - and treated it as a department.
//
// The tree itself is never hardcoded: whatever path lib/crosslist computes
// is what gets navigated.
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The real row class. */
  const ROW_SELECTOR = ".dropdown__link.dropdown__menu__item";

  /**
   * Fallbacks, used only if the confirmed selector matches nothing - a class
   * rename should degrade rather than fail outright.
   */
  const ROW_FALLBACKS = [
    ".dropdown__menu__item",
    ".dropdown__link",
    '[role="option"]',
    '[role="menuitem"]',
  ];

  /**
   * What actually opens a picker, most specific first.
   *
   * Poshmark's category control is
   *   <div aria-haspopup="true" tabindex="0" data-test="dropdown" class="dropdown d--b">
   * which matches none of input / [role=combobox] / [role=button] / button.
   * The old lookup therefore found nothing, fell back to clicking the outer
   * container, and Vue - which listens on that inner div - ignored it. The
   * picker never opened, so the driver polled an empty document for eight
   * seconds and reported "no rows", which reads exactly like a dropdown with
   * no options. A click on the wrong element and a control with nothing in it
   * are indistinguishable from the outside; that is what made this expensive.
   *
   * Ordered by how much each selector actually tells us. data-test="dropdown"
   * is Poshmark's own hook for this control; aria-haspopup is the accessible
   * contract for "I own a popup" and is the right general answer for any
   * framework. The old four come last, unchanged, so nothing that worked
   * before stops working.
   *
   * Note this is priority order, not document order - the previous single
   * querySelector returned whichever matched first in the DOM regardless of
   * how specific it was.
   */
  const TRIGGER_SELECTORS = [
    '[data-test="dropdown"]',
    '[aria-haspopup="true"]',
    '[role="combobox"]',
    "input",
    '[role="button"]',
    "button",
    // Last resort: focusable, so at least it is meant to be interacted with.
    '[tabindex]:not([tabindex="-1"])',
  ];

  /**
   * The element to click to open `container`'s picker.
   *
   * Prefers a visible match, accepts an invisible one over giving up, and
   * reports which selector won so a failure says WHY rather than just that
   * nothing happened.
   */
  function findTrigger(container) {
    if (!container) return { el: null, how: "no-container", fellBack: true };

    for (const selector of TRIGGER_SELECTORS) {
      let matches = [];
      try {
        matches = Array.from(container.querySelectorAll(selector));
      } catch {
        continue;
      }
      // The container can be the control itself rather than its wrapper.
      try {
        if (container.matches && container.matches(selector)) matches.push(container);
      } catch {
        /* invalid selector for matches() */
      }
      if (!matches.length) continue;

      const visible = matches.find(isVisible);
      return {
        el: visible || matches[0],
        how: selector,
        fellBack: false,
        hidden: !visible,
      };
    }

    // Clicking the wrapper is what silently did nothing. Keep it as a last
    // resort, but flag it so the failure is legible.
    return { el: container, how: "container-fallback", fellBack: true };
  }

  /**
   * Rows that are navigation, not categories.
   *
   * "All Categories" is a reset/back affordance; selecting it would clear the
   * field rather than choose anything.
   */
  const EXCLUDED_ROWS = [/^all categories$/i, /^select category$/i];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** Collapse internal whitespace and trim - rows carry newlines and padding. */
  const cleanText = (el) =>
    String(el && el.textContent ? el.textContent : "")
      .replace(/\s+/g, " ")
      .trim();

  const normalise = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  const isExcluded = (text) => EXCLUDED_ROWS.some((re) => re.test(text.trim()));

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

  /** The category rows currently on screen, in order. */
  function visibleRows(root) {
    const scope = root && root.isConnected ? root : document;

    let nodes = Array.from(scope.querySelectorAll(ROW_SELECTOR));
    if (!nodes.length) {
      for (const fallback of ROW_FALLBACKS) {
        nodes = Array.from(scope.querySelectorAll(fallback));
        if (nodes.length) break;
      }
    }

    const rows = [];
    const seen = new Set();
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const text = cleanText(el);
      if (!text || isExcluded(text)) continue;
      const k = normalise(text);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ el, text });
    }
    return rows;
  }

  /** Cheap fingerprint of the currently visible rows. */
  function rowSignature(rows) {
    return rows.map((r) => normalise(r.text)).join("|");
  }

  /** What the field currently reports as selected. */
  function currentSelection(container) {
    if (!container) return null;
    const attr = container.getAttribute("selectedvalue");
    if (attr && attr.trim()) return attr.trim();
    const span = container.querySelector("span");
    return span ? cleanText(span) : null;
  }

  /**
   * Why no rows were found, in enough detail to act on.
   *
   * Distinguishes the three causes that all surface as an empty list: the
   * picker never opened, it opened somewhere we did not look, or it opened
   * and its markup no longer matches ROW_SELECTOR.
   */
  function describeEmptyMenu(container, trigger, found) {
    const counts = {};
    for (const sel of [ROW_SELECTOR, ...ROW_FALLBACKS]) {
      try {
        counts[sel] = {
          container: container.querySelectorAll(sel).length,
          document: document.querySelectorAll(sel).length,
        };
      } catch {
        counts[sel] = { error: true };
      }
    }

    // Short visible labels anywhere near the field, whatever their class. If
    // these exist the panel IS open and only the selector is wrong.
    const labels = [];
    for (const el of container.querySelectorAll("*")) {
      if (!isVisible(el)) continue;
      const text = cleanText(el);
      if (!text || text.length > 40) continue;
      if (Array.from(el.children).some((c) => cleanText(c) === text)) continue;
      labels.push(text);
      if (labels.length >= 12) break;
    }

    return {
      triggerTag: trigger ? trigger.tagName : null,
      triggerFoundBy: found ? found.how : null,
      triggerWasHidden: Boolean(found && found.hidden),
      triggerWasContainer: Boolean(found ? found.fellBack : trigger === container),
      containerVisible: isVisible(container),
      containerSelectedValue: container.getAttribute("selectedvalue"),
      containerChildren: container.children.length,
      containerText: cleanText(container).slice(0, 120),
      selectorCounts: counts,
      shortLabelsInContainer: labels,
    };
  }

  /**
   * Wait for rows to appear at all.
   *
   * The list is rendered by Vue and populated a moment after the field
   * opens, so reading once after a fixed delay catches an empty menu and
   * concludes the field has no options. That is what made the live Poshmark
   * category fill report "no-rows" against a dropdown that works perfectly
   * by hand - the same mistake that made Depop's condition look empty when
   * it has five values.
   *
   * An empty list means "not ready yet", not "nothing here", until the
   * deadline passes.
   */
  async function waitForRows(root, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let rows = visibleRows(root);
      // Some builds render the menu in a portal outside the field.
      if (!rows.length) rows = visibleRows(document);
      if (rows.length) return rows;
      if (Date.now() >= deadline) return [];
      await wait(150);
    }
  }

  /**
   * Wait until the visible rows differ from `previous`.
   *
   * This is what makes nested navigation safe - see note 2 in the header.
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
   * actually offering - which turns a wrong name in our mapping table into a
   * one-line fix rather than a mystery.
   */
  async function selectNestedPath(container, path, options = {}) {
    const openDelay = options.openDelay ?? 400;
    const settleDelay = options.settleDelay ?? 500;
    /** How long to keep looking for rows before calling the list empty. */
    const rowTimeout = options.rowTimeout ?? 8000;

    if (!container) return { ok: false, reason: "no-container" };
    if (!Array.isArray(path) || path.length === 0) {
      return { ok: false, reason: "no-path" };
    }

    const found = findTrigger(container);
    const trigger = found.el;

    // mousedown as well as click: some pickers open on mousedown and ignore
    // a bare click. Sending both costs nothing and covers either.
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    trigger.click();
    await wait(openDelay);

    const trace = [];

    for (let level = 0; level < path.length; level++) {
      const wanted = path[level];
      if (wanted == null) continue;

      const rows = await waitForRows(container, rowTimeout);
      if (!rows.length) {
        // "no rows" on its own says nothing about WHY. Record enough to tell
        // a picker that never opened from one whose rows we no longer
        // recognise - those need opposite fixes, and guessing between them
        // has cost several rounds.
        return {
          ok: false,
          reason: "no-rows",
          level,
          wanted,
          waitedMs: rowTimeout,
          diagnosis: describeEmptyMenu(container, trigger, found),
          trace,
        };
      }

      const before = rowSignature(rows);
      const choice = chooseOption(rows.map((r) => r.text), wanted);

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
      trace.push({
        level,
        wanted,
        matched: rows[choice.index].text,
        how: choice.reason,
      });

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

    // The field reports its own selection; use it rather than assuming the
    // clicks landed.
    return { ok: true, trace, selected: currentSelection(container) };
  }

  globalThis.AnkDropdown = {
    findTrigger,
    waitForRows,
    ROW_SELECTOR,
    isExcludedRow: isExcluded,
    chooseOption,
    visibleRows,
    rowSignature,
    currentSelection,
    selectNestedPath,
  };
})();
