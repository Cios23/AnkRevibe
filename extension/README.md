# AnK ReVibe Crosslister (Chrome MV3)

Ported from the ResellOS extension (`F:\Downloads\ai-co-pilot-chat-main\extension`),
scoped to **Poshmark and Depop only** and repointed at the AnK ReVibe Supabase
project.

**Not yet loaded or tested against the live marketplaces.** It parses, the
manifest resolves, and the structure is right; every DOM selector is inherited
unverified. See Assumptions.

## What it does

| Capability | Platform | Where |
|---|---|---|
| Crosslist fill | Poshmark | `content-scripts/poshmark.js` |
| Crosslist fill | Depop | `content-scripts/depop.js` |
| Auto-share to followers | Poshmark | `automation/poshmark-share.js` |
| Auto-offer to likers + auto-accept | Poshmark | `automation/offer-sender.js` |
| Daily relist | Depop | `background.js` → `doDepopRelist` |

eBay is **not** here — it goes through the Sell API server-side
(`lib/platforms/ebay.ts`). Mercari and Facebook were dropped with the rest of
the ResellOS platform set.

## Install

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select
   this folder.
2. Run the web app (`npm run dev`) and sign in. The bridge content script
   hands your Supabase access token to the extension.
3. Open the extension popup — it should read "connected" and list active
   inventory.

## How a crosslist flows

```
popup  →  OPEN_AND_FILL {platform, listing}
       →  background stores pendingListing, opens the create page
       →  tabs.onUpdated fires FILL_FORM at the content script
       →  content script fills the form (you review and submit)
       →  SPA navigates to the new listing URL
       →  CROSSPOST_COMPLETE → background → Supabase platform_listings
```

Submission is deliberately **manual**. The fill stops short of clicking
publish so a bad mapping cannot create a live listing unattended.

## Assumptions and known gaps

**1. Auth token source is uncertain.** The web app uses `@supabase/ssr`, which
stores the session in **cookies, not localStorage** — so ResellOS's approach
finds nothing here. `content-scripts/ankrevibe.js` tries, in order:
`localStorage.ankrevibe_extension_token` → any supabase localStorage key →
the `sb-<ref>-auth-token` cookie (including chunked `.0/.1` form). The cookie
path should work, but the robust fix is one line in the web app:

```ts
localStorage.setItem('ankrevibe_extension_token', session.access_token)
```

**2. No `crosspost-sync` Edge Function.** ResellOS POSTed results to one. We
have no Edge Functions, so `lib/sync.js` writes to PostgREST directly with the
user's token — the RLS policy on `platform_listings` already permits exactly
this. No new deployable.

**3. Two ResellOS sync actions were dropped**, because the schema has no table
for them: `log_share` (share counts) and `report_selector_failure`. Share and
offer counts are kept in `chrome.storage.local` for the popup only. If you want
either persisted, that needs a migration.

**4. Photos will likely need the background proxy.** Content scripts fetch
photo URLs to build `File` objects, but every imported photo lives on
`i.ebayimg.com`, which sends no CORS headers — a direct fetch from a Poshmark
page fails. `lib/dom.js` falls back to asking the service worker (which has
`host_permissions`) to fetch and return a data URL. This is an addition to the
ResellOS original, which only ever handled CORS-friendly Supabase Storage URLs.

**5. Depop has no title field.** Its primary visible input is labelled
"description" but behaves as a title, so `title` goes there and the long
description is **dropped**. Inherited from ResellOS; confirmed against their
code, not against Depop.

**6. Poshmark's "original price" is invented.** Poshmark requires an original
price ≥ the listing price, and we have no MSRP, so it uses `price × 1.8`
rounded. Carried over from ResellOS. Change it in `fillPriceFields` if that
inflated anchor isn't what you want buyers to see.

**7. Offer thresholds are price floors, not margin.** `offer_min_profit` and
`accept_min_profit` compare against the offer amount. The extension never sees
`purchase_cost`, so it cannot reason about actual profit despite the naming.

**8. Depop relist needs history.** It works from `depop_listing_urls`, which
accumulates only as the extension observes crossposts. It does nothing until
you have crosslisted to Depop through it — it cannot discover your existing
Depop listings.

**9. Selectors are unverified and dated.** Every CSS selector came from
ResellOS and reflects whenever it last worked. Poshmark and Depop change their
DOM frequently. Expect to fix selectors on first real use; each script has
multi-selector fallback lists to soften that.

**10. Localhost only.** `manifest.json` and `config.js` list
`http://localhost:3000`. Add the production origin to `host_permissions`, the
bridge's `matches`, and `CONFIG.APP_ORIGINS` when the app is deployed.

**11. No icons.** `manifest.json` omits `action.default_icon` rather than
reference PNGs that don't exist. Chrome uses a default placeholder.

## Files

```
manifest.json                    MV3 manifest
config.js                        Supabase URL + anon key, app origins
background.js                    service worker: alarms, tab orchestration, relist
lib/dom.js                       shared DOM helpers (deduped from the original)
lib/sync.js                      PostgREST writes (replaces the Edge Function)
content-scripts/ankrevibe.js     bridge: token capture, presence marker
content-scripts/poshmark.js      Poshmark create-listing fill
content-scripts/depop.js         Depop create-listing fill
automation/poshmark-share.js     share-to-followers loop
automation/offer-sender.js       offer-to-likers + auto-accept
popup.html / popup.js            item picker and automation settings
```
