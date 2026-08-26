// Poshmark closet / listings — automated "share to followers".
//
// Poshmark ranks a closet partly on recent sharing activity, so re-sharing
// every listing periodically keeps items visible. There is no API for it;
// this clicks through the share menu on each card, paginating to the end.
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poshmark rate-limits aggressive sharing, so keep a human-ish gap. */
  const SHARE_DELAY = 4000;

  const CARD_SELECTORS = [
    ".listing-card",
    '[data-test="listing-card"]',
    ".card--small",
    'li[data-et-element-type="listing"]',
  ].join(", ");

  const SHARE_BTN_SELECTORS = [
    '[data-et-element-type="share_button"]',
    'button[aria-label*="share" i]',
    ".share-btn",
    "button.share",
  ].join(", ");

  const TO_FOLLOWERS_SELECTORS = [
    '[data-et-name="to_followers"]',
    'button[aria-label*="followers" i]',
    ".sharing-menu__item:first-child button",
  ].join(", ");

  const NEXT_SELECTORS = [
    'a[rel="next"]',
    'button[aria-label="next page"]',
    ".pagination__next",
  ].join(", ");

  let shareRunInProgress = false;

  async function shareAllListings() {
    if (shareRunInProgress) return 0;
    shareRunInProgress = true;

    let sharedCount = 0;
    let hasMore = true;

    try {
      while (hasMore) {
        const cards = document.querySelectorAll(CARD_SELECTORS);
        if (!cards.length) break;

        for (const card of cards) {
          try {
            const shareBtn = card.querySelector(SHARE_BTN_SELECTORS);
            if (!shareBtn) continue;

            shareBtn.click();
            await wait(500);

            const toFollowers = document.querySelector(TO_FOLLOWERS_SELECTORS);
            if (toFollowers) {
              toFollowers.click();
              sharedCount++;
              await wait(SHARE_DELAY);
            } else {
              // Menu did not open as expected; dismiss it and move on.
              document.body.click();
              await wait(500);
            }
          } catch {
            /* one card failing must not stop the run */
          }
        }

        const next = document.querySelector(NEXT_SELECTORS);
        if (next) {
          next.click();
          await wait(3000);
        } else {
          hasMore = false;
        }
      }
    } finally {
      shareRunInProgress = false;
    }

    chrome.runtime.sendMessage({
      type: "SHARE_COMPLETE",
      count: sharedCount,
      platform: "poshmark",
    });

    return sharedCount;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "START_SHARE") {
      void (async () => {
        try {
          await shareAllListings();
        } finally {
          sendResponse({ ok: true });
        }
      })();
      return true;
    }
  });
})();
