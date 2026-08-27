import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { crosspost, recordSale, relist } from '../lib/operations'
import type { ListingContext, PlatformAdapter } from '../lib/platforms/adapter'
import type { Platform } from '../lib/types'
import { FakeSupabase, asClient } from './fake-supabase.mts'

/**
 * Records every marketplace call so tests can assert on what the
 * orchestration layer *would* have sent. No network, ever.
 */
class RecordingAdapter implements PlatformAdapter {
  calls: Array<{ method: string; args: unknown[] }> = []

  constructor(
    public platform: Platform,
    private failOn: Set<string> = new Set(),
  ) {}

  private guard(method: string) {
    if (this.failOn.has(method)) {
      throw new Error(`${this.platform} ${method} rejected: 429 rate limited`)
    }
  }

  async createListing(context: ListingContext) {
    this.guard('createListing')
    this.calls.push({
      method: 'createListing',
      args: [context.item.id, context.price, context.photos.map((p) => p.url)],
    })
    return {
      platformListingId: `${this.platform}-listing-1`,
      platformUrl: `https://example.invalid/${this.platform}/1`,
    }
  }

  async delist(platformListingId: string | null) {
    this.guard('delist')
    this.calls.push({ method: 'delist', args: [platformListingId] })
    return 'delisted' as const
  }

  async relist(platformListingId: string | null, context: ListingContext) {
    this.guard('relist')
    this.calls.push({
      method: 'relist',
      args: [platformListingId, context.item.id, context.price],
    })
    return {
      platformListingId: `${this.platform}-listing-2`,
      platformUrl: `https://example.invalid/${this.platform}/2`,
    }
  }
}

function makeAdapters(failures: Partial<Record<Platform, string[]>> = {}) {
  const registry: Record<string, RecordingAdapter> = {}
  for (const p of ['ebay', 'poshmark', 'depop', 'mercari'] as Platform[]) {
    registry[p] = new RecordingAdapter(p, new Set(failures[p] ?? []))
  }
  return {
    registry,
    getAdapter: (p: Platform) => registry[p] as unknown as PlatformAdapter,
  }
}

const ITEM = {
  id: 'item-1',
  title: '90s Levi’s Denim Jacket',
  status: 'draft',
  purchase_cost: 18,
  ebay_price: 78,
  poshmark_price: 82,
  depop_price: 75,
  mercari_price: 74,
}

function seedDb(overrides: Record<string, any[]> = {}) {
  return new FakeSupabase({
    inventory: [{ ...ITEM }],
    listing_photos: [
      { id: 'ph-1', inventory_id: 'item-1', url: 'photo-a.jpg', position: 0 },
      { id: 'ph-2', inventory_id: 'item-1', url: 'photo-b.jpg', position: 1 },
    ],
    platform_listings: [],
    orders: [],
    ...overrides,
  })
}

// ---------------------------------------------------------------- crosspost

describe('crosspost', () => {
  test('lists on every requested platform at that platform’s price', async () => {
    const db = seedDb()
    const { registry, getAdapter } = makeAdapters()

    const results = await crosspost(
      asClient(db),
      'item-1',
      ['ebay', 'poshmark'],
      { getAdapter },
    )

    assert.deepEqual(
      results.map((r) => [r.platform, r.status]),
      [
        ['ebay', 'active'],
        ['poshmark', 'active'],
      ],
    )

    // Each adapter got its own platform-specific price, not a shared one.
    assert.deepEqual(registry.ebay.calls, [
      { method: 'createListing', args: ['item-1', 78, ['photo-a.jpg', 'photo-b.jpg']] },
    ])
    assert.deepEqual(registry.poshmark.calls, [
      { method: 'createListing', args: ['item-1', 82, ['photo-a.jpg', 'photo-b.jpg']] },
    ])
    assert.equal(registry.depop.calls.length, 0, 'unrequested platform untouched')

    const listings = db.table('platform_listings')
    assert.equal(listings.length, 2)
    const ebay = listings.find((l) => l.platform === 'ebay')
    assert.equal(ebay.status, 'active')
    assert.equal(ebay.listed_price, 78)
    assert.equal(ebay.platform_listing_id, 'ebay-listing-1')
    assert.equal(ebay.delisted_at, null)
  })

  test('flips the item from draft to active', async () => {
    const db = seedDb()
    const { getAdapter } = makeAdapters()

    assert.equal(db.table('inventory')[0].status, 'draft')
    await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })
    assert.equal(db.table('inventory')[0].status, 'active')
  })

  test('is idempotent - re-crossposting updates rather than duplicates', async () => {
    const db = seedDb()
    const { getAdapter } = makeAdapters()

    await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })
    await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })

    const listings = db.table('platform_listings')
    assert.equal(listings.length, 1, 'unique (inventory_id, platform) must hold')
  })

  test('one platform failing does not stop the others', async () => {
    const db = seedDb()
    const { getAdapter } = makeAdapters({ poshmark: ['createListing'] })

    const results = await crosspost(
      asClient(db),
      'item-1',
      ['ebay', 'poshmark', 'depop'],
      { getAdapter },
    )

    assert.equal(results.find((r) => r.platform === 'ebay')?.status, 'active')
    assert.equal(results.find((r) => r.platform === 'depop')?.status, 'active')

    const failed = results.find((r) => r.platform === 'poshmark')
    assert.equal(failed?.status, 'error')
    assert.match(String(failed?.error), /rate limited/)

    const posh = db
      .table('platform_listings')
      .find((l) => l.platform === 'poshmark')
    assert.equal(posh.status, 'error', 'failure is recorded, not swallowed')
    assert.equal(db.table('inventory')[0].status, 'active', 'partial success still activates')
  })

  test('does not activate the item when every platform fails', async () => {
    const db = seedDb()
    const { getAdapter } = makeAdapters({ ebay: ['createListing'] })

    const results = await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })

    assert.equal(results[0].status, 'error')
    assert.equal(
      db.table('inventory')[0].status,
      'draft',
      'nothing went live, so the item must stay draft',
    )
  })
})

// --------------------------------------------------------------- recordSale

function seedCrossposted() {
  return seedDb({
    inventory: [{ ...ITEM, status: 'active' }],
    platform_listings: [
      {
        id: 'pl-ebay',
        inventory_id: 'item-1',
        platform: 'ebay',
        platform_listing_id: 'ebay-1',
        status: 'active',
      },
      {
        id: 'pl-posh',
        inventory_id: 'item-1',
        platform: 'poshmark',
        platform_listing_id: 'posh-1',
        status: 'active',
      },
      {
        id: 'pl-depop',
        inventory_id: 'item-1',
        platform: 'depop',
        platform_listing_id: 'depop-1',
        status: 'active',
      },
    ],
  })
}

describe('recordSale', () => {
  test('marks the item sold with platform and price', async () => {
    const db = seedCrossposted()
    const { getAdapter } = makeAdapters()

    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    const item = db.table('inventory')[0]
    assert.equal(item.status, 'sold')
    assert.equal(item.sold_platform, 'ebay')
    assert.equal(item.sold_price, 78)
    assert.ok(item.sold_at, 'sold_at must be stamped')
  })

  test('opens a pending order', async () => {
    const db = seedCrossposted()
    const { getAdapter } = makeAdapters()

    const result = await recordSale(
      asClient(db),
      'item-1',
      'ebay',
      78,
      { name: 'A. Buyer' },
      { getAdapter },
    )

    const orders = db.table('orders')
    assert.equal(orders.length, 1)
    assert.equal(orders[0].inventory_id, 'item-1')
    assert.equal(orders[0].platform, 'ebay')
    assert.equal(orders[0].sale_price, 78)
    assert.equal(orders[0].status, 'pending')
    assert.deepEqual(orders[0].buyer_info, { name: 'A. Buyer' })
    assert.equal(result.orderId, orders[0].id)
  })

  test('delists the OTHER platforms and calls their adapters', async () => {
    const db = seedCrossposted()
    const { registry, getAdapter } = makeAdapters()

    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    assert.deepEqual(registry.poshmark.calls, [
      { method: 'delist', args: ['posh-1'] },
    ])
    assert.deepEqual(registry.depop.calls, [
      { method: 'delist', args: ['depop-1'] },
    ])

    for (const platform of ['poshmark', 'depop']) {
      const row = db
        .table('platform_listings')
        .find((l) => l.platform === platform)
      assert.equal(row.status, 'delisted', `${platform} must be delisted`)
      assert.ok(row.delisted_at, `${platform} needs a delisted_at stamp`)
    }
  })

  test('does NOT call the selling platform’s adapter, but still marks it delisted', async () => {
    // eBay already closed the listing when it sold; calling delist again
    // would be a spurious API call against a listing that no longer exists.
    const db = seedCrossposted()
    const { registry, getAdapter } = makeAdapters()

    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    assert.deepEqual(registry.ebay.calls, [], 'no delist call to the selling platform')

    const ebayRow = db
      .table('platform_listings')
      .find((l) => l.platform === 'ebay')
    assert.equal(ebayRow.status, 'delisted')
    assert.ok(ebayRow.delisted_at)
  })

  test('leaves already-delisted listings alone', async () => {
    const db = seedCrossposted()
    db.table('platform_listings').find((l) => l.platform === 'depop').status =
      'delisted'
    const { registry, getAdapter } = makeAdapters()

    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    assert.equal(
      registry.depop.calls.length,
      0,
      'an already-delisted listing must not be delisted again',
    )
  })

  test('a failing delist is recorded as error, and the sale still stands', async () => {
    const db = seedCrossposted()
    const { getAdapter } = makeAdapters({ poshmark: ['delist'] })

    const result = await recordSale(asClient(db), 'item-1', 'ebay', 78, null, {
      getAdapter,
    })

    const posh = result.delisted.find((d) => d.platform === 'poshmark')
    assert.equal(posh?.status, 'error')
    assert.match(String(posh?.error), /rate limited/)

    const poshRow = db
      .table('platform_listings')
      .find((l) => l.platform === 'poshmark')
    assert.equal(poshRow.status, 'error')

    // The important part: the sale is still recorded.
    assert.equal(db.table('inventory')[0].status, 'sold')
    assert.equal(db.table('orders').length, 1)

    // ...and depop still got delisted despite poshmark blowing up.
    const depop = result.delisted.find((d) => d.platform === 'depop')
    assert.equal(depop?.status, 'delisted')
  })
})

// ------------------------------------------------------------------ relist

describe('relist', () => {
  test('brings a delisted listing back to active', async () => {
    const db = seedDb({
      inventory: [{ ...ITEM, status: 'active' }],
      platform_listings: [
        {
          id: 'pl-ebay',
          inventory_id: 'item-1',
          platform: 'ebay',
          platform_listing_id: 'ebay-1',
          status: 'delisted',
          delisted_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const { registry, getAdapter } = makeAdapters()

    const results = await relist(asClient(db), 'item-1', undefined, { getAdapter })

    assert.deepEqual(results, [
      {
        platform: 'ebay',
        status: 'active',
        platformUrl: 'https://example.invalid/ebay/2',
      },
    ])
    assert.deepEqual(registry.ebay.calls, [
      { method: 'relist', args: ['ebay-1', 'item-1', 78] },
    ])

    const row = db.table('platform_listings')[0]
    assert.equal(row.status, 'active')
    assert.equal(row.platform_listing_id, 'ebay-listing-2', 'new id stored')
    assert.equal(row.delisted_at, null, 'delisted_at must be cleared')
    assert.ok(row.last_relisted_at, 'last_relisted_at must be stamped')
  })

  test('only touches the platforms asked for', async () => {
    const db = seedDb({
      inventory: [{ ...ITEM, status: 'active' }],
      platform_listings: [
        { id: 'a', inventory_id: 'item-1', platform: 'ebay', status: 'delisted' },
        { id: 'b', inventory_id: 'item-1', platform: 'depop', status: 'delisted' },
      ],
    })
    const { registry, getAdapter } = makeAdapters()

    await relist(asClient(db), 'item-1', ['depop'], { getAdapter })

    assert.equal(registry.ebay.calls.length, 0)
    assert.equal(registry.depop.calls.length, 1)
    assert.equal(
      db.table('platform_listings').find((l) => l.platform === 'ebay').status,
      'delisted',
      'unasked platform untouched',
    )
  })

  test('reports a failure without aborting the rest', async () => {
    const db = seedDb({
      inventory: [{ ...ITEM, status: 'active' }],
      platform_listings: [
        { id: 'a', inventory_id: 'item-1', platform: 'ebay', status: 'delisted' },
        { id: 'b', inventory_id: 'item-1', platform: 'depop', status: 'delisted' },
      ],
    })
    const { getAdapter } = makeAdapters({ ebay: ['relist'] })

    const results = await relist(asClient(db), 'item-1', undefined, { getAdapter })

    assert.equal(results.find((r) => r.platform === 'ebay')?.status, 'error')
    assert.equal(results.find((r) => r.platform === 'depop')?.status, 'active')
  })
})


// ------------------------------------------- purchase_cost is NOT required

describe('crosspost without a cost basis', () => {
  test('lists normally - a missing cost must not block selling', async () => {
    // Costs are entered by hand over time. Blocking a listing until then
    // would stop real selling for the sake of a reporting field.
    const db = seedDb({ inventory: [{ ...ITEM, purchase_cost: null }] })
    const { registry, getAdapter } = makeAdapters()

    const results = await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })

    assert.equal(results[0].status, 'active')
    assert.equal(registry.ebay.calls.length, 1)
    assert.equal(db.table('platform_listings')[0].status, 'active')
  })

  test('and the item still goes active', async () => {
    const db = seedDb({ inventory: [{ ...ITEM, purchase_cost: null }] })
    const { getAdapter } = makeAdapters()
    await crosspost(asClient(db), 'item-1', ['ebay'], { getAdapter })
    assert.equal(db.table('inventory')[0].status, 'active')
  })
})

// ------------------------------------------------------------- profit

describe('recordSale computes profit', () => {
  test('stores profit and fee on the order', async () => {
    const db = seedCrossposted()
    const { getAdapter } = makeAdapters()

    // $78 on eBay: 13.25% = 10.34 fee, $18 cost -> 49.66
    const result = await recordSale(asClient(db), 'item-1', 'ebay', 78, null, {
      getAdapter,
    })

    assert.equal(result.platformFee, 10.34)
    assert.equal(result.profit, 49.66)

    const order = db.table('orders')[0]
    assert.equal(order.platform_fee, 10.34)
    assert.equal(order.profit, 49.66)
  })

  test('uses the SELLING platform’s fee, not a default', async () => {
    const db = seedCrossposted()
    const { getAdapter } = makeAdapters()

    // Same $78 on Depop: 10% = 7.80 fee -> 52.20
    const result = await recordSale(asClient(db), 'item-1', 'depop', 78, null, {
      getAdapter,
    })
    assert.equal(result.platformFee, 7.8)
    assert.equal(result.profit, 52.2)
  })

  test('records a loss as negative rather than clamping', async () => {
    const db = seedCrossposted()
    db.table('inventory')[0].purchase_cost = 100
    const { getAdapter } = makeAdapters()

    const result = await recordSale(asClient(db), 'item-1', 'ebay', 78, null, {
      getAdapter,
    })
    assert.ok(result.profit! < 0, 'a bad sale must show as a loss')
  })

  test('a sale without purchase_cost still records, with null profit', async () => {
    // Items listed before the cost rule existed can still sell; losing the
    // sale over a missing reporting field would be far worse.
    const db = seedCrossposted()
    db.table('inventory')[0].purchase_cost = null
    const { getAdapter } = makeAdapters()

    const result = await recordSale(asClient(db), 'item-1', 'ebay', 78, null, {
      getAdapter,
    })

    assert.equal(result.profit, null)
    assert.equal(result.platformFee, null)
    assert.equal(db.table('orders').length, 1, 'the sale is still recorded')
    assert.equal(db.table('inventory')[0].status, 'sold')
  })
})

// ------------------------------------------------- queued (Depop) delists

describe('recordSale with a platform that cannot delist server-side', () => {
  /** Adapter that reports a delist as queued rather than done. */
  function queuedAdapters() {
    const { registry, getAdapter } = makeAdapters()
    const queued = { ...registry.depop } as never
    return {
      registry,
      getAdapter: (p: Platform) =>
        p === 'depop'
          ? ({
              platform: 'depop',
              createListing: async () => ({
                platformListingId: 'x',
                platformUrl: 'https://x.invalid',
              }),
              delist: async () => 'queued',
              relist: async () => ({
                platformListingId: 'x',
                platformUrl: 'https://x.invalid',
              }),
            } as never)
          : getAdapter(p),
      queued,
    }
  }

  test('marks the row pending_delist, NOT delisted', async () => {
    // Recording it as delisted would tell the sync-failure detector there is
    // nothing to look for, on a listing that is still live and sellable.
    const db = seedCrossposted()
    const { getAdapter } = queuedAdapters()

    const result = await recordSale(asClient(db), 'item-1', 'ebay', 78, null, {
      getAdapter,
    })

    const depopRow = db
      .table('platform_listings')
      .find((l) => l.platform === 'depop')
    assert.equal(depopRow.status, 'pending_delist')

    const reported = result.delisted.find((d) => d.platform === 'depop')
    assert.equal(reported?.status, 'pending_delist')
  })

  test('leaves delisted_at unset while the listing is still up', async () => {
    const db = seedCrossposted()
    const { getAdapter } = queuedAdapters()
    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    const depopRow = db
      .table('platform_listings')
      .find((l) => l.platform === 'depop')
    assert.equal(
      depopRow.delisted_at,
      null,
      'a delist timestamp would imply it already came down',
    )
  })

  test('a queued platform does not hold up the ones that did delist', async () => {
    const db = seedCrossposted()
    const { getAdapter } = queuedAdapters()
    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })

    const posh = db
      .table('platform_listings')
      .find((l) => l.platform === 'poshmark')
    assert.equal(posh.status, 'delisted')
    assert.ok(posh.delisted_at)
  })

  test('the sale itself is unaffected', async () => {
    const db = seedCrossposted()
    const { getAdapter } = queuedAdapters()
    await recordSale(asClient(db), 'item-1', 'ebay', 78, null, { getAdapter })
    assert.equal(db.table('inventory')[0].status, 'sold')
    assert.equal(db.table('orders').length, 1)
  })
})
