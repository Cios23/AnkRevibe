/* ===========================================================================
 * Depop listing-field scraper — paste into DevTools on
 * https://www.depop.com/products/create/ while logged in.
 *
 *   MODE = "scrape"    normal run
 *   MODE = "diagnose"  dump the real DOM around ONE field's open menu
 *
 * If a field misbehaves, run diagnose on it FIRST and paste the output.
 * Guessing at the structure blind has cost several rounds already; the
 * diagnose output shows what is actually there.
 *
 * -------------------------------------------------------------------------
 * WHAT WENT WRONG LAST RUN, AND WHY
 *
 * Category returned "Info, Category, Brand, Condition"; Brand returned page
 * section labels; Condition returned "No option". All three were the SAME
 * bug, not three separate ones:
 *
 *   1. The ancestor fallback climbed up to 6 levels from the input with no
 *      check that it was still inside a menu. Once it reached the form panel
 *      it collected every short visible label - which is precisely the field
 *      names and section headings that came back.
 *   2. "No option" is react-select's empty-state message. The menu opened
 *      with zero options; finding none, the code fell through to (1) and
 *      returned form labels instead of reporting an empty menu.
 *   3. The listbox scan took the FIRST visible [role="listbox"] in the whole
 *      document, so a lingering menu from another field could be read as
 *      this field's options.
 *
 * The fixes, in order of importance:
 *   - Never climb past the field. The walk stops the moment an ancestor
 *     contains more than one input[id$="-input"], which means it has left
 *     this field and entered the form.
 *   - A candidate menu must LOOK like a menu, and must not contain another
 *     field's input or a <label>.
 *   - Empty states and form-label bleed are detected by name and reported,
 *     never returned as data.
 *   - Menus resolve per-input, and every other menu is closed first.
 * ========================================================================= */
(async function depopFieldScraper() {
  "use strict";

  /** "scrape" | "diagnose" */
  const MODE = "diagnose";
  /** Which field diagnose mode inspects. */
  const DIAGNOSE_FIELD = "brand";

  const CONFIG = {
    fields: [
      { name: "category", input: "group-input", hierarchical: true },
      { name: "brand", input: "brand-input", mayBeSearchDriven: true },
      { name: "condition", input: "condition-input" },
      { name: "colour", input: "colour-input" },
      { name: "source", input: "source-input" },
      { name: "age", input: "age-input" },
      { name: "style", input: "style-input" },
    ],

    openDelay: 900,
    /**
     * How long to keep re-reading a menu before calling it empty.
     *
     * This is what broke condition. react-select renders the menu instantly
     * with its "No option" placeholder and fills it a moment later, so the
     * single read at openDelay (900ms) captured the placeholder and returned
     * "empty-menu" as a terminal failure. Diagnose happened to wait 1500ms
     * and saw the real five values from the same aria-controls candidate.
     * Polling fixes the class of bug; a longer sleep would only move it.
     */
    menuTimeout: 8000,
    pollInterval: 250,
    levelDelay: 700,
    /** Attempts to reach a verified root before abandoning a branch. */
    rootResetAttempts: 4,
    maxLabelLength: 80,
    /** Rows that navigate or reset rather than select a value. */
    excludeRows: [/^all categories$/i, /^select /i, /^choose /i, /^back$/i],
    /** Longer than this is assumed virtualised, so unreadable in full. */
    suspiciouslyLarge: 400,
  };

  /**
   * The form's own labels. If a "menu" is made of these, the walk escaped
   * the field and the result is garbage - the exact failure last run.
   */
  const FIELD_LABEL = new RegExp(
    "^(info|details|category|categories|brand|condition|colour|color|source|" +
      "age|style|price|description|photos?|shipping|size|quantity|listing|" +
      "sell|save|draft|preview|no option)$",
    "i"
  );

  /** react-select's "nothing here" message, in its known variants. */
  const EMPTY_STATE = /^(no options?|nothing found|no results?)$/i;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).toLowerCase();

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

  /** How many listing-field inputs live under a node. >1 means we are in the form. */
  const fieldInputCount = (node) =>
    node.querySelectorAll('input[id$="-input"]').length;

  // ------------------------------------------------------- menu resolution

  /**
   * Candidate menus for ONE input, best first.
   *
   * Every candidate is scoped to the field. The ancestor walk stops as soon
   * as a node contains more than one field input, because past that point it
   * is the form rather than the field - which is how the last run came back
   * with "Category, Brand, Condition" as though they were options.
   */
  function menuCandidates(input) {
    const out = [];
    const seen = new Set();
    const push = (el, via) => {
      if (!el || seen.has(el) || !isVisible(el) || el.contains(input)) return;
      seen.add(el);
      out.push({ el, via });
    };

    // 1. The accessible contract, when the component provides one.
    const aria =
      input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    if (aria) push(document.getElementById(aria), "aria-controls");

    // 2. react-select's convention: foo-input pairs with foo-listbox.
    const stem = input.id.replace(/-input$/, "");
    push(document.getElementById(stem + "-listbox"), "id-convention");
    push(document.getElementById(stem + "-menu"), "id-convention");

    // 3. Anything menu-shaped inside the field's own wrapper.
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (fieldInputCount(node) > 1) break; // left the field - stop climbing
      const selector =
        '[role="listbox"],[role="menu"],[class*="menu"],[class*="Menu"],' +
        '[class*="option"],[class*="Option"],[class*="dropdown"],ul';
      for (const el of node.querySelectorAll(selector)) push(el, "scoped-" + depth);
      // The wrapper itself can be the menu once it holds options.
      if (node.querySelector('[role="option"]')) push(node, "wrapper-" + depth);
    }

    // 4. A portalled menu - accepted only when it sits directly under this
    //    input, so another field's open menu cannot be mistaken for it.
    const box = input.getBoundingClientRect();
    for (const el of document.querySelectorAll('[role="listbox"],[role="menu"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      const rect = el.getBoundingClientRect();
      const overlaps = rect.left < box.right && rect.right > box.left;
      const below = rect.top >= box.top - 8 && rect.top - box.bottom < 220;
      if (overlaps && below) push(el, "portal");
    }

    return out;
  }

  /** Visible leaf elements carrying a short label, de-duplicated by text. */
  function leafRows(root) {
    const out = [];
    const seen = new Set();
    for (const el of root.querySelectorAll("*")) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent);
      if (!text || text.length > CONFIG.maxLabelLength) continue;
      // A row is a leaf: no child carries the identical text.
      if (Array.from(el.children).some((c) => norm(c.textContent) === text)) continue;
      const k = key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ el, text });
    }
    return out;
  }

  /**
   * Decide whether a candidate really is this field's option list.
   *
   * Each check corresponds to a way the last run produced confident garbage,
   * so none of them are theoretical.
   */
  function validateMenu(candidate) {
    const el = candidate.el;

    // Holds another field's input, or a form label: it is the form.
    if (fieldInputCount(el) > 0) return { ok: false, reason: "contains-field-input" };
    if (el.querySelector("label")) return { ok: false, reason: "contains-label" };

    // Prefer explicit options when the component marks them.
    const explicit = Array.from(el.querySelectorAll('[role="option"]'))
      .filter(isVisible)
      .map((node) => ({ el: node, text: norm(node.textContent) }))
      .filter((r) => r.text && r.text.length <= CONFIG.maxLabelLength);

    let rows = explicit.length ? explicit : leafRows(el);
    if (!rows.length) return { ok: false, reason: "no-rows" };

    // react-select's empty state. Real information, not an option.
    if (rows.length <= 2 && rows.every((r) => EMPTY_STATE.test(r.text))) {
      return { ok: false, reason: "empty-menu", sample: rows.map((r) => r.text) };
    }

    // The form-label bleed that produced last run's garbage.
    const labelish = rows.filter((r) => FIELD_LABEL.test(r.text)).length;
    if (labelish >= Math.max(2, rows.length * 0.5)) {
      return {
        ok: false,
        reason: "form-labels-not-options",
        sample: rows.slice(0, 6).map((r) => r.text),
      };
    }

    rows = rows.filter(
      (r) =>
        !CONFIG.excludeRows.some((re) => re.test(r.text)) && !EMPTY_STATE.test(r.text)
    );
    if (!rows.length) return { ok: false, reason: "no-rows-after-filtering" };

    return { ok: true, rows };
  }

  /** The one menu belonging to this input, or a reason there is none. */
  function resolveMenu(input) {
    const rejected = [];
    for (const candidate of menuCandidates(input)) {
      const verdict = validateMenu(candidate);
      if (verdict.ok) return { ok: true, ...candidate, rows: verdict.rows };
      rejected.push(candidate.via + ":" + verdict.reason);
    }
    // An empty menu is a distinct and useful outcome - surface it as such.
    const empty = rejected.some((r) => r.endsWith("empty-menu"));
    return {
      ok: false,
      reason: empty ? "empty-menu" : "no-menu",
      detail: rejected.length ? "rejected " + rejected.join(", ") : "no candidates",
    };
  }

  const signature = (rows) => rows.map((r) => key(r.text)).join("|");

  // --------------------------------------------------------- open / close

  async function closeAll() {
    try {
      if (document.activeElement) document.activeElement.blur();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } catch {
      /* ignore */
    }
    await wait(180);
    document.body.click();
    await wait(260);
  }

  /** Set a React-controlled input's value so React actually sees it. */
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Clear a selection so the control returns to its root state. */
  async function clearField(input) {
    setNativeValue(input, "");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })
    );
    await wait(220);
  }

  /**
   * Open the control.
   *
   * mousedown first, because react-select opens on mousedown and ignores a
   * bare click; the click stays for components that want it. Sending both
   * costs nothing and covers either implementation.
   */
  function openControl(input) {
    input.focus();
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    input.click();
  }

  /**
   * Poll until the menu has real options, or the deadline passes.
   *
   * An empty menu is not an answer, it is a menu that has not loaded yet -
   * exactly what made condition report "empty-menu" when it has five perfectly
   * good values. Only a menu still empty at the deadline is reported as empty.
   */
  async function waitForMenu(input) {
    const deadline = Date.now() + CONFIG.menuTimeout;
    let last = { ok: false, reason: "no-menu", detail: "never resolved" };

    while (Date.now() < deadline) {
      const menu = resolveMenu(input);
      if (menu.ok) return menu;
      last = menu;
      await wait(CONFIG.pollInterval);
    }

    return {
      ...last,
      detail:
        (last.detail || "") + " (still so after " +
        Math.round(CONFIG.menuTimeout / 1000) + "s of polling)",
    };
  }

  /**
   * Open one field and resolve its menu.
   *
   * Closes everything else first: a menu left open elsewhere was one of the
   * ways the wrong field's options got read last run.
   */
  async function openField(field, { type = null } = {}) {
    const input = trigger(field);
    if (!input)
      return { ok: false, reason: "trigger-not-found", detail: "#" + field.input };
    if (!isVisible(input)) {
      return {
        ok: false,
        reason: "trigger-hidden",
        detail:
          "#" + field.input + " exists but is not visible; it may only appear " +
          "once an earlier field is set",
      };
    }

    await closeAll();
    openControl(input);

    let menu = await waitForMenu(input);

    // A search-driven control populates on keystroke, not on click.
    if (!menu.ok && type) {
      setNativeValue(input, type);
      menu = await waitForMenu(input);
    }

    if (!menu.ok) return { ok: false, reason: menu.reason, detail: menu.detail };
    return { ok: true, input, container: menu.el, rows: menu.rows, via: menu.via };
  }

  // ------------------------------------------------------------ flat read

  /**
   * Read a flat list to completion, or refuse.
   *
   * Scrolls until the row count stops growing so a lazily-rendered list is
   * read fully; refuses anything that never settles or is large enough to be
   * virtualised, because only rendered rows can be read and a partial list
   * looks correct.
   */
  async function readAll(opened) {
    const container = opened.container;
    let rows = opened.rows;
    let previous = -1;
    let rounds = 0;

    while (rows.length !== previous && rounds < 25) {
      previous = rows.length;
      rounds++;
      if (!container || container.scrollHeight <= container.clientHeight) break;
      container.scrollTop = container.scrollHeight;
      await wait(340);
      const again = resolveMenu(opened.input);
      if (!again.ok) break;
      rows = again.rows;
    }

    if (rows.length !== previous && rounds >= 25) {
      return {
        ok: false,
        reason: "list-never-settled",
        detail:
          "still growing after " + rounds + " scrolls (" + rows.length +
          " so far) - virtualised, so any result would be partial",
      };
    }
    if (rows.length >= CONFIG.suspiciouslyLarge) {
      return {
        ok: false,
        reason: "suspiciously-large",
        detail:
          rows.length + " rows - likely virtualised or search-driven; treat " +
          "as free text rather than an enumerable set",
      };
    }
    return { ok: true, values: rows.map((r) => r.text) };
  }

  async function scrapeFlat(field) {
    let opened = await openField(field);

    // Empty on click - probe for a search-driven list before failing.
    if (!opened.ok && opened.reason === "empty-menu" && field.mayBeSearchDriven) {
      const probe = await openField(field, { type: "a" });
      if (probe.ok) {
        await closeAll();
        addProblem(
          field.name,
          "search-driven",
          "empty until typed, then " + probe.rows.length + " results for 'a' " +
            "(e.g. " + probe.rows.slice(0, 4).map((r) => r.text).join(", ") +
            "). An autocomplete over a large set, not an enumerable list - " +
            "pass values through rather than mapping them."
        );
        return null;
      }
    }

    if (!opened.ok) {
      addProblem(field.name, opened.reason, opened.detail);
      await closeAll();
      return null;
    }

    const read = await readAll(opened);
    await closeAll();
    if (!read.ok) {
      addProblem(field.name, read.reason, read.detail);
      return null;
    }
    console.log(
      "%c  " + field.name + ": " + read.values.length + " options (via " +
        opened.via + ")",
      "color:#166534"
    );
    return read.values;
  }

  // --------------------------------------------------------- hierarchical

  /**
   * Return to a VERIFIED root before every branch.
   *
   * The Poshmark scraper failed four times by assuming a single reset click
   * had worked; it had landed one level deep, and whole branches were filed
   * under the wrong parent. Nothing is trusted here: the menu is reopened
   * and its signature compared against the root captured on the first open,
   * retrying with escalating resets. A branch whose root cannot be verified
   * is abandoned rather than walked from an unknown position.
   */
  async function resetToRoot(field, rootSig) {
    for (let attempt = 0; attempt < CONFIG.rootResetAttempts; attempt++) {
      await closeAll();
      const input = trigger(field);
      if (input && attempt > 0) await clearField(input);
      const opened = await openField(field);
      if (opened.ok && signature(opened.rows) === rootSig) return opened;
      await wait(400);
    }
    return null;
  }

  async function scrapeHierarchical(field) {
    const first = await openField(field);
    if (!first.ok) {
      addProblem(field.name, first.reason, first.detail);
      await closeAll();
      return null;
    }

    const rootSig = signature(first.rows);
    const tops = first.rows.map((r) => r.text);
    console.log(
      "%c  " + field.name + ": " + tops.length + " top-level (via " + first.via + ")",
      "color:#166534"
    );
    console.log("    " + tops.join(", "));
    await closeAll();

    const tree = {};

    for (const top of tops) {
      const opened = await resetToRoot(field, rootSig);
      if (!opened) {
        addProblem(
          field.name,
          "not-at-root",
          'could not return to the top-level list before "' + top + '" after ' +
            CONFIG.rootResetAttempts + " attempts; branch skipped rather than " +
            "walked from an unknown position"
        );
        tree[top] = null;
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

      const next = resolveMenu(opened.input);

      if (!next.ok) {
        addProblem(
          field.name,
          next.reason === "empty-menu" ? "no-second-level" : next.reason,
          '"' + top + '" produced no further options - a leaf, or the control ' +
            "closed on selection (" + (next.detail || "") + ")"
        );
        tree[top] = null;
        await closeAll();
        continue;
      }

      if (signature(next.rows) === before) {
        addProblem(field.name, "list-did-not-advance", top);
        tree[top] = null;
        await closeAll();
        continue;
      }

      tree[top] = next.rows.map((r) => r.text);
      console.log("      " + top + ": " + next.rows.length);
      await closeAll();
    }

    return tree;
  }

  // -------------------------------------------------------- diagnose mode

  /**
   * Dump what is actually in the DOM around one field's open menu.
   * Cheaper than another blind guess at the structure.
   */
  async function diagnose(name) {
    const field = CONFIG.fields.find((f) => f.name === name);
    if (!field) return console.error("unknown field: " + name);

    const input = trigger(field);
    console.log("%cdiagnose: " + name, "color:#111;font-weight:700");
    console.log("input #" + field.input + ":", input);
    if (!input) return;
    console.log("  visible:", isVisible(input), " class:", input.className);
    console.log(
      "  aria-controls:", input.getAttribute("aria-controls"),
      " aria-expanded:", input.getAttribute("aria-expanded"),
      " role:", input.getAttribute("role")
    );

    await closeAll();

    // Snapshot the whole document, click, then diff. Whatever appears IS the
    // menu - wherever it renders, whatever it is called. This is the one
    // check that does not depend on any assumption about Depop's markup,
    // which is what the last three rounds got wrong.
    const before = new Set(document.querySelectorAll("*"));

    openControl(input);
    await wait(1500);

    const appeared = Array.from(document.querySelectorAll("*")).filter(
      (el) => !before.has(el)
    );

    console.log(
      "%c  --- " + appeared.length + " element(s) appeared after the click ---",
      "color:#2563eb;font-weight:700"
    );
    console.log("  aria-expanded now:", input.getAttribute("aria-expanded"));

    if (!appeared.length) {
      console.warn(
        "  NOTHING appeared. The click did not open anything - the control " +
          "may need a different event (mousedown/keydown), or the field may " +
          "be disabled until another field is set."
      );
      // Does a real mousedown work where click did not?
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await wait(1200);
      const afterMouseDown = Array.from(document.querySelectorAll("*")).filter(
        (el) => !before.has(el)
      );
      console.log("  after mousedown, appeared:", afterMouseDown.length);
      appeared.push(...afterMouseDown);
    }

    // Roots of the appeared subtrees, so one line per menu rather than one
    // per node.
    const roots = appeared.filter((el) => !appeared.includes(el.parentElement));
    console.log("  appeared subtree roots:", roots.length);
    roots.slice(0, 12).forEach((el, i) => {
      console.log(
        "   root[" + i + "] <" + el.tagName.toLowerCase() + "> id=" +
          (el.id || "-") + " class=" + String(el.className).slice(0, 70) +
          " visible=" + isVisible(el) +
          " options=" + el.querySelectorAll('[role="option"]').length +
          " children=" + el.children.length,
        el
      );
      console.log("      text: " + norm(el.textContent).slice(0, 200));
      console.log("      html: " + el.outerHTML.slice(0, 400));
    });

    console.log(
      "  [role=option] in document:",
      document.querySelectorAll('[role="option"]').length
    );
    console.log(
      "  [role=listbox] in document:",
      document.querySelectorAll('[role="listbox"]').length
    );

    const candidates = menuCandidates(input);
    console.log("  candidates:", candidates.length);
    candidates.forEach((c, i) => {
      const verdict = validateMenu(c);
      console.log(
        "   [" + i + "] via=" + c.via + " -> " +
          (verdict.ok ? "OK " + verdict.rows.length + " rows" : "REJECTED " + verdict.reason),
        verdict.ok ? verdict.rows.slice(0, 8).map((r) => r.text) : verdict.sample || "",
        c.el
      );
    });

    console.log("  --- ancestors of the input ---");
    let node = input.parentElement;
    for (let d = 0; node && d < 8; d++, node = node.parentElement) {
      console.log(
        "   [" + d + "] <" + node.tagName.toLowerCase() + "> fieldInputs=" +
          fieldInputCount(node) + " options=" +
          node.querySelectorAll('[role="option"]').length + " class=" +
          String(node.className).slice(0, 70)
      );
    }

    console.log("%c  --- typing probe ---", "color:#2563eb;font-weight:700");
    const beforeTyping = new Set(document.querySelectorAll("*"));
    setNativeValue(input, "a");
    await wait(1500);
    const typed = Array.from(document.querySelectorAll("*")).filter(
      (el) => !beforeTyping.has(el)
    );
    console.log("  typing 'a' produced " + typed.length + " new element(s)");
    const typedRoots = typed.filter((el) => !typed.includes(el.parentElement));
    typedRoots.slice(0, 6).forEach((el, i) => {
      console.log(
        "   typed-root[" + i + "] <" + el.tagName.toLowerCase() + "> class=" +
          String(el.className).slice(0, 60) + " -> " +
          norm(el.textContent).slice(0, 160)
      );
    });
    console.log(
      "  [role=option] after typing:",
      document.querySelectorAll('[role="option"]').length
    );
    const after = resolveMenu(input);
    console.log(
      "  resolve after typing:",
      after.ok
        ? after.rows.length + " rows: " + after.rows.slice(0, 8).map((r) => r.text).join(", ")
        : after.reason + " " + after.detail
    );

    await closeAll();
  }

  // ------------------------------------------------------------------ run

  if (MODE === "diagnose") {
    await diagnose(DIAGNOSE_FIELD);
    return;
  }

  console.log("%cScraping Depop listing fields...", "color:#111;font-weight:700");

  if (CONFIG.fields.every((f) => !document.getElementById(f.input))) {
    return console.error(
      "%cNone of the expected inputs exist. Are you on /products/create/ ?",
      "color:#b91c1c;font-weight:700"
    );
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
  }

  await closeAll();

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
    console.log(
      '%cTo investigate one: set MODE = "diagnose" and DIAGNOSE_FIELD to it, ' +
        "then re-run and paste the output.",
      "color:#6b7280"
    );
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
