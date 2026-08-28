/**
 * Generate the extension's crosslist mapping from lib/crosslist.
 *
 *   npm run crosslist:generate-map
 *
 * lib/crosslist is TypeScript with a rule engine; the extension is plain
 * browser JS with no bundler and cannot import it. Rather than port the rules
 * - two copies of the same logic drifting apart is how a listing ends up in
 * the wrong category, and this codebase has already been bitten by exactly
 * that - the mapping is RUN here, per item, and the finished result is
 * emitted as data.
 *
 * The extension therefore performs no mapping at all. It reads a resolved
 * category path, size, colours, condition and the rest, and fills them. That
 * keeps one source of truth, and means a fix to the rules reaches the
 * extension by re-running this rather than by editing browser JS.
 *
 * The cost is that the table is a snapshot: an item imported after this ran
 * is absent, and the popup falls back to raw values for it and says so.
 * Re-run after importing inventory. Items the mapping rejects are listed at
 * the end, because a listing that cannot be mapped is one that would be
 * filled wrongly.
 */

import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { mapListing } = await import('../lib/crosslist')
const { CROSSLIST_PLATFORMS } = await import('../lib/crosslist/types')
import type { CrosslistItem, CrosslistPlatform } from '../lib/crosslist/types'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

/** Only the platforms the extension can actually fill. */
const TARGETS = CROSSLIST_PLATFORMS.filter(
  (p): p is Exclude<CrosslistPlatform, 'mercari'> => p !== 'mercari',
)

type Row = {
  id: string
  title: string | null
  description: string | null
  brand: string | null
  category: string | null
  subcategory: string | null
  size: string | null
  color: string | null
  condition: string | null
  flaw_notes: string | null
  measurements: Record<string, unknown> | null
  style_era: string | null
  poshmark_price: number | null
  depop_price: number | null
}

const rows: Row[] = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('inventory')
    .select(
      'id, title, description, brand, category, subcategory, size, color, ' +
        'condition, flaw_notes, measurements, style_era, poshmark_price, ' +
        'depop_price',
    )
    .eq('status', 'active')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  rows.push(...((data ?? []) as Row[]))
  if (!data || data.length < 1000) break
}

/**
 * Price is per platform, so the item is built per platform: Poshmark's
 * original-price derivation works off the listing price, and handing it the
 * wrong one produces a wrong discount.
 */
const toItem = (row: Row, platform: CrosslistPlatform): CrosslistItem => ({
  title: row.title,
  description: row.description,
  brand: row.brand,
  category: row.category,
  subcategory: row.subcategory,
  size: row.size,
  color: row.color,
  condition: row.condition,
  measurements: row.measurements,
  flawNotes: row.flaw_notes,
  styleEra: row.style_era,
  price: platform === 'poshmark' ? row.poshmark_price : row.depop_price,
  // Photos are attached by the extension from listing_photos, and the count
  // is only used to warn about listings with none. One is assumed so a photo
  // warning here does not read as a mapping failure.
  photoCount: 1,
})

/**
 * What the extension needs to fill a form. Deliberately not the whole
 * MappedListing: title and description come live from the popup, so shipping
 * them here as well would double the file for no gain.
 */
type Emitted = {
  ok: boolean
  categoryPath: string[] | null
  categorySource: string | null
  size: string | null
  colors: string[]
  condition: string | null
  nwt?: boolean
  originalPrice?: number | null
  styleTags: string[]
  source?: string | null
  age?: string | null
  errors: string[]
  warnings: string[]
}

const items: Record<string, Record<string, Emitted>> = {}
const stats: Record<string, { ok: number; blocked: number; noCategory: number }> = {}
const blockedExamples: Array<{ id: string; platform: string; why: string }> = []

for (const platform of TARGETS) {
  stats[platform] = { ok: 0, blocked: 0, noCategory: 0 }
}

for (const row of rows) {
  for (const platform of TARGETS) {
    const result = mapListing(platform, toItem(row, platform))
    const listing = result.listing

    const emitted: Emitted = {
      ok: result.ok,
      categoryPath: listing.category?.path ?? null,
      categorySource: listing.category?.source ?? null,
      size: listing.size,
      colors: listing.colors,
      condition: listing.condition,
      styleTags: listing.styleTags,
      errors: result.errors.map((e) => `${e.field}: ${e.message}`),
      warnings: result.warnings.map((w) => `${w.field}: ${w.message}`),
    }

    if (platform === 'poshmark') {
      emitted.nwt = listing.nwt
      emitted.originalPrice = listing.originalPrice ?? null
    }
    if (platform === 'depop') {
      emitted.source = listing.depopSource ?? null
      emitted.age = listing.depopAge ?? null
    }

    if (!items[row.id]) items[row.id] = {}
    items[row.id][platform] = emitted

    if (result.ok) stats[platform].ok++
    else {
      stats[platform].blocked++
      if (blockedExamples.length < 12) {
        blockedExamples.push({
          id: (row.title ?? row.id).slice(0, 48),
          platform,
          why: emitted.errors[0] ?? 'unknown',
        })
      }
    }
    if (!emitted.categoryPath) stats[platform].noCategory++
  }
}

const banner = `// GENERATED by scripts/generate-crosslist-map.mts - do not edit by hand.
//
// The finished crosslist mapping for every active item, per platform: the
// category path, size, colours, condition and platform extras, already
// resolved by lib/crosslist.
//
// The extension does NO mapping of its own. Porting the rules into browser JS
// would put two copies of them in the repo, and the one that is not tested is
// the one that ends up filling the wrong category.
//
// Snapshot of ${rows.length} active items, ${TARGETS.length} platforms.
// Re-run \`npm run crosslist:generate-map\` after importing inventory - an
// item added since this ran has no entry, and the popup falls back to raw
// values and flags it.
`

const body = `(function () {
  "use strict";

  globalThis.AnkCrosslist = {
    generatedFor: ${rows.length},
    items: ${JSON.stringify(items)},

    /**
     * The resolved mapping for one item on one platform, or null when the
     * table predates the item. Null means "regenerate", not "no mapping".
     */
    lookup: function (platform, inventoryId) {
      var entry = globalThis.AnkCrosslist.items[inventoryId];
      if (!entry) return null;
      return entry[platform] || null;
    },
  };
})();
`

writeFileSync('extension/lib/crosslist-map.generated.js', banner + body, 'utf8')

console.log(`active items              ${rows.length}`)
for (const platform of TARGETS) {
  const s = stats[platform]
  console.log(
    `  ${platform.padEnd(10)} ready ${String(s.ok).padStart(4)}   ` +
      `blocked ${String(s.blocked).padStart(4)}   ` +
      `no category ${String(s.noCategory).padStart(4)}`,
  )
}

if (blockedExamples.length) {
  console.log(`\nblocked - these would be filled wrongly, so the popup refuses:`)
  for (const example of blockedExamples) {
    console.log(`  ${example.platform.padEnd(9)} ${example.id.padEnd(50)} ${example.why}`)
  }
}

console.log('\nwrote extension/lib/crosslist-map.generated.js')
