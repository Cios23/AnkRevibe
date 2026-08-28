/* ===========================================================================
 * Depop listing-field scraper — paste into DevTools on
 * https://www.depop.com/products/create/ while logged in.
 *
 * CONFIRMED STRUCTURE (live DOM inspection)
 * Every field is opened by an input:  input#{field}-input
 * carrying the class _selectInput_1qbo3_84. So the triggers are known:
 * group-input, brand-input, condition-input, colour-input, source-input,
 * age-input, style-input.
 *
 * The OPTION rows are not knowable in advance: those classes are CSS-module
 * hashes (_selectInput_1qbo3_84 is one), and a hash changes on every build.
 * So rows are found structurally - by what appears when the field opens -
 * rather than by a class name that would rot.
 *
 * ACCURACY OVER COMPLETION
 * If a field cannot be opened, yields no rows, looks truncated, or looks
 * virtualised, it is recorded in `problems` and its value is set to null -
 * never to a partial array. Partial data is worse than absent data when it
 * feeds a pipeline downstream: an empty list is obviously broken, whereas a
 * list that is 60% complete looks fine and quietly mismaps every item it is
 * missing. Re-running one field is cheap; finding a silent gap later is not.
 * ========================================================================= */
(async function depopFieldScraper() {
  "use strict";

  const CONFIG = {
    /**
     * All seven fields. `hierarchical` drills (department > category >
     * subcategory); the rest are read in one open.
     */
    fields: [
      { name: "category", input: "group-input", hierarchical: true },
      { name: "brand", input: "brand-input", mayBeFreeText: true },
      { name: "condition", input: "condition-input" },
      { name: "colour", input: "colour-input" },
      { name: "source", input: "source-input" },
      { name: "age", input: "age-input" },
      { name: "style", input: "style-input" },
    ],

    openDelay: 900,
    levelDelay: 700,
    changeTimeout: 5000,
    /** Longer than a label, shorter than a paragraph. */
    maxLabelLength: 80,
    /** Rows that navigate or reset rather than select. */
    excludeRows: [/^all\b/i, /^select\b/i, /^choose\b/i, /^back$/i, /^none$/i],
    /**
     * A list longer than this is assumed virtualised - only what is rendered
     * can be read, so the result would be partial. Reported, not returned.
     */
    suspiciouslyLarge: 400,
    verbose: true,
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).toLowerCase();

  /** Every failure, with enough detail to fix or re-run it. */
  const problems = [];
  const addProblem = (field, reason, detail) => {
    problems.push({ field, reason, ...(detail ? { detail } : {}) });
    console.warn(
      "%c[problem] " + field + ": " + reason,
      "color:#b91c1c;font-weight:700",
      detail ?? ""
    );
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const trigger = (field) => document.getElementById(field.input);

  /**
   * Option rows for an open field.
   *
   * Structural, not class-based. Tries, in order of confidence:
   *   1. aria-controls / aria-owns on the input - the accessible contract
   *   2. a visible [role="listbox"]
   *   3. the nearest ancestor of the input that now contains a cluster of
   *      short-text leaf elements
   *
   * Returns the container as well as the rows so scroll state can be checked
   * for truncation.
   */
  function findOptionRows(input) {
    const byAria =
      input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    if (byAria) {
      const el = document.getElementById(byAria);
      if (el && isVisible(el)) {
        const rows = leafRows(el);
        if (rows.length) return { container: el, rows, via: "aria-controls" };
      }
    }

    for (const box of document.querySelectorAll('[role="listbox"]')) {
      if (!isVisible(box)) continue;
      const rows = leafRows(box);
      if (rows.length) return { container: box, rows, via: "role=listbox" };
    }

    // Walk up from the input looking for the popup that just appeared.
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const rows = leafRows(node);
      if (rows.length >= 3) return { container: node, rows, via: "ancestor" };
    }

    return { container: null, rows: [], via: "none" };
  }

  /** Visible leaf elements carrying a short label, de-duplicated by text. */
  function leafRows(root) {
    const out = [];
    const seen = new Set();

    for (const el of root.querySelectorAll("*")) {
      if (!isVisible(el)) continue;
      // A row is a leaf: no child carrying the same text.
      const text = norm(el.textContent);
      if (!text || text.length > CONFIG.maxLabelLength) continue;
      const twin = Array.from(el.children).find(
        (c) => norm(c.textContent) === text
      );
      if (twin) continue;
      if (CONFIG.excludeRows.some((re) => re.test(text))) continue;

      const k = key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ el, text });
    }
    return out;
  }

  const signature = (rows) => rows.map((r) => key(r.text)).join("|");

  async function closeAll() {
    document.body.click();
    await wait(220);
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } catch {
      /* ignore */
    }
    await wait(220);
  }

  /**
   * Open a field. Returns rows, or a reason it could not.
   *
   * Never returns partial success: either the field opened and produced
   * rows, or it did not and says why.
   */
  async function openField(field) {
    const input = trigger(field);
    if (!input) {
      return { ok: false, reason: "trigger-not-found", detail: "#" + field.input };
    }
    if (!isVisible(input)) {
      return {
        ok: false,
        reason: "trigger-hidden",
        detail: "#" + field.input + " exists but is not visible - the field " +
          "may only appear after an earlier one is set",
      };
    }

    await closeAll();
    input.click();
    input.focus();
    await wait(CONFIG.openDelay);

    let found = findOptionRows(input);

    // Some comboboxes only populate on input rather than on click.
    if (!found.rows.length) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(CONFIG.openDelay);
      found = findOptionRows(input);
    }

    if (!found.rows.length) {
      return {
        ok: false,
        reason: "no-rows",
        detail:
          "opened #" + field.input + " but found no option rows (via " +
          found.via + ")",
      };
    }

    return { ok: true, input, ...found };
  }

  /**
   * Read a flat field to completion, or refuse.
   *
   * Scrolls the popup to the bottom until the row count stops growing, so a
   * lazily-rendered list is fully read. If it never stabilises, or ends up
   * suspiciously large, the field is reported rather than returned - a
   * truncated list looks correct and is not.
   */
  async function readAllRows(opened) {
    const container = opened.container;
    let rows = opened.rows;
    let previous = -1;
    let rounds = 0;

    while (rows.length !== previous && rounds < 25) {
      previous = rows.length;
      rounds++;
      if (container && container.scrollHeight > container.clientHeight) {
        container.scrollTop = container.scrollHeight;
        await wait(350);
      } else {
        break;
      }
      rows = findOptionRows(opened.input).rows;
    }

    if (rows.length !== previous && rounds >= 25) {
      return {
        ok: false,
        reason: "list-never-settled",
        detail: "row count still growing after " + rounds + " scrolls (" +
          rows.length + " so far) - probably virtualised, so any result " +
          "would be partial",
      };
    }

    if (rows.length >= CONFIG.suspiciouslyLarge) {
      return {
        ok: false,
        reason: "suspiciously-large",
        detail: rows.length + " rows. A list this long is likely virtualised " +
          "or search-driven; treat as free text rather than an enumerable set",
      };
    }

    return { ok: true, values: rows.map((r) => r.text) };
  }

  async function scrapeFlat(field) {
    const opened = await openField(field);
    if (!opened.ok) {
      addProblem(field.name, opened.reason, opened.detail);
      await closeAll();
      return null;
    }

    const read = await readAllRows(opened);
    await closeAll();

    if (!read.ok) {
      addProblem(field.name, read.reason, read.detail);
      return null;
    }

    console.log(
      "%c  " + field.name + ": " + read.values.length + " options (via " + opened.via + ")",
      "color:#166534"
    );
    return read.values;
  }

  /**
   * Walk the hierarchical category field.
   *
   * Re-opens from the root for every branch rather than reversing out of one
   * - there is no dependable "back", and a walk that loses its place records
   * one department's categories under another. Any branch that fails is
   * reported and its value left null rather than recorded as empty.
   */
  async function scrapeHierarchical(field) {
    const first = await openField(field);
    if (!first.ok) {
      addProblem(field.name, first.reason, first.detail);
      await closeAll();
      return null;
    }

    const rootSig = signature(first.rows);
    const tops = first.rows.map((r) => r.text);
    console.log("%c  " + field.name + ": " + tops.length + " top-level", "color:#166534");
    await closeAll();

    const tree = {};

    for (const top of tops) {
      const opened = await openField(field);
      if (!opened.ok) {
        addProblem(field.name, "reopen-failed", 'while walking "' + top + '"');
        tree[top] = null;
        continue;
      }

      if (signature(opened.rows) !== rootSig) {
        addProblem(
          field.name,
          "not-at-root",
          'expected the top-level list before "' + top + '", saw: ' +
            opened.rows.slice(0, 5).map((r) => r.text).join(", ")
        );
        tree[top] = null;
        await closeAll();
        continue;
      }

      const target = opened.rows.find((r) => key(r.text) === key(top));
      if (!target) {
        addProblem(field.name, "row-vanished", top);
        tree[top] = null;
        await closeAll();
        continue;
      }

      const before = signature(opened.rows);
      target.el.click();
      await wait(CONFIG.levelDelay);

      const next = findOptionRows(opened.input).rows;

      if (!next.length) {
        // Could be a leaf, or could be the control closing on selection.
        // Either way it is not a confident empty, so say so.
        addProblem(
          field.name,
          "no-second-level",
          '"' + top + '" produced no further options - leaf, or the control ' +
            "closed on selection"
        );
        tree[top] = null;
        await closeAll();
        continue;
      }

      if (signature(next) === before) {
        addProblem(field.name, "list-did-not-advance", top);
        tree[top] = null;
        await closeAll();
        continue;
      }

      tree[top] = next.map((r) => r.text);
      console.log("    " + top + ": " + next.length);
      await closeAll();
    }

    return tree;
  }

  // ------------------------------------------------------------------ run

  console.log("%cScraping Depop listing fields...", "color:#111;font-weight:700");

  const missing = CONFIG.fields.filter((f) => !document.getElementById(f.input));
  if (missing.length === CONFIG.fields.length) {
    console.error(
      "%cNone of the expected inputs exist. Are you on /products/create/ ?",
      "color:#b91c1c;font-weight:700"
    );
    return;
  }

  const result = {
    scrapedAt: new Date().toISOString(),
    source: location.href,
    fields: {},
    problems,
  };

  for (const field of CONFIG.fields) {
    console.log("%c" + field.name, "color:#2563eb;font-weight:700");
    result.fields[field.name] = field.hierarchical
      ? await scrapeHierarchical(field)
      : await scrapeFlat(field);

    // Brand is expected to be free text; a refusal there is information,
    // not a failure to fix.
    if (field.mayBeFreeText && result.fields[field.name] === null) {
      console.log(
        "%c  brand looks like free text or a search field - pass values " +
          "through rather than enumerating them",
        "color:#6b7280"
      );
    }
  }

  await closeAll();

  // --------------------------------------------------------------- output

  const summary = Object.entries(result.fields).map(([name, value]) => ({
    field: name,
    status: value === null ? "FAILED - see problems" : "ok",
    values: Array.isArray(value)
      ? value.length
      : value && typeof value === "object"
        ? Object.keys(value).length + " groups"
        : 0,
  }));

  console.log("");
  console.table(summary);

  if (problems.length) {
    console.warn(
      "%c" + problems.length + " field(s)/branch(es) did NOT scrape cleanly - " +
        "their values are null, not partial:",
      "color:#b91c1c;font-weight:700"
    );
    console.table(problems);
  } else {
    console.log("%cAll fields scraped cleanly.", "color:#166534;font-weight:700");
  }

  const json = JSON.stringify(result, null, 2);
  try {
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "depop-fields.json";
    link.click();
  } catch (err) {
    console.warn("Download failed; copy from below.", err);
  }

  globalThis.__depopFields = result;
  console.log("Also on: __depopFields");
  console.log(json);
  return result;
})();
