/**
 * Sanity check for dHash + Hamming distance.
 * Run: npx tsx scripts/phash.test.mts
 */
import assert from 'node:assert/strict'
import sharp from 'sharp'

import { computePhash, hammingDistance, PHASH_MATCH_THRESHOLD } from '../lib/phash'

// A structured gradient-ish image, not flat colour - a flat image produces a
// degenerate all-zero hash and would make this test vacuous.
async function makeImage(seed: number, size = 600) {
  const channels = 3
  const raw = Buffer.alloc(size * size * channels)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * channels
      raw[i] = (x * 3 + seed * 71) % 256
      raw[i + 1] = (y * 5 + seed * 37) % 256
      raw[i + 2] = ((x ^ y) + seed * 113) % 256
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels } })
    .png()
    .toBuffer()
}

const a = await makeImage(1)
const hashA = await computePhash(a)

// 1. Format: 16 hex chars = 64 bits.
assert.equal(hashA.length, 16, `expected 16 hex chars, got ${hashA.length}`)
assert.match(hashA, /^[0-9a-f]{16}$/)

// 2. Deterministic.
assert.equal(await computePhash(a), hashA)

// 3. Not degenerate.
assert.notEqual(hashA, '0000000000000000')

// 4. Same image, resized + re-encoded as JPEG (what a marketplace does to an
//    upload) stays within the match threshold.
const recompressed = await sharp(a).resize(400).jpeg({ quality: 70 }).toBuffer()
const hashRecompressed = await computePhash(recompressed)
const nearDistance = hammingDistance(hashA, hashRecompressed)
assert.ok(
  nearDistance <= PHASH_MATCH_THRESHOLD,
  `re-encoded copy should match: distance ${nearDistance} > ${PHASH_MATCH_THRESHOLD}`,
)

// 5. A genuinely different image must NOT match.
const hashB = await computePhash(await makeImage(9))
const farDistance = hammingDistance(hashA, hashB)
assert.ok(
  farDistance > PHASH_MATCH_THRESHOLD,
  `different image should not match: distance ${farDistance}`,
)

// 6. Hamming basics.
assert.equal(hammingDistance(hashA, hashA), 0)
assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64)
assert.equal(hammingDistance('abc', 'abcd'), Number.POSITIVE_INFINITY)

console.log('hash          ', hashA)
console.log('recompressed  ', hashRecompressed, `distance ${nearDistance}`)
console.log('different img ', hashB, `distance ${farDistance}`)
console.log('\nAll phash assertions passed.')
