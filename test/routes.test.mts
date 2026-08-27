import { test, describe, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Route-handler tests.
 *
 * Only the session boundary and the operation layer are mocked - the real
 * requireUser(), the real body parsing, the real platform validation and
 * the real status codes all run. No network, no database.
 *
 * Requires --experimental-test-module-mocks (see the test:routes script).
 */

let currentUser: { id: string } | null = { id: 'user-1' }

const calls: Record<string, unknown[][]> = {
  crosspost: [],
  recordSale: [],
  relist: [],
  runHealthCheck: [],
}

let crosspostImpl = async (..._args: unknown[]) => [
  { platform: 'ebay', status: 'active' },
]
let recordSaleImpl = async (..._args: unknown[]) => ({
  inventoryId: 'item-1',
  soldPlatform: 'ebay',
  orderId: 'order-1',
  delisted: [],
})
let relistImpl = async (..._args: unknown[]) => [
  { platform: 'ebay', status: 'active' },
]
let healthImpl = async (..._args: unknown[]) => ({
  soldInventoryId: 'item-1',
  photosHashed: 0,
  candidatesCompared: 1,
  flagsCreated: 1,
  flags: [{ flaggedInventoryId: 'dupe', similarityScore: 0 }],
})

mock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: currentUser } }) },
    }),
  },
})

mock.module('@/lib/operations', {
  namedExports: {
    crosspost: async (...args: unknown[]) => {
      calls.crosspost.push(args)
      return crosspostImpl(...args)
    },
    recordSale: async (...args: unknown[]) => {
      calls.recordSale.push(args)
      return recordSaleImpl(...args)
    },
    relist: async (...args: unknown[]) => {
      calls.relist.push(args)
      return relistImpl(...args)
    },
  },
})

mock.module('@/lib/health', {
  namedExports: {
    runHealthCheck: async (...args: unknown[]) => {
      calls.runHealthCheck.push(args)
      return healthImpl(...args)
    },
  },
})

const { POST: crosspostRoute } = await import('../app/api/crosspost/route')
const { POST: saleRoute } = await import('../app/api/sale/route')
const { POST: relistRoute } = await import('../app/api/relist/route')
const { POST: healthRoute } = await import('../app/api/health-check/route')

function post(body: unknown, raw = false) {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

beforeEach(() => {
  currentUser = { id: 'user-1' }
  for (const key of Object.keys(calls)) calls[key] = []
  crosspostImpl = async () => [{ platform: 'ebay', status: 'active' }]
  recordSaleImpl = async () => ({
    inventoryId: 'item-1',
    soldPlatform: 'ebay',
    orderId: 'order-1',
    delisted: [],
  })
  relistImpl = async () => [{ platform: 'ebay', status: 'active' }]
  healthImpl = async () => ({
    soldInventoryId: 'item-1',
    photosHashed: 0,
    candidatesCompared: 1,
    flagsCreated: 1,
    flags: [{ flaggedInventoryId: 'dupe', similarityScore: 0 }],
  })
})

const ROUTES = [
  { name: 'crosspost', handler: crosspostRoute },
  { name: 'sale', handler: saleRoute },
  { name: 'relist', handler: relistRoute },
  { name: 'health-check', handler: healthRoute },
]

describe('auth gate', () => {
  for (const route of ROUTES) {
    test(`${route.name} returns 401 when signed out`, async () => {
      currentUser = null
      const response = await route.handler(post({ inventoryId: 'item-1' }))
      assert.equal(response.status, 401)
      assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    })
  }

  test('a signed-out request never reaches the operation layer', async () => {
    currentUser = null
    await crosspostRoute(post({ inventoryId: 'item-1' }))
    assert.equal(calls.crosspost.length, 0)
  })
})

describe('body validation', () => {
  for (const route of ROUTES) {
    test(`${route.name} rejects a non-JSON body with 400`, async () => {
      const response = await route.handler(post('not json{', true))
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /JSON/)
    })

    test(`${route.name} rejects a missing inventoryId with 400`, async () => {
      const response = await route.handler(post({}))
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /inventoryId/)
    })
  }
})

describe('POST /api/crosspost', () => {
  test('defaults to all four platforms when none are given', async () => {
    const response = await crosspostRoute(post({ inventoryId: 'item-1' }))
    assert.equal(response.status, 200)

    const [, inventoryId, platforms] = calls.crosspost[0]
    assert.equal(inventoryId, 'item-1')
    assert.deepEqual(platforms, ['ebay', 'poshmark', 'depop', 'mercari'])
  })

  test('passes through an explicit platform list', async () => {
    await crosspostRoute(post({ inventoryId: 'item-1', platforms: ['depop'] }))
    assert.deepEqual(calls.crosspost[0][2], ['depop'])
  })

  test('rejects an unknown platform by name', async () => {
    const response = await crosspostRoute(
      post({ inventoryId: 'item-1', platforms: ['ebay', 'etsy'] }),
    )
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /etsy/)
    assert.equal(calls.crosspost.length, 0, 'must not run a partial crosspost')
  })

  test('returns the per-platform results', async () => {
    crosspostImpl = async () => [
      { platform: 'ebay', status: 'active', platformUrl: 'https://x.invalid/1' },
      { platform: 'depop', status: 'error', error: 'boom' },
    ]
    const response = await crosspostRoute(post({ inventoryId: 'item-1' }))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.results.length, 2)
    assert.equal(body.results[1].status, 'error')
  })

  test('surfaces an operation throw as 500', async () => {
    crosspostImpl = async () => {
      throw new Error('database exploded')
    }
    const response = await crosspostRoute(post({ inventoryId: 'item-1' }))
    assert.equal(response.status, 500)
    assert.match((await response.json()).error, /database exploded/)
  })

})

describe('POST /api/sale', () => {
  test('requires a valid platform', async () => {
    const missing = await saleRoute(post({ inventoryId: 'item-1' }))
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /platform/)

    const bogus = await saleRoute(
      post({ inventoryId: 'item-1', platform: 'craigslist' }),
    )
    assert.equal(bogus.status, 400)
    assert.equal(calls.recordSale.length, 0)
  })

  test('records the sale then runs the health check', async () => {
    const response = await saleRoute(
      post({ inventoryId: 'item-1', platform: 'ebay', salePrice: 78 }),
    )
    assert.equal(response.status, 200)

    assert.equal(calls.recordSale.length, 1)
    const [, inventoryId, platform, salePrice] = calls.recordSale[0]
    assert.equal(inventoryId, 'item-1')
    assert.equal(platform, 'ebay')
    assert.equal(salePrice, 78)

    assert.deepEqual(calls.runHealthCheck[0], ['item-1'])

    const body = await response.json()
    assert.equal(body.sale.orderId, 'order-1')
    assert.equal(body.health.flagsCreated, 1)
    assert.equal(body.healthError, null)
  })

  test('defaults salePrice to null when omitted', async () => {
    await saleRoute(post({ inventoryId: 'item-1', platform: 'ebay' }))
    assert.equal(calls.recordSale[0][3], null)
  })

  test('a health-check failure does not fail the sale', async () => {
    // The sale is already durable; losing the scan must not 500 the request
    // or the UI would suggest the sale did not go through.
    healthImpl = async () => {
      throw new Error('sharp could not decode image')
    }

    const response = await saleRoute(
      post({ inventoryId: 'item-1', platform: 'ebay', salePrice: 78 }),
    )

    assert.equal(response.status, 200, 'sale must still succeed')
    const body = await response.json()
    assert.equal(body.sale.orderId, 'order-1')
    assert.equal(body.health, null)
    assert.match(body.healthError, /could not decode/)
  })

  test('a recordSale failure IS a 500', async () => {
    recordSaleImpl = async () => {
      throw new Error('constraint violation')
    }
    const response = await saleRoute(
      post({ inventoryId: 'item-1', platform: 'ebay' }),
    )
    assert.equal(response.status, 500)
    assert.equal(calls.runHealthCheck.length, 0, 'no scan after a failed sale')
  })
})

describe('POST /api/relist', () => {
  test('relists every platform when none are named', async () => {
    const response = await relistRoute(post({ inventoryId: 'item-1' }))
    assert.equal(response.status, 200)
    assert.equal(calls.relist[0][2], undefined)
  })

  test('passes an explicit platform list through', async () => {
    await relistRoute(post({ inventoryId: 'item-1', platforms: ['ebay'] }))
    assert.deepEqual(calls.relist[0][2], ['ebay'])
  })

  test('rejects an unknown platform', async () => {
    const response = await relistRoute(
      post({ inventoryId: 'item-1', platforms: ['facebook'] }),
    )
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /facebook/)
    assert.equal(calls.relist.length, 0)
  })
})

describe('POST /api/health-check', () => {
  test('runs the scan for the given item', async () => {
    const response = await healthRoute(post({ inventoryId: 'item-1' }))
    assert.equal(response.status, 200)
    assert.deepEqual(calls.runHealthCheck[0], ['item-1'])

    const body = await response.json()
    assert.equal(body.flagsCreated, 1)
    assert.equal(body.flags[0].flaggedInventoryId, 'dupe')
  })

  test('a scan failure here IS a 500 - it is the whole point of the call', async () => {
    healthImpl = async () => {
      throw new Error('scan blew up')
    }
    const response = await healthRoute(post({ inventoryId: 'item-1' }))
    assert.equal(response.status, 500)
    assert.match((await response.json()).error, /scan blew up/)
  })
})
