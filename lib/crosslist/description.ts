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
  const core = (input.description ?? '').trim()

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
  if (input.material?.trim()) {
    sections.push({ label: 'Material', value: input.material.trim() })
  }
  if (measurements) sections.push({ label: 'Measurements', value: measurements })
  if (input.flawNotes?.trim()) {
    sections.push({ label: 'Condition notes', value: input.flawNotes.trim() })
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
