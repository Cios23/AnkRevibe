// Depop create-listing — AnK ReVibe crosslist fill.
// URL: https://www.depop.com/products/create/
(function () {
  "use strict";

  const {
    wait,
    waitForBody,
    findElement,
    setNativeValue,
    showNotification,
    attachPhotos,
    photoMessage,
    clearPending,
    captureMeta,
    getPendingListing,
    watchForNavigation,
  } = globalThis.AnkDom;

  const PLATFORM = "depop";
  const MAX_PHOTOS = 4;

  let fillStarted = false;
  let crosspostMeta = null;
  let navigationWatched = false;
  let crosspostSent = false;

  const SEL_DESCRIPTION = [
    'input[name="description"]',
    'textarea[name="description"]',
    'input[data-testid*="description"]',
    'textarea[data-testid*="description"]',
    'input[placeholder*="describe" i]',
    'textarea[placeholder*="describe" i]',
    'input[placeholder*="what are you selling" i]',
  ];

  const SEL_PRICE = [
    'input[name="price"]',
    'input[data-testid*="price"]',
    'input[id*="price"]',
    'input[placeholder*="price" i]',
    'input[type="number"]',
  ];

  function numericPrice(listing) {
    const n = Number(listing?.price);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Depop has no separate title field. Its primary visible input is labelled
   * "description" but behaves as the item title, so the title goes there and
   * the long description is dropped.
   */
  function primaryText(listing) {
    const title = (listing.title || "").trim();
    if (title) return title;
    const description = (listing.description || "").trim();
    return description.split("\n")[0].trim() || description;
  }

  /**
   * Depop offers only New / Used as buttons, not a dropdown.
   *
   * Anything eBay would call new-with-tags or new-without-tags maps to New;
   * everything else is Used. Our imported items carry eBay's display names,
   * so match on those as well as our own vocabulary.
   */
  function isNewCondition(condition) {
    const value = (condition || "").toLowerCase();
    if (!value) return false;
    return (
      value.indexOf("new") >= 0 &&
      value.indexOf("pre-owned") === -1 &&
      value.indexOf("preowned") === -1
    );
  }

  function clickConditionButton(isNew) {
    const selectors = isNew
      ? [
          '[data-testid="new-condition"]',
          'button[data-testid="new-condition"]',
          'button[value="new"]',
        ]
      : [
          '[data-testid="used-condition"]',
          'button[data-testid="used-condition"]',
          'button[value="used"]',
        ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  /** Depop navigates to /products/<slug> once the listing is created. */
  async function captureListingUrl() {
    await wait(3000);
    const url = window.location.href;
    if (url.indexOf("depop.com/products/") === -1 || url.indexOf("create") >= 0) return;
    if (crosspostSent || !crosspostMeta) return;

    const match = url.match(/\/products\/([^/?]+)/);
    const listingId = match ? match[1] : null;
    if (!listingId) return;

    crosspostSent = true;
    void chrome.runtime.sendMessage({
      type: "CROSSPOST_COMPLETE",
      platform: PLATFORM,
      listingUrl: url,
      listingId: listingId,
      inventoryId: crosspostMeta.inventoryId,
      price: crosspostMeta.price,
    });
  }

  async function fillDepop(listing) {
    if (!listing) return;

    crosspostMeta = captureMeta(listing);
    crosspostSent = false;

    try {
      await waitForBody();
      await wait(2000);

      const photos = await attachPhotos(listing.photos || [], MAX_PHOTOS);

      const descEl = await findElement(SEL_DESCRIPTION, 10000);
      if (descEl) {
        setNativeValue(descEl, primaryText(listing));
        await wait(500);
      }

      const priceEl = await findElement(SEL_PRICE, 8000);
      if (priceEl) {
        setNativeValue(priceEl, String(numericPrice(listing)));
        await wait(500);
      }

      try {
        if (clickConditionButton(isNewCondition(listing.condition))) {
          await wait(300);
        }
      } catch {
        /* condition buttons not rendered */
      }

      const msg = photoMessage("Depop", photos.attempted, photos.succeeded);
      showNotification(msg.text, msg.type);

      if (!navigationWatched) {
        navigationWatched = true;
        watchForNavigation((url) => {
          if (url.indexOf("depop.com/products/") >= 0 && url.indexOf("create") === -1) {
            void captureListingUrl();
          }
        });
      }
      void captureListingUrl();
      clearPending();
    } catch (err) {
      showNotification(
        "AnK ReVibe: fill interrupted — " + (err?.message || "see console (F12)"),
        "error"
      );
      clearPending();
    }
  }

  function startFill(listing) {
    if (!listing || fillStarted) return;
    fillStarted = true;
    const run = () => fillDepop(listing);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => setTimeout(run, 600));
    } else {
      setTimeout(run, 600);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FILL_FORM" && message.listing) {
      startFill(message.listing);
      sendResponse({ ok: true });
      return false;
    }
  });

  (async function bootstrap() {
    const pending = await getPendingListing(PLATFORM);
    if (pending) startFill(pending);
  })();
})();
