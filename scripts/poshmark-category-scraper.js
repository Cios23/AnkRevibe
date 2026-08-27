/* ===========================================================================
 * Poshmark category-tree scraper — paste into DevTools on
 * https://poshmark.com/create-listing while logged in.
 *
 * Downloads department -> category -> subcategory as JSON.
 *
 * THE STRUCTURE, as finally established
 * Poshmark splits this across TWO fields, not one three-level picker:
 *
 *   Category field     a nested picker holding TWO levels, department then
 *                      category. Choosing a category selects it and closes
 *                      the panel, leaving e.g. "Women Other" in the field.
 *   Subcategory field  a SEPARATE dropdown ("Select Subcategory (optional)")
 *                      that only populates once a category is set.
 *
 * The previous run captured 20 categories under Women and then recorded an
 * empty subcategory list for every one of them, because it was drilling for
 * a third level inside the category picker - a level that does not exist
 * there. No amount of extra delay could have found it.
 *
 * Two smaller things that also had to be true:
 *
 *   - a click that CLOSES the picker is a selection, not a timeout. The old
 *     wait required `rows.length && signature !== previous`, which a closed
 *     menu can never satisfy.
 *   - a selection persists (see `selectedvalue`), so the field must be reset
 *     between walks or the next department is not on screen to click. "All
 *     Categories" is that reset - which is why it is excluded from category
 *     rows but clicked deliberately here.
 * ========================================================================= */
(async function scrapePoshmarkCategories() {
  "use strict";

  const CONFIG = {
    containerSelectors: [
      "div.listing-editor__category-container",
      '[class*="listing-editor__category-container"]',
    ],
    /**
     * Subcategory is a SEPARATE field, not a third level of the category
     * picker. Confirmed: after choosing a category the page shows Category
     * as "Women Other" and a distinct "Select Subcategory (optional)"
     * control beside it.
     */
    subcategorySelectors: [
      "div.listing-editor__subcategory-container",
      '[class*="listing-editor__subcategory-container"]',
    ],
    openDelay: 900,
    levelDelay: 700,
    changeTimeout: 5000,
    /** Set to a small number to sample before a full run. */
    maxDepartments: Infinity,
    /** CONFIRMED row class on the live page. */
    rowSelector: ".dropdown__link.dropdown__menu__item",
    rowFallbacks: [
      ".dropdown__menu__item",
      ".dropdown__link",
      '[role="option"]',
      '[role="menuitem"]',
    ],
    /** Not categories: "All Categories" resets, the placeholder is a label. */
    excludeRows: [/^all categories$/i, /^select category$/i],
    /** Row text that returns the picker to the top. */
    resetRow: /^all categories$/i,
    /** Log DOM state on the first open and on the first few level-3 attempts. */
    verbose: true,
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).toLowerCase();

  function findContainer() {
    for (const selector of CONFIG.containerSelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /** The separate subcategory field. Only populated once a category is set. */
  function findSubcategoryContainer() {
    for (const selector of CONFIG.subcategorySelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * Options offered by the subcategory field for whatever category is
   * currently selected.
   *
   * Its own container, its own open click - the reason a third-level drill
   * inside the category picker returned nothing every time.
   */
  async function readSubcategories(verbose) {
    const subContainer = findSubcategoryContainer();
    if (!subContainer) return { ok: false, reason: "no-subcategory-field", rows: [] };

    const rows = await openPicker(subContainer, false);

    if (verbose) {
      console.log(
        "%c[subcategory] field found, " + rows.length + " options",
        "color:#7c3aed"
      );
      console.log("  selectedvalue:", subContainer.getAttribute("selectedvalue"));
      console.log("  options      :", rows.map((r) => r.text));
    }

    await closePicker();
    return { ok: rows.length > 0, rows, reason: rows.length ? "ok" : "empty" };
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** Row nodes before filtering - the reset control lives here too. */
  function rawRows(root) {
    const scope = root && root.isConnected ? root : document;
    let nodes = Array.from(scope.querySelectorAll(CONFIG.rowSelector));
    if (!nodes.length) {
      for (const fallback of CONFIG.rowFallbacks) {
        nodes = Array.from(scope.querySelectorAll(fallback));
        if (nodes.length) break;
      }
    }
    return nodes
      .filter(isVisible)
      .map((el) => ({ el, text: norm(el.textContent) }))
      .filter((r) => r.text);
  }

  /** Category rows only. */
  function visibleRows(root) {
    const out = [];
    const seen = new Set();
    for (const row of rawRows(root)) {
      if (CONFIG.excludeRows.some((re) => re.test(row.text))) continue;
      const k = key(row.text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    return out;
  }

  const signature = (rows) => rows.map((r) => key(r.text)).join("|");

  function describeState(container, label) {
    const inContainer = visibleRows(container);
    const inDocument = visibleRows(document);

    console.group("%c[state] " + label, "color:#2563eb;font-weight:700");
    console.log("selectedvalue        :", container.getAttribute("selectedvalue"));
    console.log("container classes    :", container.className);
    console.log(
      "raw rows (unfiltered):",
      rawRows(document).map((r) => r.text).slice(0, 40)
    );
    console.log(
      "rows INSIDE container: " + inContainer.length,
      inContainer.map((r) => r.text).slice(0, 30)
    );
    console.log(
      "rows in DOCUMENT     : " + inDocument.length,
      inDocument.map((r) => r.text).slice(0, 40)
    );
    console.log("container.outerHTML (first 2000 chars):");
    console.log(container.outerHTML.slice(0, 2000));
    console.groupEnd();

    return { inContainer, inDocument };
  }

  /** Where the option list rendered. Set by openPicker. */
  let activeScope = null;

  async function closePicker() {
    document.body.click();
    await wait(250);
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } catch {
      /* ignore */
    }
    await wait(250);
  }

  function triggerCandidates(container) {
    const inner = Array.from(
      container.querySelectorAll(
        'input, [role="combobox"], [role="button"], button, .dropdown__selector, div'
      )
    ).filter(isVisible);
    return [...inner.slice(0, 5), container];
  }

  async function openPicker(container, verbose) {
    await closePicker();

    const beforeDocSig = signature(visibleRows(document));
    if (verbose) describeState(container, "before click");

    for (const trigger of triggerCandidates(container)) {
      trigger.click();
      await wait(CONFIG.openDelay);

      const inContainer = visibleRows(container);
      const inDocument = visibleRows(document);

      // With the real row class the closed field yields NO rows, so any row
      // at all means the menu opened here.
      if (inContainer.length >= 1) {
        activeScope = container;
        return inContainer;
      }
      if (signature(inDocument) !== beforeDocSig && inDocument.length >= 1) {
        if (verbose) {
          console.log(
            "%c[open] list rendered OUTSIDE the container - using document scope",
            "color:#b45309;font-weight:700"
          );
        }
        activeScope = document;
        return inDocument;
      }
    }

    if (verbose) describeState(container, "after all click attempts");
    activeScope = container;
    return visibleRows(container);
  }

  /**
   * The department list, captured on the first open. The definition of root.
   */
  let rootSignature = null;
  let rootNames = [];

  /**
   * Put the picker back at the DEPARTMENT list, and verify it got there.
   *
   * The previous version clicked "All Categories" once and trusted it. That
   * control moves up ONE level, so from inside Women it lands on Women's
   * category list rather than the department list - and the next walk then
   * treated "Accessories", "Bags", "Dresses" as though they were
   * departments, which is why every one came back not-found and Men was
   * never reached.
   *
   * So this climbs in a loop and checks against the real department list
   * rather than assuming a fixed depth.
   */
  async function resetToRoot(container, verbose) {
    await closePicker();
    let rows = await openPicker(container, false);

    // First call defines what root looks like.
    if (rootSignature === null) {
      rootSignature = signature(rows);
      rootNames = rows.map((r) => r.text);
      return rows;
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      if (signature(rows) === rootSignature) return rows;

      const reset = rawRows(activeScope).find((r) =>
        CONFIG.resetRow.test(r.text)
      );
      if (!reset) break;

      if (verbose) {
        console.log(
          "%c[reset] attempt " +
            (attempt + 1) +
            " - at [" +
            rows.slice(0, 4).map((r) => r.text).join(", ") +
            "...], climbing",
          "color:#6b7280"
        );
      }

      reset.el.click();
      await wait(CONFIG.levelDelay);

      rows = visibleRows(activeScope);
      // Clicking reset can close the panel; reopen and keep climbing.
      if (!rows.length) rows = await openPicker(container, false);
    }

    if (signature(rows) !== rootSignature) {
      console.warn(
        "%c[reset] could NOT get back to the department list",
        "color:#b91c1c;font-weight:700"
      );
      console.warn("  expected:", rootNames.slice(0, 8));
      console.warn("  saw     :", rows.map((r) => r.text).slice(0, 8));
      return null;
    }

    return rows;
  }

  /**
   * Click a row and classify what happened.
   *
   * The previous version recognised only "the list changed". A click that
   * CLOSES the picker looks identical to a timeout, which is exactly what
   * recorded every category as having no subcategories.
   */
  async function drill(rows, label) {
    const target = rows.find((r) => key(r.text) === key(label));
    if (!target) return { kind: "not-found", label };

    const before = signature(rows);
    target.el.click();
    await wait(CONFIG.levelDelay);

    const start = Date.now();
    while (Date.now() - start < CONFIG.changeTimeout) {
      const now = visibleRows(activeScope);

      if (now.length && signature(now) !== before) {
        return { kind: "advanced", rows: now };
      }
      if (!now.length && !visibleRows(document).length) {
        // Menu closed: a selection was made rather than a level opened.
        return { kind: "closed" };
      }
      await wait(120);
    }
    return { kind: "unchanged", rows: visibleRows(activeScope) };
  }

  // ------------------------------------------------------------------ run

  const container = findContainer();
  if (!container) {
    console.error("%cCategory field not found.", "color:#b91c1c;font-weight:700");
    console.error("On /create-listing? Tried:", CONFIG.containerSelectors);
    return;
  }

  console.log("%cScraping Poshmark categories...", "color:#111;font-weight:700");

  const departmentRows = await openPicker(container, CONFIG.verbose);
  if (!departmentRows.length) {
    console.error("No rows. Raise CONFIG.openDelay.");
    describeState(container, "no rows on open");
    return;
  }

  // Define root from the FIRST open, while nothing is selected. Every later
  // reset is checked against this, so a reset that lands one level too deep
  // is caught instead of being walked as if it were the department list.
  rootSignature = signature(departmentRows);
  rootNames = departmentRows.map((r) => r.text);

  const departments = rootNames.slice(0, CONFIG.maxDepartments);
  console.log("departments (" + departments.length + "):", departments);

  const tree = {};
  const problems = [];
  let loggedThirdLevel = 0;

  for (const department of departments) {
    tree[department] = {};

    let rows = await resetToRoot(container, CONFIG.verbose);
    if (!rows) {
      problems.push('department "' + department + '": could not reset to root');
      console.warn("  " + department + " - reset failed, skipping");
      continue;
    }
    // If the visible list does not contain this department, we are not at
    // root and drilling would pick something arbitrary.
    if (!rows.some((r) => key(r.text) === key(department))) {
      problems.push('department "' + department + '": not at root when drilling');
      console.warn(
        "  " + department + " - not on screen; saw:",
        rows.map((r) => r.text).slice(0, 8)
      );
      continue;
    }

    const deptStep = await drill(rows, department);

    if (deptStep.kind !== "advanced") {
      problems.push('department "' + department + '": ' + deptStep.kind);
      console.warn("  " + department + " - " + deptStep.kind);
      describeState(container, 'department "' + department + '" -> ' + deptStep.kind);
      continue;
    }

    const categories = deptStep.rows.map((r) => r.text);
    console.log("  " + department + " (" + categories.length + " categories)");

    for (const category of categories) {
      rows = await resetToRoot(container, false);
      if (!rows) {
        problems.push('"' + department + '" > "' + category + '": reset failed');
        tree[department][category] = [];
        continue;
      }
      const again = await drill(rows, department);
      if (again.kind !== "advanced") {
        problems.push('"' + department + '" > "' + category + '": lost department');
        continue;
      }

      const catStep = await drill(again.rows, category);

      const shouldLog = CONFIG.verbose && loggedThirdLevel < 3;
      if (shouldLog) {
        loggedThirdLevel++;
        console.group(
          "%c[after category] " + department + " > " + category + " -> " + catStep.kind,
          "color:#7c3aed;font-weight:700"
        );
        console.log("category selectedvalue:", container.getAttribute("selectedvalue"));
        console.groupEnd();
      }

      if (catStep.kind === "not-found" || catStep.kind === "unchanged") {
        problems.push('"' + department + '" > "' + category + '": ' + catStep.kind);
        tree[department][category] = [];
        continue;
      }

      // The category is now selected. Subcategories are NOT a third level of
      // this picker - they live in their own field, which only populates once
      // a category is set. Drilling for them here is what returned nothing
      // on every category last run.
      const subs = await readSubcategories(shouldLog);
      tree[department][category] = subs.rows.map((r) => r.text);

      if (!subs.ok && subs.reason === "no-subcategory-field") {
        problems.push(
          '"' + department + '" > "' + category + '": subcategory field not found'
        );
      }
    }
  }

  await closePicker();

  // --------------------------------------------------------------- output

  const departmentCount = Object.keys(tree).length;
  const categoryCount = Object.values(tree).reduce(
    (n, cats) => n + Object.keys(cats).length,
    0
  );
  const subcategoryCount = Object.values(tree).reduce(
    (n, cats) => n + Object.values(cats).reduce((m, subs) => m + subs.length, 0),
    0
  );

  const payload = {
    scrapedAt: new Date().toISOString(),
    source: location.href,
    counts: {
      departments: departmentCount,
      categories: categoryCount,
      subcategories: subcategoryCount,
    },
    problems,
    tree,
  };

  const json = JSON.stringify(payload, null, 2);

  console.log(
    "%cDone - " +
      departmentCount +
      " departments, " +
      categoryCount +
      " categories, " +
      subcategoryCount +
      " subcategories",
    "color:#166534;font-weight:700"
  );
  if (problems.length) console.warn(problems.length + " problem(s):", problems);

  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "poshmark-category-tree.json";
    link.textContent = "download poshmark-category-tree.json";
    link.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#111827;color:#fff;padding:10px 18px;border-radius:100px;" +
      "font:600 13px -apple-system,system-ui,sans-serif;text-decoration:none;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.35)";
    document.body.appendChild(link);
    link.click();
  } catch (err) {
    console.warn("Download failed; copy from below.", err);
  }

  globalThis.__poshmarkCategoryTree = payload;
  console.log("Also on: __poshmarkCategoryTree");
  console.log(json);

  return payload;
})();
