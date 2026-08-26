import { getItem, type TradingOptions } from '@/lib/ebay/trading'

/**
 * Recovers an imported listing's true category and full item specifics from
 * eBay before republishing it.
 *
 * Why this exists: the first bulk publish failed with
 * `25002 The item specific Type is missing`. Every category has its own
 * required specifics, and we only ever send an apparel-shaped set (Brand,
 * Size, Color, Style, Department). The importer read five named specifics
 * out of GetItem and discarded the rest, so the data eBay already held was
 * no longer ours to send.
 *
 * One GetItem call per publish recovers all of it. Using the ORIGINAL
 * categoryId at the same time matters just as much: specifics are only
 * valid against the category they came from, so re-suggesting a category
 * from the title while sending the old category's specifics would trade one
 * failure for another.
 */

/** eBay caps a listing at 30 aspects; values are capped at 65 chars. */
const MAX_ASPECTS = 30
const MAX_VALUE_LENGTH = 65

/**
 * Specifics eBay derives or rejects on input. Sending them back is either
 * pointless or an error.
 */
const SKIP_ASPECTS = new Set([
  'condition',
  'conditiondescription',
])

export type LegacyListingDetail = {
  categoryId: string | null
  aspects: Record<string, string[]>
}

/**
 * Compare aspect names ignoring case and separators, but NOT digits -
 * stripping those collapses genuinely distinct names ("Set Includes 2" vs
 * "Set Includes 3") onto each other and silently drops one.
 */
function normaliseKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** True for a bare eBay ItemID, as opposed to one of our offer ids. */
export function isLegacyItemId(value: string | null | undefined): boolean {
  return !!value && /^\d{9,15}$/.test(value)
}

export async function getLegacyListingDetail(
  itemId: string,
  options: TradingOptions = {},
): Promise<LegacyListingDetail> {
  const detail = await getItem(itemId, options)

  const aspects: Record<string, string[]> = {}
  let count = 0

  for (const [name, value] of Object.entries(detail.specifics)) {
    if (count >= MAX_ASPECTS) break
    const trimmedName = name.trim()
    const trimmedValue = String(value).trim()
    if (!trimmedName || !trimmedValue) continue
    if (SKIP_ASPECTS.has(normaliseKey(trimmedName))) continue

    aspects[trimmedName] = [trimmedValue.slice(0, MAX_VALUE_LENGTH)]
    count++
  }

  return { categoryId: detail.categoryId, aspects }
}

/**
 * Merge recovered specifics over our derived ones.
 *
 * eBay's own values win: they were valid on the live listing in that exact
 * category, which is a stronger guarantee than anything we inferred from a
 * column. Ours fill the gaps and keep Brand present.
 */
export function mergeAspects(
  derived: Record<string, string[]>,
  recovered: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...derived }
  const seen = new Set(Object.keys(derived).map(normaliseKey))

  for (const [name, value] of Object.entries(recovered)) {
    const key = normaliseKey(name)
    if (seen.has(key)) {
      // Replace our guess with eBay's value, under eBay's spelling.
      const ours = Object.keys(merged).find((k) => normaliseKey(k) === key)
      if (ours) delete merged[ours]
    }
    merged[name] = value
    seen.add(key)
  }

  return Object.fromEntries(Object.entries(merged).slice(0, MAX_ASPECTS))
}
