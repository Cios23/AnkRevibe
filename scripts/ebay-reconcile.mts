/**
 * Reconciles platform_listings against what eBay actually shows.
 *
 *   npm run ebay:reconcile -- --dry-run
 *   npm run ebay:reconcile
 *
 * Our row and eBay drift apart whenever a write half-succeeds. The bulk
 * publish is the clearest case: crosspost() marks a row `error` when the
 * publish call fails, but the ORIGINAL listing is still live and selling -
 * so the row says error while eBay says Active.
 *
 * That mismatch is not cosmetic. runHealthCheck only compares a sold item
 * against candidates whose listing status is 'active', so every row stuck
 * on 'error' silently drops out of sync-failure detection - exactly the
 * items most likely to need it.
 *
 * eBay is the source of truth here; this makes our rows agree with it.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { tradingCall, TradingApiError } = await import('../lib/ebay/trading')
const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')

const DRY_RUN = process.argv.includes('--dry-run')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

type Resolution = {
  kind: 'offer' | 'legacy' | 'unknown'
  expected: string | null
  detail: string
}

/**
 * Offer ids and legacy ItemIDs are BOTH bare 12-digit numbers, so the id
 * alone cannot tell them apart. Ask eBay instead: the Offer API knows our
 * offers and 404s on an ItemID, so a hit identifies the id definitively.
 *
 * Guessing from the format is how the first version of this script nearly
 * marked 362 healthy listings delisted - it treated every offer id as a
 * legacy id, got an error back from GetItem, and read that error as "gone".
 * An API error is never evidence about a listing's state.
 */
async function resolveStatus(id: string): Promise<Resolution> {
  // 1. Is it one of our offers?
  try {
    const offer = await ebayFetch<{
      status?: string
      listing?: { listingStatus?: string }
    }>(`/sell/inventory/v1/offer/${encodeURIComponent(id)}`, { attempts: 1 })

    if (offer) {
      const published = offer.status === 'PUBLISHED'
      const listingStatus = offer.listing?.listingStatus ?? offer.status ?? '?'
      return {
        kind: 'offer',
        expected: published ? 'active' : 'delisted',
        detail: 'offer ' + listingStatus,
      }
    }
  } catch (cause) {
    // Not an offer - fall through to the legacy check. Anything other than
    // "not found" means we simply could not tell.
    if (!(cause instanceof EbayApiError) || !cause.isNotFound) {
      return { kind: 'unknown', expected: null, detail: 'offer lookup failed' }
    }
  }

  // 2. Then it should be a legacy listing.
  try {
    const envelope = await tradingCall('GetItem', `<ItemID>${id}</ItemID>`)
    const listingStatus = envelope.Item?.SellingStatus?.ListingStatus ?? null
    if (listingStatus === 'Active') {
      return { kind: 'legacy', expected: 'active', detail: 'listing Active' }
    }
    if (listingStatus === 'Completed' || listingStatus === 'Ended') {
      return {
        kind: 'legacy',
        expected: 'delisted',
        detail: 'listing ' + listingStatus,
      }
    }
    return {
      kind: 'legacy',
      expected: null,
      detail: 'listing ' + (listingStatus ?? '?'),
    }
  } catch (cause) {
    const why =
      cause instanceof TradingApiError
        ? cause.errors.map((e) => e.code).join('/')
        : 'error'
    return { kind: 'unknown', expected: null, detail: 'GetItem ' + why }
  }
}

type Row = {
  id: string
  inventory_id: string | null
  platform_listing_id: string | null
  status: string | null
}

const rows: Row[] = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('platform_listings')
    .select('id, inventory_id, platform_listing_id, status')
    .eq('platform', 'ebay')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  rows.push(...((data ?? []) as Row[]))
  if (!data || data.length < 1000) break
}

const checkable = rows.filter((r) => !!r.platform_listing_id)

console.log(`mode        ${DRY_RUN ? 'DRY RUN' : 'live'}`)
console.log(`rows        ${rows.length} eBay listings, ${checkable.length} with an id\n`)

const stats = { checked: 0, agreed: 0, corrected: 0, undetermined: 0 }
const changes: Array<{ id: string; from: string; to: string }> = []

let processed = 0
for (const row of checkable) {
  const id = row.platform_listing_id!
  const resolved = await resolveStatus(id)

  processed++
  if (processed % 50 === 0) {
    process.stdout.write(`\r  ${processed}/${checkable.length} checked`)
  }

  if (resolved.kind === 'unknown' || !resolved.expected) {
    stats.undetermined++
    continue
  }
  stats.checked++

  if (resolved.expected === row.status) {
    stats.agreed++
    continue
  }

  changes.push({ id, from: row.status ?? 'null', to: resolved.expected })
  console.log(
    `\r  ${id}  ${String(row.status).padEnd(9)} -> ${resolved.expected.padEnd(9)} (${resolved.detail})`,
  )

  if (!DRY_RUN) {
    const patch: Record<string, unknown> = { status: resolved.expected }
    // Clearing delisted_at matters: a row flipped back to active while still
    // carrying a delist timestamp reads as delisted everywhere else.
    if (resolved.expected === 'active') patch.delisted_at = null

    const { error } = await supabase
      .from('platform_listings')
      .update(patch)
      .eq('id', row.id)
    if (error) {
      console.log(`      update FAILED: ${error.message}`)
      continue
    }
  }
  stats.corrected++
}

console.log('\n\n── summary ──────────────────────────────────────')
console.log(`  determined    ${stats.checked}`)
console.log(`  already agree ${stats.agreed}`)
console.log(`  corrected     ${stats.corrected}`)
console.log(`  undetermined  ${stats.undetermined}  (left untouched)`)

if (DRY_RUN && changes.length) console.log('\nDry run - nothing written.')
