// AnK ReVibe popup — pick an item to crosslist, and configure the
// scheduled automations.
(function () {
  "use strict";

  const cfg = globalThis.ANKREVIBE_CONFIG;

  const SETTINGS = {
    auto_share_enabled: false,
    share_frequency_hours: 8,
    auto_offers_enabled: false,
    offer_discount_percent: 10,
    offer_min_profit: 10,
    auto_accept_enabled: false,
    accept_floor_percent: 10,
    accept_min_profit: 10,
    offer_require_known_cost: true,
    depop_relist_percent: 10,
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- tabs

  function selectTab(which) {
    const items = which === "items";
    $("tab-items").setAttribute("aria-selected", String(items));
    $("tab-settings").setAttribute("aria-selected", String(!items));
    $("panel-items").hidden = !items;
    $("panel-settings").hidden = items;
  }
  $("tab-items").addEventListener("click", () => selectTab("items"));
  $("tab-settings").addEventListener("click", () => selectTab("settings"));

  // --------------------------------------------------------- settings

  function loadSettings() {
    chrome.storage.local.get(Object.keys(SETTINGS), (stored) => {
      for (const [key, fallback] of Object.entries(SETTINGS)) {
        const el = $(key);
        if (!el) continue;
        const value = stored[key] ?? fallback;
        if (el.type === "checkbox") el.checked = Boolean(value);
        else el.value = value;

        el.addEventListener("change", () => {
          const next =
            el.type === "checkbox" ? el.checked : Number(el.value) || fallback;
          chrome.storage.local.set({ [key]: next });

          // The share alarm's period is set at install time, so changing the
          // frequency has to recreate it or the change is invisible.
          if (key === "share_frequency_hours") {
            const mins = Math.max(1, Math.round(Number(next) * 60));
            chrome.alarms.create("poshmark-share", { periodInMinutes: mins });
          }
        });
      }
    });

    chrome.storage.local.get(
      ["last_share_count", "last_share_at", "depop_last_relist_count"],
      (d) => {
        const parts = [];
        if (d.last_share_at) {
          parts.push(
            "Last share: " +
              (d.last_share_count ?? 0) +
              " items, " +
              new Date(d.last_share_at).toLocaleString()
          );
        }
        if (d.depop_last_relist_count != null) {
          parts.push("Last Depop relist: " + d.depop_last_relist_count + " items");
        }
        $("last-run").textContent = parts.join(" · ");
      }
    );
  }

  $("relist-now").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "MANUAL_DEPOP_RELIST" });
    $("relist-now").textContent = "Relist started…";
  });

  $("share-now").addEventListener("click", () => {
    chrome.tabs.query(
      { url: ["https://poshmark.com/*", "https://*.poshmark.com/*"] },
      (tabs) => {
        if (tabs?.length && tabs[0].id != null) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "START_SHARE" });
          $("share-now").textContent = "Sharing…";
        } else {
          $("share-now").textContent = "Open Poshmark first";
        }
      }
    );
  });

  // ------------------------------------------------------------ items

  let allItems = [];

  function token() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["supabase_token", "ankrevibe_token"], (d) =>
        resolve(d.supabase_token || d.ankrevibe_token || null)
      );
    });
  }

  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  async function fetchInventory(accessToken) {
    const headers = {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + accessToken,
    };

    const invUrl =
      cfg.SUPABASE_URL +
      "/rest/v1/inventory?select=id,title,brand,size,condition,description," +
      "purchase_cost,poshmark_price,depop_price" +
      "&status=eq.active&order=created_at.desc&limit=200";

    const res = await fetch(invUrl, { headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const items = await res.json();
    if (!items.length) return [];

    const ids = items.map((i) => i.id).join(",");
    const photoUrl =
      cfg.SUPABASE_URL +
      "/rest/v1/listing_photos?select=inventory_id,url,position&inventory_id=in.(" +
      ids +
      ")&order=position.asc";
    const photoRes = await fetch(photoUrl, { headers });
    const photos = photoRes.ok ? await photoRes.json() : [];

    const byItem = new Map();
    for (const p of photos) {
      if (!byItem.has(p.inventory_id)) byItem.set(p.inventory_id, []);
      byItem.get(p.inventory_id).push(p.url);
    }
    for (const item of items) item.photos = byItem.get(item.id) || [];
    return items;
  }

  function render(items) {
    const container = $("items");
    container.textContent = "";

    if (!items.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No active inventory found.";
      container.appendChild(p);
      return;
    }

    for (const item of items) {
      const card = document.createElement("div");
      card.className = "item";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = item.title || "Untitled";

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [
        item.brand,
        item.size,
        item.condition,
        item.photos.length + " photos",
        item.purchase_cost == null ? "no cost" : "cost $" + item.purchase_cost,
      ]
        .filter(Boolean)
        .join(" · ");

      const buttons = document.createElement("div");
      buttons.className = "buttons";

      // A missing cost does NOT block listing - it only means profit and
      // margin are unknown for this item until one is entered.
      for (const platform of ["poshmark", "depop"]) {
        const price = platform === "poshmark" ? item.poshmark_price : item.depop_price;
        const btn = document.createElement("button");
        btn.textContent =
          platform === "poshmark" ? "Poshmark" : "Depop";
        if (price == null) {
          btn.disabled = true;
          btn.title = "No " + platform + "_price set";
          btn.style.opacity = "0.5";
        }
        btn.addEventListener("click", () => {
          chrome.runtime.sendMessage(
            {
              type: "OPEN_AND_FILL",
              platform,
              listing: {
                inventoryId: item.id,
                title: item.title,
                description: item.description,
                brand: item.brand,
                size: item.size,
                condition: item.condition,
                price,
                // Carried so the listing payload is self-describing. The
                // offer automation does NOT read it from here - it runs on
                // Poshmark pages long after this, and gets costs from the
                // map the background builds. See lib/sync.js.
                purchaseCost:
                  item.purchase_cost == null ? null : Number(item.purchase_cost),
                photos: item.photos,
              },
            },
            () => {
              btn.textContent = "Opened";
              setTimeout(() => window.close(), 400);
            }
          );
        });
        buttons.appendChild(btn);
      }

      card.append(title, meta, buttons);
      container.appendChild(card);
    }
  }

  $("search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    render(
      !q
        ? allItems
        : allItems.filter((i) =>
            [i.title, i.brand, i.size].join(" ").toLowerCase().includes(q)
          )
    );
  });

  (async function init() {
    loadSettings();

    const accessToken = await token();
    if (!accessToken) {
      setStatus("not signed in", "bad");
      $("items").innerHTML =
        '<p class="empty">Open the AnK ReVibe web app and sign in,<br />then reopen this popup.</p>';
      return;
    }

    setStatus("connected", "ok");
    try {
      allItems = await fetchInventory(accessToken);
      render(allItems);
    } catch (err) {
      setStatus("error", "bad");
      $("items").innerHTML =
        '<p class="empty">Could not load inventory.<br />' +
        String(err.message || err) +
        "</p>";
    }
  })();
})();
