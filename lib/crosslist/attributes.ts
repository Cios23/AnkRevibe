import type { CrosslistPlatform } from '@/lib/crosslist/types'

/**
 * Size, colour and condition coercion.
 *
 * Every value here is normalised from what the catalogue actually contains,
 * not from an idealised schema. Real sizes include "M", "2XL", "44", "33",
 * "18-24 Months", "One Size" and "Small"; real colours include both
 * "Multicolor" and "Multi-Color"; real conditions include eBay display names
 * ("Pre-owned - Excellent"), bare words ("Used"), and a lowercase "good".
 */

// ------------------------------------------------------------------ sizes

const LETTER_SIZES: Record<string, string> = {
  xxs: 'XXS',
  xs: 'XS',
  'extra small': 'XS',
  s: 'S',
  small: 'S',
  m: 'M',
  medium: 'M',
  l: 'L',
  large: 'L',
  xl: 'XL',
  'extra large': 'XL',
  '1x': 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
  '2x': 'XXL',
  xxxl: 'XXXL',
  '3xl': 'XXXL',
  '3x': 'XXXL',
}

/** Depop writes plus sizes as XXL rather than 2XL. Poshmark/Mercari use both. */
const DEPOP_LETTER: Record<string, string> = { XXL: 'XXL', XXXL: 'XXXL' }

/** Poshmark spells the plus range with digits. */
const POSHMARK_LETTER: Record<string, string> = { XXS: 'XXS', XXL: '2X', XXXL: '3X' }

export type SizeResult = {
  value: string | null
  /** Mapped, but the platform's field may not accept it verbatim. */
  warning?: string
}

function cleanSize(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Coerce a size into what a platform's single-select expects.
 *
 * All three take one size, so a range like "18-24 Months" has to resolve to
 * a single option rather than being sent as free text.
 */
export function mapSize(
  platform: CrosslistPlatform,
  raw: string | null | undefined,
): SizeResult {
  if (!raw || !raw.trim()) return { value: null }
  const value = cleanSize(raw)

  if (value === 'one size' || value === 'os' || value === 'onesize') {
    return { value: 'One Size' }
  }

  const letter = LETTER_SIZES[value]
  if (letter) {
    if (platform === 'poshmark' && POSHMARK_LETTER[letter]) {
      return { value: POSHMARK_LETTER[letter] }
    }
    if (platform === 'depop' && DEPOP_LETTER[letter]) {
      return { value: DEPOP_LETTER[letter] }
    }
    return { value: letter }
  }

  // Age ranges, e.g. "18-24 Months". Platforms list a single bucket, so take
  // the upper bound - a garment that fits up to 24 months is listed there.
  const months = value.match(/^(\d+)\s*-\s*(\d+)\s*months?$/)
  if (months) return { value: `${months[2]} Months` }
  const singleMonths = value.match(/^(\d+)\s*months?$/)
  if (singleMonths) return { value: `${singleMonths[1]} Months` }

  // Waist x inseam, e.g. "34x30" -> the waist is the selectable size.
  const waist = value.match(/^(\d{2})\s*x\s*(\d{2})$/)
  if (waist) {
    return {
      value: waist[1],
      warning: `Inseam ${waist[2]} dropped - ${platform} selects on waist only`,
    }
  }

  // Bare numbers: shoe or numeric apparel sizing. Pass through - which scale
  // it belongs to depends on the category, which the platform form decides.
  if (/^\d{1,2}(\.5)?$/.test(value)) return { value }

  return {
    value: raw.trim(),
    warning: `Size "${raw.trim()}" is not a recognised value; the ${platform} form may reject it`,
  }
}

// ----------------------------------------------------------------- colours

/** Poshmark's palette: 16 options. */
export const POSHMARK_COLORS = [
  'Red', 'Pink', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Gold',
  'Silver', 'Black', 'White', 'Gray', 'Brown', 'Tan', 'Cream', 'Multi',
]

/** Depop's palette. */
export const DEPOP_COLORS = [
  'Black', 'White', 'Grey', 'Brown', 'Cream', 'Red', 'Pink', 'Orange',
  'Yellow', 'Green', 'Blue', 'Purple', 'Silver', 'Gold', 'Multi',
]

/** Mercari's palette. */
export const MERCARI_COLORS = [
  'Black', 'White', 'Gray', 'Brown', 'Beige', 'Red', 'Pink', 'Orange',
  'Yellow', 'Green', 'Blue', 'Purple', 'Silver', 'Gold', 'Multi',
]

const PALETTES: Record<CrosslistPlatform, string[]> = {
  poshmark: POSHMARK_COLORS,
  depop: DEPOP_COLORS,
  mercari: MERCARI_COLORS,
}

export const MAX_COLORS: Record<CrosslistPlatform, number> = {
  poshmark: 2,
  depop: 2,
  mercari: 2,
}

/**
 * Colours our data uses that no palette contains, and the nearest option.
 *
 * Reduction is lossy on purpose: "Navy" is not offered anywhere, and listing
 * it as Blue is right. Anything genuinely multi-coloured collapses to Multi.
 */
const COLOR_SYNONYMS: Record<string, string> = {
  navy: 'Blue', 'navy blue': 'Blue', teal: 'Blue', turquoise: 'Blue', aqua: 'Blue',
  denim: 'Blue', royal: 'Blue', 'light blue': 'Blue', 'dark blue': 'Blue',
  charcoal: 'Gray', grey: 'Gray', 'light gray': 'Gray', 'dark gray': 'Gray',
  heather: 'Gray', 'heather gray': 'Gray',
  burgundy: 'Red', maroon: 'Red', wine: 'Red', crimson: 'Red', rust: 'Orange',
  khaki: 'Tan', camel: 'Tan', taupe: 'Tan', sand: 'Tan',
  beige: 'Beige', ivory: 'Cream', 'off white': 'Cream', bone: 'Cream',
  olive: 'Green', mint: 'Green', lime: 'Green', forest: 'Green', sage: 'Green',
  lavender: 'Purple', violet: 'Purple', plum: 'Purple', magenta: 'Pink',
  coral: 'Pink', peach: 'Pink', salmon: 'Pink',
  multicolor: 'Multi', 'multi color': 'Multi', 'multi-color': 'Multi',
  multicolour: 'Multi', multi: 'Multi', rainbow: 'Multi', assorted: 'Multi',
  clear: 'White', natural: 'Cream',
}

function canonicalColor(raw: string): string | null {
  const value = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!value) return null
  const synonym = COLOR_SYNONYMS[value]
  if (synonym) return synonym
  // Title-case a plain colour word.
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Fallbacks when a canonical colour is absent from a given palette. */
const PALETTE_FALLBACK: Record<string, string> = {
  Gray: 'Grey', // Depop spells it Grey
  Grey: 'Gray',
  Beige: 'Tan', // Poshmark has Tan, not Beige
  Tan: 'Beige', // Mercari has Beige, not Tan
  Cream: 'White',
}

export type ColorResult = { values: string[]; warning?: string }

/**
 * Reduce our colour string to at most `MAX_COLORS` palette entries.
 *
 * Our data holds a single colour per item, but the field is free text and
 * can carry "Blue/White", so split before reducing.
 */
export function mapColors(
  platform: CrosslistPlatform,
  raw: string | null | undefined,
): ColorResult {
  if (!raw || !raw.trim()) return { values: [] }

  const palette = PALETTES[platform]
  const parts = raw.split(/[\/,&]|\band\b/i).map((p) => p.trim()).filter(Boolean)

  const mapped: string[] = []
  const dropped: string[] = []

  for (const part of parts) {
    const canonical = canonicalColor(part)
    if (!canonical) continue

    let chosen: string | null = palette.includes(canonical) ? canonical : null
    if (!chosen) {
      const fallback = PALETTE_FALLBACK[canonical]
      if (fallback && palette.includes(fallback)) chosen = fallback
    }
    if (!chosen) {
      dropped.push(part)
      continue
    }
    if (!mapped.includes(chosen)) mapped.push(chosen)
  }

  const limit = MAX_COLORS[platform]
  const warnings: string[] = []
  if (dropped.length) {
    warnings.push(`No ${platform} colour for: ${dropped.join(', ')}`)
  }
  if (mapped.length > limit) {
    warnings.push(`${platform} allows ${limit} colours; dropped ${mapped.slice(limit).join(', ')}`)
  }

  return {
    values: mapped.slice(0, limit),
    warning: warnings.length ? warnings.join('. ') : undefined,
  }
}

// -------------------------------------------------------------- conditions

/** Depop's 5 tiers. */
export const DEPOP_CONDITIONS = [
  'Brand new', 'Like new', 'Excellent', 'Very good', 'Good',
] as const

/** Mercari's 6 tiers. */
export const MERCARI_CONDITIONS = [
  'New', 'Like new', 'Good', 'Fair', 'Poor', 'For parts',
] as const

/**
 * Rank our condition on a 0-5 scale, best to worst, from the values the
 * catalogue actually holds. Everything else maps off this single ranking so
 * the three platforms cannot disagree about which item is in better shape.
 */
function conditionRank(raw: string | null | undefined): number | null {
  if (!raw || !raw.trim()) return null
  const value = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

  if (value.includes('new with tag') || value === 'nwt') return 0
  if (value.includes('new without tag') || value === 'nwot') return 1
  if (value === 'new' || value.includes('brand new') || value.includes('sealed')) return 0
  if (value.includes('open box') || value.includes('new other')) return 1
  if (value.includes('like new') || value.includes('mint')) return 1
  if (value.includes('excellent')) return 2
  if (value.includes('very good')) return 3
  if (value.includes('good')) return 4 // covers "Pre-owned - Good" and "good"
  if (value.includes('fair') || value.includes('acceptable')) return 5
  if (value.includes('poor') || value.includes('parts') || value.includes('damaged')) return 5
  // "Used", "Pre-owned", "Ungraded" - known to be second-hand, nothing more.
  if (value.includes('used') || value.includes('pre owned') || value.includes('ungraded')) {
    return 4
  }
  return null
}

export type ConditionResult = {
  /** Platform-specific label; null for Poshmark, which uses a boolean. */
  value: string | null
  /** Poshmark only. */
  nwt?: boolean
  warning?: string
}

export function mapCondition(
  platform: CrosslistPlatform,
  raw: string | null | undefined,
): ConditionResult {
  const rank = conditionRank(raw)

  if (platform === 'poshmark') {
    // Poshmark has no condition field, only a New-With-Tags flag. Anything
    // short of genuinely new-with-tags is simply not NWT.
    const isNwt = (raw ?? '').toLowerCase().includes('new with tag') || rank === 0
    return { value: null, nwt: isNwt }
  }

  if (rank === null) {
    return {
      value: null,
      warning: `Condition "${raw ?? ''}" not recognised; ${platform} requires one`,
    }
  }

  if (platform === 'depop') {
    // 0..5 -> Brand new / Like new / Excellent / Very good / Good / Good
    const scale = ['Brand new', 'Like new', 'Excellent', 'Very good', 'Good', 'Good']
    return { value: scale[rank] }
  }

  // Mercari: 0..5 -> New / Like new / Like new / Good / Good / Fair
  const scale = ['New', 'Like new', 'Like new', 'Good', 'Good', 'Fair']
  return { value: scale[rank] }
}

// ------------------------------------------------------------- style tags

export const MAX_STYLE_TAGS: Record<CrosslistPlatform, number> = {
  poshmark: 3,
  depop: 2,
  mercari: 0, // Mercari has no style-tag field
}

/**
 * Style tags from the fields we have - era and brand read as style on these
 * platforms, and both are searched.
 */
export function buildStyleTags(
  platform: CrosslistPlatform,
  input: { styleEra?: string | null; brand?: string | null; garmentHint?: string | null },
): string[] {
  const limit = MAX_STYLE_TAGS[platform]
  if (limit === 0) return []

  const tags: string[] = []
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && !tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      tags.push(trimmed)
    }
  }

  push(input.styleEra)
  push(input.brand)
  push(input.garmentHint)

  return tags.slice(0, limit)
}
