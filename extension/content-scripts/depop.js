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
   * The listing form's fields, in the order they are filled.
   *
   * Category first: on a react-select form the later fields can depend on it,
   * and filling in the order a person would is the safest assumption.
   *
   * Every value here was resolved by lib/crosslist before the popup handed
   * the listing over. Nothing on this page maps anything - see
   * lib/crosslist-map.generated.js for why.
   */
  const FIELDS = [
    { id: "condition-input", from: (l) => l.condition, label: "condition" },
    { id: "colour-input", from: (l) => (l.colors || [])[0], label: "colour" },
    { id: "source-input", from: (l) => l.depopSource, label: "source" },
    { id: "age-input", from: (l) => l.depopAge, label: "age" },
    { id: "style-input", from: (l) => (l.styleTags || [])[0], label: "style" },
  ];

  /**
   * Fill the dropdown fields, collecting rather than throwing.
   *
   * Only category and condition are required by Depop; the rest are optional,
   * so one that cannot be set must not abandon a listing that is otherwise
   * complete. Every miss is recorded, because a value our table holds that
   * the form will not accept means the table is wrong - and that is exactly
   * the bug that had Depop conditions set to strings the form rejects.
   */
  async function fillSelectFields(listing) {
    const misses = [];
    const select = globalThis.AnkDepopSelect;
    if (!select) return misses;

    let categoryOk = false;

    if (Array.isArray(listing.categoryPath) && listing.categoryPath.length) {
      const result = await select.selectCategoryPath(
        "group-input",
        listing.categoryPath
      );
      categoryOk = Boolean(result.ok);
      if (!result.ok) misses.push(Object.assign({ label: "category" }, result));
    } else {
      misses.push({ label: "category", reason: "no-mapping" });
    }

    // The rest wait on the category. On a listing form the later fields are
    // routinely gated behind it - Poshmark disables Size and Colour outright
    // until one is set - and attempting them early does not merely fail, it
    // reports "not found" and buries the real cause.
    if (!categoryOk) {
      for (const field of FIELDS) {
        if (field.from(listing)) {
          misses.push({ label: field.label, reason: "skipped-category-not-set" });
        }
      }
      return misses;
    }

    for (const field of FIELDS) {
      const wanted = field.from(listing);
      if (!wanted) continue;
      const result = await select.selectValue(field.id, wanted);
      if (!result.ok) misses.push(Object.assign({ label: field.label }, result));
    }

    return misses;
  }

  /**
   * Brand is a search-driven autocomplete over a large dataset, not a fixed
   * list, so the value is typed and left for Depop to match. Confirmed by
   * scraping: the default view shows an unrelated sample, and typing returns
   * a different filtered set.
   */
  async function fillBrand(listing) {
    const brand = (listing.brand || "").trim();
    if (!brand) return;
    const input = document.getElementById("brand-input");
    if (!input) return;
    setNativeValue(input, brand);
    await wait(600);
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
        await fillBrand(listing);
      } catch {
        /* brand field not rendered */
      }

      let misses = [];
      try {
        misses = await fillSelectFields(listing);
      } catch (err) {
        misses.push({ label: "dropdowns", reason: err?.message || "threw" });
      }

      if (misses.length) {
        // Kept so a wrong value in our tables is a one-line fix rather than
        // a mystery weeks later.
        chrome.storage.local.set({
          depop_field_last_failures: {
            at: new Date().toISOString(),
            inventoryId: listing.inventoryId || null,
            misses: misses,
          },
        });
      }

      const msg = photoMessage("Depop", photos.attempted, photos.succeeded);
      if (misses.length) {
        // If the category failed it took the rest with it; name that rather
        // than listing every field as though each broke separately.
        const failedCategory = misses.some((m) => m.label === "category");
        showNotification(
          failedCategory
            ? msg.text + " — category could not be set, so the rest were skipped"
            : msg.text + " — check by hand: " + misses.map((m) => m.label).join(", "),
          "error"
        );
      } else {
        showNotification(msg.text, msg.type);
      }

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
