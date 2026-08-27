// Depop — end a listing.
//
// Depop has no delist API, and no API at all for sellers, so this drives
// their UI. It runs on a listing page and works through: open the listing's
// own menu -> find a control that removes or ends it -> confirm.
//
// ⚠️ EVERY SELECTOR AND LABEL BELOW IS UNVERIFIED. Depop returns HTTP 403 to
// any scripted request, so their markup could not be inspected while writing
// this, and the seller controls sit behind a login in any case. The strings
// are the plausible wordings ("Delete", "Remove listing", "Mark as sold"),
// not observed ones.
//
// Two consequences, both deliberate:
//
//   1. It never guesses. If it cannot find a control it reports exactly what
//      it looked for and what it found on the page, so one real run turns
//      this from a guess into a fix. It does NOT click something
//      approximately right - on a page with a delete button, a wrong click
//      is destructive.
//   2. It never reports success it did not observe. The caller only marks a
//      listing delisted when this says it confirmed one.
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Candidate wordings for ending a listing, best first.
   *
   * "Mark as sold" is deliberately last: on Depop it may record a sale
   * rather than merely removing the listing, which is a different action
   * with different consequences. Only used if nothing else is present.
   */
  const END_LABELS = [
    "delete listing",
    "delete item",
    "delete",
    "remove listing",
    "remove item",
    "remove",
    "end listing",
    "archive",
    "mark as sold",
  ];

  const MENU_LABELS = ["more", "options", "manage", "edit listing", "actions"];

  const CONFIRM_LABELS = ["delete", "confirm", "yes", "remove", "ok"];

  /** Every clickable thing on the page, with its visible text. */
  function clickables() {
    const nodes = document.querySelectorAll(
      'button, a[href], [role="button"], [role="menuitem"]'
    );
    return Array.from(nodes).map((el) => ({
      el,
      text: (el.textContent || "").trim().toLowerCase(),
      label: (
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("data-testid") ||
        ""
      ).toLowerCase(),
    }));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** Whole-word matching lives in lib/labels.js so it can be unit-tested. */
  function findByLabel(labels) {
    const candidates = clickables().filter((c) => isVisible(c.el));
    const hit = globalThis.AnkLabels.findByLabels(candidates, labels);
    if (!hit) return null;
    return { el: hit.candidate.el, matched: hit.matched, via: hit.via };
  }

  /** What the page offered, so a failed run is diagnosable in one pass. */
  function pageInventory() {
    return clickables()
      .filter((c) => isVisible(c.el) && (c.text || c.label))
      .slice(0, 40)
      .map((c) => c.text || c.label);
  }

  async function endListing() {
    await wait(1500);

    // Some layouts show the control directly; others hide it behind a menu.
    let target = findByLabel(END_LABELS);

    if (!target) {
      const menu = findByLabel(MENU_LABELS);
      if (menu) {
        menu.el.click();
        await wait(1200);
        target = findByLabel(END_LABELS);
      }
    }

    if (!target) {
      return {
        ok: false,
        reason: "no-control",
        lookedFor: END_LABELS,
        found: pageInventory(),
      };
    }

    target.el.click();
    await wait(1200);

    // A destructive action usually asks twice. If a confirm appears, take it;
    // if none does, the first click may already have been enough.
    const confirm = findByLabel(CONFIRM_LABELS);
    let confirmed = false;
    if (confirm && confirm.el !== target.el) {
      confirm.el.click();
      confirmed = true;
      await wait(2000);
    }

    return {
      ok: true,
      matched: target.matched,
      via: target.via,
      confirmed,
      // Whether it actually came down cannot be established from this page;
      // the caller re-checks. Saying otherwise would be a guess.
      verified: false,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "DEPOP_DELIST") return;
    void (async () => {
      try {
        sendResponse(await endListing());
      } catch (err) {
        sendResponse({ ok: false, reason: "threw", error: String(err) });
      }
    })();
    return true;
  });
})();
