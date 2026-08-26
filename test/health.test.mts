import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findPhashMatches, runHealthCheck } from '../lib/health'
import { hammingDistance, PHASH_MATCH_THRESHOLD } from '../lib/phash'
import { FakeSupabase, asClient } from './fake-supabase.mts'

// Hashes taken from real dHash output (scripts/phash.test.mts), so the
// distances below are representative rather than synthetic.
const SOLD_HASH = 'e48db326cc9933e4'
const RECOMPRESSED = '44cc3366cc993344' // same garment, re-encoded
const DIFFERENT = '1133ccd93344cc13' // unrelated garment

describe('hash fixtures', () => {
  test('the fixtures have the distances the other tests assume', () => {
    assert.equal(hammingDistance(SOLD_HASH, SOLD_HASH), 0)
    assert.equal(hammingDistance(SOLD_HASH, RECOMPRESSED), 8)
    assert.equal(hammingDistance(SOLD_HASH, DIFFERENT), 56)
    assert.ok(8 <= PHASH_MATCH_THRESHOLD, 'recompressed must be inside threshold')
    assert.ok(56 > PHASH_MATCH_THRESHOLD, 'different must be outside threshold')
  })
})

describe('findPhashMatches', () => {
  const sold = [{ phash: SOLD_HASH }]

  test('flags an identical photo at distance 0', () => {
    const matches = findPhashMatches(sold, [
      { phash: SOLD_HASH, inventory_id: 'dupe' },
    ])
    assert.deepEqual(matches, [{ inventoryId: 'dupe', distance: 0 }])
  })

  test('flags a re-compressed copy inside the threshold', () => {
    const matches = findPhashMatches(sold, [
      { phash: RECOMPRESSED, inventory_id: 'dupe' },
    ])
    assert.deepEqual(matches, [{ inventoryId: 'dupe', distance: 8 }])
  })

  test('does not flag an unrelated photo', () => {
    const matches = findPhashMatches(sold, [
      { phash: DIFFERENT, inventory_id: 'other' },
    ])
    assert.deepEqual(matches, [])
  })

  test('threshold is inclusive at the boundary and exclusive past it', () => {
    const base = '0000000000000000'
    const four = '000000000000000f' // 4 bits set
    assert.equal(hammingDistance(base, four), 4)

    const inside = findPhashMatches(
      [{ phash: base }],
      [{ phash: four, inventory_id: 'x' }],
      4,
    )
    assert.equal(inside.length, 1, 'distance == threshold must match')

    const outside = findPhashMatches(
      [{ phash: base }],
      [{ phash: four, inventory_id: 'x' }],
      3,
    )
    assert.equal(outside.length, 0, 'distance > threshold must not match')
  })

  test('keeps the CLOSEST photo pair per candidate item', () => {
    // The same item has one unrelated photo and one near-identical photo.
    // The near one must win, or a real duplicate hides behind a bad angle.
    const matches = findPhashMatches(sold, [
      { phash: DIFFERENT, inventory_id: 'dupe' },
      { phash: RECOMPRESSED, inventory_id: 'dupe' },
    ])
    assert.deepEqual(matches, [{ inventoryId: 'dupe', distance: 8 }])
  })

  test('compares against every photo of the sold item, not just the first', () => {
    const matches = findPhashMatches(
      [{ phash: DIFFERENT }, { phash: SOLD_HASH }],
      [{ phash: RECOMPRESSED, inventory_id: 'dupe' }],
    )
    assert.deepEqual(matches, [{ inventoryId: 'dupe', distance: 8 }])
  })

  test('ignores photos with no hash and no inventory_id', () => {
    const matches = findPhashMatches(
      [{ phash: null }, { phash: SOLD_HASH }],
      [
        { phash: null, inventory_id: 'a' },
        { phash: SOLD_HASH, inventory_id: null },
        { phash: SOLD_HASH, inventory_id: 'b' },
      ],
    )
    assert.deepEqual(matches, [{ inventoryId: 'b', distance: 0 }])
  })

  test('returns multiple matches closest-first', () => {
    const matches = findPhashMatches(sold, [
      { phash: RECOMPRESSED, inventory_id: 'far' },
      { phash: SOLD_HASH, inventory_id: 'near' },
    ])
    assert.deepEqual(matches, [
      { inventoryId: 'near', distance: 0 },
      { inventoryId: 'far', distance: 8 },
    ])
  })

  test('mismatched hash lengths never match', () => {
    const matches = findPhashMatches(
      [{ phash: 'abcd' }],
      [{ phash: 'abcdef', inventory_id: 'x' }],
    )
    assert.deepEqual(matches, [])
  })
})

// --------------------------------------------------------------------------

function seedDb(overrides: Record<string, any[]> = {}) {
  return new FakeSupabase({
    inventory: [
      { id: 'sold-item', title: 'Denim Jacket', status: 'sold' },
      { id: 'dupe-item', title: 'Denim Jacket (dupe)', status: 'active' },
      { id: 'other-item', title: 'Chore Coat', status: 'active' },
    ],
    listing_photos: [
      { id: 'p1', inventory_id: 'sold-item', url: 'u1', phash: SOLD_HASH },
      { id: 'p2', inventory_id: 'dupe-item', url: 'u2', phash: RECOMPRESSED },
      { id: 'p3', inventory_id: 'other-item', url: 'u3', phash: DIFFERENT },
    ],
    platform_listings: [
      { id: 'l1', inventory_id: 'dupe-item', platform: 'ebay', status: 'active' },
      { id: 'l2', inventory_id: 'other-item', platform: 'ebay', status: 'active' },
    ],
    inventory_health_flags: [],
    ...overrides,
  })
}

const noNetwork = async () => {
  throw new Error('hashUrl must not be called when every photo is hashed')
}

describe('runHealthCheck', () => {
  test('flags the duplicate and leaves the unrelated item alone', async () => {
    const db = seedDb()
    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })

    assert.equal(result.flagsCreated, 1)
    assert.equal(result.candidatesCompared, 2)
    assert.deepEqual(result.flags, [
      { flaggedInventoryId: 'dupe-item', similarityScore: 8 },
    ])

    const flags = db.table('inventory_health_flags')
    assert.equal(flags.length, 1)
    assert.equal(flags[0].flagged_inventory_id, 'dupe-item')
    assert.equal(flags[0].sold_inventory_id, 'sold-item')
    assert.equal(flags[0].similarity_score, 8)
    assert.equal(flags[0].status, 'open')
  })

  test('only considers items with an ACTIVE platform listing', async () => {
    // This is the trap the seed file warns about: a duplicate that was
    // never crossposted is invisible to the check.
    const db = seedDb({
      platform_listings: [
        {
          id: 'l1',
          inventory_id: 'dupe-item',
          platform: 'ebay',
          status: 'delisted',
        },
      ],
    })
    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })

    assert.equal(result.candidatesCompared, 0)
    assert.equal(result.flagsCreated, 0)
    assert.equal(db.table('inventory_health_flags').length, 0)
  })

  test('never flags the sold item against itself', async () => {
    const db = seedDb({
      platform_listings: [
        { id: 'l0', inventory_id: 'sold-item', platform: 'ebay', status: 'active' },
        { id: 'l1', inventory_id: 'dupe-item', platform: 'ebay', status: 'active' },
      ],
    })
    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })

    assert.equal(result.candidatesCompared, 1)
    assert.ok(
      !result.flags.some((f) => f.flaggedInventoryId === 'sold-item'),
      'sold item must not flag itself',
    )
  })

  test('is idempotent - a second run creates no duplicate flag', async () => {
    const db = seedDb()
    const deps = { supabase: asClient(db), hashUrl: noNetwork }

    const first = await runHealthCheck('sold-item', deps)
    const second = await runHealthCheck('sold-item', deps)

    assert.equal(first.flagsCreated, 1)
    assert.equal(second.flagsCreated, 0, 'must not re-insert an open flag')
    assert.equal(db.table('inventory_health_flags').length, 1)
    // The match is still reported even though nothing new was written.
    assert.equal(second.flags.length, 1)
  })

  test('re-flags if the previous flag was dismissed', async () => {
    const db = seedDb()
    await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })
    db.table('inventory_health_flags')[0].status = 'dismissed'

    const again = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })
    assert.equal(
      again.flagsCreated,
      1,
      'a dismissed flag should not suppress a new one',
    )
    assert.equal(db.table('inventory_health_flags').length, 2)
  })

  test('backfills a missing hash and writes it back exactly once', async () => {
    const db = seedDb({
      listing_photos: [
        { id: 'p1', inventory_id: 'sold-item', url: 'u1', phash: null },
        { id: 'p2', inventory_id: 'dupe-item', url: 'u2', phash: RECOMPRESSED },
      ],
      platform_listings: [
        { id: 'l1', inventory_id: 'dupe-item', platform: 'ebay', status: 'active' },
      ],
    })

    const calls: string[] = []
    const hashUrl = async (url: string) => {
      calls.push(url)
      return SOLD_HASH
    }

    const first = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl,
    })
    assert.equal(first.photosHashed, 1)
    assert.deepEqual(calls, ['u1'])
    assert.equal(db.table('listing_photos')[0].phash, SOLD_HASH, 'hash persisted')

    // Second run must reuse the stored hash rather than re-fetching.
    const second = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl,
    })
    assert.equal(second.photosHashed, 0)
    assert.deepEqual(calls, ['u1'], 'no second fetch for an already-hashed photo')
  })

  test('skips a photo whose image cannot be read', async () => {
    const db = seedDb({
      listing_photos: [
        { id: 'p1', inventory_id: 'sold-item', url: 'broken', phash: null },
        { id: 'p2', inventory_id: 'dupe-item', url: 'u2', phash: RECOMPRESSED },
      ],
      platform_listings: [
        { id: 'l1', inventory_id: 'dupe-item', platform: 'ebay', status: 'active' },
      ],
    })

    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: async () => null, // fetch failed / not an image
    })

    assert.equal(result.flagsCreated, 0, 'unreadable photo must not flag anything')
    assert.equal(db.table('listing_photos')[0].phash, null, 'nothing written back')
  })

  test('returns empty when the sold item has no photos', async () => {
    const db = seedDb({
      listing_photos: [
        { id: 'p2', inventory_id: 'dupe-item', url: 'u2', phash: RECOMPRESSED },
      ],
    })
    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
    })
    assert.equal(result.flagsCreated, 0)
    assert.equal(result.flags.length, 0)
  })

  test('a custom threshold widens the net', async () => {
    const db = seedDb()
    const result = await runHealthCheck('sold-item', {
      supabase: asClient(db),
      hashUrl: noNetwork,
      threshold: 60, // now even the unrelated coat is "close enough"
    })
    assert.equal(result.flagsCreated, 2)
  })

  test('surfaces a read failure instead of silently reporting no flags', async () => {
    const db = seedDb()
    db.failOn = { table: 'listing_photos', kind: 'select', message: 'boom' }

    await assert.rejects(
      () =>
        runHealthCheck('sold-item', {
          supabase: asClient(db),
          hashUrl: noNetwork,
        }),
      /boom/,
    )
  })
})
