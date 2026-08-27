import type { GarmentKey } from '@/lib/crosslist/categories'
import { toInternalCategory } from '@/lib/crosslist/categories'

/**
 * Which eBay fulfillment (shipping) policy a listing gets.
 *
 * Previously every listing used one flat default, which under-charges
 * shipping on a coat and over-charges on a t-shirt. The account carries four
 * weight-banded policies, and this picks between them by garment type.
 *
 * IDs fetched live from the account on 2026-08-27. They are account
 * configuration rather than secrets, so they live here; each can still be
 * overridden by environment variable for a second account or a sandbox.
 *
 * A policy that no longer exists fails the publish - which is not
 * hypothetical: the previous flat default (259353376018 "Clothing Items")
 * was deleted from the account, so every publish would have failed on it.
 * `npm run ebay:verify-policies` checks these against the live list.
 */

export type ShippingBand =
  | 'tshirts-shorts'
  | 'sweatshirts'
  | 'light-coats-jeans'
  | 'heavy'

export type PolicyDefinition = {
  band: ShippingBand
  /** The policy id on the account. */
  id: string
  /**
   * eBay's own name for the policy. Kept verbatim so the live list can be
   * matched against it - NOT a source of truth for the price. "T Shirts/
   * Shorts $5" actually charges $6; the name was never updated.
   */
  label: string
  /** The flat rate actually configured, read from the policy on 2026-08-27. */
  costUsd: number
  envVar: string
}

export const FULFILLMENT_POLICIES: Record<ShippingBand, PolicyDefinition> = {
  'tshirts-shorts': {
    band: 'tshirts-shorts',
    id: '261742192018',
    label: 'T Shirts/Shorts $5',
    // The NAME says $5. The policy charges $6.
    costUsd: 6,
    envVar: 'EBAY_POLICY_TSHIRTS',
  },
  sweatshirts: {
    band: 'sweatshirts',
    id: '261742395018',
    label: 'Sweatshirts $8',
    costUsd: 8,
    envVar: 'EBAY_POLICY_SWEATSHIRTS',
  },
  'light-coats-jeans': {
    band: 'light-coats-jeans',
    id: '261742420018',
    label: 'Lights Coats/Jeans $10',
    costUsd: 10,
    envVar: 'EBAY_POLICY_LIGHT_COATS',
  },
  heavy: {
    band: 'heavy',
    id: '261742440018',
    label: 'Heavy Coat',
    costUsd: 12.5,
    envVar: 'EBAY_POLICY_HEAVY',
  },
}

/**
 * Garment type -> shipping band.
 *
 * Banded by what the policies are NAMED for rather than purely by estimated
 * weight, because the names encode the intent: jeans belong in
 * "Lights Coats/Jeans" even though they weigh about the same as a
 * sweatshirt.
 *
 * NOTE: shoes are the heaviest thing in the catalogue (~2lb 8oz) and there
 * is no shoe policy, so they take the heavy band. That is a judgement call -
 * the band is right by weight and odd by name.
 */
const GARMENT_BANDS: Record<GarmentKey, ShippingBand> = {
  tshirts: 'tshirts-shorts',
  polos: 'tshirts-shorts',
  'casual-shirts': 'tshirts-shorts',
  'dress-shirts': 'tshirts-shorts',
  'activewear-tops': 'tshirts-shorts',
  shorts: 'tshirts-shorts',
  swimwear: 'tshirts-shorts',
  hats: 'tshirts-shorts',

  hoodies: 'sweatshirts',
  sweaters: 'sweatshirts',
  sleepwear: 'sweatshirts',
  dresses: 'sweatshirts',
  skirts: 'sweatshirts',
  onepiece: 'sweatshirts',

  jeans: 'light-coats-jeans',
  pants: 'light-coats-jeans',
  'activewear-pants': 'light-coats-jeans',
  'coats-jackets': 'light-coats-jeans',
  bags: 'light-coats-jeans',

  coveralls: 'heavy',
  suits: 'heavy',
  'athletic-shoes': 'heavy',
  'casual-shoes': 'heavy',
}

/**
 * The band a non-apparel item falls into.
 *
 * Most of the catalogue's non-apparel is small (ornaments, trading cards,
 * mugs), so the lightest band is the closest fit - but it IS a guess, and
 * `resolveShippingPolicy` reports it as one so a heavy collectible can be
 * spotted rather than silently under-charged.
 */
export const DEFAULT_BAND: ShippingBand = 'tshirts-shorts'

/**
 * Band inferred from the title, when the category could not be mapped.
 *
 * Not cosmetic. 102 of 402 active items have no department in their eBay
 * category, so they fall to the default band - and among them are jackets,
 * hoodies and sweatshirts that would then ship on the t-shirt rate. Every
 * one of those under-declares, and shipping is paid on every sale.
 *
 * Ordered heaviest-first so "hooded jacket" bands as a jacket rather than a
 * hoodie. Titles are seller-written and messy, so this is a heuristic and is
 * reported as one.
 */
const TITLE_BANDS: Array<{ match: RegExp; band: ShippingBand }> = [
  { match: /\bcoveralls?\b|\bbibs?\b|\bsnowsuit\b/i, band: 'heavy' },
  { match: /\bboots?\b|\bsneakers?\b|\bshoes?\b|\bcleats?\b/i, band: 'heavy' },
  { match: /\bsuits?\b|\bblazer\b|\bsport coat\b/i, band: 'heavy' },
  { match: /\bparka\b|\bpuffer\b|\boveralls?\b/i, band: 'heavy' },
  { match: /\bjacket\b|\bcoat\b|\banorak\b|\bwindbreaker\b|\bvest\b/i, band: 'light-coats-jeans' },
  { match: /\bjeans?\b|\bdenim\b|\bpants?\b|\btrousers?\b|\bjoggers?\b|\bsweatpants?\b|\bchinos?\b/i, band: 'light-coats-jeans' },
  { match: /\bhoodie\b|\bhooded\b|\bsweatshirt\b|\bsweater\b|\bpullover\b|\bcrewneck\b|\bfleece\b/i, band: 'sweatshirts' },
  { match: /\bdress\b|\bskirt\b|\bromper\b/i, band: 'sweatshirts' },
  { match: /\bt-?shirts?\b|\btee\b|\btees\b|\bpolo\b|\bshorts?\b|\btank\b|\bhat\b|\bcap\b|\bsocks\b/i, band: 'tshirts-shorts' },
]
export function inferBandFromTitle(title: string | null | undefined): ShippingBand | null {
  if (!title) return null
  for (const rule of TITLE_BANDS) {
    if (rule.match.test(title)) return rule.band
  }
  return null
}

export function policyIdFor(band: ShippingBand): string {
  const policy = FULFILLMENT_POLICIES[band]
  return process.env[policy.envVar] || policy.id
}

export type ShippingResolution = {
  band: ShippingBand
  policyId: string
  label: string
  garment: GarmentKey | null
  /** How the band was chosen. */
  source: 'category' | 'title' | 'default'
  /** True when nothing matched and the default band was assumed. */
  assumed: boolean
}

/**
 * Choose a fulfillment policy for an item.
 *
 * Reuses the same category mapping the crosslist layer uses, so an item is
 * banded by the garment type we already infer rather than by a second,
 * separately-drifting table.
 */
export function resolveShippingPolicy(item: {
  category?: string | null
  subcategory?: string | null
  title?: string | null
}): ShippingResolution {
  const internal = toInternalCategory(item.category, item.subcategory)
  const garment = internal?.garment ?? null

  // The category is the better signal, so it wins outright.
  if (garment) {
    const band = GARMENT_BANDS[garment]
    return {
      band,
      policyId: policyIdFor(band),
      label: FULFILLMENT_POLICIES[band].label,
      garment,
      source: 'category',
      assumed: false,
    }
  }

  // No department in the eBay category. Rather than ship a jacket at the
  // t-shirt rate, read the title.
  const fromTitle = inferBandFromTitle(item.title)
  const band = fromTitle ?? DEFAULT_BAND

  return {
    band,
    policyId: policyIdFor(band),
    label: FULFILLMENT_POLICIES[band].label,
    garment: null,
    source: fromTitle ? 'title' : 'default',
    assumed: !fromTitle,
  }
}

/** Every policy id this module can produce, for validation. */
export function allPolicyIds(): PolicyDefinition[] {
  return Object.values(FULFILLMENT_POLICIES).map((p) => ({
    ...p,
    id: policyIdFor(p.band),
  }))
}
