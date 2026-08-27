/* ===========================================================================
 * Depop listing-field scraper — paste into DevTools on
 * https://www.depop.com/products/create/ while logged in.
 *
 * Captures the options of every dropdown on the listing form, so our mapping
 * tables can be verified against real values instead of guessed - the same
 * exercise that found 25 wrong paths in the Poshmark table.
 *
 * TWO MODES
 *
 *   MODE = "discover"   Finds every field on the page and prints its id,
 *                       label and shape. Run this FIRST. It answers which
 *                       selectors to use and which fields are dropdowns at
 *                       all, without anyone having to read the DOM by hand.
 *
 *   MODE = "scrape"     Walks the fields listed in CONFIG.fields and
 *                       downloads their options as JSON.
 *
 * WHY DISCOVER EXISTS
 * The confirmed element ids for these fields did not survive the trip into
 * this file (only a "#group-men" fragment did), and guessing selectors is
 * exactly what produced a scrape of "Select Category" on Poshmark. Discovery
 * makes the ids an output rather than an input.
 * ========================================================================= */
(async function depopFieldScraper() {
  "use strict";

  const MODE = "discover"; // "discover" | "scrape"

  const CONFIG = {
    /**
     * Fields to scrape once their selectors are known.
     *
     * `hierarchical: true` means the control drills - department, then
     * category, then subcategory - and is walked level by level. Everything
     * else is opened once and read.
     *
     * Brand is deliberately ABSENT: on Depop it appears to be a free-text
     * field with autocomplete rather than a fixed list, so there is nothing
     * to enumerate and values pass straight through. Run the check in
     * MODE "discover" output to confirm before adding it.
     */
    fields: [
      { name: "category", selector: null, hierarchical: true },
      { name: "condition", selector: null },
      { name: "colour", selector: null },
      { name: "source", selector: null },
      { name: "age", selector: null },
      { name: "style", selector: null },
    ],

    /**
     * Row selectors, most specific first. Depop's are not yet confirmed -
     * the Poshmark ones are here as a starting point because both are
     * conventional listbox markup.
     */
    rowSelectors: [
      '[role="option"]',
      '[role="menuitem"]',
      ".dropdown__link",
      ".dropdown__menu__item",
      "li",
    ],

    openDelay: 800,
    levelDelay: 600,
    changeTimeout: 5000,
    maxLabelLength: 60,
    /** Rows that navigate rather than select. */
    excludeRows: [/^all\b/i, /^select\b/i, /^choose\b/i, /^back$/i],
  };

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

  /** The visible label for a field, from whatever the markup offers. */
  function labelFor(el) {
    if (el.id) {
      const bound = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (bound) return norm(bound.textContent);
    }
    const wrapper = el.closest("label");
    if (wrapper) return norm(wrapper.textContent).slice(0, 60);
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    return "";
  }

  // ------------------------------------------------------------- discover

  /**
   * Every control on the page that could be a listing field.
   *
   * Deliberately broad, and reports rather than decides - the point is to
   * see what is actually there.
   */
  function discoverFields() {
    const candidates = new Map();

    const add = (el, why) => {
      if (!isVisible(el)) return;
      const id = el.id || "";
      const cls = typeof el.className === "string" ? el.className : "";
      const k = id || cls || el.tagName + Math.random();
      if (candidates.has(k)) return;
      candidates.set(k, {
        why,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        id,
        className: cls.split(" ").slice(0, 3).join(" "),
        label: labelFor(el),
        placeholder: el.getAttribute("placeholder") || "",
        readOnly: el.readOnly === true,
        role: el.getAttribute("role") || "",
        optionCount: el.tagName === "SELECT" ? el.options.length : null,
        text: norm(el.textContent).slice(0, 40),
        el,
      });
    };

    document.querySelectorAll("select").forEach((el) => add(el, "select"));
    document.querySelectorAll("input").forEach((el) => add(el, "input"));
    document
      .querySelectorAll('[role="combobox"], [role="listbox"], [aria-haspopup]')
      .forEach((el) => add(el, "aria"));
    document
      .querySelectorAll('[id^="group-"], [class*="dropdown"], [class*="select"]')
      .forEach((el) => add(el, "pattern"));

    return Array.from(candidates.values());
  }

  function reportDiscovery() {
    const fields = discoverFields();

    console.log(
      "%cDepop form fields found: " + fields.length,
      "color:#111;font-weight:700"
    );

    // A table is far easier to read back than nested console groups.
    console.table(
      fields.map((f) => ({
        tag: f.tag,
        type: f.type,
        id: f.id,
        label: f.label,
        placeholder: f.placeholder,
        readOnly: f.readOnly,
        role: f.role,
        options: f.optionCount,
        class: f.className,
      }))
    );

    // Answer the brand question outright.
    const brand = fields.find((f) =>
      /brand/i.test(f.id + " " + f.label + " " + f.placeholder + " " + f.className)
    );
    console.log("");
    if (!brand) {
      console.log(
        "%cBRAND: no field found. It may only appear after a category is set.",
        "color:#b45309;font-weight:700"
      );
    } else if (brand.tag === "select") {
      console.log(
        "%cBRAND: a <select> with " + brand.optionCount + " options - FIXED LIST, worth scraping.",
        "color:#166534;font-weight:700"
      );
    } else if (brand.tag === "input" && !brand.readOnly) {
      console.log(
        "%cBRAND: a free-text input (placeholder: " +
          JSON.stringify(brand.placeholder) +
          ") - autocomplete, NOT a fixed list. Pass values straight through; do not scrape.",
        "color:#166534;font-weight:700"
      );
    } else {
      console.log(
        "%cBRAND: " + brand.tag + ", readOnly=" + brand.readOnly + " - inspect before deciding.",
        "color:#b45309;font-weight:700"
      );
    }

    console.log(
      "\nCopy the table above (or the JSON below) back, and I will fill in " +
        "CONFIG.fields and switch MODE to \"scrape\"."
    );

    const json = JSON.stringify(
      fields.map(({ el, ...rest }) => rest),
      null,
      2
    );
    globalThis.__depopFields = json;
    console.log(json);
    return json;
  }

  // --------------------------------------------------------------- scrape

  function rowsIn(root) {
    const scope = root && root.isConnected ? root : document;
    let nodes = [];
    for (const selector of CONFIG.rowSelectors) {
      nodes = Array.from(scope.querySelectorAll(selector)).filter(isVisible);
      if (nodes.length) break;
    }

    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const text = norm(el.textContent);
      if (!text || text.length > CONFIG.maxLabelLength) continue;
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
    await wait(200);
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } catch {
      /* ignore */
    }
    await wait(200);
  }

  /** Open one field and return its visible rows, with diagnostics on failure. */
  async function openField(field) {
    const container = document.querySelector(field.selector);
    if (!container) {
      console.warn(
        "%c[" + field.name + "] selector matched nothing: " + field.selector,
        "color:#b91c1c;font-weight:700"
      );
      return { container: null, rows: [] };
    }

    await closeAll();

    const before = signature(rowsIn(document));
    const triggers = [
      ...Array.from(
        container.querySelectorAll('input, button, [role="combobox"], [role="button"]')
      ).filter(isVisible),
      container,
    ];

    for (const trigger of triggers) {
      trigger.click();
      await wait(CONFIG.openDelay);

      const inside = rowsIn(container);
      if (inside.length) return { container, rows: inside, scope: container };

      const anywhere = rowsIn(document);
      if (anywhere.length && signature(anywhere) !== before) {
        return { container, rows: anywhere, scope: document };
      }
    }

    console.warn(
      "%c[" + field.name + "] found the field but could not open it",
      "color:#b91c1c;font-weight:700"
    );
    console.log("  outerHTML:", container.outerHTML.slice(0, 1200));
    return { container, rows: [] };
  }

  async function scrapeFlatField(field) {
    const { rows } = await openField(field);
    await closeAll();
    console.log("  " + field.name + ": " + rows.length + " options");
    return rows.map((r) => r.text);
  }

  /**
   * Walk a drilling field level by level.
   *
   * Mirrors the Poshmark scraper: re-open from the top for each branch rather
   * than trying to reverse out of one, and treat a click that CLOSES the
   * control as a selection rather than a timeout.
   */
  async function scrapeHierarchicalField(field) {
    const first = await openField(field);
    if (!first.rows.length) return {};

    const rootSig = signature(first.rows);
    const tops = first.rows.map((r) => r.text);
    console.log("  " + field.name + ": " + tops.length + " top-level options");

    const tree = {};

    for (const top of tops) {
      tree[top] = {};

      const opened = await openField(field);
      if (signature(opened.rows) !== rootSig) {
        console.warn("    not at root for " + top + " - skipping");
        continue;
      }

      const target = opened.rows.find((r) => key(r.text) === key(top));
      if (!target) continue;

      const before = signature(opened.rows);
      target.el.click();
      await wait(CONFIG.levelDelay);

      const second = rowsIn(opened.scope || document);
      if (!second.length || signature(second) === before) {
        console.log("    " + top + ": no second level");
        continue;
      }

      for (const mid of second.map((r) => r.text)) tree[top][mid] = [];
      console.log("    " + top + ": " + second.length + " categories");
    }

    await closeAll();
    return tree;
  }

  async function runScrape() {
    const missing = CONFIG.fields.filter((f) => !f.selector);
    if (missing.length) {
      console.error(
        "%cThese fields have no selector yet: " +
          missing.map((f) => f.name).join(", "),
        "color:#b91c1c;font-weight:700"
      );
      console.error('Run with MODE = "discover" first.');
      return;
    }

    const result = { scrapedAt: new Date().toISOString(), source: location.href, fields: {} };

    for (const field of CONFIG.fields) {
      console.log("%c" + field.name, "color:#2563eb;font-weight:700");
      result.fields[field.name] = field.hierarchical
        ? await scrapeHierarchicalField(field)
        : await scrapeFlatField(field);
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
    console.log(json);
    return result;
  }

  // ------------------------------------------------------------------ go

  if (MODE === "discover") return reportDiscovery();
  return await runScrape();
})();
