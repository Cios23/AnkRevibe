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

// ------------------------------------------------- price derivation

/**
 * Minimum listing price each platform enforces.
 *
 * ASSUMED, not verified against current policy: Poshmark $3, Mercari $5,
 * Depop $1. A derived price below the floor is raised to it, which breaks
 * net-parity for that item - deliberately, since a listing the platform
 * rejects is worth less than one that nets slightly more.
 */
export const PLATFORM_MIN_PRICE: Record<Platform, number> = {
  ebay: 0.99,
  poshmark: 3,
  depop: 1,
  mercari: 5,
}

/**
 * The listing price that nets `targetNet` after the platform's fee.
 *
 * The inverse of platformFee. For a percentage this is net / (1 - rate).
 * Poshmark is tiered, so both branches are solved and the one whose answer
 * actually lands in its own band is taken - solving the wrong branch gives
 * a price that silently nets the wrong amount.
 *
 * Rounds UP to the cent, so the derived price never nets less than asked.
 */
export function priceForNetProceeds(
  platform: Platform,
  targetNet: number,
): number | null {
  if (!Number.isFinite(targetNet) || targetNet <= 0) return null
  const model = PLATFORM_FEES[platform]
  if (!model) return null

  const ceilCents = (value: number) => Math.ceil(value * 100) / 100

  let price: number
  if (model.kind === 'percent') {
    price = ceilCents(targetNet / (1 - model.rate))
  } else {
    // Below the threshold the fee is flat, above it a percentage. Solve both.
    const flatBranch = ceilCents(targetNet + model.flatBelow)
    const rateBranch = ceilCents(targetNet / (1 - model.rateAtOrAbove))

    if (flatBranch < model.threshold) {
      price = flatBranch
    } else if (rateBranch >= model.threshold) {
      price = rateBranch
    } else {
      // Neither branch is self-consistent: the target net sits in the gap
      // around the threshold. The threshold itself is the cheapest price
      // that clears it.
      price = model.threshold
    }
  }

  return Math.max(price, PLATFORM_MIN_PRICE[platform])
}

/**
 * Price for `platform` that matches the net proceeds of `fromPrice` on
 * `fromPlatform`.
 *
 * Equal sticker prices are NOT equal earnings: Poshmark takes 20% where
 * eBay takes 13.25%, so listing the same number on both quietly earns less
 * on Poshmark for identical work.
 */
export function equivalentPrice(
  fromPlatform: Platform,
  fromPrice: number | null | undefined,
  toPlatform: Platform,
): number | null {
  if (fromPrice == null) return null
  const price = Number(fromPrice)
  if (!Number.isFinite(price) || price <= 0) return null

  const net = price - platformFee(fromPlatform, price)
  return priceForNetProceeds(toPlatform, net)
}
