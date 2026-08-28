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
/**
 * Depop's palette, read from the live listing form on 2026-08-28.
 *
 * Four of these were missing when written by hand: Tan, Burgundy, Navy and
 * Khaki. Nothing invalid was being submitted, but the reduction below was
 * throwing away detail Depop accepts - and khaki was dropped outright,
 * because it reduced to Tan and Tan was not in the table either.
 */
export const DEPOP_COLORS = [
  'Black', 'Grey', 'White', 'Brown', 'Tan', 'Cream', 'Yellow', 'Red',
  'Burgundy', 'Orange', 'Pink', 'Purple', 'Blue', 'Navy', 'Green', 'Khaki',
  'Multi', 'Silver', 'Gold',
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
  navy: 'Navy', 'navy blue': 'Navy', teal: 'Blue', turquoise: 'Blue', aqua: 'Blue',
  denim: 'Blue', royal: 'Blue', 'light blue': 'Blue', 'dark blue': 'Blue',
  charcoal: 'Gray', grey: 'Gray', 'light gray': 'Gray', 'dark gray': 'Gray',
  heather: 'Gray', 'heather gray': 'Gray',
  burgundy: 'Burgundy', maroon: 'Burgundy', wine: 'Burgundy',
  crimson: 'Red', rust: 'Orange',
  khaki: 'Khaki', camel: 'Tan', taupe: 'Tan', sand: 'Tan',
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

/**
 * Nearest alternatives when a palette lacks a colour, best first.
 *
 * Reduction happens per platform rather than globally, so a colour survives
 * wherever it is offered: Navy stays Navy on Depop and becomes Blue on
 * Poshmark and Mercari, which have no Navy. Collapsing at canonicalisation
 * time - as this did - lost the distinction everywhere, for everyone.
 *
 * Chains are followed transitively, so Khaki reaches Beige on Mercari via
 * Tan. Colours no platform offers (teal, olive, lavender) still collapse in
 * COLOR_SYNONYMS, where there is nothing to preserve.
 */
const COLOR_REDUCTIONS: Record<string, string[]> = {
  Navy: ['Blue'],
  Burgundy: ['Red'],
  // Beige before Green: on Mercari, which has neither Khaki nor Tan,
  // Beige is far closer than Green.
  Khaki: ['Tan', 'Beige', 'Green'],
  Tan: ['Beige', 'Khaki', 'Brown'],
  Beige: ['Tan', 'Cream'],
  Cream: ['White', 'Beige'],
  Gray: ['Grey'], // Depop spells it Grey
  Grey: ['Gray'],
}

/** The nearest colour this palette offers, or null if there is none. */
function reduceToPalette(canonical: string, palette: string[]): string | null {
  if (palette.includes(canonical)) return canonical

  const seen = new Set([canonical])
  const queue = [...(COLOR_REDUCTIONS[canonical] ?? [])]
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next)) continue
    seen.add(next)
    if (palette.includes(next)) return next
    queue.push(...(COLOR_REDUCTIONS[next] ?? []))
  }
  return null
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

    const chosen = reduceToPalette(canonical, palette)
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

/**
 * Depop's 5 tiers, read from the live listing form on 2026-08-28.
 *
 * Written by hand these were wrong on three of five: Depop prefixes its used
 * tiers with "Used - " and has no "Very good" at all, so the guessed values
 * ("Excellent", "Very good", "Good") were strings the form does not accept.
 * Verified against the rendered dropdown - do not "tidy" the prefix away.
 */
export const DEPOP_CONDITIONS = [
  'Brand new', 'Like new', 'Used - Excellent', 'Used - Good', 'Used - Fair',
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
    // 0..5 -> Brand new / Like new / Used - Excellent / Used - Good /
    //         Used - Good / Used - Fair
    //
    // Depop offers only three used tiers, so rank 3 ("very good") lands on
    // "Used - Good" rather than "Used - Excellent". Understating condition
    // costs a little money; overstating it earns a return and a defect.
    const scale: readonly string[] = [
      'Brand new',
      'Like new',
      'Used - Excellent',
      'Used - Good',
      'Used - Good',
      'Used - Fair',
    ]
    return { value: scale[rank] }
  }

  // Mercari: 0..5 -> New / Like new / Like new / Good / Good / Fair
  const scale = ['New', 'Like new', 'Like new', 'Good', 'Good', 'Fair']
  return { value: scale[rank] }
}

// -------------------------------------------------- Depop source and age

/**
 * Depop's "Source" options, read from the live listing form on 2026-08-28.
 *
 * The spacing in "Reworked / Upcycled" is Depop's, not a typo - do not tidy
 * it, the form matches on the exact string.
 */
export const DEPOP_SOURCES = [
  'Vintage', 'Preloved', 'Reworked / Upcycled', 'Custom', 'Handmade',
  'Deadstock', 'Designer', 'Repaired',
] as const

/** Depop's "Age" options, read from the live listing form on 2026-08-28. */
export const DEPOP_AGES = [
  'Modern', '00s', '90s', '80s', '70s', '60s', '50s', 'Antique',
] as const

/**
 * Which decade bucket an era string falls into.
 *
 * This is where styleEra belongs. It was previously being pushed into Depop's
 * Style field as free text ("1990s"), which Style does not accept - Age is
 * the field that takes a decade, and it takes it from a fixed list.
 */
export function mapDepopAge(
  styleEra: string | null | undefined,
): { value: string | null; warning?: string } {
  if (!styleEra || !styleEra.trim()) return { value: null }
  const text = styleEra.toLowerCase()

  if (/\bantique\b/.test(text)) return { value: 'Antique' }
  if (/\by2k\b/.test(text)) return { value: '00s' }
  if (/\bmodern\b|\bcontemporary\b|\bcurrent\b/.test(text)) return { value: 'Modern' }

  // "1990s" first: the trailing s means \b never fires after the year, so a
  // plain four-digit pattern misses the single commonest way an era is
  // written. Then a bare year, then a bare decade.
  const spelled = text.match(/\b(18|19|20)(\d)0s\b/)
  const year = text.match(/\b(18|19|20)(\d)\d\b/)
  const bare = text.match(/\b(\d0)s\b/)

  let decade: number | null = null
  if (spelled) decade = Number(spelled[1] + spelled[2] + '0')
  else if (year) decade = Number(year[1] + year[2] + '0')
  else if (bare) {
    const two = Number(bare[1])
    // Bare "00s"/"10s" are this century; everything else is the last one.
    decade = two <= 20 ? 2000 + two : 1900 + two
  }

  if (decade === null) {
    // "Vintage" on its own says second-hand, not which decade.
    return {
      value: null,
      warning: `Era "${styleEra}" gives no decade for Depop's Age field`,
    }
  }

  if (decade < 1950) return { value: 'Antique' }
  if (decade >= 2010) return { value: 'Modern' }
  if (decade >= 2000) return { value: '00s' }
  return { value: String(decade).slice(2) + 's' } // 1990 -> "90s"
}

/**
 * Where the item came from, as Depop models it.
 *
 * Optional on the form, so this returns null rather than guessing when the
 * signals are weak - a wrong "Deadstock" is a misrepresented listing, an
 * absent one is merely a blank field.
 */
export function mapDepopSource(input: {
  styleEra?: string | null
  condition?: string | null
  title?: string | null
  description?: string | null
}): { value: string | null } {
  const text = [input.title, input.description, input.styleEra]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const condition = (input.condition ?? '').toLowerCase()

  // Most specific claims first: each says something the others do not.
  if (/\breworked\b|\bupcycled\b|\brepurposed\b/.test(text)) {
    return { value: 'Reworked / Upcycled' }
  }
  if (/\bhandmade\b|\bhand made\b|\bhand-made\b/.test(text)) return { value: 'Handmade' }
  if (/\bdeadstock\b|\bnos\b/.test(text)) return { value: 'Deadstock' }
  if (/\brepaired\b|\bmended\b|\bdarned\b/.test(text)) return { value: 'Repaired' }
  if (/\bcustom\b|\bone of one\b|\bbespoke\b/.test(text)) return { value: 'Custom' }

  const age = mapDepopAge(input.styleEra).value
  const oldEnough = age !== null && age !== 'Modern'
  if (oldEnough || /\bvintage\b/.test(text)) return { value: 'Vintage' }

  // Anything second-hand that is not vintage is simply preloved.
  if (condition && !/\bnew\b/.test(condition)) return { value: 'Preloved' }

  return { value: null }
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
  input: {
    styleEra?: string | null
    brand?: string | null
    garmentHint?: string | null
    title?: string | null
    description?: string | null
  },
): string[] {
  const limit = MAX_STYLE_TAGS[platform]
  if (limit === 0) return []

  // Depop's Style is a fixed vocabulary, so it gets chosen values, never
  // free text. Poshmark's is genuinely free text and keeps the old behaviour.
  if (platform === 'depop') return depopStyleTags(input).slice(0, limit)

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

/**
 * Depop's "Style" options, read from the live listing form on 2026-08-28.
 *
 * Style is a fixed list, and buildStyleTags was feeding it free text - the
 * era ("1990s"), the brand ("Nike") and the garment ("tshirts"). None of
 * those are Style values, so every Depop style tag would have been rejected.
 */
export const DEPOP_STYLES = [
  'Streetwear', 'Sportswear', 'Loungewear', 'Goth', 'Retro', 'Boho',
  'Western', 'Indie', 'Skater', 'Rave', 'Costume', 'Cosplay', 'Grunge',
  'Emo', 'Minimalist', 'Preppy', 'Avant Garde', 'Punk', 'Glam', 'Regency',
  'Casual', 'Utility', 'Futuristic', 'Cottage', 'Fairy', 'Kidcore', 'Y2K',
  'Biker', 'Gorpcore', 'Twee', 'Coquette', 'Whimsygoth',
] as const

/**
 * Words that justify a Style value, most distinctive first.
 *
 * Deliberately narrow. A tag nobody searches costs nothing; a wrong one puts
 * the item in front of the wrong buyers, so anything ambiguous is left off.
 */
const STYLE_KEYWORDS: Array<{ style: string; match: RegExp }> = [
  { style: 'Whimsygoth', match: /\bwhimsygoth\b/i },
  { style: 'Gorpcore', match: /\bgorpcore\b|\bouterdoor\b/i },
  { style: 'Coquette', match: /\bcoquette\b/i },
  { style: 'Kidcore', match: /\bkidcore\b/i },
  { style: 'Cosplay', match: /\bcosplay\b/i },
  { style: 'Costume', match: /\bcostume\b|\bhalloween\b/i },
  { style: 'Avant Garde', match: /\bavant.?garde\b/i },
  { style: 'Regency', match: /\bregency\b|\bvictorian\b|\bedwardian\b/i },
  { style: 'Futuristic', match: /\bfuturistic\b|\bcyber\b|\bcybercore\b/i },
  { style: 'Whimsygoth', match: /\bwhimsy\b/i },
  { style: 'Cottage', match: /\bcottagecore\b|\bcottage core\b/i },
  { style: 'Fairy', match: /\bfairycore\b|\bfairy core\b|\bfairy\b/i },
  { style: 'Grunge', match: /\bgrunge\b|\bflannel\b/i },
  { style: 'Goth', match: /\bgoth\b|\bgothic\b/i },
  { style: 'Emo', match: /\bemo\b|\bscene\b/i },
  { style: 'Punk', match: /\bpunk\b|\bstuds\b|\bstudded\b/i },
  { style: 'Rave', match: /\brave\b|\bneon\b|\bfestival\b/i },
  { style: 'Skater', match: /\bskater\b|\bskate\b|\bthrasher\b|\bskateboard\b/i },
  { style: 'Biker', match: /\bbiker\b|\bmoto\b|\bmotorcycle\b|\bharley\b/i },
  { style: 'Western', match: /\bwestern\b|\bcowboy\b|\bcowgirl\b|\brodeo\b/i },
  { style: 'Boho', match: /\bboho\b|\bbohemian\b|\bcrochet\b/i },
  { style: 'Preppy', match: /\bpreppy\b|\bprep\b|\bvarsity\b|\bpolo\b/i },
  { style: 'Glam', match: /\bglam\b|\bsequin\b|\bsequined\b|\brhinestone\b/i },
  { style: 'Twee', match: /\btwee\b/i },
  { style: 'Indie', match: /\bindie\b/i },
  { style: 'Minimalist', match: /\bminimalist\b|\bminimal\b/i },
  { style: 'Utility', match: /\butility\b|\bcargo\b|\bworkwear\b|\bcarhartt\b|\bdickies\b/i },
  { style: 'Sportswear', match: /\bsportswear\b|\bathletic\b|\bjersey\b|\btrack (jacket|pants|suit)\b|\bwarm.?up\b/i },
  { style: 'Loungewear', match: /\bloungewear\b|\bpyjama\b|\bpajama\b|\bsleepwear\b|\brobe\b/i },
  { style: 'Streetwear', match: /\bstreetwear\b|\bsupreme\b|\bhypebeast\b/i },
  { style: 'Y2K', match: /\by2k\b/i },
]

/**
 * Style values for Depop, drawn only from its own vocabulary.
 *
 * Returns an empty array when nothing matches. Style is optional on the form,
 * and a blank field is better than a plausible-sounding wrong one.
 */
function depopStyleTags(input: {
  styleEra?: string | null
  brand?: string | null
  garmentHint?: string | null
  title?: string | null
  description?: string | null
}): string[] {
  const text = [input.title, input.description, input.styleEra, input.brand]
    .filter(Boolean)
    .join(' ')

  const chosen: string[] = []
  const add = (style: string) => {
    if (!chosen.includes(style)) chosen.push(style)
  }

  for (const rule of STYLE_KEYWORDS) {
    if (rule.match.test(text)) add(rule.style)
  }

  // The era earns a tag on its own: 00s reads as Y2K, older reads as Retro.
  const age = mapDepopAge(input.styleEra).value
  if (age === '00s') add('Y2K')
  else if (age && age !== 'Modern' && age !== 'Antique') add('Retro')

  // Garment-level hints, only where the garment implies the style.
  if (input.garmentHint === 'activewear-tops' || input.garmentHint === 'activewear-pants') {
    add('Sportswear')
  }
  if (input.garmentHint === 'sleepwear') add('Loungewear')

  return chosen
}
