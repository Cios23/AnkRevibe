// Poshmark create-listing — AnK ReVibe crosslist fill.
// URL: https://poshmark.com/create-listing
//
// Ported from the ResellOS extension. Shared DOM helpers now live in
// lib/dom.js (loaded first by the manifest) rather than being duplicated
// here and in depop.js.
(function () {
  "use strict";

  const {
    wait,
    waitForBody,
    findElement,
    setNativeValue,
    showNotification,
    showProgress,
    removeProgress,
    attachPhotos,
    photoMessage,
    clearPending,
    captureMeta,
    getPendingListing,
    watchForNavigation,
  } = globalThis.AnkDom;

  const PLATFORM = "poshmark";
  const MAX_PHOTOS = 8;

  let fillStarted = false;
  /** Survives clearPending() so the post-submit URL capture can still report. */
  let crosspostMeta = null;
  let navigationWatched = false;
  let crosspostSent = false;

  const SEL_TITLE = [
    'input[data-vv-name="title"]',
    'input[id*="title"]',
    'input[name="title"]',
    'input[placeholder*="title" i]',
    'input[placeholder*="what are you selling" i]',
    'input[maxlength="80"]',
    'form input[type="text"]:first-of-type',
  ];

  const SEL_DESCRIPTION = [
    'textarea[data-vv-name="description"]',
    'textarea[id*="description"]',
    'textarea[name="description"]',
    'textarea[placeholder*="describe" i]',
    'textarea[placeholder*="what" i]',
    "form textarea:first-of-type",
  ];

  const SEL_PRICE = [
    'input[data-vv-name="listingPrice"]',
    'input[id*="price"]',
    'input[name*="price" i]',
    'input[placeholder*="price" i]',
    'input[type="number"]',
  ];

  /**
   * Category picker - OBSERVED on the live create-listing page.
   *
   * It is a single nested text list, not three separate dropdowns: opening
   * it shows departments, clicking one replaces the list with that
   * department's categories, and clicking a category replaces it again with
   * subcategories. So the container is opened ONCE and navigated, which is
   * what lib/dropdown.js selectNestedPath does.
   *
   * The tree is never hardcoded here - whatever path lib/crosslist computes
   * is what gets clicked through.
   */
  const SEL_CATEGORY_CONTAINER = [
    "div.listing-editor__category-container",
    '[class*="listing-editor__category-container"]',
  ];

  /**
   * Subcategory has its own container on the page. Some builds finish all
   * three levels inside the first panel; others hand the last level to this
   * one. Both are handled: if the nested walk consumes the whole path we are
   * done, and if it stops with one level left this is tried for the
   * remainder.
   */
  const SEL_SUBCATEGORY_CONTAINER = [
    "div.listing-editor__subcategory-container",
    '[class*="listing-editor__subcategory-container"]',
  ];

  function firstContainer(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * Click through Department > Category > Subcategory.
   *
   * Stops at the first failed level rather than pressing on. Each level's
   * list is generated from the one above, so continuing past a miss selects
   * an arbitrary category rather than an incomplete one - and an item filed
   * somewhere wrong looks correctly listed.
   */
  async function fillCategory(path) {
    if (!Array.isArray(path) || path.length < 2) {
      return { ok: false, reason: "no-mapping" };
    }

    const container = firstContainer(SEL_CATEGORY_CONTAINER);
    if (!container) {
      return { ok: false, reason: "no-container", step: "category" };
    }

    const result = await globalThis.AnkDropdown.selectNestedPath(container, path);
    if (result.ok) return result;

    // The nested walk got partway and the list stopped advancing - the build
    // that splits the final level into its own field. Finish there.
    const consumed = result.trace ? result.trace.length : 0;
    const remaining = path.slice(consumed);

    if (consumed > 0 && remaining.length > 0) {
      const subContainer = firstContainer(SEL_SUBCATEGORY_CONTAINER);
      if (subContainer) {
        const tail = await globalThis.AnkDropdown.selectNestedPath(
          subContainer,
          remaining,
        );
        if (tail.ok) {
          return { ok: true, trace: [...(result.trace || []), ...tail.trace] };
        }
        return { ...tail, reason: tail.reason, viaSubcategoryField: true };
      }
    }

    return result;
  }

  const SEL_BRAND = [
    'input[data-vv-name="brand"]',
    'input[id*="brand"]',
    'input[name="brand"]',
    'input[placeholder*="brand" i]',
    'input[placeholder*="enter a brand" i]',
  ];

  function numericPrice(listing) {
    const n = Number(listing?.price);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Poshmark shows an Original price and a Listing price, and their order in
   * the DOM is not stable, so identify them by placeholder where possible
   * and fall back to document order.
   */
  function fillPriceFields(listing) {
    const price = numericPrice(listing);
    const placeholderOf = (el) => (el?.placeholder || "").toLowerCase();

    const found = [];
    for (const sel of SEL_PRICE) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.tagName === "INPUT" && found.indexOf(el) === -1) found.push(el);
        });
      } catch {
        /* invalid selector */
      }
    }

    let nodes = found.length
      ? found
      : Array.from(
          document.querySelectorAll(
            'input[type="number"], input[inputmode="decimal"], input[type="text"], input:not([type="hidden"])'
          )
        ).filter((el) => {
          const p = placeholderOf(el);
          const name = (el.name || "").toLowerCase();
          const vv = (el.getAttribute("data-vv-name") || "").toLowerCase();
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          return (
            p.indexOf("price") >= 0 ||
            name.indexOf("price") >= 0 ||
            vv.indexOf("price") >= 0 ||
            aria.indexOf("price") >= 0
          );
        });

    nodes = nodes.filter((el, i, a) => a.indexOf(el) === i);

    if (nodes.length >= 2) {
      let originalEl = nodes[0];
      let listingEl = nodes[1];
      for (const el of nodes) {
        const p = placeholderOf(el);
        if (p.indexOf("original") >= 0 || p.indexOf("retail") >= 0 || p.indexOf("msrp") >= 0) {
          originalEl = el;
        }
        if (
          p.indexOf("listing") >= 0 ||
          p.indexOf("your price") >= 0 ||
          p.indexOf("selling") >= 0 ||
          p.indexOf("list price") >= 0
        ) {
          listingEl = el;
        }
      }
      // Poshmark requires an original price >= the listing price; buyers see
      // the difference as a discount.
      setNativeValue(originalEl, String(Math.max(price, Math.round(price * 1.8))));
      setNativeValue(listingEl, String(price));
      return;
    }

    if (nodes.length === 1) setNativeValue(nodes[0], String(price));
  }

  /**
   * Poshmark navigates from /create-listing to /listing/<id> on success, so
   * that transition is the signal the listing actually exists.
   */
  async function captureListingUrl() {
    await wait(2000);
    const url = window.location.href;
    if (url.indexOf("poshmark.com") === -1 || url.indexOf("create-listing") >= 0) return;
    if (crosspostSent || !crosspostMeta) return;

    const parts = url.split("/").filter(Boolean);
    const listingId = parts[parts.length - 1] || "";
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

  async function fillPoshmark(listing) {
    if (!listing) return;

    crosspostMeta = captureMeta(listing);
    crosspostSent = false;

    try {
      await waitForBody();
      showProgress(1, 6, "Loading form...");
      await wait(2000);

      showProgress(2, 6, "Uploading photos...");
      const photos = await attachPhotos(listing.photos || [], MAX_PHOTOS);

      showProgress(3, 6, "Filling title...");
      const titleInput = await findElement(SEL_TITLE, 8000);
      if (titleInput) {
        setNativeValue(titleInput, (listing.title || "").trim().substring(0, 80));
        await wait(500);
      }

      showProgress(4, 6, "Filling description...");
      const descInput = await findElement(SEL_DESCRIPTION, 8000);
      if (descInput) {
        setNativeValue(
          descInput,
          (listing.description || "").trim().substring(0, 1500)
        );
        await wait(500);
      }

      showProgress(5, 6, "Filling category...");
      if (listing.categoryPath) {
        const categoryResult = await fillCategory(listing.categoryPath);
        if (!categoryResult.ok) {
          // Kept so a wrong name in our mapping table is a one-line fix
          // rather than a mystery.
          chrome.storage.local.set({
            poshmark_category_last_failure: {
              at: new Date().toISOString(),
              ...categoryResult,
            },
          });
        }
      }

      showProgress(5, 6, "Filling price & details...");
      try {
        fillPriceFields(listing);
        await wait(400);
      } catch {
        /* price inputs not rendered */
      }

      if ((listing.brand || "").trim()) {
        const brandInput = await findElement(SEL_BRAND, 5000);
        if (brandInput) {
          setNativeValue(brandInput, listing.brand.trim());
          await wait(300);
        }
      }

      if ((listing.size || "").trim()) {
        const sizeInput = document.querySelector(
          'input[placeholder*="size" i], select[name*="size" i], [data-vv-name="size"]'
        );
        if (sizeInput) {
          setNativeValue(sizeInput, listing.size.trim());
          await wait(300);
        }
      }

      showProgress(6, 6, "Done");
      await wait(500);
      removeProgress();

      const msg = photoMessage("Poshmark", photos.attempted, photos.succeeded);
      showNotification(msg.text, msg.type);

      if (!navigationWatched) {
        navigationWatched = true;
        watchForNavigation((url) => {
          if (url.indexOf("create-listing") === -1) void captureListingUrl();
        });
      }
      void captureListingUrl();
      clearPending();
    } catch (err) {
      removeProgress();
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
    const run = () => fillPoshmark(listing);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => setTimeout(run, 800));
    } else {
      setTimeout(run, 800);
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
