// Writes crosspost results back to Supabase.
//
// ResellOS POSTed to a `crosspost-sync` Supabase Edge Function. AnK ReVibe
// has no such function, and adding one would mean a second deployable for
// what is a single upsert. Instead this talks to PostgREST directly with the
// signed-in user's access token: the RLS policy on platform_listings grants
// full access to any authenticated user, so the same row the web app would
// write is written here, under the same rules.
//
// Loaded into the service worker via importScripts, after config.js.
(function () {
  "use strict";

  const cfg = () => globalThis.ANKREVIBE_CONFIG;

  function headers(token) {
    return {
      apikey: cfg().SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Record that an item is now listed on a platform.
   *
   * Mirrors lib/operations.ts crosspost(): upsert on the
   * (inventory_id, platform) unique constraint so a repeat crosspost updates
   * the row rather than duplicating it, and clear delisted_at so a relisted
   * item does not look delisted.
   */
  async function saveCrosspost(token, payload) {
    const { inventoryId, platform, platformUrl, platformListingId, price } = payload;
    if (!token || !inventoryId || !platform) {
      return { ok: false, error: "missing inventoryId/platform/token" };
    }

    const url =
      cfg().SUPABASE_URL +
      "/rest/v1/platform_listings?on_conflict=inventory_id,platform";

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: Object.assign(headers(token), {
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify([
          {
            inventory_id: inventoryId,
            platform: platform,
            platform_listing_id: platformListingId ?? null,
            platform_url: platformUrl ?? null,
            status: "active",
            listed_price: price ?? null,
            listed_at: new Date().toISOString(),
            delisted_at: null,
          },
        ]),
      });

      if (!res.ok) {
        return { ok: false, error: "HTTP " + res.status + " " + (await res.text()) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Flip an item to active once it is live somewhere.
   *
   * crosspost() does this server-side; the extension path bypasses that, so
   * an imported draft would otherwise stay `draft` after a successful fill.
   */
  async function markInventoryActive(token, inventoryId) {
    if (!token || !inventoryId) return { ok: false };
    const url =
      cfg().SUPABASE_URL +
      "/rest/v1/inventory?id=eq." +
      encodeURIComponent(inventoryId) +
      "&status=eq.draft";
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify({ status: "active" }),
      });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Build a Poshmark-listing-id -> cost map so the offer automation can
   * reason about margin.
   *
   * offer-sender.js walks Poshmark's own DOM and has no link back to our
   * inventory, so without this it can only compare against the raw offer
   * amount. The key is platform_listings.platform_listing_id, which
   * content-scripts/poshmark.js records as the last path segment of the
   * listing URL - the same value the offer automation reads off a card.
   */
  async function fetchPoshmarkCostMap(token) {
    if (!token) return {};

    const url =
      cfg().SUPABASE_URL +
      "/rest/v1/platform_listings" +
      "?select=platform_listing_id,listed_price,inventory:inventory(id,title,purchase_cost)" +
      "&platform=eq.poshmark&status=eq.active&limit=1000";

    try {
      const res = await fetch(url, { headers: headers(token) });
      if (!res.ok) return {};
      const rows = await res.json();

      const map = {};
      for (const row of rows) {
        if (!row.platform_listing_id) continue;
        const inv = row.inventory;
        map[row.platform_listing_id] = {
          inventoryId: inv?.id ?? null,
          title: inv?.title ?? null,
          purchaseCost:
            inv && inv.purchase_cost != null ? Number(inv.purchase_cost) : null,
          listedPrice: row.listed_price != null ? Number(row.listed_price) : null,
        };
      }
      return map;
    } catch {
      return {};
    }
  }

  /**
   * Listings the server has asked to be taken down but cannot take down
   * itself.
   *
   * recordSale marks Depop rows `pending_delist` rather than `delisted`,
   * precisely because the server cannot do the work. This is the queue.
   */
  async function fetchPendingDelists(token, platform) {
    if (!token) return [];
    const url =
      cfg().SUPABASE_URL +
      "/rest/v1/platform_listings" +
      "?select=id,platform_listing_id,platform_url,inventory_id" +
      "&platform=eq." + encodeURIComponent(platform) +
      "&status=eq.pending_delist&limit=100";
    try {
      const res = await fetch(url, { headers: headers(token) });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /**
   * Record the outcome of a delist attempt.
   *
   * `delisted` is written ONLY when the extension observed the listing come
   * down. A failed attempt goes to `error`, never back to `pending_delist`,
   * so a broken selector cannot spin forever reopening the same tab.
   */
  async function recordDelistResult(token, rowId, success) {
    if (!token || !rowId) return { ok: false };
    const url =
      cfg().SUPABASE_URL + "/rest/v1/platform_listings?id=eq." + encodeURIComponent(rowId);
    const patch = success
      ? { status: "delisted", delisted_at: new Date().toISOString() }
      : { status: "error" };
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify(patch),
      });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  globalThis.AnkSync = {
    saveCrosspost,
    markInventoryActive,
    fetchPoshmarkCostMap,
    fetchPendingDelists,
    recordDelistResult,
  };
})();
