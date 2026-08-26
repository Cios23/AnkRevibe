// Poshmark — offer to likers, and optional auto-accept of incoming offers.
//
// Both are DOM automation; Poshmark exposes no API for either. Runs on
// closet, listing and offer pages.
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const LISTING_CARD_SELECTORS = [
    ".listing-card",
    '[data-test="listing-card"]',
    'li[data-et-element-type="listing"]',
  ].join(", ");

  function setInputValue(el, value) {
    if (!el) return;
    const str = String(value);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (setter) setter.call(el, str);
    else el.value = str;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Poshmark relabels this button often, so fall back to a text scan. */
  function queryOfferToLikersButton() {
    const byAttr = document.querySelector(
      [
        'button[data-et-name="offer_to_likers"]',
        'button[aria-label*="offer to likers" i]',
        ".offer-to-likers-btn",
      ].join(", ")
    );
    if (byAttr) return byAttr;

    for (const btn of document.querySelectorAll("button")) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text.indexOf("offer") >= 0 && text.indexOf("liker") >= 0) return btn;
    }
    return null;
  }

  let offersRunInProgress = false;

  async function sendOffersToLikers(settings) {
    if (offersRunInProgress) return 0;
    offersRunInProgress = true;

    const discountPercent = Number(settings?.discountPercent) || 10;
    const minProfit = Number(settings?.minProfit) || 10;

    let offersSent = 0;

    try {
      const listings = document.querySelectorAll(LISTING_CARD_SELECTORS);

      for (const listing of listings) {
        try {
          listing.click();
          await wait(2000);

          const offerBtn = queryOfferToLikersButton();
          if (!offerBtn) {
            await wait(500);
            window.history.back();
            await wait(1000);
            continue;
          }

          const priceEl = document.querySelector(
            [
              '[data-et-name="listing_price"]',
              ".listing__ipad-centered-content .price",
              'span[data-et-element-type="price"]',
            ].join(", ")
          );
          if (!priceEl) {
            window.history.back();
            await wait(1000);
            continue;
          }

          const currentPrice = parseFloat(
            priceEl.textContent.replace(/[^0-9.]/g, "")
          );
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            window.history.back();
            await wait(1000);
            continue;
          }

          const offerPrice = Math.round(currentPrice * (1 - discountPercent / 100));

          // minProfit is a floor on the offer itself, not true profit - the
          // extension has no visibility of purchase_cost. See README.
          if (offerPrice < minProfit) {
            window.history.back();
            await wait(1000);
            continue;
          }

          offerBtn.click();
          await wait(1500);

          const priceInput = document.querySelector(
            [
              'input[placeholder*="offer" i]',
              'input[name="offer_price"]',
              '.offer-modal input[type="number"]',
            ].join(", ")
          );

          if (priceInput) {
            setInputValue(priceInput, offerPrice.toString());
            await wait(500);

            const submitBtn = document.querySelector(
              [
                'button[data-et-name="send_offer"]',
                'button[aria-label*="send offer" i]',
                '.offer-modal button[type="submit"]',
              ].join(", ")
            );

            if (submitBtn) {
              submitBtn.click();
              offersSent++;
              await wait(2000);
            }
          }

          const closeBtn = document.querySelector(
            [
              'button[aria-label="close" i]',
              ".modal__close",
              ".icon-x-large",
            ].join(", ")
          );
          if (closeBtn) closeBtn.click();

          await wait(500);
          window.history.back();
          await wait(1500);
        } catch {
          try {
            window.history.back();
            await wait(1000);
          } catch {
            /* navigation blocked */
          }
        }
      }
    } finally {
      offersRunInProgress = false;
    }

    chrome.runtime.sendMessage({
      type: "OFFERS_COMPLETE",
      count: offersSent,
      platform: "poshmark",
    });

    return offersSent;
  }

  /**
   * Accept incoming offers that are within acceptFloorPercent of list price.
   *
   * Deliberately conservative: anything discounted further is left for a
   * human, because the extension cannot see cost basis.
   */
  async function autoAcceptOffers(settings) {
    const acceptFloorPercent = Number(settings?.acceptFloorPercent) || 10;
    const minProfit = Number(settings?.minProfit) || 10;

    const offers = document.querySelectorAll(
      [
        '[data-et-element-type="offer_received"]',
        ".offer-received-card",
        ".offer-item",
      ].join(", ")
    );

    for (const offer of offers) {
      try {
        const offerPriceEl = offer.querySelector(
          [".offer-price", '[data-et-name="offer_price"]'].join(", ")
        );
        const listPriceEl = offer.querySelector(
          [".list-price", '[data-et-name="listing_price"]'].join(", ")
        );
        if (!offerPriceEl || !listPriceEl) continue;

        const offerPrice = parseFloat(
          offerPriceEl.textContent.replace(/[^0-9.]/g, "")
        );
        const listPrice = parseFloat(
          listPriceEl.textContent.replace(/[^0-9.]/g, "")
        );
        if (!Number.isFinite(offerPrice) || !Number.isFinite(listPrice) || listPrice <= 0) {
          continue;
        }

        const discountPct = ((listPrice - offerPrice) / listPrice) * 100;

        if (discountPct <= acceptFloorPercent && offerPrice >= minProfit) {
          const acceptBtn = offer.querySelector(
            [
              'button[data-et-name="accept_offer"]',
              'button[aria-label*="accept" i]',
              ".accept-offer-btn",
            ].join(", ")
          );
          if (acceptBtn) {
            acceptBtn.click();
            await wait(2000);
          }
        }
      } catch {
        /* one offer failing must not stop the run */
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SEND_OFFERS") {
      void (async () => {
        try {
          await sendOffersToLikers(msg.settings || {});
        } finally {
          sendResponse({ ok: true });
        }
      })();
      return true;
    }
    if (msg?.type === "CHECK_OFFERS") {
      void (async () => {
        try {
          await autoAcceptOffers(msg.settings || {});
        } finally {
          sendResponse({ ok: true });
        }
      })();
      return true;
    }
  });
})();
