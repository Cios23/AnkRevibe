import {
  CATEGORY_DEPTH,
  mapCategory,
  normaliseDepartment,
  toInternalCategory,
} from '@/lib/crosslist/categories'
import {
  buildStyleTags,
  mapColors,
  mapCondition,
  mapSize,
} from '@/lib/crosslist/attributes'
import {
  compileDescription,
  estimatePackageSize,
  estimateWeightOz,
} from '@/lib/crosslist/description'
import type {
  CrosslistItem,
  CrosslistPlatform,
  MappedListing,
  MappingResult,
  ValidationIssue,
} from '@/lib/crosslist/types'

// Relative rather than aliased: the `@/` alias does not resolve in a
// re-export at runtime under the test runner.
export * from './types'
export * from './categories'
export * from './attributes'
export * from './description'

/** Title limits, which differ enough to matter. */
export const TITLE_LIMIT: Record<CrosslistPlatform, number> = {
  poshmark: 80,
  depop: 65,
  mercari: 40,
}

export const MIN_PHOTOS = 1

/**
 * Poshmark requires an "original price" at or above the listing price, and
 * shows the gap to buyers as a discount. We rarely know MSRP, so it is
 * derived - the multiplier is the same 1.8 the extension fill already uses,
 * kept in one place so the two cannot drift.
 */
export const ORIGINAL_PRICE_MULTIPLIER = 1.8

export function deriveOriginalPrice(
  price: number | null,
  explicit?: number | null,
): number | null {
  if (explicit != null && price != null && explicit >= price) return explicit
  if (price == null) return null
  return Math.max(price, Math.round(price * ORIGINAL_PRICE_MULTIPLIER))
}

/**
 * Map an item onto one platform's fields, and validate the result.
 *
 * Validation runs on the MAPPED values rather than the raw ones, because
 * that is what the form will receive: an item can have a colour and still
 * fail if no palette entry exists for it.
 *
 * Errors block the fill. Warnings record that something was mapped lossily -
 * a dropped inseam, a second colour that did not fit - and are worth showing
 * without stopping a listing that will otherwise be correct.
 */
export function mapListing(
  platform: CrosslistPlatform,
  item: CrosslistItem,
): MappingResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  const department = normaliseDepartment(item.subcategory, item.category)
  const internal = toInternalCategory(item.category, item.subcategory)
  const category = mapCategory(platform, item.category, item.subcategory)

  // --- category
  if (!category) {
    errors.push({
      field: 'category',
      message: internal
        ? `No ${platform} category for ${internal.department}/${internal.garment}`
        : `Cannot map "${item.category ?? '(none)'}" to a ${platform} category` +
          (department ? '' : ' - department is unknown too'),
    })
  } else if (category.path.length !== CATEGORY_DEPTH[platform]) {
    // A short path means the table is wrong, not the item.
    errors.push({
      field: 'category',
      message: `${platform} needs ${CATEGORY_DEPTH[platform]} category levels, mapping gave ${category.path.length}`,
    })
  }

  // --- title
  const rawTitle = (item.title ?? '').trim()
  if (!rawTitle) {
    errors.push({ field: 'title', message: 'Title is required' })
  }
  const title = rawTitle.slice(0, TITLE_LIMIT[platform])
  if (rawTitle.length > TITLE_LIMIT[platform]) {
    warnings.push({
      field: 'title',
      message: `Title truncated to ${TITLE_LIMIT[platform]} chars for ${platform}`,
    })
  }

  // --- price
  if (item.price == null || item.price <= 0) {
    errors.push({ field: 'price', message: `No ${platform} price set` })
  }

  // --- photos
  if (item.photoCount < MIN_PHOTOS) {
    errors.push({ field: 'photos', message: 'At least one photo is required' })
  }

  // --- size
  const size = mapSize(platform, item.size)
  if (size.warning) warnings.push({ field: 'size', message: size.warning })
  // Shoes and clothing need a size; accessories genuinely do not.
  const sizeOptional =
    internal?.garment === 'hats' || internal?.garment === 'bags'
  if (!size.value && !sizeOptional) {
    errors.push({ field: 'size', message: `${platform} requires a size` })
  }

  // --- colours
  const colors = mapColors(platform, item.color)
  if (colors.warning) warnings.push({ field: 'color', message: colors.warning })
  if (colors.values.length === 0) {
    if (platform === 'mercari') {
      errors.push({ field: 'color', message: 'Mercari requires a colour' })
    } else {
      warnings.push({
        field: 'color',
        message: `No colour mapped for ${platform}`,
      })
    }
  }

  // --- condition
  const condition = mapCondition(platform, item.condition)
  if (condition.warning) {
    warnings.push({ field: 'condition', message: condition.warning })
  }
  if (platform !== 'poshmark' && !condition.value) {
    errors.push({
      field: 'condition',
      message: `${platform} requires a condition and "${item.condition ?? '(none)'}" could not be mapped`,
    })
  }

  // --- brand
  if (!item.brand?.trim() && platform === 'poshmark') {
    warnings.push({
      field: 'brand',
      message: 'No brand - Poshmark will list this under "Boutique"',
    })
  }

  // --- description
  const description = compileDescription(platform, {
    description: item.description,
    material: item.material,
    measurements: item.measurements,
    flawNotes: item.flawNotes,
    condition: item.condition,
  })
  if (description.dropped.length) {
    warnings.push({
      field: 'description',
      message: `Dropped from description to fit ${platform}'s limit: ${description.dropped.join(', ')}`,
    })
  }

  // --- platform extras
  const listing: MappedListing = {
    platform,
    title,
    description: description.text,
    brand: item.brand?.trim() || null,
    category,
    size: size.value,
    colors: colors.values,
    condition: condition.value,
    styleTags: buildStyleTags(platform, {
      styleEra: item.styleEra,
      brand: item.brand,
      garmentHint: internal?.garment ?? null,
    }),
    price: item.price,
  }

  if (platform === 'poshmark') {
    listing.nwt = condition.nwt
    listing.originalPrice = deriveOriginalPrice(item.price, item.originalPrice)
    if (listing.originalPrice == null) {
      errors.push({
        field: 'originalPrice',
        message: 'Poshmark requires an original price and none could be derived',
      })
    }
  }

  if (platform === 'mercari') {
    const weight = estimateWeightOz(internal?.garment ?? null)
    listing.shippingWeightOz = weight
    listing.packageSize = estimatePackageSize(weight)
    if (!internal?.garment) {
      warnings.push({
        field: 'shippingWeightOz',
        message: `Unrecognised garment - using the ${weight}oz default, which may under-declare shipping`,
      })
    }
  }

  return { platform, ok: errors.length === 0, listing, errors, warnings }
}

/** Map one item for several platforms at once. */
export function mapListings(
  platforms: CrosslistPlatform[],
  item: CrosslistItem,
): Record<string, MappingResult> {
  return Object.fromEntries(platforms.map((p) => [p, mapListing(p, item)]))
}

/** One-line summary of why a platform is blocked. */
export function describeErrors(result: MappingResult): string {
  if (result.ok) return ''
  return (
    `Cannot list on ${result.platform}: ` +
    result.errors.map((e) => `${e.field} - ${e.message}`).join('; ')
  )
}
