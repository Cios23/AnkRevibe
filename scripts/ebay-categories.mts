/**
 * Verifies STATIC_CATEGORY_MAP against eBay's live taxonomy.
 *
 * Run: npm run ebay:categories
 *
 * The ids in lib/ebay/categories.ts were seeded by hand. eBay retires and
 * re-parents categories, and publishing into a non-leaf or retired category
 * fails at the last step of a three-call flow - after the inventory item
 * and offer already exist. This checks them up front instead.
 */

try {
  process.loadEnvFile('.env.local')
} catch {
  // Fall through to the ambient environment.
}

const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')
const { getCategoryTreeId, STATIC_CATEGORY_MAP } = await import(
  '../lib/ebay/categories'
)
const { ebayEnv, marketplaceId } = await import('../lib/ebay/config')

console.log(`environment   ${ebayEnv()}`)
console.log(`marketplace   ${marketplaceId()}\n`)

let treeId: string
try {
  treeId = await getCategoryTreeId()
} catch (cause) {
  console.error(
    `Could not read the category tree: ${cause instanceof Error ? cause.message : cause}`,
  )
  if (cause instanceof EbayApiError && cause.status === 401) {
    console.error('→ run: npm run ebay:auth')
  }
  process.exit(1)
}

console.log(`category tree ${treeId}\n`)

let bad = 0

for (const [key, categoryId] of Object.entries(STATIC_CATEGORY_MAP)) {
  try {
    const subtree = await ebayFetch<any>(
      `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_subtree` +
        `?category_id=${encodeURIComponent(categoryId)}`,
    )

    const node = subtree?.categorySubtreeNode
    const name = node?.category?.categoryName ?? '(unknown)'
    const isLeaf = node?.leafCategoryTreeNode === true

    if (isLeaf) {
      console.log(`  OK    ${key.padEnd(22)} ${categoryId.padEnd(8)} ${name}`)
    } else {
      bad++
      console.log(
        `  NOT LEAF ${key.padEnd(19)} ${categoryId.padEnd(8)} ${name}` +
          `\n         → publishing here will fail; pick a child category`,
      )
    }
  } catch (cause) {
    bad++
    const message = cause instanceof Error ? cause.message : String(cause)
    console.log(`  FAIL  ${key.padEnd(22)} ${categoryId.padEnd(8)} ${message}`)
  }
}

console.log()
if (bad) {
  console.log(
    `${bad} entr${bad === 1 ? 'y' : 'ies'} need attention in ` +
      `lib/ebay/categories.ts. Unmapped items still fall back to eBay's ` +
      `own suggestion at publish time, so this is a warning, not a blocker.`,
  )
} else {
  console.log('All static category mappings resolve to leaf categories.')
}

process.exit(bad ? 1 : 0)
