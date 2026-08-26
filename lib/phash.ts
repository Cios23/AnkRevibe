import sharp from 'sharp'

/**
 * Perceptual hashing via dHash (difference hash).
 *
 * The image is reduced to 9x8 greyscale and each pixel is compared to its
 * right-hand neighbour, producing 8x8 = 64 bits rendered as 16 hex chars.
 * dHash is resilient to resizing, re-compression and mild colour shifts -
 * exactly the transforms a photo undergoes when it is uploaded to four
 * different marketplaces - while staying sensitive to genuinely different
 * garments.
 */

const HASH_WIDTH = 9
const HASH_HEIGHT = 8

/**
 * Hamming distance at or below this counts as "probably the same physical
 * item".
 *
 * Tuned against the real catalogue (3,086 photos, 402 listings) rather than
 * guessed. Measured false-positive rate over 241,981 unrelated cross-item
 * pairs:
 *
 *   <=4   0.0008%      <=8   0.037%
 *   <=6   0.0058%      <=10  0.144%
 *
 * One sold item with 7 photos makes ~21,600 comparisons against that
 * catalogue, so a threshold of 10 produces roughly 30 chance collisions per
 * scan - which is exactly what the first backfill found (two nonsense
 * matches at distance 10, a doll lot against a shirt and a jacket).
 *
 * 6 keeps the expected false positives near 1 per scan while still
 * comfortably catching the real case: the same photo file re-hosted by
 * another marketplace, which lands at 0-4. Raise it only with evidence,
 * and re-measure if the catalogue grows by an order of magnitude.
 */
export const PHASH_MATCH_THRESHOLD = Number(
  process.env.PHASH_MATCH_THRESHOLD ?? 6,
)

export async function computePhash(image: Buffer): Promise<string> {
  const raw = await sharp(image)
    .greyscale()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer()

  let bits = ''
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      const left = raw[row * HASH_WIDTH + col]
      const right = raw[row * HASH_WIDTH + col + 1]
      bits += left > right ? '1' : '0'
    }
  }

  // 64 bits -> 16 hex chars, 4 bits at a time.
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

export async function hashImageUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    return await computePhash(buffer)
  } catch {
    return null
  }
}

/** Number of differing bits. Lower means more similar. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY

  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (xor) {
      distance += xor & 1
      xor >>= 1
    }
  }
  return distance
}
