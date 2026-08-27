/**
 * Check every Poshmark path in lib/crosslist against the real category tree.
 *
 *   npm run poshmark:verify
 *
 * The tree in lib/crosslist/data/poshmark-tree.json was scraped from the live
 * create-listing page (scripts/poshmark-category-scraper.js). A path that is
 * not in it will fail at fill time in the worst possible way: the picker
 * simply will not contain the row, so the listing goes out miscategorised or
 * not at all.
 *
 * Re-run this after editing the table, and re-scrape when Poshmark changes
 * its taxonomy.
 */

import { readFileSync } from 'node:fs'

const { mapCategory } = await import('../lib/crosslist/categories')
const { CROSSLIST_PLATFORMS } = await import('../lib/crosslist/types')

type Tree = Record<string, Record<string, string[]>>

const scraped = JSON.parse(
  readFileSync('lib/crosslist/data/poshmark-tree.json', 'utf8'),
) as { counts?: Record<string, number>; tree: Tree }

const tree = scraped.tree

console.log(
  `tree: ${Object.keys(tree).length} departments, ` +
    `${Object.values(tree).reduce((n, c) => n + Object.keys(c).length, 0)} categories, ` +
    `${Object.values(tree).reduce(
      (n, c) => n + Object.values(c).reduce((m, s) => m + s.length, 0),
      0,
    )} subcategories\n`,
)

/** Every (category, subcategory) pair the catalogue can produce. */
const pairsFile = 'extension/lib/category-map.generated.js'
let pairs: Array<[string, string]> = []
try {
  const source = readFileSync(pairsFile, 'utf8')
  new Function(source).call(globalThis)
  const map = (globalThis as never as { AnkCategoryMap: Record<string, Record<string, string[]>> })
    .AnkCategoryMap
  pairs = Object.keys(map.poshmark ?? {}).map((k) => {
    const [category, subcategory] = k.split('|')
    return [category, subcategory] as [string, string]
  })
} catch {
  console.log(`(no generated map yet - run npm run crosslist:generate-map)\n`)
}

let ok = 0
const problems: string[] = []

for (const [category, subcategory] of pairs) {
  const mapped = mapCategory('poshmark', category, subcategory || null)
  if (!mapped) continue

  const [department, cat, sub] = mapped.path
  const label = `${category || '(none)'} | ${subcategory || '(none)'}`

  if (!tree[department]) {
    problems.push(`${label}\n    department "${department}" not in tree`)
    continue
  }
  if (!tree[department][cat]) {
    problems.push(
      `${label}\n    "${cat}" is not a category under ${department}\n` +
        `    available: ${Object.keys(tree[department]).slice(0, 8).join(', ')}`,
    )
    continue
  }
  if (sub && !tree[department][cat].includes(sub)) {
    problems.push(
      `${label}\n    "${sub}" is not under ${department} > ${cat}\n` +
        `    available: ${tree[department][cat].slice(0, 8).join(', ')}`,
    )
    continue
  }
  ok++
}

console.log(`catalogue pairs mapping to a valid Poshmark path: ${ok}`)
console.log(`invalid: ${problems.length}`)

if (problems.length) {
  console.log('')
  for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`)
  if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`)
}

// Depop and Mercari have no scraped tree yet, so say so rather than implying
// they were checked.
const unverified = CROSSLIST_PLATFORMS.filter((p) => p !== 'poshmark')
console.log(
  `\nNOT verified against a live tree: ${unverified.join(', ')} ` +
    `- those tables are still hand-written.`,
)

process.exit(problems.length ? 1 : 0)
