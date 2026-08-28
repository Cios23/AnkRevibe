// Depop listing-form select driver — AnK ReVibe.
//
// Every field on Depop's create page is opened by input#{field}-input:
// group (category), brand, condition, colour, source, age, style. The option
// rows are react-select markup with CSS-module class hashes that change on
// every Depop build, so nothing here matches on a class name.
//
// Everything in this file was established by running scripts/depop-field-
// scraper.js against the live form, and each rule below exists because
// assuming otherwise produced wrong data:
//
//   - The control opens on MOUSEDOWN. A bare click was ignored.
//   - The menu renders IMMEDIATELY, showing react-select's "No option"
//     placeholder, and fills a moment later. Reading once after a fixed
//     delay caught the placeholder and concluded the field was empty when it
//     had five perfectly good values. So: poll until options appear.
//   - The menu is found via aria-controls, then role=listbox, then by
//     looking inside the field's own wrapper - never by scanning the
//     document, which picked up a different field's open menu.
//   - The walk up from the input stops as soon as an ancestor holds more
//     than one input[id$="-input"], because past that point it is the form.
//     Without that guard the "options" came back as "Info, Category, Brand,
//     Condition" - the page's own labels.
(function () {
  "use strict";

  const OPEN_TIMEOUT = 8000;
  const POLL_INTERVAL = 200;
  const MAX_LABEL = 80;

  /** react-select's empty state, in its known variants. */
  const EMPTY_STATE = /^(no options?|nothing found|no results?)$/i;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).toLowerCase();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** >1 means the node is the form, not one field. */
  const fieldInputCount = (node) =>
    node.querySelectorAll('input[id$="-input"]').length;

  /**
   * Rows in an open menu.
   *
   * Prefers [role="option"], which react-select marks properly, and falls
   * back to short-text leaves only inside a container already established as
   * this field's menu.
   */
  function rowsIn(container) {
    const explicit = Array.from(container.querySelectorAll('[role="option"]'))
      .filter(isVisible)
      .map((el) => ({ el, text: norm(el.textContent) }))
      .filter((r) => r.text && r.text.length <= MAX_LABEL);
    if (explicit.length) return explicit;

    const out = [];
    const seen = new Set();
    for (const el of container.querySelectorAll("*")) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text || text.length > MAX_LABEL) continue;
      if (Array.from(el.children).some((c) => norm(c.textContent) === text)) continue;
      const k = key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ el, text });
    }
    return out;
  }

  /** This field's menu, scoped so another field's cannot be picked up. */
  function findMenu(input) {
    const candidates = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el) || !isVisible(el) || el.contains(input)) return;
      seen.add(el);
      candidates.push(el);
    };

    const aria =
      input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    if (aria) push(document.getElementById(aria));

    const stem = input.id.replace(/-input$/, "");
    push(document.getElementById(stem + "-listbox"));

    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (fieldInputCount(node) > 1) break; // left the field
      for (const el of node.querySelectorAll('[role="listbox"],[role="menu"]')) {
        push(el);
      }
      if (node.querySelector('[role="option"]')) push(node);
    }

    for (const container of candidates) {
      // A menu holding another field's input is the form, not a menu.
      if (fieldInputCount(container) > 0) continue;
      const rows = rowsIn(container).filter((r) => !EMPTY_STATE.test(r.text));
      if (rows.length) return { container, rows };
    }
    return null;
  }

  /** Open the control. mousedown is what react-select listens for. */
  function openControl(input) {
    input.focus();
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    input.click();
  }

  /**
   * Open a field and wait for its options to actually arrive.
   *
   * An empty menu means "not loaded yet", not "no values" - that mistake is
   * why condition looked broken for three rounds.
   */
  async function openField(fieldId) {
    const input = document.getElementById(fieldId);
    if (!input) return { ok: false, reason: "no-input", field: fieldId };
    if (!isVisible(input)) return { ok: false, reason: "input-hidden", field: fieldId };

    openControl(input);

    const deadline = Date.now() + OPEN_TIMEOUT;
    while (Date.now() < deadline) {
      const menu = findMenu(input);
      if (menu) return { ok: true, input, ...menu };
      await wait(POLL_INTERVAL);
    }
    return { ok: false, reason: "menu-never-filled", field: fieldId };
  }

  /**
   * Pick the row matching `wanted`.
   *
   * Exact match first, then punctuation- and case-insensitive. Never a
   * "closest" guess: our tables hold values read off this very form, so a
   * near miss means the table is wrong and should be fixed, not papered over
   * by selecting something that merely looks similar.
   */
  function chooseRow(rows, wanted) {
    const target = key(wanted);
    const exact = rows.findIndex((r) => key(r.text) === target);
    if (exact >= 0) return { index: exact, reason: "exact" };

    const loose = (s) => key(s).replace(/[^a-z0-9]+/g, " ").trim();
    const target2 = loose(wanted);
    const near = rows.findIndex((r) => loose(r.text) === target2);
    if (near >= 0) return { index: near, reason: "punctuation" };

    return { index: -1, reason: "no-match", candidates: rows.map((r) => r.text) };
  }

  /**
   * Set one flat field to one value.
   *
   * Returns a result rather than throwing: one unfillable optional field
   * should not abandon a listing that is otherwise correct, but it must be
   * reported so a wrong table value surfaces instead of vanishing.
   */
  async function selectValue(fieldId, wanted) {
    if (!wanted) return { ok: false, reason: "nothing-to-set", field: fieldId };

    const opened = await openField(fieldId);
    if (!opened.ok) return opened;

    const choice = chooseRow(opened.rows, wanted);
    if (choice.index < 0) {
      return {
        ok: false,
        reason: "no-match",
        field: fieldId,
        wanted,
        candidates: choice.candidates.slice(0, 12),
      };
    }

    opened.rows[choice.index].el.click();
    await wait(400);
    return { ok: true, field: fieldId, chose: opened.rows[choice.index].text };
  }

  /**
   * Walk the category picker, which drills two levels.
   *
   * The list must CHANGE between levels. If it does not, the click did not
   * advance and clicking again at the same level would file the item under
   * whatever happens to sit at that index - the failure that put whole
   * Poshmark branches under the wrong parent.
   */
  async function selectCategoryPath(fieldId, path) {
    if (!Array.isArray(path) || !path.length) {
      return { ok: false, reason: "no-path", field: fieldId };
    }

    const opened = await openField(fieldId);
    if (!opened.ok) return opened;

    let rows = opened.rows;
    let signature = rows.map((r) => key(r.text)).join("|");
    const trace = [];

    for (let level = 0; level < path.length; level++) {
      const choice = chooseRow(rows, path[level]);
      if (choice.index < 0) {
        return {
          ok: false,
          reason: "no-match",
          field: fieldId,
          level,
          wanted: path[level],
          candidates: choice.candidates.slice(0, 12),
          trace,
        };
      }

      rows[choice.index].el.click();
      trace.push(rows[choice.index].text);
      await wait(500);

      if (level === path.length - 1) break;

      // Wait for the next level, and require that it is genuinely different.
      const deadline = Date.now() + OPEN_TIMEOUT;
      let advanced = null;
      while (Date.now() < deadline) {
        const menu = findMenu(opened.input);
        if (menu) {
          const next = menu.rows.map((r) => key(r.text)).join("|");
          if (next !== signature) {
            advanced = menu;
            signature = next;
            break;
          }
        }
        await wait(POLL_INTERVAL);
      }

      if (!advanced) {
        return { ok: false, reason: "did-not-advance", field: fieldId, level, trace };
      }
      rows = advanced.rows;
    }

    return { ok: true, field: fieldId, trace };
  }

  globalThis.AnkDepopSelect = {
    openField,
    findMenu,
    chooseRow,
    selectValue,
    selectCategoryPath,
  };
})();
