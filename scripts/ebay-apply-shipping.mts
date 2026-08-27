/**
 * Apply the resolved shipping policy to live eBay offers.
 *
 *   npm run ebay:apply-shipping -- --dry-run
 *   npm run ebay:apply-shipping -- --limit 5
 *   npm run ebay:apply-shipping
 *
 * WRITES TO LIVE LISTINGS. Each offer is read, its fulfillment policy
 * replaced with the band resolveShippingPolicy() picks, and written back.
 *
 * Read-modify-write, not blind write: eBay's updateOffer is a REPLACE, so
 * sending a partial body would silently drop price, category, description
 * and quantity from the listing. The current offer is fetched and only the
 * one field changed.
 *
 * Offers already on the right policy are skipped rather than rewritten -
 * there is no reason to touch a listing to set it to what it already is.
 *
 * Legacy listings (imported, no offer behind them) cannot be updated this
 * way at all; they are counted and reported, not silently ignored.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { resolveShippingPolicy, FULFILLMENT_POLICIES } = await import(
  '../lib/ebay/shipping'
)
const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')

const DRY_RUN = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity
const delayArg = process.argv.indexOf('--delay')
const DELAY_MS = delayArg >= 0 ? Number(process.argv[delayArg + 1]) : 350

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Listing = { platform_listing_id: string | null; inventory_id: string | null }
type Item = {
  id: string
  title: string | null
  category: string | null
  subcategory: string | null
}

// ------------------------------------------------------------ load state

const listings: Listing[] = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('platform_listings')
    .select('platform_listing_id, inventory_id')
    .eq('platform', 'ebay')
    .eq('status', 'active')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  listings.push(...((data ?? []) as Listing[]))
  if (!data || data.length < 1000) break
}

const items = new Map<string, Item>()
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('inventory')
    .select('id, title, category, subcategory')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  for (const row of (data ?? []) as Item[]) items.set(row.id, row)
  if (!data || data.length < 1000) break
}

const targets = listings
  .filter((l) => l.platform_listing_id && l.inventory_id)
  .slice(0, LIMIT === Infinity ? undefined : LIMIT)

console.log(`mode      ${DRY_RUN ? 'DRY RUN' : 'LIVE - updating real listings'}`)
console.log(`delay     ${DELAY_MS}ms between writes`)
console.log(`listings  ${targets.length} of ${listings.length} active\n`)

const stats = {
  updated: 0,
  alreadyCorrect: 0,
  legacy: 0,
  failed: 0,
  noItem: 0,
}
const finalByPolicy = new Map<string, number>()
const failures: Array<{ id: string; reason: string }> = []

/** Only the fields updateOffer accepts; the rest of the GET is read-only. */
function writableOffer(offer: Record<string, unknown>) {
  const keep = [
    'availableQuantity',
    'categoryId',
    'listingDescription',
    'listingDuration',
    'listingPolicies',
    'merchantLocationKey',
    'pricingSummary',
    'quantityLimitPerBuyer',
    'secondaryCategoryId',
    'storeCategoryNames',
    'tax',
    'charity',
    'extendedProducerResponsibility',
    'lotSize',
    'includeCatalogProductDetails',
  ]
  const body: Record<string, unknown> = {}
  for (const key of keep) {
    if (offer[key] !== undefined && offer[key] !== null) body[key] = offer[key]
  }
  return body
}

let processed = 0

for (const listing of targets) {
  processed++
  const offerId = listing.platform_listing_id!
  const item = items.get(listing.inventory_id!)

  if (!item) {
    stats.noItem++
    continue
  }

  const resolved = resolveShippingPolicy(item)

  let offer: Record<string, unknown> | null = null
  try {
    offer = (await ebayFetch<Record<string, unknown>>(
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      { attempts: 2 },
    )) as Record<string, unknown> | null
  } catch (cause) {
    if (cause instanceof EbayApiError && cause.isNotFound) {
      // A legacy imported listing: no offer exists, so the Inventory API
      // cannot change its policy.
      stats.legacy++
      continue
    }
    stats.failed++
    failures.push({
      id: offerId,
      reason: cause instanceof Error ? cause.message.slice(0, 110) : String(cause),
    })
    continue
  }

  if (!offer) {
    stats.legacy++
    continue
  }

  const policies = (offer.listingPolicies ?? {}) as Record<string, unknown>
  const current = policies.fulfillmentPolicyId as string | undefined

  finalByPolicy.set(
    resolved.policyId,
    (finalByPolicy.get(resolved.policyId) ?? 0) + 1,
  )

  if (current === resolved.policyId) {
    stats.alreadyCorrect++
    continue
  }

  if (DRY_RUN) {
    stats.updated++
    if (stats.updated <= 8) {
      console.log(
        `  ${(item.title ?? item.id).slice(0, 44).padEnd(44)} ` +
          `${current ?? '(none)'} -> ${resolved.policyId}  ${resolved.label}`,
      )
    }
    continue
  }

  const body = writableOffer(offer)
  body.listingPolicies = { ...policies, fulfillmentPolicyId: resolved.policyId }

  try {
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      method: 'PUT',
      body,
      attempts: 2,
    })
    stats.updated++
    if (stats.updated % 25 === 0) {
      process.stdout.write(`\r  ${stats.updated} updated (${processed}/${targets.length})`)
    }
  } catch (cause) {
    stats.failed++
    failures.push({
      id: offerId,
      reason: cause instanceof Error ? cause.message.slice(0, 110) : String(cause),
    })
  }

  await sleep(DELAY_MS)
}

// ---------------------------------------------------------------- report

console.log('\n\n── summary ──────────────────────────────────────')
console.log(`  updated          ${stats.updated}`)
console.log(`  already correct  ${stats.alreadyCorrect}`)
console.log(`  legacy (no offer)${String(stats.legacy).padStart(4)}`)
console.log(`  failed           ${stats.failed}`)
if (stats.noItem) console.log(`  no inventory row ${stats.noItem}`)

console.log('\n── policy assignment across offers we could reach ──')
for (const band of Object.keys(FULFILLMENT_POLICIES) as Array<
  keyof typeof FULFILLMENT_POLICIES
>) {
  const policy = FULFILLMENT_POLICIES[band]
  const count = finalByPolicy.get(policy.id) ?? 0
  console.log(`  ${policy.label.padEnd(24)} ${policy.id}  ${count} items`)
}

if (failures.length) {
  console.log(`\n  ${failures.length} failure(s), first 10:`)
  for (const failure of failures.slice(0, 10)) {
    console.log(`    ${failure.id}  ${failure.reason}`)
  }
}

if (stats.legacy) {
  console.log(
    `\n  ${stats.legacy} listing(s) are legacy imports with no offer behind ` +
      `them. Their shipping policy cannot be changed through the Inventory ` +
      `API - they would need Trading ReviseItem, or republishing.`,
  )
}

if (DRY_RUN) console.log('\nDry run - nothing was written.')
process.exit(stats.failed ? 1 : 0)
