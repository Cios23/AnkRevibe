import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.EBAY_ENV = 'production'
process.env.EBAY_MARKETPLACE_ID = 'EBAY_US'
process.env.EBAY_FULFILLMENT_POLICY_ID = 'fp-1'
process.env.EBAY_PAYMENT_POLICY_ID = 'pp-1'
process.env.EBAY_RETURN_POLICY_ID = 'rp-1'
process.env.EBAY_MERCHANT_LOCATION_KEY = 'main-warehouse'

const { mapCondition, conditionDescription, DEFAULT_CONDITION } = await import(
  '../lib/ebay/conditions'
)
const {
  resolveCategoryId,
  clearCategoryTreeCache,
  STATIC_CATEGORY_MAP,
} = await import('../lib/ebay/categories')
const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')
const { EbayAdapter, buildAspects, buildDescription, skuFor } = await import(
  '../lib/platforms/ebay'
)

// --------------------------------------------------------------- test rig

type Route = { method: string; match: RegExp; status?: number; body?: unknown }

function mockFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body: any; headers: any }> = []

  const impl = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET'
    calls.push({
      method,
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    })

    const route = routes.find(
      (r) => r.method === method && r.match.test(String(url)),
    )
    if (!route) {
      return new Response(
        JSON.stringify({ errors: [{ errorId: 9999, message: `no route for ${method} ${url}` }] }),
        { status: 500 },
      )
    }
    const status = route.status ?? 200
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(route.body ?? {}), { status })
  }) as unknown as typeof fetch

  return { impl, calls }
}

const baseOptions = (impl: typeof fetch) => ({
  fetchImpl: impl,
  getToken: async () => 'test-token',
  sleep: async () => {},
})

const ITEM: any = {
  id: '11111111-2222-3333-4444-555555555555',
  title: '90s Levi’s Denim Jacket',
  description: 'Classic trucker jacket.',
  brand: "Levi's",
  size: 'L',
  color: 'Blue',
  condition: 'good',
  flaw_notes: 'Small paint fleck on left cuff.',
  measurements: { chest: '22in', length: '26in' },
  style_era: '1990s',
  subcategory: 'mens',
  category: 'outerwear',
  ebay_price: 78,
}

const PHOTOS = [
  { url: 'https://img.invalid/b.jpg', position: 1 },
  { url: 'https://img.invalid/a.jpg', position: 0 },
]

// ------------------------------------------------------------- conditions

describe('condition mapping', () => {
  test('maps the resale vocabulary onto eBay enums', () => {
    assert.equal(mapCondition('new'), 'NEW')
    assert.equal(mapCondition('New With Tags'), 'NEW')
    assert.equal(mapCondition('NWOT'), 'NEW_OTHER')
    assert.equal(mapCondition('like new'), 'LIKE_NEW')
    assert.equal(mapCondition('excellent'), 'USED_EXCELLENT')
    assert.equal(mapCondition('very good'), 'USED_VERY_GOOD')
    assert.equal(mapCondition('good'), 'USED_GOOD')
    assert.equal(mapCondition('fair'), 'USED_ACCEPTABLE')
    assert.equal(mapCondition('poor'), 'FOR_PARTS_OR_NOT_WORKING')
  })

  test('normalises case, underscores and punctuation', () => {
    assert.equal(mapCondition('  LIKE_NEW  '), 'LIKE_NEW')
    assert.equal(mapCondition('Very-Good'), 'USED_VERY_GOOD')
  })

  test('falls back rather than throwing on an unknown value', () => {
    // A weird condition string must never block a listing.
    assert.equal(mapCondition('slightly crunchy'), DEFAULT_CONDITION)
    assert.equal(mapCondition(null), DEFAULT_CONDITION)
    assert.equal(mapCondition(''), DEFAULT_CONDITION)
  })

  test('flaw notes become the condition description', () => {
    assert.equal(
      conditionDescription('good', 'Small stain on hem'),
      'Small stain on hem',
    )
    assert.equal(conditionDescription('good', null), undefined)
  })

  test('condition description is capped at eBay’s 1000 chars', () => {
    const long = 'x'.repeat(1500)
    assert.equal(conditionDescription('good', long)!.length, 1000)
  })
})

// ------------------------------------------------------------- categories

describe('category mapping', () => {
  beforeEach(() => clearCategoryTreeCache())

  test('prefers the static map on category/subcategory', async () => {
    const { impl, calls } = mockFetch([])
    const result = await resolveCategoryId(
      { category: 'outerwear', subcategory: 'mens', title: 'x' },
      baseOptions(impl),
    )
    assert.equal(result.categoryId, STATIC_CATEGORY_MAP['outerwear/mens'])
    assert.equal(result.source, 'static')
    assert.equal(calls.length, 0, 'a static hit must not call the taxonomy API')
  })

  test('falls back to eBay’s suggestion when unmapped', async () => {
    const { impl, calls } = mockFetch([
      {
        method: 'GET',
        match: /get_default_category_tree_id/,
        body: { categoryTreeId: '0' },
      },
      {
        method: 'GET',
        match: /get_category_suggestions/,
        body: {
          categorySuggestions: [
            { category: { categoryId: '57988', categoryName: "Men's Coats" } },
          ],
        },
      },
    ])

    const result = await resolveCategoryId(
      { category: 'unmapped-thing', title: 'Wool Overcoat', brand: 'Pendleton' },
      baseOptions(impl),
    )

    assert.equal(result.categoryId, '57988')
    assert.equal(result.source, 'suggested')
    assert.equal(calls.length, 2)
    // The query should carry brand + title so eBay has something to go on.
    assert.match(decodeURIComponent(calls[1].url), /Pendleton/)
  })

  test('throws a useful error when eBay suggests nothing', async () => {
    const { impl } = mockFetch([
      { method: 'GET', match: /get_default_category_tree_id/, body: { categoryTreeId: '0' } },
      { method: 'GET', match: /get_category_suggestions/, body: { categorySuggestions: [] } },
    ])

    await assert.rejects(
      () => resolveCategoryId({ category: 'zzz', title: 'zzz' }, baseOptions(impl)),
      /STATIC_CATEGORY_MAP/,
    )
  })

  test('throws when there is nothing to search on at all', async () => {
    const { impl } = mockFetch([])
    await assert.rejects(
      () => resolveCategoryId({}, baseOptions(impl)),
      /no category, subcategory or title/,
    )
  })
})

// ----------------------------------------------------------------- client

describe('ebayFetch error handling', () => {
  test('retries a 429 and then succeeds', async () => {
    let hits = 0
    const impl = (async () => {
      hits++
      return hits === 1
        ? new Response(JSON.stringify({ errors: [{ errorId: 1 }] }), { status: 429 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await ebayFetch('/x', baseOptions(impl))
    assert.deepEqual(result, { ok: true })
    assert.equal(hits, 2)
  })

  test('does NOT retry a 400 - repeating a bad request just burns quota', async () => {
    let hits = 0
    const impl = (async () => {
      hits++
      return new Response(
        JSON.stringify({ errors: [{ errorId: 25019, longMessage: 'Invalid condition' }] }),
        { status: 400 },
      )
    }) as unknown as typeof fetch

    await assert.rejects(() => ebayFetch('/x', baseOptions(impl)), (err: any) => {
      assert.ok(err instanceof EbayApiError)
      assert.equal(err.status, 400)
      assert.equal(err.errorId, 25019)
      assert.equal(err.isPermanent, true)
      assert.match(err.message, /Invalid condition/)
      return true
    })
    assert.equal(hits, 1)
  })

  test('retries a 401 exactly once after dropping the cached token', async () => {
    let hits = 0
    const impl = (async () => {
      hits++
      return hits === 1
        ? new Response(JSON.stringify({ errors: [{ errorId: 1001 }] }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await ebayFetch('/x', baseOptions(impl))
    assert.deepEqual(result, { ok: true })
    assert.equal(hits, 2)
  })

  test('gives up after the attempt budget on persistent 5xx', async () => {
    let hits = 0
    const impl = (async () => {
      hits++
      return new Response(JSON.stringify({ errors: [] }), { status: 503 })
    }) as unknown as typeof fetch

    await assert.rejects(() =>
      ebayFetch('/x', { ...baseOptions(impl), attempts: 3 }),
    )
    assert.equal(hits, 3)
  })

  test('returns null for 204 rather than exploding on an empty body', async () => {
    const impl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    assert.equal(await ebayFetch('/x', baseOptions(impl)), null)
  })
})

// ---------------------------------------------------------------- adapter

describe('EbayAdapter payload building', () => {
  test('builds item specifics from the inventory row', () => {
    assert.deepEqual(buildAspects(ITEM), {
      Brand: ["Levi's"],
      Size: ['L'],
      Color: ['Blue'],
      Style: ['1990s'],
      Department: ['mens'],
    })
  })

  test('omits empty aspects rather than sending blanks', () => {
    const aspects = buildAspects({ ...ITEM, color: null, style_era: '   ' })
    assert.ok(!('Color' in aspects))
    assert.ok(!('Style' in aspects))
  })

  test('description folds in measurements and flaw notes', () => {
    const html = buildDescription(ITEM)
    assert.match(html, /Classic trucker jacket/)
    assert.match(html, /chest: 22in/)
    assert.match(html, /Small paint fleck/)
  })

  test('description is never empty, even for a bare item', () => {
    const html = buildDescription({ ...ITEM, description: null, measurements: null, flaw_notes: null })
    assert.ok(html.length > 0)
  })

  test('sku is derived from the inventory id, so it is stable', () => {
    assert.equal(skuFor(ITEM), `ankrevibe-${ITEM.id}`)
  })
})

describe('EbayAdapter.createListing', () => {
  const publishRoutes: Route[] = [
    { method: 'PUT', match: /inventory_item/, status: 204 },
    { method: 'GET', match: /\/offer\?sku=/, body: { offers: [] } },
    { method: 'POST', match: /\/offer$/, body: { offerId: 'offer-99' } },
    { method: 'POST', match: /\/offer\/offer-99\/publish/, body: { listingId: '1234567890' } },
  ]

  test('does inventory-item then offer then publish, and returns the offer id', async () => {
    const { impl, calls } = mockFetch(publishRoutes)
    const adapter = new EbayAdapter(baseOptions(impl))

    const result = await adapter.createListing({
      item: ITEM,
      photos: PHOTOS,
      price: 78,
    })

    assert.equal(result.platformListingId, 'offer-99')
    assert.equal(result.platformUrl, 'https://www.ebay.com/itm/1234567890')

    const sequence = calls.map((c) => `${c.method} ${c.url.split('/sell/inventory/v1')[1] ?? c.url}`)
    assert.equal(sequence.length, 4)
    assert.match(sequence[0], /^PUT \/inventory_item/)
    assert.match(sequence[3], /publish/)
  })

  test('sends photos ordered by position, not insertion order', async () => {
    const { impl, calls } = mockFetch(publishRoutes)
    await new EbayAdapter(baseOptions(impl)).createListing({
      item: ITEM,
      photos: PHOTOS, // deliberately position 1 then 0
      price: 78,
    })

    const put = calls.find((c) => c.method === 'PUT')!
    assert.deepEqual(put.body.product.imageUrls, [
      'https://img.invalid/a.jpg',
      'https://img.invalid/b.jpg',
    ])
  })

  test('sends Content-Language, which eBay 400s without', async () => {
    const { impl, calls } = mockFetch(publishRoutes)
    await new EbayAdapter(baseOptions(impl)).createListing({
      item: ITEM,
      photos: PHOTOS,
      price: 78,
    })
    const put = calls.find((c) => c.method === 'PUT')!
    assert.equal(put.headers['Content-Language'], 'en-US')
  })

  test('offer carries price, policies, location and category', async () => {
    const { impl, calls } = mockFetch(publishRoutes)
    await new EbayAdapter(baseOptions(impl)).createListing({
      item: ITEM,
      photos: PHOTOS,
      price: 78,
    })

    const offer = calls.find((c) => c.method === 'POST' && /\/offer$/.test(c.url))!
    assert.equal(offer.body.pricingSummary.price.value, '78')
    assert.equal(offer.body.pricingSummary.price.currency, 'USD')
    assert.deepEqual(offer.body.listingPolicies, {
      fulfillmentPolicyId: 'fp-1',
      paymentPolicyId: 'pp-1',
      returnPolicyId: 'rp-1',
    })
    assert.equal(offer.body.merchantLocationKey, 'main-warehouse')
    assert.equal(offer.body.categoryId, STATIC_CATEGORY_MAP['outerwear/mens'])
    assert.equal(offer.body.availableQuantity, 1)
  })

  test('updates an existing offer instead of creating a duplicate', async () => {
    const { impl, calls } = mockFetch([
      { method: 'PUT', match: /inventory_item/, status: 204 },
      { method: 'GET', match: /\/offer\?sku=/, body: { offers: [{ offerId: 'offer-existing' }] } },
      { method: 'PUT', match: /\/offer\/offer-existing$/, status: 204 },
      { method: 'POST', match: /publish/, body: { listingId: '999' } },
    ])

    const result = await new EbayAdapter(baseOptions(impl)).createListing({
      item: ITEM,
      photos: PHOTOS,
      price: 78,
    })

    assert.equal(result.platformListingId, 'offer-existing')
    assert.equal(
      calls.filter((c) => c.method === 'POST' && /\/offer$/.test(c.url)).length,
      0,
      'must not POST a second offer for the same sku',
    )
  })

  test('refuses to list without a price', async () => {
    const { impl } = mockFetch(publishRoutes)
    await assert.rejects(
      () => new EbayAdapter(baseOptions(impl)).createListing({ item: ITEM, photos: PHOTOS, price: null }),
      /no ebay_price/,
    )
  })

  test('refuses to list without photos', async () => {
    const { impl } = mockFetch(publishRoutes)
    await assert.rejects(
      () => new EbayAdapter(baseOptions(impl)).createListing({ item: ITEM, photos: [], price: 78 }),
      /at least one photo/,
    )
  })

  test('title is truncated to eBay’s 80-char limit', async () => {
    const { impl, calls } = mockFetch(publishRoutes)
    await new EbayAdapter(baseOptions(impl)).createListing({
      item: { ...ITEM, title: 'A'.repeat(200) },
      photos: PHOTOS,
      price: 78,
    })
    const put = calls.find((c) => c.method === 'PUT')!
    assert.equal(put.body.product.title.length, 80)
  })
})

describe('EbayAdapter.delist', () => {
  test('withdraws the offer', async () => {
    const { impl, calls } = mockFetch([
      { method: 'POST', match: /\/offer\/offer-1\/withdraw/, status: 204 },
    ])
    await new EbayAdapter(baseOptions(impl)).delist('offer-1')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /withdraw/)
  })

  test('a 404 is success - the listing is already down', async () => {
    const { impl } = mockFetch([
      { method: 'POST', match: /withdraw/, status: 404, body: { errors: [{ errorId: 25001 }] } },
    ])
    await new EbayAdapter(baseOptions(impl)).delist('offer-1')
  })

  test('“offer not published” (25002) is also success', async () => {
    const { impl } = mockFetch([
      { method: 'POST', match: /withdraw/, status: 400, body: { errors: [{ errorId: 25002 }] } },
    ])
    await new EbayAdapter(baseOptions(impl)).delist('offer-1')
  })

  test('any other error still propagates', async () => {
    const { impl } = mockFetch([
      { method: 'POST', match: /withdraw/, status: 400, body: { errors: [{ errorId: 25713, longMessage: 'nope' }] } },
    ])
    await assert.rejects(
      () => new EbayAdapter(baseOptions(impl)).delist('offer-1'),
      /nope/,
    )
  })

  test('a null listing id is a no-op, not a crash', async () => {
    const { impl, calls } = mockFetch([])
    await new EbayAdapter(baseOptions(impl)).delist(null)
    assert.equal(calls.length, 0)
  })
})

describe('EbayAdapter.relist', () => {
  test('republishes from the sku and returns the new offer id', async () => {
    const { impl } = mockFetch([
      { method: 'PUT', match: /inventory_item/, status: 204 },
      { method: 'GET', match: /\/offer\?sku=/, body: { offers: [{ offerId: 'offer-7' }] } },
      { method: 'PUT', match: /\/offer\/offer-7$/, status: 204 },
      { method: 'POST', match: /publish/, body: { listingId: '555' } },
    ])

    const result = await new EbayAdapter(baseOptions(impl)).relist('offer-7', {
      item: ITEM,
      photos: PHOTOS,
      price: 80,
    })

    assert.equal(result.platformListingId, 'offer-7')
    assert.equal(result.platformUrl, 'https://www.ebay.com/itm/555')
  })
})
