/* ===========================================================================
 * Poshmark category-tree scraper — paste into DevTools on
 * https://poshmark.com/create-listing while logged in.
 *
 * Walks every department -> category -> subcategory and writes the whole tree
 * to a downloadable JSON file.
 *
 * HOW IT WALKS
 * The picker is one nested list that replaces itself in place, and there is
 * no dependable "back". So rather than trying to reverse out of a branch,
 * this re-opens the picker and re-drills from the root for every
 * (department, category) pair. Slower, but it cannot get lost halfway and
 * silently record one department's categories under another.
 *
 * Progress prints as it goes; a run of ~10 departments takes a few minutes.
 * Leave the tab focused and do not click while it runs.
 *
 * Configure below if the defaults misbehave.
 * ========================================================================= */
(async function scrapePoshmarkCategories() {
  "use strict";

  const CONFIG = {
    /** The category field. Confirmed on the live page. */
    containerSelectors: [
      "div.listing-editor__category-container",
      '[class*="listing-editor__category-container"]',
    ],
    /** Waits, in ms. Raise these if levels come back empty. */
    openDelay: 900,
    levelDelay: 700,
    /** Longest wait for a level to re-render before giving up on it. */
    changeTimeout: 5000,
    /** Set to a number to sample a few departments first. */
    maxDepartments: Infinity,
    /** Rows longer than this are prose, not category labels. */
    maxLabelLength: 60,
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
   * The clickable text rows currently on screen.
   *
   * The rows are plain text, so rather than depend on one class name this
   * keeps elements with their own short label and no child holding the same
   * text - which is what a leaf row looks like in any markup.
   */
  function visibleRows(root) {
    const scope = root && root.isConnected ? root : document;
    const out = [];
    const seen = new Set();

    for (const el of scope.querySelectorAll(
      'li, [role="option"], [role="menuitem"], button, a, div, span'
    )) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text || text.length > CONFIG.maxLabelLength) continue;

      const twin = Array.from(el.children).find(
        (c) => norm(c.textContent) === text
      );
      if (twin) continue;

      const k = key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ el, text });
    }
    return out;
  }

  const signature = (rows) => rows.map((r) => key(r.text)).join("|");

  /** Wait until the visible rows differ from `previous`. */
  async function waitForChange(root, previous) {
    const start = Date.now();
    while (Date.now() - start < CONFIG.changeTimeout) {
      await wait(120);
      const rows = visibleRows(root);
      if (rows.length && signature(rows) !== previous) return rows;
    }
    return null;
  }

  /** Close the picker so the next drill starts from a known state. */
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

  async function openPicker(container) {
    await closePicker();
    const trigger =
      container.querySelector('input, [role="combobox"], [role="button"], button') ||
      container;
    trigger.click();
    await wait(CONFIG.openDelay);
    return visibleRows(container);
  }

  /** Click the row whose text matches, and wait for the list to advance. */
  async function drill(container, rows, label) {
    const target = rows.find((r) => key(r.text) === key(label));
    if (!target) return null;
    const before = signature(rows);
    target.el.click();
    await wait(CONFIG.levelDelay);
    return await waitForChange(container, before);
  }

  // -------------------------------------------------------------- run

  const container = findContainer();
  if (!container) {
    console.error(
      "%cCould not find the category field.",
      "color:#b91c1c;font-weight:700"
    );
    console.error(
      "Are you on https://poshmark.com/create-listing ? Tried:",
      CONFIG.containerSelectors
    );
    return;
  }

  console.log("%cScraping Poshmark categories…", "color:#111;font-weight:700");

  const departmentRows = await openPicker(container);
  if (!departmentRows.length) {
    console.error("Opened the field but saw no rows. Try raising CONFIG.openDelay.");
    return;
  }

  const departments = departmentRows
    .map((r) => r.text)
    .slice(0, CONFIG.maxDepartments);

  console.log(`departments (${departments.length}):`, departments);

  const tree = {};
  const problems = [];

  for (const department of departments) {
    tree[department] = {};

    // Re-drill from the root: the list replaced itself, so the rows captured
    // above are stale.
    let rows = await openPicker(container);
    const categoryRows = await drill(container, rows, department);

    if (!categoryRows) {
      problems.push(`department "${department}": list did not advance`);
      console.warn(`  ${department} — no categories`);
      continue;
    }

    const categories = categoryRows.map((r) => r.text);
    console.log(`  ${department} (${categories.length} categories)`);

    for (const category of categories) {
      // Root -> department -> category, from scratch each time.
      rows = await openPicker(container);
      const catRows = await drill(container, rows, department);
      if (!catRows) {
        problems.push(`"${department}" > "${category}": lost the department`);
        continue;
      }

      const subRows = await drill(container, catRows, category);
      if (!subRows) {
        // A category with no third level is normal, not a failure.
        tree[department][category] = [];
        continue;
      }

      tree[department][category] = subRows.map((r) => r.text);
    }
  }

  await closePicker();

  // ----------------------------------------------------------- output

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
    `%cDone — ${departmentCount} departments, ${categoryCount} categories, ${subcategoryCount} subcategories`,
    "color:#166534;font-weight:700"
  );
  if (problems.length) {
    console.warn(`${problems.length} problem(s):`, problems);
  }

  // Download it. A tree this size is painful to copy out of the console.
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

  // Also expose it, in case the download is blocked.
  globalThis.__poshmarkCategoryTree = payload;
  console.log("Also available as: __poshmarkCategoryTree");
  console.log(json);

  return payload;
})();
