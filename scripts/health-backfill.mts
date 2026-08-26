/**
 * Historical inventory-health backfill.
 *
 *   npm run health:backfill
 *   npm run health:backfill -- --concurrency 12
 *   npm run health:backfill -- --hash-only     just compute hashes
 *
 * Two phases:
 *
 *   1. Hash every photo that has no phash yet, concurrently. runHealthCheck
 *      would do this itself, but it hashes sequentially - fine for one sale,
 *      far too slow for a few thousand imported photos.
 *   2. Run sync-failure detection for every sold item, comparing it against
 *      every item that still has an active listing.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { hashImageUrl } = await import('../lib/phash')
const { runHealthCheck } = await import('../lib/health')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return process.argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
}

const CONCURRENCY = Number(arg('concurrency') ?? 8)
const HASH_ONLY = process.argv.includes('--hash-only')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        await worker(items[cursor++])
      }
    }),
  )
}

/** PostgREST caps a response at 1000 rows; page past it. */
async function selectAll<T>(
  table: string,
  columns: string,
  apply: (q: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await apply(
      supabase.from(table).select(columns).range(from, from + pageSize - 1),
    )
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < pageSize) break
  }
  return out
}

// ------------------------------------------------------- phase 1: hashing

console.log('── phase 1: perceptual hashes ───────────────────')

const unhashed = await selectAll<{ id: string; url: string }>(
  'listing_photos',
  'id, url',
  (q) => q.is('phash', null),
)

console.log(`  ${unhashed.length} photos need hashing (concurrency ${CONCURRENCY})`)

let hashed = 0
let hashFailed = 0
let processed = 0

await pool(unhashed, CONCURRENCY, async (photo) => {
  const phash = await hashImageUrl(photo.url)
  if (phash) {
    const { error } = await supabase
      .from('listing_photos')
      .update({ phash })
      .eq('id', photo.id)
    if (error) hashFailed++
    else hashed++
  } else {
    hashFailed++
  }
  processed++
  if (processed % 100 === 0 || processed === unhashed.length) {
    process.stdout.write(`\r  ${processed}/${unhashed.length} hashed`)
  }
})

if (unhashed.length) console.log()
console.log(`  hashed ${hashed}, unreadable ${hashFailed}\n`)

if (HASH_ONLY) {
  console.log('--hash-only: stopping before detection.')
  process.exit(0)
}

// ----------------------------------------------------- phase 2: detection

console.log('── phase 2: sync-failure detection ──────────────')

const sold = await selectAll<{ id: string; title: string | null }>(
  'inventory',
  'id, title',
  (q) => q.eq('status', 'sold'),
)

const activeListings = await selectAll<{ inventory_id: string }>(
  'platform_listings',
  'inventory_id',
  (q) => q.eq('status', 'active'),
)
const activeItems = new Set(activeListings.map((l) => l.inventory_id))

console.log(
  `  ${sold.length} sold items vs ${activeItems.size} items with active listings\n`,
)

let totalFlags = 0
const found: Array<{ sold: string; flagged: string; distance: number }> = []

for (const item of sold) {
  try {
    const result = await runHealthCheck(item.id, { supabase: supabase as any })
    const label = (item.title ?? item.id).slice(0, 48)
    if (result.flags.length) {
      totalFlags += result.flags.length
      console.log(`  ${label}`)
      for (const flag of result.flags) {
        const { data } = await supabase
          .from('inventory')
          .select('title')
          .eq('id', flag.flaggedInventoryId)
          .single()
        console.log(
          `      distance ${String(flag.similarityScore).padStart(2)}  ->  ` +
            `${(data?.title ?? flag.flaggedInventoryId).slice(0, 48)}`,
        )
        found.push({
          sold: label,
          flagged: data?.title ?? flag.flaggedInventoryId,
          distance: flag.similarityScore,
        })
      }
    } else {
      console.log(`  ${label} — clean (${result.candidatesCompared} compared)`)
    }
  } catch (cause) {
    console.error(
      `  ${item.id} FAILED: ${cause instanceof Error ? cause.message : cause}`,
    )
  }
}

console.log('\n── summary ──────────────────────────────────────')
console.log(`  photos hashed        ${hashed}`)
console.log(`  photos unreadable    ${hashFailed}`)
console.log(`  sold items scanned   ${sold.length}`)
console.log(`  matches found        ${totalFlags}`)

if (found.length) {
  console.log(
    `\n  Review these at /dashboard/health — a genuine match means the item` +
      `\n  is still live somewhere it should not be.`,
  )
}
