/* ===========================================================================
 * Poshmark category picker probe — paste into DevTools on
 * https://poshmark.com/create-listing while signed in.
 *
 * The extension reported: reason "no-rows", level 0, wanted "Men", empty
 * trace, after the full 8s of polling. The container WAS found (a missing one
 * returns "no-container" earlier), so the picker either never opened, or it
 * opened and its rows no longer match .dropdown__link.dropdown__menu__item.
 *
 * Guessing between those has cost several rounds on this codebase already, so
 * this does not guess. It snapshots every element in the document, clicks,
 * and diffs: whatever appears IS the menu, whatever it is called. Then it
 * tests our real selectors against it and says which one would have worked.
 *
 * Nothing here is destructive - it opens a dropdown and reads the DOM. It
 * does not select anything or submit the form.
 * ========================================================================= */
(async function poshmarkCategoryProbe() {
  "use strict";

  // Exactly what extension/lib/dropdown.js uses, so this tests the real thing
  // rather than something similar.
  const SEL_CONTAINER = [
    "div.listing-editor__category-container",
    '[class*="listing-editor__category-container"]',
  ];
  const ROW_SELECTOR = ".dropdown__link.dropdown__menu__item";
  const ROW_FALLBACKS = [
    ".dropdown__menu__item",
    ".dropdown__link",
    '[role="option"]',
    '[role="menuitem"]',
  ];
  const EXCLUDED_ROWS = [/^all categories$/i, /^select category$/i];

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const line = (s) => console.log(s);
  const head = (s) => console.log("%c" + s, "color:#2563eb;font-weight:700");
  const bad = (s) => console.log("%c" + s, "color:#b91c1c;font-weight:700");
  const good = (s) => console.log("%c" + s, "color:#166534;font-weight:700");

  const findings = [];

  head("=== 1. the container ===");

  let container = null;
  for (const selector of SEL_CONTAINER) {
    const el = document.querySelector(selector);
    line(`  ${selector}  ->  ${el ? "FOUND" : "not found"}`);
    if (el && !container) container = el;
  }

  if (!container) {
    bad("  No category container. The extension would report no-container,");
    bad("  but it reported no-rows - so the page has changed since the fill.");
    findings.push("container missing");
    return;
  }

  line(`  visible: ${isVisible(container)}`);
  line(`  class:   ${String(container.className).slice(0, 120)}`);
  line(`  selectedvalue: ${JSON.stringify(container.getAttribute("selectedvalue"))}`);
  line(`  text:    ${norm(container.textContent).slice(0, 160)}`);
  line("  html (first 600 chars):");
  line("    " + container.outerHTML.slice(0, 600));

  head("=== 2. what the driver would click ===");

  const trigger =
    container.querySelector('input, [role="combobox"], [role="button"], button') ||
    container;
  const usedFallback = trigger === container;
  line(
    `  chosen trigger: <${trigger.tagName.toLowerCase()}>` +
      (usedFallback ? "  (FELL BACK TO THE CONTAINER ITSELF)" : "") +
      `  class=${String(trigger.className).slice(0, 80)}`
  );
  if (usedFallback) {
    findings.push(
      "no input/combobox/button inside the container - the driver clicks the " +
        "container itself, which may not open anything"
    );
    bad("  There is no input/[role=combobox]/[role=button]/button in there.");
    bad("  The driver falls back to clicking the container, which often does");
    bad("  nothing on a Vue component that listens on an inner element.");
  }

  line("  clickable-looking descendants:");
  const clickable = Array.from(
    container.querySelectorAll('input,button,[role],[tabindex],[class*="dropdown"]')
  ).filter(isVisible);
  clickable.slice(0, 12).forEach((el, i) => {
    line(
      `    [${i}] <${el.tagName.toLowerCase()}> role=${el.getAttribute("role")} ` +
        `class=${String(el.className).slice(0, 70)} text="${norm(el.textContent).slice(0, 40)}"`
    );
  });
  if (!clickable.length) line("    (none)");

  // ---------------------------------------------------------------- rows
  const countRows = (label) => {
    const report = [];
    for (const sel of [ROW_SELECTOR, ...ROW_FALLBACKS]) {
      let inContainer = 0;
      let inDocument = 0;
      let visibleInDoc = 0;
      let surviving = 0;
      try {
        inContainer = container.querySelectorAll(sel).length;
        const all = Array.from(document.querySelectorAll(sel));
        inDocument = all.length;
        const vis = all.filter(isVisible);
        visibleInDoc = vis.length;
        surviving = vis.filter((el) => {
          const text = norm(el.textContent);
          return text && !EXCLUDED_ROWS.some((re) => re.test(text));
        }).length;
      } catch {
        /* invalid selector */
      }
      report.push({ selector: sel, inContainer, inDocument, visibleInDoc, surviving });
    }
    head(`=== rows ${label} ===`);
    console.table(report);
    return report;
  };

  const before = countRows("BEFORE opening");

  // ------------------------------------------------------- open and diff
  head("=== 3. opening it, and diffing the whole document ===");

  const snapshot = new Set(document.querySelectorAll("*"));

  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  trigger.click();
  await wait(2500);

  let appeared = Array.from(document.querySelectorAll("*")).filter(
    (el) => !snapshot.has(el)
  );
  line(`  after mousedown+click: ${appeared.length} new element(s)`);

  // If nothing happened, work through other ways of opening it. Which one
  // works is the fix.
  if (!appeared.length) {
    bad("  NOTHING appeared. The click did not open the picker.");
    const attempts = [
      {
        name: "click the container itself",
        run: () => container.click(),
      },
      {
        name: "click the first clickable descendant",
        run: () => clickable[0] && clickable[0].click(),
      },
      {
        name: "mousedown on the container",
        run: () =>
          container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      },
      {
        name: "focus + Enter on the trigger",
        run: () => {
          trigger.focus();
          trigger.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
          );
        },
      },
      {
        name: "pointerdown on the trigger",
        run: () =>
          trigger.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true })
          ),
      },
    ];

    for (const attempt of attempts) {
      try {
        attempt.run();
      } catch {
        continue;
      }
      await wait(1200);
      appeared = Array.from(document.querySelectorAll("*")).filter(
        (el) => !snapshot.has(el)
      );
      line(`  "${attempt.name}" -> ${appeared.length} new element(s)`);
      if (appeared.length) {
        good(`  THIS ONE OPENED IT: ${attempt.name}`);
        findings.push("opens via: " + attempt.name);
        break;
      }
    }
  } else {
    findings.push("mousedown+click DOES open it");
  }

  if (appeared.length) {
    const roots = appeared.filter((el) => !appeared.includes(el.parentElement));
    head(`=== 4. what appeared (${roots.length} subtree root(s)) ===`);
    roots.slice(0, 8).forEach((el, i) => {
      line(
        `  root[${i}] <${el.tagName.toLowerCase()}> visible=${isVisible(el)} ` +
          `children=${el.children.length} class=${String(el.className).slice(0, 80)}`
      );
      line(`      text: ${norm(el.textContent).slice(0, 200)}`);
      line(`      html: ${el.outerHTML.slice(0, 500)}`);
    });

    // The decisive question: do OUR selectors match what appeared?
    head("=== 5. do our selectors match what appeared? ===");
    const matchers = [ROW_SELECTOR, ...ROW_FALLBACKS];
    for (const sel of matchers) {
      let hits = 0;
      try {
        hits = appeared.filter((el) => el.matches && el.matches(sel)).length;
      } catch {
        /* invalid */
      }
      line(`  ${sel.padEnd(38)} matches ${hits} of the new elements`);
    }

    // What the rows actually look like, so a correct selector can be written.
    const leaves = appeared
      .filter(isVisible)
      .filter((el) => {
        const text = norm(el.textContent);
        if (!text || text.length > 40) return false;
        return !Array.from(el.children).some(
          (c) => norm(c.textContent) === text
        );
      })
      .slice(0, 20);

    head("=== 6. the visible short-text rows, whatever their class ===");
    leaves.forEach((el, i) => {
      line(
        `  [${i}] "${norm(el.textContent)}"  <${el.tagName.toLowerCase()}> ` +
          `class=${JSON.stringify(String(el.className))}`
      );
    });
    if (!leaves.length) line("  (none - the panel appeared but holds no short labels)");

    const looksRight = leaves.some((el) => /^(women|men|kids|home|pets)$/i.test(norm(el.textContent)));
    if (looksRight) {
      good("  Departments are present - so the rows exist and only the SELECTOR is wrong.");
      findings.push("rows exist; selector is wrong");
    }
  }

  countRows("AFTER opening");

  head("=== SUMMARY (paste this) ===");
  if (!findings.length) findings.push("inconclusive - paste the whole log");
  findings.forEach((f) => line("  - " + f));
  line("");
  line("Paste everything above, or right-click the console -> Save as...");
})();
