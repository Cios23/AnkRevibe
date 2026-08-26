/**
 * Condition mapping: our free-text `inventory.condition` -> eBay's
 * ConditionEnum.
 *
 * IMPORTANT / unverified: apparel categories on eBay historically use
 * condition IDs 1000 (New with tags) / 1500 (New without tags) / 1750
 * (New with defects) / 3000 (Used), and some clothing categories reject
 * the generic USED_* enums. The values below are the cross-category
 * enums, which is the safe default, but the first live publish into a
 * clothing category is the thing that will prove or disprove this. If a
 * publish fails with error 25019 ("Invalid condition"), the fix is to
 * switch that category to NEW_WITH_TAGS / NEW_WITHOUT_TAGS / USED_*
 * per eBay's per-category condition policy.
 */

export type EbayCondition =
  | 'NEW'
  | 'LIKE_NEW'
  | 'NEW_OTHER'
  | 'NEW_WITH_DEFECTS'
  | 'USED_EXCELLENT'
  | 'USED_VERY_GOOD'
  | 'USED_GOOD'
  | 'USED_ACCEPTABLE'
  | 'FOR_PARTS_OR_NOT_WORKING'

/** Normalised lookup - lowercase, punctuation and spacing collapsed. */
const CONDITION_MAP: Record<string, EbayCondition> = {
  new: 'NEW',
  'brand new': 'NEW',
  nwt: 'NEW',
  'new with tags': 'NEW',
  'new without tags': 'NEW_OTHER',
  nwot: 'NEW_OTHER',
  'new other': 'NEW_OTHER',
  'new with defects': 'NEW_WITH_DEFECTS',
  'like new': 'LIKE_NEW',
  mint: 'LIKE_NEW',
  excellent: 'USED_EXCELLENT',
  'used excellent': 'USED_EXCELLENT',
  'very good': 'USED_VERY_GOOD',
  'used very good': 'USED_VERY_GOOD',
  good: 'USED_GOOD',
  'used good': 'USED_GOOD',
  fair: 'USED_ACCEPTABLE',
  acceptable: 'USED_ACCEPTABLE',
  'used acceptable': 'USED_ACCEPTABLE',
  poor: 'FOR_PARTS_OR_NOT_WORKING',
  'for parts': 'FOR_PARTS_OR_NOT_WORKING',
  parts: 'FOR_PARTS_OR_NOT_WORKING',
  damaged: 'FOR_PARTS_OR_NOT_WORKING',
}

/** Anything we cannot recognise lists as used-good rather than failing. */
export const DEFAULT_CONDITION: EbayCondition = 'USED_GOOD'

export function normaliseCondition(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function mapCondition(value: string | null | undefined): EbayCondition {
  if (!value) return DEFAULT_CONDITION
  return CONDITION_MAP[normaliseCondition(value)] ?? DEFAULT_CONDITION
}

/**
 * eBay shows this under the condition on the listing page. Flaw notes are
 * the single most dispute-relevant field a resale listing has, so they go
 * here verbatim rather than being buried in the description.
 */
export function conditionDescription(
  condition: string | null | undefined,
  flawNotes: string | null | undefined,
): string | undefined {
  const parts = [flawNotes?.trim()].filter(Boolean) as string[]
  if (parts.length === 0) return undefined
  // eBay caps this at 1000 characters.
  return parts.join(' ').slice(0, 1000)
}

// ---------------------------------------------------------------------------
// Category-aware resolution
//
// The enums above are the cross-category set. Apparel categories reject
// them: category 52365 (Men's Hats) accepts only 1000/1500/1750/2990/3000/
// 3010 - "New with tags" ... "Pre-owned - Fair" - and a publish with
// USED_GOOD fails with error 25021, after the inventory item and offer have
// already been created.
//
// Rather than hard-code which category families use which set, ask eBay for
// the category's allowed conditions and match against them. Imported items
// carry eBay's own display names ("Pre-owned - Good"), so the match is
// usually exact.

import { ebayFetch, type EbayFetchOptions } from '@/lib/ebay/client'
import { marketplaceId } from '@/lib/ebay/config'

/**
 * ConditionEnum -> the numeric conditionId eBay translates it to.
 *
 * This indirection is the whole problem. The Inventory API accepts only
 * these enum names - PRE_OWNED_GOOD is rejected outright with "Could not
 * serialize field [condition]" - but a category validates the resulting
 * ID. Apparel categories allow 1000/1500/1750/2990/3000/3010, so USED_GOOD
 * (5000) fails with 25021 even though it serializes fine, while
 * USED_EXCELLENT (3000) succeeds and displays as "Pre-owned - Good".
 *
 * IDs 2990 and 3010 have no enum, so they are simply unreachable through
 * this API.
 */
const ENUM_TO_CONDITION_ID: Record<string, number> = {
  NEW: 1000,
  NEW_OTHER: 1500,
  NEW_WITH_DEFECTS: 1750,
  MANUFACTURER_REFURBISHED: 2000,
  CERTIFIED_REFURBISHED: 2000,
  SELLER_REFURBISHED: 2500,
  LIKE_NEW: 2750,
  USED_EXCELLENT: 3000,
  USED_VERY_GOOD: 4000,
  USED_GOOD: 5000,
  USED_ACCEPTABLE: 6000,
  FOR_PARTS_OR_NOT_WORKING: 7000,
}

export type AllowedCondition = { conditionId: string; description: string }

const policyCache = new Map<string, AllowedCondition[]>()

export function clearConditionPolicyCache() {
  policyCache.clear()
}

export async function getAllowedConditions(
  categoryId: string,
  options: EbayFetchOptions = {},
): Promise<AllowedCondition[]> {
  const cached = policyCache.get(categoryId)
  if (cached) return cached

  const body = await ebayFetch<{
    itemConditionPolicies?: Array<{
      itemConditions?: Array<{ conditionId?: string; conditionDescription?: string }>
    }>
  }>(
    `/sell/metadata/v1/marketplace/${marketplaceId()}` +
      `/get_item_condition_policies?filter=categoryIds:{${categoryId}}`,
    options,
  )

  const allowed = (body?.itemConditionPolicies?.[0]?.itemConditions ?? [])
    .filter((c) => c.conditionId)
    .map((c) => ({
      conditionId: String(c.conditionId),
      description: String(c.conditionDescription ?? ''),
    }))

  policyCache.set(categoryId, allowed)
  return allowed
}

/**
 * The ConditionEnum to send for this item in this category.
 *
 * Resolves to a target conditionId from the category's own published list -
 * imported items carry eBay's display names, so that match is usually
 * exact - then picks the enum that maps to it. When the target ID has no
 * enum, falls back to the nearest reachable one, preferring to understate
 * (a higher ID) so a listing never claims better condition than it has.
 */
export async function resolveConditionForCategory(
  value: string | null | undefined,
  categoryId: string,
  options: EbayFetchOptions = {},
): Promise<string> {
  const allowed = await getAllowedConditions(categoryId, options)
  if (allowed.length === 0) return mapCondition(value)

  const allowedIds = new Set(allowed.map((c) => Number(c.conditionId)))

  const reachable = Object.entries(ENUM_TO_CONDITION_ID)
    .filter(([, id]) => allowedIds.has(id))
    .sort((a, b) => a[1] - b[1])

  // The category publishes conditions we cannot express at all.
  if (reachable.length === 0) return mapCondition(value)

  const wanted = value ? normaliseCondition(value) : ''

  // Target id: exact display-name match against the category's own list.
  let targetId: number | null = null
  for (const candidate of allowed) {
    if (normaliseCondition(candidate.description) === wanted) {
      targetId = Number(candidate.conditionId)
      break
    }
  }

  // Otherwise fall back to our generic mapping's id.
  if (targetId === null) {
    targetId = ENUM_TO_CONDITION_ID[mapCondition(value)] ?? 5000
  }

  // Exact hit.
  const exact = reachable.find(([, id]) => id === targetId)
  if (exact) return exact[0]

  // Nearest reachable by absolute distance, tie-broken toward the worse
  // condition. Walking strictly downward instead would land a no-condition
  // collectible on FOR_PARTS_OR_NOT_WORKING simply because the category
  // happens to offer it - a far bigger error than being one grade off.
  let best = reachable[0]
  let bestDelta = Math.abs(best[1] - targetId)
  for (const candidate of reachable) {
    const delta = Math.abs(candidate[1] - targetId)
    if (delta < bestDelta || (delta === bestDelta && candidate[1] > best[1])) {
      best = candidate
      bestDelta = delta
    }
  }
  return best[0]
}
