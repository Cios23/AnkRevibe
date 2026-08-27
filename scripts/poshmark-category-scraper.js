/* ===========================================================================
 * Poshmark category-tree scraper — paste into DevTools on
 * https://poshmark.com/create-listing while logged in.
 *
 * Walks every department -> category -> subcategory and downloads the tree
 * as JSON.
 *
 * WHY IT RE-DRILLS
 * The picker is one nested list that replaces itself in place, and there is
 * no dependable "back". So rather than reversing out of a branch, this
 * re-opens and re-drills from the root for every (department, category)
 * pair. Slower, but it cannot get lost halfway and silently record one
 * department's categories under another.
 *
 * WHERE THE LIST LIVES
 * The first run captured only "Select Category" - the field's own closed
 * label. Either the click opened nothing, or the list opened OUTSIDE the
 * field and a container-scoped read could never see it. Vue dropdowns often
 * render their menu in a portal at body level, so this now tries several
 * triggers, watches the whole document for the change, and remembers which
 * scope actually holds the rows.
 *
 * Progress prints as it goes. Leave the tab focused and do not click while
 * it runs. Raise the delays in CONFIG if levels come back empty.
 * ========================================================================= */
(async function scrapePoshmarkCategories() {
  "use strict";

  const CONFIG = {
    containerSelectors: [
      "div.listing-editor__category-container",
      '[class*="listing-editor__category-container"]',
    ],
    openDelay: 900,
    levelDelay: 700,
    changeTimeout: 5000,
    /** Set to a small number to sample before a full run. */
    maxDepartments: Infinity,
    /** CONFIRMED row class on the live page. */
    rowSelector: ".dropdown__link.dropdown__menu__item",
    /** Used only if the confirmed class matches nothing. */
    rowFallbacks: [
      ".dropdown__menu__item",
      ".dropdown__link",
      '[role="option"]',
      '[role="menuitem"]',
    ],
    /** Navigation rows, not categories. */
    excludeRows: [/^all categories$/i, /^select category$/i],
    /** Log DOM state at each step. */
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

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /**
   * Category rows currently on screen.
   *
   * Matched on the real row class rather than swept up from every div and
   * span - the generic approach also collected "Select Category", the
   * field's own closed-state label, and reported it as a department.
   */
  function visibleRows(root) {
    const scope = root && root.isConnected ? root : document;

    let nodes = Array.from(scope.querySelectorAll(CONFIG.rowSelector));
    if (!nodes.length) {
      for (const fallback of CONFIG.rowFallbacks) {
        nodes = Array.from(scope.querySelectorAll(fallback));
        if (nodes.length) break;
      }
    }

    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text) continue;
      // "All Categories" is a reset affordance, not a category.
      if (CONFIG.excludeRows.some((re) => re.test(text))) continue;
      const k = key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ el, text });
    }
    return out;
  }

  const signature = (rows) => rows.map((r) => key(r.text)).join("|");

  /** Everything about the DOM at one moment - the diagnostic. */
  function describeState(container, label) {
    const inContainer = visibleRows(container);
    const inDocument = visibleRows(document);

    console.group("%c[state] " + label, "color:#2563eb;font-weight:700");
    console.log("container classes    :", container.className);
    console.log("selectedvalue        :", container.getAttribute("selectedvalue"));
    console.log("aria-expanded        :", container.getAttribute("aria-expanded"));
    console.log("descendant nodes     :", container.querySelectorAll("*").length);
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

  /** Where the option list actually rendered. Set by openPicker. */
  let activeScope = null;

  async function closePicker() {
    document.body.click();
    await wait(300);
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } catch {
      /* ignore */
    }
    await wait(300);
  }

  /** Elements that might open the picker, most specific first. */
  function triggerCandidates(container) {
    const inner = Array.from(
      container.querySelectorAll(
        'input, [role="combobox"], [role="button"], button, .dropdown__selector, div'
      )
    ).filter(isVisible);
    return [...inner.slice(0, 5), container];
  }

  /**
   * Open the picker and return the visible rows.
   *
   * Tries each candidate trigger until the page visibly changes. A single
   * blind click on the wrong node is how the first run got nothing.
   */
  async function openPicker(container, verbose) {
    await closePicker();

    const before = verbose
      ? describeState(container, "before click")
      : { inDocument: visibleRows(document) };
    const beforeDocSig = signature(before.inDocument);

    for (const trigger of triggerCandidates(container)) {
      trigger.click();
      await wait(CONFIG.openDelay);

      const inContainer = visibleRows(container);
      const inDocument = visibleRows(document);

      if (verbose) {
        const cls = trigger.className
          ? "." + String(trigger.className).split(" ")[0]
          : "";
        console.log(
          "%c[open] <" +
            trigger.tagName.toLowerCase() +
            cls +
            "> -> container " +
            inContainer.length +
            " rows, document " +
            inDocument.length +
            " rows",
          "color:#6b7280"
        );
      }

      // With the real row class, the closed field yields NO rows - so any
      // row at all means the menu opened here.
      if (inContainer.length >= 1) {
        activeScope = container;
        return inContainer;
      }

      // Otherwise the menu may have rendered elsewhere on the page.
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

  /** Wait until the visible rows differ from `previous`. */
  async function waitForChange(previous) {
    const start = Date.now();
    while (Date.now() - start < CONFIG.changeTimeout) {
      await wait(120);
      const rows = visibleRows(activeScope);
      if (rows.length && signature(rows) !== previous) return rows;
    }
    return null;
  }

  /** Click the row matching `label`, then wait for the list to advance. */
  async function drill(rows, label) {
    const target = rows.find((r) => key(r.text) === key(label));
    if (!target) return null;
    const before = signature(rows);
    target.el.click();
    await wait(CONFIG.levelDelay);
    return await waitForChange(before);
  }

  // ------------------------------------------------------------------ run

  const container = findContainer();
  if (!container) {
    console.error(
      "%cCould not find the category field.",
      "color:#b91c1c;font-weight:700"
    );
    console.error("On /create-listing? Tried:", CONFIG.containerSelectors);
    return;
  }

  console.log("%cScraping Poshmark categories...", "color:#111;font-weight:700");

  const departmentRows = await openPicker(container, CONFIG.verbose);

  if (!departmentRows.length) {
    console.error("No rows at all. Try raising CONFIG.openDelay.");
    return;
  }

  // "Select Category" alone is the CLOSED state, not a department. Treating
  // it as one is what produced an empty tree on the first run.
  const looksClosed =
    departmentRows.length <= 2 &&
    departmentRows.some((r) => /select|choose/i.test(r.text));

  if (looksClosed) {
    console.error(
      "%cThe picker did not open - only its placeholder is visible.",
      "color:#b91c1c;font-weight:700"
    );
    console.error("Saw:", departmentRows.map((r) => r.text));
    describeState(container, "failed open");
    console.error(
      "Next: open the picker BY HAND, then run this to find where the list rendered:"
    );
    console.error(
      "copy([...document.querySelectorAll('*')].filter(e => /women/i.test(e.textContent) && e.children.length < 3).slice(0,10).map(e => e.className))"
    );
    return;
  }

  const departments = departmentRows
    .map((r) => r.text)
    .slice(0, CONFIG.maxDepartments);

  console.log("departments (" + departments.length + "):", departments);

  const tree = {};
  const problems = [];

  for (const department of departments) {
    tree[department] = {};

    // Re-drill from the root; the rows captured above are stale.
    let rows = await openPicker(container, false);
    const categoryRows = await drill(rows, department);

    if (!categoryRows) {
      problems.push('department "' + department + '": list did not advance');
      console.warn("  " + department + " - no categories");
      continue;
    }

    const categories = categoryRows.map((r) => r.text);
    console.log("  " + department + " (" + categories.length + " categories)");

    for (const category of categories) {
      rows = await openPicker(container, false);
      const catRows = await drill(rows, department);
      if (!catRows) {
        problems.push('"' + department + '" > "' + category + '": lost the department');
        continue;
      }

      const subRows = await drill(catRows, category);
      if (!subRows) {
        // A category with no third level is normal, not a failure.
        tree[department][category] = [];
        continue;
      }

      tree[department][category] = subRows.map((r) => r.text);
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
    console.log(
      "%cIf the download did not start, click the button at the top of the page.",
      "color:#6b7280"
    );
  } catch (err) {
    console.warn("Download failed; copy from below instead.", err);
  }

  globalThis.__poshmarkCategoryTree = payload;
  console.log("Also on: __poshmarkCategoryTree");
  console.log(json);

  return payload;
})();
