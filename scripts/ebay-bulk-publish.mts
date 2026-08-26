/**
 * Republishes imported eBay inventory through our Inventory API path.
 *
 *   npm run ebay:bulk-publish -- --dry-run --limit 10     inspect only
 *   npm run ebay:bulk-publish -- --limit 25               publish 25
 *   npm run ebay:bulk-publish                             publish all
 *
 * Flags:
 *   --dry-run        resolve category/condition and report, write nothing
 *   --limit N        only the first N candidates
 *   --delay MS       pause between items (default 1500)
 *   --end-legacy     END the original legacy listing after publishing the
 *                    replacement. WITHOUT THIS THE ITEM IS LISTED TWICE.
 *
 * A candidate is an active item whose eBay platform_listings row still
 * carries a legacy numeric ItemID rather than one of our offer ids - i.e.
 * imported but not yet migrated.
 *
 * IMPORTANT: publishing through the Inventory API does NOT replace the
 * existing listing. It creates a second, independent one for the same
 * physical garment. --end-legacy is what makes this a migration rather
 * than a duplication.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { crosspost } = await import('../lib/operations')
const { resolveCategoryId } = await import('../lib/ebay/categories')
const { resolveConditionForCategory } = await import('../lib/ebay/conditions')
const { endItem, TradingApiError } = await import('../lib/ebay/trading')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return process.argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
}
const has = (f: string) => process.argv.includes(`--${f}`)

const DRY_RUN = has('dry-run')
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity
const DELAY_MS = Number(arg('delay') ?? 1500)
const END_LEGACY = has('end-legacy')
/** Items with no condition data are held back for manual review. */
const ALLOW_MISSING_CONDITION = has('allow-missing-condition')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Legacy eBay ItemIDs are bare digits; our offer ids come from publish. */
const isLegacyItemId = (id: string | null) => !!id && /^\d{9,15}$/.test(id)

type Candidate = {
  inventoryId: string
  title: string | null
  condition: string | null
  category: string | null
  price: number | null
  legacyItemId: string
  photoCount: number
}

async function loadCandidates(): Promise<Candidate[]> {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('platform_listings')
      .select('platform_listing_id, inventory_id, status')
      .eq('platform', 'ebay')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }

  const legacy = rows.filter(
    (r) => r.status === 'active' && isLegacyItemId(r.platform_listing_id),
  )

  const photoCounts = new Map<string, number>()
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('listing_photos')
      .select('inventory_id')
      .range(from, from + 999)
    for (const p of data ?? []) {
      photoCounts.set(p.inventory_id, (photoCounts.get(p.inventory_id) ?? 0) + 1)
    }
    if (!data || data.length < 1000) break
  }

  const candidates: Candidate[] = []
  for (let i = 0; i < legacy.length; i += 200) {
    const chunk = legacy.slice(i, i + 200)
    const { data, error } = await supabase
      .from('inventory')
      .select('id, title, condition, category, ebay_price, status')
      .in('id', chunk.map((c) => c.inventory_id))
    if (error) throw new Error(error.message)
    const byId = new Map((data ?? []).map((r) => [r.id, r]))
    for (const row of chunk) {
      const item = byId.get(row.inventory_id)
      if (!item || item.status !== 'active') continue
      candidates.push({
        inventoryId: item.id,
        title: item.title,
        condition: item.condition,
        category: item.category,
        price: item.ebay_price,
        legacyItemId: row.platform_listing_id,
        photoCount: photoCounts.get(item.id) ?? 0,
      })
    }
  }
  return candidates.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
}

console.log(`mode          ${DRY_RUN ? 'DRY RUN (nothing published)' : 'LIVE PUBLISH'}`)
console.log(`delay         ${DELAY_MS}ms between items`)
console.log(`end legacy    ${END_LEGACY ? 'YES - originals will be ended' : 'NO - originals stay live (duplicates!)'}`)
console.log(`no-condition  ${ALLOW_MISSING_CONDITION ? 'publish anyway' : 'skip for manual review'}`)
if (LIMIT !== Infinity) console.log(`limit         ${LIMIT}`)
console.log()

const all = await loadCandidates()
const targets = LIMIT === Infinity ? all : all.slice(0, LIMIT)
console.log(`${all.length} candidates not yet migrated; processing ${targets.length}\n`)

const succeeded: Array<{ title: string; url: string }> = []
const failed: Array<{ title: string; id: string; reason: string }> = []
const skipped: Array<{ title: string; id: string; reason: string }> = []

let index = 0
for (const c of targets) {
  index++
  const label = (c.title ?? c.inventoryId).slice(0, 46)

  // Pre-flight: things that would fail at publish anyway.
  if (c.photoCount === 0) {
    skipped.push({ title: label, id: c.inventoryId, reason: 'no photos' })
    console.log(`  [${index}/${targets.length}] SKIP  ${label} — no photos`)
    continue
  }
  if (c.price === null) {
    skipped.push({ title: label, id: c.inventoryId, reason: 'no ebay_price' })
    console.log(`  [${index}/${targets.length}] SKIP  ${label} — no price`)
    continue
  }
  if (!c.condition && !ALLOW_MISSING_CONDITION) {
    // Guessing a condition puts a wrong claim on a real listing.
    skipped.push({ title: label, id: c.inventoryId, reason: 'no condition data' })
    console.log(`  [${index}/${targets.length}] SKIP  ${label} — no condition data`)
    continue
  }

  try {
    if (DRY_RUN) {
      // Resolve exactly what a real run would send, without writing.
      const category = await resolveCategoryId(
        { category: c.category, subcategory: null, title: c.title, brand: null },
      )
      const condition = await resolveConditionForCategory(
        c.condition,
        category.categoryId,
      )
      console.log(
        `  [${index}/${targets.length}] WOULD PUBLISH  ${label}\n` +
          `        legacy ${c.legacyItemId}  $${c.price}  ${c.photoCount} photos\n` +
          `        category ${category.categoryId} (${category.source})  condition ${c.condition ?? '(none)'} -> ${condition}` +
          (END_LEGACY ? `\n        then END ${c.legacyItemId}` : ''),
      )
      continue
    }

    const results = await crosspost(supabase as any, c.inventoryId, ['ebay'])
    const result = results[0]

    if (result.status !== 'active') {
      failed.push({ title: label, id: c.inventoryId, reason: result.error ?? 'unknown' })
      console.log(`  [${index}/${targets.length}] FAIL  ${label} — ${String(result.error).slice(0, 90)}`)
    } else {
      succeeded.push({ title: label, url: result.platformUrl ?? '' })
      console.log(`  Published ${succeeded.length}/${targets.length}  ${label}`)

      if (END_LEGACY) {
        try {
          await endItem(c.legacyItemId)
          console.log(`        ended legacy ${c.legacyItemId}`)
        } catch (cause) {
          const already =
            cause instanceof TradingApiError &&
            cause.errors.some((e) => e.code === '1047' || e.code === '1048')
          if (!already) {
            console.log(
              `        WARNING: legacy ${c.legacyItemId} still live — ` +
                `${cause instanceof Error ? cause.message.slice(0, 80) : cause}`,
            )
          }
        }
      }
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    failed.push({ title: label, id: c.inventoryId, reason })
    console.log(`  [${index}/${targets.length}] FAIL  ${label} — ${reason.slice(0, 90)}`)
  }

  if (index < targets.length) await sleep(DELAY_MS)
}

// ---------------------------------------------------------------- summary

console.log('\n── summary ──────────────────────────────────────')
console.log(`  processed   ${targets.length}`)
console.log(`  succeeded   ${succeeded.length}`)
console.log(`  failed      ${failed.length}`)
console.log(`  skipped     ${skipped.length}`)

if (skipped.length) {
  console.log('\n  skipped:')
  const byReason = new Map<string, number>()
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)
  for (const [reason, n] of byReason) console.log(`    ${n}x ${reason}`)
}

if (failed.length) {
  console.log('\n  failures:')
  const byReason = new Map<string, number>()
  for (const f of failed) {
    const key = f.reason.replace(/\d{6,}/g, 'N').slice(0, 90)
    byReason.set(key, (byReason.get(key) ?? 0) + 1)
  }
  for (const [reason, n] of byReason) console.log(`    ${n}x  ${reason}`)
  console.log('\n  first 10 failed items:')
  for (const f of failed.slice(0, 10)) console.log(`    ${f.id}  ${f.title}`)
}

if (DRY_RUN) console.log('\nDry run — nothing was published.')
