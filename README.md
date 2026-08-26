# AnK ReVibe

Private reselling backend for two users. Not a SaaS — there is no public
signup, no roles and no per-row ownership; both accounts see everything.

Phase 1 scope is the core operational loop: **crosspost → sell →
auto-delist everywhere else → relist → detect sync failures.** The public
storefront, camera/AI pipeline, animated home page, tax center and
analytics are deliberately not built yet.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind · Supabase (Postgres +
Auth) · `sharp` for perceptual hashing. Deploy target is Vercel; nothing
is deployed yet.

## Setup

1. `npm install`
2. `cp .env.example .env.local` and fill in from Supabase → Settings → API.
3. Apply the schema: paste `supabase/migrations/0001_init.sql` into the
   Supabase SQL Editor and run it.
4. Optionally paste `supabase/seed.sql` for demo data.
5. Create the two user accounts by hand in Supabase → Authentication →
   Users. There is no signup route.
6. `npm run dev`

## Layout

```
app/dashboard/listings   inventory + per-platform status, crosspost/relist/sell
app/dashboard/health     sync-failure flags, dismiss/resolve, manual rescan
app/api/{crosspost,sale,relist,health-check}   the same operations over HTTP
lib/operations.ts        crosspost / recordSale / relist orchestration
lib/health.ts            phash comparison → inventory_health_flags
lib/phash.ts             dHash + Hamming distance
lib/platforms/           adapter interface + stubs (no real marketplace API yet)
```

## Inventory Health

When an item sells, its photos are perceptually hashed and compared against
the photos of every other item that still has an active listing. A Hamming
distance at or below `PHASH_MATCH_THRESHOLD` (10) means the same physical
garment is probably still live somewhere it shouldn't be — a delist that
silently failed, or a duplicate entry. Matches are written to
`inventory_health_flags` for review.

`npm run test:phash` checks the hashing behaves: a resized, re-compressed
copy stays within threshold while a different image does not.

## Marketplace integrations

`lib/platforms/` registers one adapter per platform behind the
`PlatformAdapter` interface, so the crosspost / delist / relist
orchestration is unaware of which are real.

**eBay is live** against the Sell Inventory API. Poshmark, Depop and
Mercari have no official write API and remain stubbed until a
browser-automation worker exists.

### eBay setup (one time)

1. Create an application keyset in the eBay developer console and put
   `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_RUNAME` in `.env.local`.
2. `npm run ebay:auth` — prints a consent URL. Approve it, then re-run with
   the returned code:
   `npm run ebay:auth -- --code "..."`. The refresh token (~18 months) is
   written to `.env.local` automatically.
3. `npm run ebay:policies` — lists your business policies and prints the
   three `EBAY_*_POLICY_ID` lines to add.
4. Create an inventory location on the eBay account and set
   `EBAY_MERCHANT_LOCATION_KEY`.
5. `npm run ebay:categories` — sanity-checks the static category map
   against the live taxonomy.

Access tokens last ~2 hours and are minted on demand from the refresh
token; nothing needs pasting again. Set `EBAY_USE_STUB=true` to route eBay
through the fake adapter for local work.

### How a publish works

Three calls, because eBay separates the garment from the sale terms:

```
PUT  /inventory_item/{sku}   title, photos, condition, item specifics
POST /offer                  price, category, business policies
POST /offer/{id}/publish     goes live, returns the item number
```

The SKU is derived from our inventory id, so the whole flow is idempotent —
re-crossposting updates the existing offer rather than creating a duplicate
listing. `platform_listings.platform_listing_id` stores the **offer id**
(what withdraw/republish operate on), not the public item number.

Delist withdraws the offer, keeping it for a later republish. A 404 or
error 25002 ("not published") counts as success, since the desired end
state — listing down — already holds.

Category resolution prefers `STATIC_CATEGORY_MAP` and falls back to eBay's
own taxonomy suggestion, so an unmapped or stale id degrades instead of
failing.
