/**
 * Imports the eBay account's existing inventory into Supabase.
 *
 *   npm run ebay:import                 full run
 *   npm run ebay:import -- --limit 5    first N active listings only
 *   npm run ebay:import -- --dry-run    fetch and map, write nothing
 *   npm run ebay:import -- --skip-sold  active listings only
 *
 * Why the Trading API: the Sell Inventory API only knows listings created
 * through itself, and returns 0 for this account. See lib/ebay/trading.ts.
 *
 * Two phases per listing, because GetMyeBaySelling's ActiveList carries no
 * category, condition, description, item specifics or full photo set - only
 * a single GalleryURL. Those need a GetItem call each.
 *
 * Idempotent: an eBay ItemID already present in platform_listings updates
 * the linked inventory row instead of inserting a duplicate.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const {
  getMyeBaySellingActive,
  getMyeBaySellingSold,
  getItem,
  TradingApiError,
} = await import('../lib/ebay/trading')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return process.argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
}
const has = (flag: string) => process.argv.includes(`--${flag}`)

const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity
const DRY_RUN = has('dry-run')
const SKIP_SOLD = has('skip-sold')
const CONCURRENCY = Number(arg('concurrency') ?? 4)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const stats = {
  activeSeen: 0,
  detailOk: 0,
  detailFailed: 0,
  inventoryInserted: 0,
  inventoryUpdated: 0,
  photosInserted: 0,
  listingsUpserted: 0,
  soldSeen: 0,
  soldImported: 0,
  ordersInserted: 0,
  noPhotos: 0,
  noCategory: 0,
  noCondition: 0,
}

const failures: Array<{ itemId: string; error: string }> = []

/** eBay item specifics -> our columns. Names vary by category. */
function pick(specifics: Record<string, string>, ...names: string[]) {
  for (const name of names) {
    for (const [key, value] of Object.entries(specifics)) {
      if (key.toLowerCase() === name.toLowerCase() && value?.trim()) {
        return value.trim()
      }
    }
  }
  return null
}

function mapDetail(detail: Awaited<ReturnType<typeof getItem>>) {
  const s = detail.specifics
  return {
    title: detail.title,
    description: detail.description,
    brand: pick(s, 'Brand'),
    size: pick(s, 'Size', 'Shoe Size', 'Waist Size'),
    color: pick(s, 'Color', 'Colour'),
    condition: detail.conditionName,
    style_era: pick(s, 'Decade', 'Era', 'Style', 'Vintage'),
    category: detail.categoryName,
    subcategory: pick(s, 'Department', 'Gender'),
    ebay_price: detail.price,
    status: 'active' as const,
  }
}

async function pool<T, R>(
  items: T[],
  size: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}

/** Existing eBay ItemID -> inventory id, so re-runs update in place. */
async function loadExistingByItemId(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const { data, error } = await supabase
    .from('platform_listings')
    .select('platform_listing_id, inventory_id')
    .eq('platform', 'ebay')
  if (error) throw new Error(error.message)
  for (const row of data ?? []) {
    if (row.platform_listing_id && row.inventory_id) {
      map.set(row.platform_listing_id, row.inventory_id)
    }
  }
  return map
}

console.log(`mode          ${DRY_RUN ? 'DRY RUN (no writes)' : 'live'}`)
console.log(`concurrency   ${CONCURRENCY}`)
if (LIMIT !== Infinity) console.log(`limit         ${LIMIT}`)
console.log()

const existing = await loadExistingByItemId()
console.log(`already linked to eBay item ids: ${existing.size}\n`)

// ---------------------------------------------------------------- active

console.log('── phase 1: active listings ─────────────────────')

const summaries: Awaited<ReturnType<typeof getMyeBaySellingActive>>['items'] = []
let page = 1
let totalPages = 1

while (page <= totalPages && summaries.length < LIMIT) {
  const result = await getMyeBaySellingActive(page, 200)
  totalPages = result.totalPages || 1
  summaries.push(...result.items)
  console.log(
    `  page ${page}/${totalPages}  +${result.items.length}  (account total ${result.total})`,
  )
  page++
}

const targets = summaries.slice(0, LIMIT === Infinity ? undefined : LIMIT)
stats.activeSeen = targets.length
console.log(`\n  fetching detail for ${targets.length} listings...`)

let done = 0
await pool(targets, CONCURRENCY, async (summary) => {
  try {
    const detail = await getItem(summary.itemId)
    stats.detailOk++

    const mapped = mapDetail(detail)
    if (detail.pictureUrls.length === 0) stats.noPhotos++
    if (!mapped.category) stats.noCategory++
    if (!mapped.condition) stats.noCondition++

    if (!DRY_RUN) {
      const existingId = existing.get(summary.itemId)
      let inventoryId = existingId

      if (existingId) {
        const { error } = await supabase
          .from('inventory')
          .update(mapped)
          .eq('id', existingId)
        if (error) throw new Error(error.message)
        stats.inventoryUpdated++
      } else {
        const { data, error } = await supabase
          .from('inventory')
          .insert(mapped)
          .select('id')
          .single()
        if (error) throw new Error(error.message)
        inventoryId = data.id
        stats.inventoryInserted++
      }

      // platform_listings: ItemID is the handle for a legacy listing.
      const { error: plError } = await supabase.from('platform_listings').upsert(
        {
          inventory_id: inventoryId,
          platform: 'ebay',
          platform_listing_id: summary.itemId,
          platform_url: detail.viewUrl ?? summary.viewUrl,
          status: 'active',
          listed_price: detail.price ?? summary.price,
        },
        { onConflict: 'inventory_id,platform' },
      )
      if (plError) throw new Error(plError.message)
      stats.listingsUpserted++

      // Photos: replace wholesale so a re-run does not accumulate.
      const urls = detail.pictureUrls.length
        ? detail.pictureUrls
        : summary.galleryUrl
          ? [summary.galleryUrl]
          : []

      if (urls.length) {
        await supabase.from('listing_photos').delete().eq('inventory_id', inventoryId)
        const { error: photoError } = await supabase.from('listing_photos').insert(
          urls.map((url, position) => ({ inventory_id: inventoryId, url, position })),
        )
        if (photoError) throw new Error(photoError.message)
        stats.photosInserted += urls.length
      }
    }
  } catch (cause) {
    stats.detailFailed++
    const message =
      cause instanceof TradingApiError
        ? cause.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
        : cause instanceof Error
          ? cause.message
          : String(cause)
    failures.push({ itemId: summary.itemId, error: message.slice(0, 160) })
  }

  done++
  if (done % 25 === 0 || done === targets.length) {
    process.stdout.write(`\r  ${done}/${targets.length} processed`)
  }
})
console.log('\n')

// ------------------------------------------------------------------ sold

if (!SKIP_SOLD) {
  console.log('── phase 2: sold history ────────────────────────')
  try {
    const sold = await getMyeBaySellingSold(1, 200)
    stats.soldSeen = sold.items.length
    console.log(`  ${sold.items.length} sold (account total ${sold.total})`)

    for (const sale of sold.items) {
      try {
        const detail = await getItem(sale.itemId).catch(() => null)
        const mapped = detail
          ? mapDetail(detail)
          : { title: sale.title, ebay_price: sale.salePrice }

        if (DRY_RUN) {
          stats.soldImported++
          continue
        }

        const soldRow = {
          ...mapped,
          status: 'sold' as const,
          sold_at: sale.saleDate ?? null,
          sold_platform: 'ebay',
          sold_price: sale.salePrice,
        }

        let inventoryId = existing.get(sale.itemId)
        if (inventoryId) {
          await supabase.from('inventory').update(soldRow).eq('id', inventoryId)
        } else {
          const { data, error } = await supabase
            .from('inventory')
            .insert(soldRow)
            .select('id')
            .single()
          if (error) throw new Error(error.message)
          inventoryId = data.id

          await supabase.from('platform_listings').upsert(
            {
              inventory_id: inventoryId,
              platform: 'ebay',
              platform_listing_id: sale.itemId,
              platform_url: detail?.viewUrl ?? null,
              status: 'delisted',
              listed_price: sale.salePrice,
              delisted_at: sale.saleDate ?? null,
            },
            { onConflict: 'inventory_id,platform' },
          )
        }

        const urls = detail?.pictureUrls ?? []
        if (urls.length) {
          await supabase.from('listing_photos').delete().eq('inventory_id', inventoryId)
          await supabase.from('listing_photos').insert(
            urls.map((url, position) => ({ inventory_id: inventoryId, url, position })),
          )
          stats.photosInserted += urls.length
        }

        const { error: orderError } = await supabase.from('orders').insert({
          inventory_id: inventoryId,
          platform: 'ebay',
          sale_price: sale.salePrice,
          buyer_info: sale.buyerId ? { buyerId: sale.buyerId } : null,
          status: 'completed',
        })
        if (!orderError) stats.ordersInserted++

        stats.soldImported++
      } catch (cause) {
        failures.push({
          itemId: sale.itemId,
          error: `sold: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 160),
        })
      }
    }
  } catch (cause) {
    console.error(
      `  sold history unavailable: ${cause instanceof Error ? cause.message : cause}`,
    )
  }
  console.log()
}

// --------------------------------------------------------------- summary

console.log('── summary ──────────────────────────────────────')
for (const [key, value] of Object.entries(stats)) {
  console.log(`  ${key.padEnd(20)} ${value}`)
}

if (failures.length) {
  console.log(`\n  ${failures.length} failures (first 10):`)
  for (const f of failures.slice(0, 10)) {
    console.log(`    ${f.itemId}  ${f.error}`)
  }
}

console.log(
  `\n${DRY_RUN ? 'Dry run - nothing written.' : 'Import complete.'}`,
)
process.exit(failures.length && stats.detailOk === 0 ? 1 : 0)
