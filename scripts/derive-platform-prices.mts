/**
 * Fill in per-platform prices from ebay_price, matched on NET proceeds.
 *
 *   npm run prices:derive -- --dry-run
 *   npm run prices:derive
 *   npm run prices:derive -- --overwrite      recompute existing values too
 *
 * The import only ever populated ebay_price - eBay has no idea what you
 * would charge elsewhere - so every other platform price is null and the
 * extension cannot list anything.
 *
 * Copying the eBay number across would be the easy answer and the wrong one:
 * Poshmark takes 20% where eBay takes 13.25%, so the same sticker price
 * quietly earns less for identical work. Each price is instead solved so the
 * money that actually reaches you is the same on every platform.
 *
 * Values are written to the real columns, so they show up in the UI and can
 * be edited per item. By default only nulls are filled; anything you have
 * already set by hand is left alone unless --overwrite is passed.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { equivalentPrice, platformFee, PLATFORM_MIN_PRICE } = await import('../lib/fees')

const DRY_RUN = process.argv.includes('--dry-run')
const OVERWRITE = process.argv.includes('--overwrite')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

type Row = {
  id: string
  title: string | null
  ebay_price: number | null
  poshmark_price: number | null
  depop_price: number | null
  mercari_price: number | null
}

const TARGETS = ['poshmark', 'depop', 'mercari'] as const

const rows: Row[] = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('inventory')
    .select('id, title, ebay_price, poshmark_price, depop_price, mercari_price')
    .eq('status', 'active')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  rows.push(...((data ?? []) as Row[]))
  if (!data || data.length < 1000) break
}

console.log(`mode        ${DRY_RUN ? 'DRY RUN' : 'live'}`)
console.log(`existing    ${OVERWRITE ? 'OVERWRITE' : 'left alone'}`)
console.log(`active rows ${rows.length}\n`)

const stats = {
  updated: 0,
  skippedNoEbayPrice: 0,
  skippedAlreadySet: 0,
  fieldsWritten: 0,
  raisedToMinimum: 0,
  failed: 0,
}

let shown = 0
let processed = 0

for (const row of rows) {
  if (processed >= LIMIT) break

  if (row.ebay_price == null) {
    stats.skippedNoEbayPrice++
    continue
  }

  const patch: Record<string, number> = {}
  const notes: string[] = []

  for (const platform of TARGETS) {
    const column = `${platform}_price` as keyof Row
    if (!OVERWRITE && row[column] != null) continue

    const price = equivalentPrice('ebay', row.ebay_price, platform)
    if (price == null) continue

    patch[column] = price
    if (price === PLATFORM_MIN_PRICE[platform]) {
      stats.raisedToMinimum++
      notes.push(`${platform} at floor`)
    }
  }

  if (Object.keys(patch).length === 0) {
    stats.skippedAlreadySet++
    continue
  }

  processed++

  if (shown < 8) {
    shown++
    const net = row.ebay_price - platformFee('ebay', row.ebay_price)
    console.log(
      `  ${(row.title ?? row.id).slice(0, 40).padEnd(40)} ` +
        `ebay $${String(row.ebay_price).padStart(6)} (nets ${net.toFixed(2)}) -> ` +
        TARGETS.map((p) =>
          patch[`${p}_price`] != null ? `${p} $${patch[`${p}_price`]}` : `${p} —`,
        ).join('  ') +
        (notes.length ? `   [${notes.join(', ')}]` : ''),
    )
  }

  if (!DRY_RUN) {
    const { error } = await supabase.from('inventory').update(patch).eq('id', row.id)
    if (error) {
      stats.failed++
      console.log(`      FAILED ${row.id}: ${error.message}`)
      continue
    }
  }

  stats.updated++
  stats.fieldsWritten += Object.keys(patch).length
}

if (shown === 8 && processed > 8) console.log(`  ... and ${processed - 8} more`)

console.log('\n── summary ──────────────────────────────────────')
console.log(`  items updated        ${stats.updated}`)
console.log(`  price fields written ${stats.fieldsWritten}`)
console.log(`  already had prices   ${stats.skippedAlreadySet}`)
console.log(`  no ebay_price        ${stats.skippedNoEbayPrice}`)
console.log(`  raised to a minimum  ${stats.raisedToMinimum}`)
if (stats.failed) console.log(`  failed               ${stats.failed}`)

if (DRY_RUN) console.log('\nDry run - nothing written.')
else console.log('\nPrices are stored on each item and editable per row.')
