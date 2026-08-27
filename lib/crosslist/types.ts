import type { Platform } from '@/lib/types'

/**
 * Field mapping and validation for the platforms that have no listing API.
 *
 * eBay is not here: its adapter sends structured aspects to the Sell API and
 * asks eBay itself which ones a category requires. Poshmark, Depop and
 * Mercari are filled by driving a form, so every value has to be coerced
 * into a shape that form will accept BEFORE we start typing into it - a
 * rejected value halfway through a fill leaves a half-built listing.
 */

export type CrosslistPlatform = Extract<
  Platform,
  'poshmark' | 'depop' | 'mercari'
>

export const CROSSLIST_PLATFORMS: CrosslistPlatform[] = [
  'poshmark',
  'depop',
  'mercari',
]

/** What we know about an item, before any platform-specific coercion. */
export type CrosslistItem = {
  title: string | null
  description: string | null
  brand: string | null
  /** eBay-style category path, e.g. "Clothing, Shoes & Accessories:Men:..." */
  category: string | null
  /** Department, as imported: "Men", "Women", "Boys", "Unisex Adults"... */
  subcategory: string | null
  size: string | null
  color: string | null
  condition: string | null
  material?: string | null
  measurements?: Record<string, unknown> | null
  flawNotes?: string | null
  styleEra?: string | null
  price: number | null
  /** Poshmark requires one; we derive it when absent. */
  originalPrice?: number | null
  photoCount: number
}

/**
 * A platform's category, as a path down its own tree.
 *
 * Poshmark and Depop are 3 tiers, Mercari is 4. Modelled as an array rather
 * than named fields so one type covers all three and a depth mismatch is a
 * validation failure rather than a silently dropped level.
 */
export type PlatformCategory = {
  path: string[]
  /** Where the mapping came from, for debugging a wrong listing later. */
  source: 'mapped' | 'department-fallback'
}

export type MappedListing = {
  platform: CrosslistPlatform
  title: string
  description: string
  brand: string | null
  category: PlatformCategory | null
  size: string | null
  colors: string[]
  condition: string | null
  styleTags: string[]
  price: number | null
  /** Poshmark only. */
  originalPrice?: number | null
  /** Poshmark models condition as a New-With-Tags boolean. */
  nwt?: boolean
  /** Mercari only. */
  shippingWeightOz?: number
  packageSize?: string
}

export type ValidationIssue = {
  field: string
  message: string
}

export type MappingResult = {
  platform: CrosslistPlatform
  /** False when `errors` is non-empty - do not attempt the fill. */
  ok: boolean
  listing: MappedListing
  errors: ValidationIssue[]
  /** Mapped, but lossily - worth surfacing without blocking. */
  warnings: ValidationIssue[]
}
