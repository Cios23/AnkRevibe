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
