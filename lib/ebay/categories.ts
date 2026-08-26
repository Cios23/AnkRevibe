import { ebayFetch, type EbayFetchOptions } from '@/lib/ebay/client'
import { marketplaceId } from '@/lib/ebay/config'

/**
 * Category mapping: our `inventory.category` / `subcategory` -> an eBay
 * leaf category id.
 *
 * Two layers, in order:
 *
 *   1. STATIC_CATEGORY_MAP - an explicit override table. Fast, free, and
 *      deterministic, but the ids below are NOT verified against the live
 *      taxonomy; treat them as a starting point. `npm run ebay:categories`
 *      checks them and reports any that no longer resolve to a leaf.
 *   2. eBay's Taxonomy API - asks eBay to suggest a category from the item
 *      title. Authoritative, and the reason a wrong entry in layer 1 is
 *      recoverable rather than fatal.
 *
 * Publishing into a non-leaf or wrong category is one of the most common
 * causes of a failed publish, which is why the fallback exists at all.
 */

/** key: `${category}` or `${category}/${subcategory}`, lowercased. */
export const STATIC_CATEGORY_MAP: Record<string, string> = {
  'outerwear/mens': '57988', // Men's Coats & Jackets
  'outerwear/womens': '63862', // Women's Coats, Jackets & Vests
  'jeans/mens': '11483',
  'jeans/womens': '11554',
  'tshirts/mens': '15687',
  'tops/womens': '53159',
  'sweaters/mens': '11484',
  'sweaters/womens': '63866',
  dresses: '63861',
  // Shoes are deliberately absent. 93427 (Men's Shoes) and 3034 (Women's
  // Shoes) are BROWSE nodes, not leaves - `npm run ebay:categories` flags
  // them and a publish into either would fail. The right leaf depends on
  // style (Sneakers vs Boots vs Dress), which a single static entry cannot
  // express, so shoes fall through to eBay's per-item suggestion instead.
}

export function staticCategoryKey(
  category: string | null | undefined,
  subcategory: string | null | undefined,
): string[] {
  const c = category?.toLowerCase().trim()
  const s = subcategory?.toLowerCase().trim()
  const keys: string[] = []
  if (c && s) keys.push(`${c}/${s}`)
  if (c) keys.push(c)
  return keys
}

let cachedTreeId: string | null = null

export async function getCategoryTreeId(
  options: EbayFetchOptions = {},
): Promise<string> {
  if (cachedTreeId) return cachedTreeId
  const result = await ebayFetch<{ categoryTreeId: string }>(
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId()}`,
    options,
  )
  if (!result?.categoryTreeId) {
    throw new Error('eBay did not return a category tree id')
  }
  cachedTreeId = result.categoryTreeId
  return cachedTreeId
}

export function clearCategoryTreeCache() {
  cachedTreeId = null
}

export type CategorySuggestion = {
  categoryId: string
  categoryName: string
}

/** Ask eBay which leaf category a title belongs in. */
export async function suggestCategory(
  query: string,
  options: EbayFetchOptions = {},
): Promise<CategorySuggestion | null> {
  const treeId = await getCategoryTreeId(options)
  const result = await ebayFetch<{
    categorySuggestions?: Array<{
      category?: { categoryId?: string; categoryName?: string }
    }>
  }>(
    `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions` +
      `?q=${encodeURIComponent(query)}`,
    options,
  )

  const top = result?.categorySuggestions?.[0]?.category
  if (!top?.categoryId) return null
  return {
    categoryId: top.categoryId,
    categoryName: top.categoryName ?? '',
  }
}

export type CategoryResolution = {
  categoryId: string
  source: 'static' | 'suggested'
  categoryName?: string
}

/**
 * Resolve a listing category, preferring the static override and falling
 * back to eBay's own suggestion.
 */
export async function resolveCategoryId(
  item: {
    category?: string | null
    subcategory?: string | null
    title?: string | null
    brand?: string | null
  },
  options: EbayFetchOptions = {},
): Promise<CategoryResolution> {
  for (const key of staticCategoryKey(item.category, item.subcategory)) {
    const hit = STATIC_CATEGORY_MAP[key]
    if (hit) return { categoryId: hit, source: 'static' }
  }

  const query = [item.brand, item.title, item.category]
    .filter(Boolean)
    .join(' ')
    .trim()

  if (!query) {
    throw new Error(
      'Cannot resolve an eBay category: item has no category, subcategory or title.',
    )
  }

  const suggestion = await suggestCategory(query, options)
  if (!suggestion) {
    throw new Error(
      `eBay could not suggest a category for "${query}". ` +
        `Add an entry to STATIC_CATEGORY_MAP in lib/ebay/categories.ts.`,
    )
  }

  return {
    categoryId: suggestion.categoryId,
    source: 'suggested',
    categoryName: suggestion.categoryName,
  }
}
