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
   * Category is split across TWO fields on the live page.
   *
   *   Category field     a nested picker holding department THEN category.
   *                      Choosing a category selects it and closes the panel,
   *                      leaving e.g. "Women Other" in the field.
   *   Subcategory field  a SEPARATE dropdown, "Select Subcategory
   *                      (optional)", which only populates once a category
   *                      is set.
   *
   * Both container classes are confirmed. Treating subcategory as a third
   * level of the first picker is what made a scrape of every Women category
   * return an empty subcategory list - that level does not exist there.
   */
  const SEL_CATEGORY_CONTAINER = [
    "div.listing-editor__category-container",
    '[class*="listing-editor__category-container"]',
  ];

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
   * Set Department > Category in the first field, then Subcategory in the
   * second.
   *
   * Subcategory is labelled optional by Poshmark, so failing to set it does
   * NOT fail the fill - the listing is still correctly categorised without
   * it, and refusing to fill anything over an optional field would be worse
   * than filling most of it. It is reported so a wrong name in our mapping
   * table still surfaces.
   */
  async function fillCategory(path) {
    if (!Array.isArray(path) || path.length < 2) {
      return { ok: false, reason: "no-mapping" };
    }

    const container = firstContainer(SEL_CATEGORY_CONTAINER);
    if (!container) {
      return { ok: false, reason: "no-container", step: "category" };
    }

    // Two levels, one picker.
    const main = await globalThis.AnkDropdown.selectNestedPath(container, [
      path[0],
      path[1],
    ]);
    if (!main.ok) return Object.assign({ step: "category" }, main);

    if (!path[2]) return { ok: true, trace: main.trace };

    const subContainer = firstContainer(SEL_SUBCATEGORY_CONTAINER);
    if (!subContainer) {
      return {
        ok: true,
        trace: main.trace,
        subcategory: { ok: false, reason: "no-subcategory-field" },
      };
    }

    const sub = await globalThis.AnkDropdown.selectNestedPath(subContainer, [
      path[2],
    ]);

    return {
      ok: true,
      trace: sub.ok ? [...main.trace, ...sub.trace] : main.trace,
      subcategory: sub,
    };
  }

  const SEL_SIZE_CONTAINER = [
    "div.listing-editor__size-container",
    '[class*="listing-editor__size-container"]',
    '[data-vv-name="size"]',
  ];

  const SEL_COLOR_CONTAINER = [
    "div.listing-editor__color-container",
    '[class*="listing-editor__color-container"]',
  ];

  /**
   * Size is a picker, not a text box.
   *
   * Poshmark groups sizes by type, so the mapped value may sit one level
   * down; both a direct hit and a one-level drill are attempted. Typing into
   * it does not stick, which is why the old setNativeValue call left size
   * blank on listings that looked filled.
   */
  async function fillSize(size) {
    if (!size) return { ok: false, reason: "no-mapping" };

    const container = firstContainer(SEL_SIZE_CONTAINER);
    if (!container) return { ok: false, reason: "no-container", step: "size" };

    const direct = await globalThis.AnkDropdown.selectNestedPath(container, [size]);
    if (direct.ok) return direct;

    // Grouped under a size type ("Standard", "Juniors"...): try one level in.
    const grouped = await globalThis.AnkDropdown.selectNestedPath(container, [
      "Standard",
      size,
    ]);
    return grouped.ok ? grouped : direct;
  }

  /**
   * Colours are swatches with visible labels, and Poshmark accepts at most
   * two - the mapping layer has already capped the list, so this fills what
   * it is given rather than deciding.
   */
  async function fillColors(colors) {
    if (!Array.isArray(colors) || !colors.length) {
      return { ok: false, reason: "no-mapping" };
    }

    const container = firstContainer(SEL_COLOR_CONTAINER);
    if (!container) return { ok: false, reason: "no-container", step: "color" };

    const missed = [];
    for (const color of colors) {
      const result = await globalThis.AnkDropdown.selectNestedPath(container, [color]);
      if (!result.ok) missed.push(color);
    }

    return missed.length
      ? { ok: false, reason: "not-found", missed }
      : { ok: true };
  }

  /**
   * New With Tags is a toggle, not a condition dropdown - Poshmark has no
   * condition field at all, which is why the mapping layer returns a boolean
   * here and a string everywhere else.
   */
  function setNwt(nwt) {
    if (!nwt) return { ok: true, skipped: true };

    const candidates = Array.from(
      document.querySelectorAll('button, [role="switch"], [role="checkbox"], label')
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text === "new with tags" || text === "nwt") {
        el.click();
        return { ok: true };
      }
    }
    return { ok: false, reason: "toggle-not-found" };
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
      // the difference as a discount. The figure comes from lib/crosslist so
      // the rule lives in one place - the local multiplier that used to be
      // here was a second copy of it.
      const original =
        Number.isFinite(Number(listing.originalPrice)) && Number(listing.originalPrice) >= price
          ? Number(listing.originalPrice)
          : Math.max(price, Math.round(price * 1.8));
      setNativeValue(originalEl, String(original));
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
        if (categoryResult.ok && categoryResult.subcategory && !categoryResult.subcategory.ok) {
          // Optional field, so the listing still stands - but a miss here is
          // usually a wrong name in our mapping table.
          chrome.storage.local.set({
            poshmark_subcategory_last_failure: {
              at: new Date().toISOString(),
              wanted: listing.categoryPath[2],
              ...categoryResult.subcategory,
            },
          });
        }
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

      // Size, colour and NWT all come from lib/crosslist already resolved.
      const misses = [];

      try {
        const sizeResult = await fillSize((listing.size || "").trim());
        if (!sizeResult.ok) misses.push({ label: "size", ...sizeResult });
      } catch (err) {
        misses.push({ label: "size", reason: err?.message || "threw" });
      }

      try {
        const colorResult = await fillColors(listing.colors);
        if (!colorResult.ok) misses.push({ label: "colour", ...colorResult });
      } catch (err) {
        misses.push({ label: "colour", reason: err?.message || "threw" });
      }

      try {
        const nwtResult = setNwt(listing.nwt);
        if (!nwtResult.ok) misses.push({ label: "new-with-tags", ...nwtResult });
        await wait(200);
      } catch (err) {
        misses.push({ label: "new-with-tags", reason: err?.message || "threw" });
      }

      if (misses.length) {
        // A value our table holds that the form will not take means the
        // table is wrong; keep it rather than lose it.
        chrome.storage.local.set({
          poshmark_field_last_failures: {
            at: new Date().toISOString(),
            inventoryId: listing.inventoryId || null,
            misses: misses,
          },
        });
      }

      showProgress(6, 6, "Done");
      await wait(500);
      removeProgress();

      const msg = photoMessage("Poshmark", photos.attempted, photos.succeeded);
      if (misses.length) {
        showNotification(
          msg.text + " — check by hand: " + misses.map((m) => m.label).join(", "),
          "error"
        );
      } else {
        showNotification(msg.text, msg.type);
      }

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
