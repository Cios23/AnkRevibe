/**
 * Check every Depop path in lib/crosslist against the real category names.
 *
 *   npm run depop:verify
 *
 * WHAT THIS CAN AND CANNOT CHECK
 *
 * lib/crosslist/data/depop-tree.json holds the 140 LEAF names the live
 * category picker offers, captured by scripts/depop-field-scraper.js. It does
 * not hold the department/category tiers above them: every branch walk failed
 * with no-menu, so recording a hierarchy would mean inventing one.
 *
 * So this verifies the leaf - the third element of each mapped path - and
 * says plainly that the first two are unchecked. That is worth doing on its
 * own: a leaf the picker does not contain cannot be selected at all, and the
 * fill either miscategorises the listing or gives up. It is exactly how the
 * hand-written table came to be written in British English ("Trainers",
 * "Trousers", "Joggers") for a form that says Sneakers, Pants and Sweatpants.
 *
 * Re-run after editing the table, and re-capture when Depop changes its
 * taxonomy.
 */

import { readFileSync } from 'node:fs'

const { mapCategory } = await import('../lib/crosslist/categories')

type Capture = {
  capturedAt?: string
  shape?: string
  leaves: string[]
}

const capture = JSON.parse(
  readFileSync('lib/crosslist/data/depop-tree.json', 'utf8'),
) as Capture

const leaves = new Set(capture.leaves.map((l) => l.toLowerCase()))

console.log(
  `capture: ${capture.leaves.length} leaf names, taken ${capture.capturedAt ?? 'unknown'}\n`,
)

/** Every (category, subcategory) pair the catalogue can produce. */
const pairs = new Set<string>()
try {
  const source = readFileSync('extension/lib/crosslist-map.generated.js', 'utf8')
  new Function(source).call(globalThis)
  const map = (globalThis as never as {
    AnkCrosslist: { items: Record<string, Record<string, { categoryPath?: string[] }>> }
  }).AnkCrosslist

  for (const entry of Object.values(map.items)) {
    const path = entry.depop?.categoryPath
    if (path?.length) pairs.add(path.join(' > '))
  }
} catch {
  console.log('(no generated map yet - run npm run crosslist:generate-map)\n')
}

let ok = 0
const problems: Array<{ path: string; leaf: string }> = []

for (const path of pairs) {
  const leaf = path.split(' > ').pop() ?? ''
  if (leaves.has(leaf.toLowerCase())) ok++
  else problems.push({ path, leaf })
}

console.log(`distinct Depop paths in use: ${pairs.size}`)
console.log(`  leaf exists on the form:   ${ok}`)
console.log(`  leaf does NOT exist:       ${problems.length}`)

if (problems.length) {
  console.log('\nThese cannot be selected - the picker has no such row:')
  for (const problem of problems) {
    // Offer the closest real names rather than only saying "wrong", since the
    // fix is always picking the right row from the captured list.
    const needle = problem.leaf.toLowerCase().split(/[^a-z]+/).filter(Boolean)
    const near = capture.leaves
      .filter((l) => needle.some((w) => w.length > 3 && l.toLowerCase().includes(w)))
      .slice(0, 4)
    console.log(`  ${problem.path}`)
    console.log(
      `      "${problem.leaf}" is not a Depop category` +
        (near.length ? ` - closest real names: ${near.join(', ')}` : ''),
    )
  }
}

// Say what was not checked, so a clean run is not mistaken for a full one.
console.log(
  `\nNOT verified: the department and category tiers of each path. The ` +
    `capture holds leaf names only - see the note in depop-tree.json. ` +
    `Re-run the scraper with a working branch walk to check those too.`,
)

/** A sanity check on the capture itself, not on our table. */
const sanity = ['T-shirts', 'Sneakers', 'Pants', 'Other']
const missing = sanity.filter((s) => !leaves.has(s.toLowerCase()))
if (missing.length) {
  console.log(
    `\nWARNING: the capture is missing basics (${missing.join(', ')}) - ` +
      `it is probably truncated, so treat a pass here as meaningless.`,
  )
}

process.exit(problems.length ? 1 : 0)
