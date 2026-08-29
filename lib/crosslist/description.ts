import type { GarmentKey } from '@/lib/crosslist/categories'
import type { CrosslistPlatform } from '@/lib/crosslist/types'

/**
 * Description compilation and Mercari shipping estimates.
 *
 * eBay carries material, measurements and flaw notes as structured item
 * specifics. Depop and Mercari have no equivalent fields, so that detail
 * either goes into the description or is lost - and for second-hand clothing
 * measurements and flaws are the detail buyers most need.
 */

export const DESCRIPTION_LIMIT: Record<CrosslistPlatform, number> = {
  // Poshmark keeps structured fields, so its description stays as authored.
  poshmark: 1500,
  depop: 1000,
  mercari: 1000,
}

/**
 * Named entities the catalogue actually contains, plus the ones eBay
 * descriptions routinely carry.
 *
 * A table rather than a DOM decode: this runs server-side in the generator,
 * where there is no document to borrow innerHTML from, and a regex-driven
 * decode is the honest option. Unknown entities are left alone rather than
 * mangled - "&foo;" is likelier to be literal text than a typo'd entity.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  deg: '°', trade: '™', reg: '®', copy: '©',
  times: '×', frac12: '½', frac14: '¼', frac34: '¾',
  bull: '•', middot: '·',
}

/**
 * Turn eBay's description markup into plain text.
 *
 * 399 of 402 active items hold HTML in their description, because that is
 * what the eBay import stored: 127 wrapped in a CDATA section, 94 with <br />
 * line breaks, 185 containing &apos;. eBay renders it; Poshmark and Depop
 * have plain-text description boxes and show it verbatim, so a listing goes
 * out reading "<![CDATA[<div>Elevate your game-day..." - visible to buyers.
 *
 * Done here rather than in the extension so one definition serves every
 * platform, and rather than rewriting the catalogue, which would throw away
 * the markup eBay itself needs.
 */
export function toPlainText(raw: string | null | undefined): string {
  if (!raw) return ''
  let text = String(raw)

  // The CDATA wrapper is a transport artefact; its contents are the text.
  text = text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')

  text = text.replace(/<!--[\s\S]*?-->/g, '')
  // Anything inside these is code, not description.
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')

  // Structure that carries meaning becomes whitespace, so paragraphs survive
  // as paragraphs instead of running together into one block.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/\s*(p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n')
  text = text.replace(/<\s*li\b[^>]*>/gi, '• ')

  // Everything else goes.
  text = text.replace(/<[^>]*>/g, '')

  // One pass, deliberately: decoding &amp; first and then rescanning would
  // turn "&amp;apos;" into an apostrophe, when it should read "&apos;".
  text = text.replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => {
    const decoded = HTML_ENTITIES[name.toLowerCase()]
    return decoded === undefined ? match : decoded
  })
  text = text.replace(/&#(\d+);/g, (match, digits: string) => {
    const code = Number(digits)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
  text = text.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
    const code = parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })

  // Tidy the whitespace the tags left behind.
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/ /g, ' ')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/ *\n */g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

function formatMeasurements(
  measurements: Record<string, unknown> | null | undefined,
): string | null {
  if (!measurements || typeof measurements !== 'object') return null
  const parts = Object.entries(measurements)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
  return parts.length ? parts.join(', ') : null
}

export type DescriptionInput = {
  description: string | null
  material?: string | null
  measurements?: Record<string, unknown> | null
  flawNotes?: string | null
  condition?: string | null
}

export type DescriptionResult = {
  text: string
  /** True when appended detail had to be trimmed to fit. */
  truncated: boolean
  /** Sections that were dropped entirely. */
  dropped: string[]
}

/**
 * Build the description a platform will receive.
 *
 * The core description is never truncated - it is the part the seller wrote
 * and the part a buyer reads first. When the total exceeds the limit, the
 * appended detail block is trimmed instead, section by section from the
 * bottom, and only then character-truncated.
 */
export function compileDescription(
  platform: CrosslistPlatform,
  input: DescriptionInput,
): DescriptionResult {
  const limit = DESCRIPTION_LIMIT[platform]
  // Every text field here came from the same eBay import, so all of them are
  // cleaned - not just the description that was noticed.
  const core = toPlainText(input.description)

  // Poshmark has its own fields for this; appending would duplicate them.
  if (platform === 'poshmark') {
    return {
      text: core.slice(0, limit),
      truncated: core.length > limit,
      dropped: [],
    }
  }

  // Ordered least- to most-droppable, so trimming removes the least useful
  // first. Condition notes stay longest: an undisclosed flaw is a dispute.
  const sections: Array<{ label: string; value: string }> = []
  const measurements = formatMeasurements(input.measurements)
  if (toPlainText(input.material)) {
    sections.push({ label: 'Material', value: toPlainText(input.material) })
  }
  if (measurements) sections.push({ label: 'Measurements', value: measurements })
  if (toPlainText(input.flawNotes)) {
    sections.push({ label: 'Condition notes', value: toPlainText(input.flawNotes) })
  }

  if (sections.length === 0) {
    return { text: core.slice(0, limit), truncated: core.length > limit, dropped: [] }
  }

  const render = (chosen: typeof sections) =>
    chosen.map((s) => `${s.label}: ${s.value}`).join('\n')

  const separator = '\n\n'
  const dropped: string[] = []
  const chosen = [...sections]

  // Drop whole sections from the FRONT of the list (material first, condition
  // notes last) until the block fits.
  while (chosen.length > 0) {
    const candidate = core + separator + render(chosen)
    if (candidate.length <= limit) {
      return { text: candidate, truncated: dropped.length > 0, dropped }
    }
    const removed = chosen.shift()!
    dropped.push(removed.label)
  }

  // Nothing fits alongside the core description.
  if (core.length <= limit) {
    return { text: core, truncated: true, dropped }
  }

  // The core alone is over the limit. Only now is it trimmed, and it is the
  // last thing trimmed rather than the first.
  return { text: core.slice(0, limit), truncated: true, dropped }
}

// ------------------------------------------------------- shipping weight

/**
 * Mercari requires a shipping weight before a listing can be created.
 *
 * The three values below are the ones specified for this catalogue. The rest
 * are estimates: under-declaring weight costs money on every shipment, so a
 * blanket default for a winter coat would be worse than a rough per-garment
 * figure. Anything unrecognised falls back to DEFAULT_WEIGHT_OZ.
 */
export const DEFAULT_WEIGHT_OZ = 16 // 1 lb

const WEIGHTS_OZ: Partial<Record<GarmentKey, number>> = {
  // Specified.
  tshirts: 8,
  'casual-shirts': 8,
  'dress-shirts': 8,
  polos: 8,
  jeans: 20, // 1 lb 4 oz
  'activewear-pants': 20, // sweatpants
  'athletic-shoes': 40, // 2 lb 8 oz
  'casual-shoes': 40,
  // Estimated beyond the specified table - see the note above.
  'activewear-tops': 8,
  sweaters: 20,
  hoodies: 24,
  'coats-jackets': 40,
  pants: 20,
  shorts: 10,
  skirts: 10,
  dresses: 12,
  swimwear: 6,
  sleepwear: 12,
  suits: 48,
  hats: 6,
  bags: 16,
  coveralls: 40,
  onepiece: 6,
}

export function estimateWeightOz(garment: GarmentKey | null): number {
  if (!garment) return DEFAULT_WEIGHT_OZ
  return WEIGHTS_OZ[garment] ?? DEFAULT_WEIGHT_OZ
}

/** Mercari's package-size buckets. */
export type PackageSize = 'Small' | 'Medium' | 'Large'

export function estimatePackageSize(weightOz: number): PackageSize {
  if (weightOz <= 12) return 'Small'
  if (weightOz <= 32) return 'Medium'
  return 'Large'
}

/** "2 lb 8 oz" for display. */
export function formatWeight(oz: number): string {
  const pounds = Math.floor(oz / 16)
  const ounces = oz % 16
  if (pounds === 0) return `${ounces} oz`
  if (ounces === 0) return `${pounds} lb`
  return `${pounds} lb ${ounces} oz`
}
