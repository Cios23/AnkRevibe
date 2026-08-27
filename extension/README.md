# AnK ReVibe Crosslister (Chrome MV3)

Ported from the ResellOS extension (`F:\Downloads\ai-co-pilot-chat-main\extension`),
scoped to **Poshmark and Depop only** and repointed at the AnK ReVibe Supabase
project.

**Not yet loaded in Chrome, and not tested against the live marketplaces.**
It parses, the manifest resolves, the auth bridge is verified against a real
session, and the margin arithmetic is unit-tested. Every DOM selector is still
inherited unverified. See Assumptions.

## What it does

| Capability | Platform | Where |
|---|---|---|
| Crosslist fill | Poshmark | `content-scripts/poshmark.js` |
| Crosslist fill | Depop | `content-scripts/depop.js` |
| Auto-share to followers | Poshmark | `automation/poshmark-share.js` |
| Auto-offer to likers + auto-accept | Poshmark | `automation/offer-sender.js` |
| Daily relist | Depop | `background.js` → `doDepopRelist` |
| **Delist on sale** | Depop | `automation/depop-delist.js` |

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

**1. Auth token capture — VERIFIED, after a real bug.** The web app uses
`@supabase/ssr`, which stores the session in **cookies, not localStorage**, so
ResellOS's approach finds nothing here. `content-scripts/ankrevibe.js` tries,
in order: `localStorage.ankrevibe_extension_token` → any supabase localStorage
key → the `sb-<ref>-auth-token` cookie (including the chunked `.0/.1` form).

The cookie path **was broken as first written**: `@supabase/ssr` encodes the
session as `base64-<payload>`, and the single-cookie branch passed that
straight to `JSON.parse`, so the bridge recovered nothing and the popup would
have read "not signed in" forever. Verified against a real session — sign in
through the app's own `createServerClient`, run the bridge's parser over the
cookies it writes, then make the popup's exact PostgREST call:

```
2. signed in, cookies written: sb-…-auth-token (2639 chars)
3. bridge cookie parser: recovered a token (818 chars)
4. popup query with that token: HTTP 200 → 1 row readable
5. anon key alone: HTTP 200, 0 rows (RLS holding)
```

`test/auth-bridge.test.mts` pins this. Still unverified: Chrome actually
executing the content script and rendering the popup — everything up to that
point is proven.

The explicit key remains the most robust option if you want to remove the
dependency on cookie format entirely:

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

**7. Offer thresholds are real margin.** `offer_min_profit` and
`accept_min_profit` compare against
`poshmarkNetProceeds(offer) - purchase_cost`, where net proceeds subtract
Poshmark's published commission (flat $2.95 under $15, otherwise 20%).

`offer-sender.js` runs on Poshmark's own pages and has no link back to our
inventory, so the background builds a `platform_listing_id → purchase_cost`
map from Supabase and passes it in. The join key is the last path segment of
the listing URL — the same value `content-scripts/poshmark.js` records as
`platform_listing_id`.

Items with no `purchase_cost` are **skipped**, not judged on price; untick
"Require known cost" to fall back to the old price-floor behaviour. The
arithmetic is unit-tested in `test/margin.test.mts`, including the case that
motivated it: a $12 offer on a $9 item reads as $3 of profit and actually
nets five cents.

Caveat: the fee model covers standard Poshmark commission only. It ignores
shipping discounts you fund, promoted-listing fees, and any seller-fee
promotion — so treat the margin as an upper bound.

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

**11. Depop delist selectors are guesses, and marked as such.** Depop has no
API for sellers, so ending a listing means driving their UI - and Depop
returns HTTP 403 to any scripted request, so their markup could not be
inspected at all while writing it. The wordings tried ("Delete listing",
"Remove", "End listing", "Mark as sold") are plausible, not observed.

Two deliberate consequences:

- It **never clicks an approximate match**. Matching is whole-word, so
  "Deleted items" does not answer a search for "delete" - on a page of
  destructive controls a loose match is how the wrong thing gets clicked.
  If nothing matches it reports every control the page offered, which turns
  one real run into a one-line fix.
- It **never reports success it did not observe**. A failed attempt marks
  the row `error`, never back to `pending_delist`, so a broken selector
  cannot spin forever reopening the same tab.

How it reaches the browser at all: the server cannot delist Depop, so
`recordSale` marks the row **`pending_delist`** rather than `delisted` -
claiming otherwise would tell the sync-failure detector there is nothing to
look for, on a listing that is still live. `background.js` drains that queue
on a 30-minute alarm, or on demand via `MANUAL_DEPOP_DELIST`.

**12. No icons.** `manifest.json` omits `action.default_icon` rather than
reference PNGs that don't exist. Chrome uses a default placeholder.

## Files

```
manifest.json                    MV3 manifest
config.js                        Supabase URL + anon key, app origins
background.js                    service worker: alarms, tab orchestration, relist
lib/dom.js                       shared DOM helpers (deduped from the original)
lib/margin.js                    Poshmark fee + margin arithmetic (unit-tested)
lib/sync.js                      PostgREST writes (replaces the Edge Function)
content-scripts/ankrevibe.js     bridge: token capture, presence marker
content-scripts/poshmark.js      Poshmark create-listing fill
content-scripts/depop.js         Depop create-listing fill
automation/poshmark-share.js     share-to-followers loop
automation/offer-sender.js       offer-to-likers + auto-accept
popup.html / popup.js            item picker and automation settings
```
