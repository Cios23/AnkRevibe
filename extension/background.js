// AnK ReVibe crosslister — service worker.
//
// Ported from the ResellOS extension, scoped to Poshmark and Depop only.
// eBay is handled server-side through the Sell API (lib/platforms/ebay.ts),
// so it has no extension surface here. Mercari and Facebook were dropped
// with the rest of the ResellOS platform set.
//
// Responsibilities:
//   - open a marketplace's create page and hand the listing to its content
//     script once the page is ready
//   - run the scheduled jobs: Poshmark share, Poshmark offers-to-likers,
//     Depop relist
//   - write results back to Supabase (lib/sync.js)
//   - fetch listing photos on behalf of content scripts, which cannot read
//     cross-origin images the marketplace page has no CORS access to

importScripts("config.js", "lib/sync.js");

const EXT_VERSION = "0.1.0";

const PLATFORM_URL_SNIPPETS = {
  poshmark: "poshmark.com/create-listing",
  depop: "depop.com/products/create",
};

const PLATFORM_OPEN_URL = {
  poshmark: "https://poshmark.com/create-listing",
  depop: "https://www.depop.com/products/create/",
};

const TOKEN_KEYS = ["supabase_token", "ankrevibe_token"];

function readToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(TOKEN_KEYS, (data) => {
      resolve(data.supabase_token || data.ankrevibe_token || null);
    });
  });
}

/**
 * Content scripts are not guaranteed to be listening the instant a tab
 * reports complete, so retry until one answers.
 */
function sendTabMessageWithRetry(tabId, message, attempt = 0) {
  const maxAttempts = 45;
  if (attempt > maxAttempts) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      setTimeout(
        () => sendTabMessageWithRetry(tabId, message, attempt + 1),
        1000
      );
    }
  });
}

// ------------------------------------------------------------------ alarms

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["share_frequency_hours"], (s) => {
    const hours = s.share_frequency_hours ?? 8;
    const shareMins = Math.max(1, Math.round(Number(hours) * 60));
    try {
      chrome.alarms.create("poshmark-share", { periodInMinutes: shareMins });
      chrome.alarms.create("send-offers", { periodInMinutes: 720 });
      chrome.alarms.create("check-offers", { periodInMinutes: 60 });
      chrome.alarms.create("depop-relist", { periodInMinutes: 1440 });
      chrome.alarms.create("depop-delist-queue", { periodInMinutes: 30 });
    } catch {
      /* alarms unavailable */
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poshmark-share") return void onShareAlarm();
  if (alarm.name === "send-offers") return void onOffersAlarm();
  if (alarm.name === "check-offers") return void onCheckOffersAlarm();
  if (alarm.name === "depop-relist") return void doDepopRelist(false);
  if (alarm.name === "depop-delist-queue") return void drainDepopDelistQueue();
});

const POSHMARK_PATTERNS = ["https://poshmark.com/*", "https://*.poshmark.com/*"];

function onShareAlarm() {
  chrome.storage.local.get(["auto_share_enabled"], (prefs) => {
    if (!prefs.auto_share_enabled) return;
    chrome.tabs.query({ url: POSHMARK_PATTERNS }, (tabs) => {
      if (chrome.runtime.lastError) return;
      if (tabs?.length && tabs[0].id != null) {
        sendTabMessageWithRetry(tabs[0].id, { type: "START_SHARE" });
        return;
      }
      chrome.tabs.create(
        { url: "https://poshmark.com/closet", active: false },
        (tab) => {
          if (chrome.runtime.lastError || tab?.id == null) return;
          setTimeout(
            () => sendTabMessageWithRetry(tab.id, { type: "START_SHARE" }),
            5000
          );
        }
      );
    });
  });
}

function onOffersAlarm() {
  chrome.storage.local.get(
    [
      "auto_offers_enabled",
      "offer_discount_percent",
      "offer_min_profit",
      "offer_require_known_cost",
    ],
    async (prefs) => {
      if (!prefs.auto_offers_enabled) return;

      // Margin needs purchase_cost, which only Supabase has.
      const token = await readToken();
      const costMap = await globalThis.AnkSync.fetchPoshmarkCostMap(token);

      chrome.tabs.create(
        { url: "https://poshmark.com/closet", active: false },
        (tab) => {
          if (chrome.runtime.lastError || tab?.id == null) return;
          setTimeout(() => {
            sendTabMessageWithRetry(tab.id, {
              type: "SEND_OFFERS",
              settings: {
                discountPercent: prefs.offer_discount_percent ?? 10,
                minProfit: prefs.offer_min_profit ?? 10,
                requireKnownCost: prefs.offer_require_known_cost !== false,
                costMap,
              },
            });
          }, 5000);
        }
      );
    }
  );
}

function onCheckOffersAlarm() {
  chrome.storage.local.get(
    [
      "auto_accept_enabled",
      "accept_floor_percent",
      "accept_min_profit",
      "offer_require_known_cost",
    ],
    async (prefs) => {
      if (!prefs.auto_accept_enabled) return;

      const token = await readToken();
      const costMap = await globalThis.AnkSync.fetchPoshmarkCostMap(token);

      chrome.tabs.query({ url: POSHMARK_PATTERNS }, (tabs) => {
        if (chrome.runtime.lastError || !tabs?.length || tabs[0].id == null) return;
        sendTabMessageWithRetry(tabs[0].id, {
          type: "CHECK_OFFERS",
          settings: {
            acceptFloorPercent: prefs.accept_floor_percent ?? 10,
            minProfit: prefs.accept_min_profit ?? 10,
            requireKnownCost: prefs.offer_require_known_cost !== false,
            costMap,
          },
        });
      });
    }
  );
}

// ----------------------------------------------------------- depop relist

let depopRelistInProgress = false;

/**
 * Depop surfaces recently-touched listings first, so opening a listing and
 * re-saving it without changes pushes it back to the top of the feed. There
 * is no API for this - it is a scripted edit-then-save.
 *
 * Works through the oldest N% of listings we have URLs for.
 */
async function doDepopRelist(skipDailyGate) {
  if (depopRelistInProgress) return;
  depopRelistInProgress = true;

  try {
    const prefs = await new Promise((resolve) => {
      chrome.storage.local.get(
        ["depop_listing_urls", "depop_relist_percent", "depop_last_relist_date"],
        resolve
      );
    });

    if (!skipDailyGate && prefs.depop_last_relist_date === new Date().toDateString()) {
      return;
    }

    const urls = Array.isArray(prefs.depop_listing_urls) ? prefs.depop_listing_urls : [];
    if (!urls.length) return;

    const percent = Math.min(100, Math.max(1, Number(prefs.depop_relist_percent) || 10));
    const count = Math.max(1, Math.round(urls.length * (percent / 100)));
    const toRelist = urls.slice(-count); // oldest sit at the end of a newest-first list

    let reposted = 0;

    for (const listingUrl of toRelist) {
      await new Promise((resolve) => {
        chrome.tabs.create({ url: listingUrl, active: false }, (tab) => {
          if (chrome.runtime.lastError || !tab?.id) return resolve();
          const tabId = tab.id;
          setTimeout(async () => {
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                  (async () => {
                    await wait(1500);
                    const editBtn = document.querySelector(
                      [
                        'a[href*="/edit"]',
                        'button[aria-label*="edit" i]',
                        '[data-testid*="edit"]',
                      ].join(", ")
                    );
                    if (!editBtn) return;
                    editBtn.click();
                    await wait(2000);
                    const saveBtn = document.querySelector(
                      [
                        'button[type="submit"]',
                        'button[data-testid*="save"]',
                        'button[aria-label*="save" i]',
                      ].join(", ")
                    );
                    if (saveBtn) saveBtn.click();
                    await wait(1000);
                    setTimeout(() => {
                      chrome.runtime.sendMessage({ type: "CLOSE_TAB" });
                    }, 12000);
                  })();
                },
              });
              reposted++;
            } catch {
              /* tab navigated away or injection blocked */
            }
            resolve();
          }, 3000);
        });
      });
      await new Promise((r) => setTimeout(r, 2500));
    }

    chrome.storage.local.set({
      depop_last_relist_date: new Date().toDateString(),
      depop_last_relist_count: reposted,
    });
  } finally {
    depopRelistInProgress = false;
  }
}

// ------------------------------------------------------ depop delist queue

let delistQueueRunning = false;

/**
 * Take down Depop listings the server has flagged.
 *
 * Depop has no delist API, so recordSale can only mark the row
 * `pending_delist`; the listing stays live until this runs. Each row gets
 * its own background tab, the content script drives the UI, and the row is
 * updated from what the script actually observed.
 */
async function drainDepopDelistQueue() {
  if (delistQueueRunning) return;
  delistQueueRunning = true;

  const summary = { attempted: 0, delisted: 0, failed: 0, reasons: [] };

  try {
    const token = await readToken();
    if (!token) return;

    const pending = await globalThis.AnkSync.fetchPendingDelists(token, "depop");
    if (!pending.length) return;

    for (const row of pending) {
      if (!row.platform_url) {
        summary.failed++;
        summary.reasons.push("no listing url");
        await globalThis.AnkSync.recordDelistResult(token, row.id, false);
        continue;
      }

      summary.attempted++;
      const result = await delistOneDepopListing(row.platform_url);

      if (result?.ok) {
        summary.delisted++;
      } else {
        summary.failed++;
        summary.reasons.push(result?.reason || "unknown");
        // Keep what the page actually offered - this is what turns an
        // unverified selector guess into a one-line fix.
        if (result?.found) {
          chrome.storage.local.set({ depop_delist_last_page_controls: result.found });
        }
      }

      await globalThis.AnkSync.recordDelistResult(token, row.id, Boolean(result?.ok));
      await new Promise((r) => setTimeout(r, 2500));
    }
  } finally {
    delistQueueRunning = false;
    chrome.storage.local.set({
      depop_delist_last_run: new Date().toISOString(),
      depop_delist_last_summary: summary,
    });
  }
}

/** Open one listing, ask the content script to end it, close the tab. */
function delistOneDepopListing(listingUrl) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: listingUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        resolve({ ok: false, reason: "tab-failed" });
        return;
      }
      const tabId = tab.id;
      // Give the SPA time to render before the script looks for controls.
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "DEPOP_DELIST" }, (response) => {
          const err = chrome.runtime.lastError;
          try {
            chrome.tabs.remove(tabId);
          } catch {
            /* already closed */
          }
          resolve(err ? { ok: false, reason: "no-content-script" } : response);
        });
      }, 4000);
    });
  });
}

// ---------------------------------------------------------------- messages

function notifyFillWithRetry(tabId, listing, attempt = 0) {
  const maxAttempts = 20;
  chrome.tabs.sendMessage(tabId, { type: "FILL_FORM", listing }, () => {
    if (chrome.runtime.lastError && attempt < maxAttempts) {
      setTimeout(() => notifyFillWithRetry(tabId, listing, attempt + 1), 400);
    }
  });
}

/**
 * Fetch an image the content script cannot reach.
 *
 * Marketplace pages have no CORS access to i.ebayimg.com, which is where
 * every imported photo currently lives. The service worker does, via
 * host_permissions, so it fetches and hands back a data URL.
 */
async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(binary);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FETCH_IMAGE" && message.url) {
    fetchImageAsDataUrl(message.url)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  if (message?.type === "MANUAL_DEPOP_DELIST") {
    void drainDepopDelistQueue();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "MANUAL_DEPOP_RELIST") {
    void doDepopRelist(true);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "CROSSPOST_COMPLETE") {
    // Depop relist works off listing URLs we have seen created.
    if (message.platform === "depop" && message.listingUrl) {
      chrome.storage.local.get(["depop_listing_urls"], (d) => {
        const arr = Array.isArray(d.depop_listing_urls) ? d.depop_listing_urls : [];
        arr.unshift(message.listingUrl);
        if (arr.length > 5000) arr.splice(5000);
        chrome.storage.local.set({ depop_listing_urls: arr });
      });
    }

    void (async () => {
      const token = await readToken();
      if (!token || !message.inventoryId) return;
      await globalThis.AnkSync.saveCrosspost(token, {
        inventoryId: message.inventoryId,
        platform: message.platform,
        platformUrl: message.listingUrl,
        platformListingId: message.listingId,
        price: message.price,
      });
      await globalThis.AnkSync.markInventoryActive(token, message.inventoryId);
    })();
    return false;
  }

  if (message?.type === "SHARE_COMPLETE") {
    // No shares table in the schema; keep a local tally for the popup.
    chrome.storage.local.set({
      last_share_count: message.count,
      last_share_at: new Date().toISOString(),
    });
    return false;
  }

  if (message?.type === "OFFERS_COMPLETE") {
    chrome.storage.local.set({
      last_offers_count: message.count,
      last_offers_at: new Date().toISOString(),
    });
    return false;
  }

  if (message?.type === "ANKREVIBE_AUTH" && message.token) {
    chrome.storage.local.set({
      ankrevibe_token: message.token,
      supabase_token: message.token,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "OPEN_AND_FILL") {
    const { platform, listing } = message;
    const url = PLATFORM_OPEN_URL[platform];
    if (!url || !listing) {
      sendResponse({ success: false, error: "bad_request" });
      return false;
    }
    chrome.storage.local.set(
      { pendingListing: listing, targetPlatform: platform },
      () => {
        chrome.tabs.create({ url }, (tab) => {
          if (chrome.runtime.lastError || !tab?.id) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError?.message,
            });
            return;
          }
          sendResponse({ success: true, tabId: tab.id });
        });
      }
    );
    return true;
  }

  if (message?.type === "CHECK_EXTENSION") {
    sendResponse({ installed: true, version: EXT_VERSION });
    return false;
  }

  if (message?.type === "CLOSE_TAB") {
    if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id);
    return false;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) return;
  chrome.storage.local.get(["pendingListing", "targetPlatform"], (data) => {
    if (!data.pendingListing || !data.targetPlatform) return;
    const snippet = PLATFORM_URL_SNIPPETS[data.targetPlatform];
    if (!snippet || tab.url.indexOf(snippet) === -1) return;
    notifyFillWithRetry(tabId, data.pendingListing);
  });
});
