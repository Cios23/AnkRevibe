// Shared DOM helpers for the marketplace content scripts.
//
// The ResellOS originals carried a near-identical copy of all of this in
// both poshmark.js and depop.js. Content scripts listed together in one
// manifest entry share a scope, so this file loads first and both platform
// scripts use it.
(function () {
  "use strict";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Wait for document.body so a MutationObserver has a stable root. */
  async function waitForBody(maxMs = 10000) {
    const start = Date.now();
    while (!document.body && Date.now() - start < maxMs) await wait(50);
    return document.body || document.documentElement;
  }

  /**
   * Resolve the first element matching any selector.
   *
   * Disconnects the observer and clears the timer on success - the ResellOS
   * original leaked both, leaving observers running until their timeout even
   * after resolving.
   */
  const waitForElement = (selectors, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const list = Array.isArray(selectors) ? selectors : [selectors];
      let settled = false;
      let observer;
      let timer;

      const cleanup = () => {
        clearTimeout(timer);
        if (observer) observer.disconnect();
      };

      const check = () => {
        for (const sel of list) {
          try {
            const el = document.querySelector(sel);
            if (el) return el;
          } catch {
            /* selector invalid against a mid-render DOM */
          }
        }
        return null;
      };

      const finish = (el, err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (el) resolve(el);
        else reject(err);
      };

      timer = setTimeout(() => {
        finish(check(), new Error("Timeout waiting for: " + list.join(", ")));
      }, timeout);

      const now = check();
      if (now) return finish(now, null);

      waitForBody().then((root) => {
        if (settled) return;
        const again = check();
        if (again) return finish(again, null);
        observer = new MutationObserver(() => {
          const el = check();
          if (el) finish(el, null);
        });
        observer.observe(root, { childList: true, subtree: true });
      });
    });

  const findElement = async (selectors, timeout = 5000) => {
    try {
      return await waitForElement(selectors, timeout);
    } catch {
      return null;
    }
  };

  /**
   * Set a value on a React/Vue-controlled input.
   *
   * Assigning .value directly is swallowed by the framework's own setter, so
   * this calls the native prototype setter and then fires the events the
   * framework listens for.
   */
  const setNativeValue = (element, value) => {
    if (!element) return;
    const str = value == null ? "" : String(value);

    if (element.tagName === "SELECT") {
      element.value = str;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const proto =
      element.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, str);
    else element.value = str;

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  const NOTIF_ID = "ankrevibe-notif";
  const PROGRESS_ID = "ankrevibe-progress";

  const showNotification = (message, type) => {
    document.getElementById(NOTIF_ID)?.remove();
    const el = document.createElement("div");
    el.id = NOTIF_ID;
    el.style.position = "fixed";
    el.style.top = "20px";
    el.style.left = "50%";
    el.style.transform = "translateX(-50%)";
    el.style.zIndex = "2147483647";
    el.style.background = type === "error" ? "#b91c1c" : "#111827";
    el.style.color = "#fff";
    el.style.padding = "12px 24px";
    el.style.borderRadius = "100px";
    el.style.fontWeight = "600";
    el.style.fontSize = "13px";
    el.style.fontFamily = "-apple-system, system-ui, sans-serif";
    el.style.boxShadow = "0 4px 20px rgba(0,0,0,.35)";
    el.textContent = message;
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const showProgress = (step, total, message) => {
    let bar = document.getElementById(PROGRESS_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = PROGRESS_ID;
      bar.style.position = "fixed";
      bar.style.top = "0";
      bar.style.left = "0";
      bar.style.right = "0";
      bar.style.zIndex = "2147483647";
      bar.style.background = "#0a0a0a";
      bar.style.borderBottom = "1px solid #1f2937";
      bar.style.padding = "10px 20px";
      bar.style.display = "flex";
      bar.style.alignItems = "center";
      bar.style.gap = "12px";
      bar.style.fontFamily = "-apple-system, system-ui, sans-serif";

      const brand = document.createElement("div");
      brand.textContent = "AnK ReVibe";
      brand.style.color = "#fff";
      brand.style.fontWeight = "700";
      brand.style.fontSize = "12px";
      brand.style.whiteSpace = "nowrap";

      const track = document.createElement("div");
      track.style.flex = "1";
      track.style.background = "#1f2937";
      track.style.borderRadius = "100px";
      track.style.height = "4px";

      const fill = document.createElement("div");
      fill.className = "ankrevibe-progress-fill";
      fill.style.background = "#fff";
      fill.style.height = "4px";
      fill.style.borderRadius = "100px";
      fill.style.transition = "width .3s";
      track.appendChild(fill);

      const label = document.createElement("div");
      label.className = "ankrevibe-progress-label";
      label.style.color = "#9ca3af";
      label.style.fontSize = "11px";
      label.style.whiteSpace = "nowrap";

      bar.append(brand, track, label);
      (document.body || document.documentElement).appendChild(bar);
    }

    const pct = Math.round((step / total) * 100);
    bar.querySelector(".ankrevibe-progress-fill").style.width = pct + "%";
    bar.querySelector(".ankrevibe-progress-label").textContent = message;
  };

  const removeProgress = () => document.getElementById(PROGRESS_ID)?.remove();

  /**
   * Turn photo URLs into File objects for a file input.
   *
   * Tries a direct fetch first, then asks the service worker to fetch on our
   * behalf. The direct path fails for hosts that send no CORS headers -
   * i.ebayimg.com among them - and every imported photo currently lives
   * there, so the background fallback is the path that will usually run.
   */
  async function urlsToFiles(urls, limit) {
    const take = urls.slice(0, limit);
    const files = await Promise.all(
      take.map(async (url, i) => {
        let blob = null;
        try {
          const res = await fetch(url, { mode: "cors", credentials: "omit" });
          if (res.ok) blob = await res.blob();
        } catch {
          /* fall through to the background proxy */
        }

        if (!blob) {
          try {
            const proxied = await chrome.runtime.sendMessage({
              type: "FETCH_IMAGE",
              url,
            });
            if (proxied?.dataUrl) {
              const res = await fetch(proxied.dataUrl);
              blob = await res.blob();
            }
          } catch {
            return null;
          }
        }

        if (!blob) return null;
        const mime = blob.type || "image/jpeg";
        const ext = mime.indexOf("png") >= 0 ? "png" : "jpg";
        return new File([blob], "photo_" + i + "." + ext, { type: mime });
      })
    );
    return files.filter(Boolean);
  }

  async function attachPhotos(urls, limit) {
    if (!urls || !urls.length) return { attempted: 0, succeeded: 0 };
    const attempted = urls.slice(0, limit).length;

    const input =
      document.querySelector('input[type="file"][accept*="image" i]') ||
      document.querySelector('input[type="file"]');
    if (!input) return { attempted, succeeded: 0 };

    const files = await urlsToFiles(urls, limit);
    if (!files.length) return { attempted, succeeded: 0 };

    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(3000);
    return { attempted, succeeded: files.length };
  }

  function photoMessage(platform, attempted, succeeded) {
    if (attempted > 0 && succeeded === 0) {
      return {
        text:
          "AnK ReVibe filled your " +
          platform +
          " listing, but photos failed to upload. Add them manually.",
        type: "error",
      };
    }
    if (attempted > 0 && succeeded < attempted) {
      return {
        text:
          "AnK ReVibe filled your " +
          platform +
          " listing. Some photos failed to upload.",
        type: "success",
      };
    }
    return {
      text: "AnK ReVibe filled your " + platform + " listing.",
      type: "success",
    };
  }

  function clearPending() {
    chrome.storage.local.remove(["pendingListing", "targetPlatform"]);
  }

  /** Identifiers the background needs to write the crosspost back. */
  function captureMeta(listing) {
    const inventoryId = listing?.inventoryId ?? listing?.inventory_id;
    if (!inventoryId) return null;
    return { inventoryId, price: listing.price };
  }

  /** Read a pending listing queued by the popup, if it targets this platform. */
  function getPendingListing(platform) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["pendingListing", "targetPlatform"], (data) => {
        if (!data.pendingListing) return resolve(null);
        if (data.targetPlatform && data.targetPlatform !== platform) {
          return resolve(null);
        }
        resolve(data.pendingListing);
      });
    });
  }

  /**
   * Watch for the SPA navigating away from the create page, which is how
   * both Poshmark and Depop signal that a listing was actually created.
   */
  function watchForNavigation(onNavigate) {
    let lastUrl = location.href;
    const check = () => {
      const url = location.href;
      if (url === lastUrl) return;
      lastUrl = url;
      onNavigate(url);
    };
    try {
      new MutationObserver(check).observe(document.documentElement, {
        subtree: true,
        childList: true,
      });
    } catch {
      /* observer unavailable */
    }
    window.addEventListener("popstate", check);
  }

  globalThis.AnkDom = {
    wait,
    waitForBody,
    waitForElement,
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
  };
})();
