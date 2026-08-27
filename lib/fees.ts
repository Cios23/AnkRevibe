import type { Platform } from '@/lib/types'

/**
 * Platform selling fees and profit.
 *
 * These are ESTIMATES of each marketplace's headline seller fee, not a
 * reconciliation of what actually landed in your account. They deliberately
 * ignore:
 *
 *   - shipping you subsidise, and shipping-label costs
 *   - promoted-listing / advertising fees
 *   - eBay's per-order fixed fee and store-subscription rate differences
 *   - payment-processing surcharges and sales tax handling
 *   - refunds, partial refunds and returns
 *
 * So a computed profit is an upper bound. Treat it as a decision aid, not
 * bookkeeping - the real figure comes from each platform's payout report.
 */

export type FeeModel =
  | { kind: 'percent'; rate: number }
  | { kind: 'tiered'; threshold: number; flatBelow: number; rateAtOrAbove: number }

export const PLATFORM_FEES: Record<Platform, FeeModel> = {
  // eBay's final value fee for most categories, inclusive of payment
  // processing. Category rates vary; this is the common case.
  ebay: { kind: 'percent', rate: 0.1325 },
  // Poshmark: flat $2.95 under $15, otherwise 20%.
  poshmark: { kind: 'tiered', threshold: 15, flatBelow: 2.95, rateAtOrAbove: 0.2 },
  depop: { kind: 'percent', rate: 0.1 },
  mercari: { kind: 'percent', rate: 0.1 },
}

/** Round to cents, avoiding the usual binary-float drift. */
function toCents(value: number): number {
  return Math.round(value * 100) / 100
}

/** The platform's cut of a sale at this price. */
export function platformFee(platform: Platform, salePrice: number): number {
  const model = PLATFORM_FEES[platform]
  if (!model) return 0
  if (!Number.isFinite(salePrice) || salePrice <= 0) return 0

  if (model.kind === 'percent') return toCents(salePrice * model.rate)

  return toCents(
    salePrice < model.threshold
      ? model.flatBelow
      : salePrice * model.rateAtOrAbove,
  )
}

export type ProfitBreakdown = {
  salePrice: number
  purchaseCost: number
  fee: number
  /** salePrice - fee - purchaseCost */
  profit: number
}

/**
 * Profit on a sale.
 *
 * Returns null when either input is missing rather than guessing: a profit
 * figure computed from an assumed cost is worse than no figure, because it
 * looks authoritative.
 */
export function computeProfit(
  platform: Platform,
  salePrice: number | null | undefined,
  purchaseCost: number | null | undefined,
): ProfitBreakdown | null {
  if (salePrice == null || purchaseCost == null) return null

  const price = Number(salePrice)
  const cost = Number(purchaseCost)
  if (!Number.isFinite(price) || !Number.isFinite(cost)) return null

  const fee = platformFee(platform, price)
  return {
    salePrice: toCents(price),
    purchaseCost: toCents(cost),
    fee,
    profit: toCents(price - fee - cost),
  }
}

/** Human-readable fee rule, for surfacing in the UI. */
export function describeFee(platform: Platform): string {
  const model = PLATFORM_FEES[platform]
  if (!model) return 'unknown'
  if (model.kind === 'percent') return `${(model.rate * 100).toFixed(2)}%`
  return `$${model.flatBelow.toFixed(2)} under $${model.threshold}, else ${
    model.rateAtOrAbove * 100
  }%`
}

// ---------------------------------------------------------------- ROI

/**
 * Return on investment: profit divided by what the item cost.
 *
 * Deliberately returns null rather than a number in three cases, because a
 * plausible-looking figure is worse than an absent one when ranking:
 *
 *   - no purchase_cost      we do not know the investment
 *   - no profit             the item has not sold
 *   - cost of zero          the ratio is undefined (free item, infinite
 *                           return) and would sort above every real result
 *
 * A zero cost is still a REAL cost for profit purposes - only the ratio is
 * undefined - so profit stays reportable while ROI does not.
 */
export function computeRoi(
  profit: number | null | undefined,
  purchaseCost: number | null | undefined,
): number | null {
  if (profit == null || purchaseCost == null) return null
  const cost = Number(purchaseCost)
  const gain = Number(profit)
  if (!Number.isFinite(cost) || !Number.isFinite(gain)) return null
  if (cost <= 0) return null
  return gain / cost
}

export function formatRoi(roi: number | null): string {
  if (roi === null) return '—'
  return `${roi >= 0 ? '' : '−'}${Math.abs(roi * 100).toFixed(0)}%`
}

export type RankableSale = {
  profit: number | null
  purchaseCost: number | null
  roi: number | null
}

/**
 * Split sold items into those that can be ranked and those that cannot.
 *
 * Keeping them apart is the point: unknown-cost items are not zero-cost
 * items, and mixing them into a sorted list silently misrepresents them.
 */
export function partitionRankable<T>(
  items: T[],
  read: (item: T) => RankableSale,
): { rankable: T[]; unknown: T[] } {
  const rankable: T[] = []
  const unknown: T[] = []
  for (const item of items) {
    const sale = read(item)
    if (sale.roi === null || sale.profit === null || sale.purchaseCost === null) {
      unknown.push(item)
    } else {
      rankable.push(item)
    }
  }
  return { rankable, unknown }
}
