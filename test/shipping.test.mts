import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BAND,
  FULFILLMENT_POLICIES,
  allPolicyIds,
  inferBandFromTitle,
  policyIdFor,
  resolveShippingPolicy,
} from '../lib/ebay/shipping'

/**
 * Shipping policy selection.
 *
 * This decides what the buyer is charged to ship, on every listing. Getting
 * it wrong is not cosmetic: banding a winter coat as a t-shirt under-declares
 * the postage and the difference comes out of the sale.
 */

const MENS = "Clothing, Shoes & Accessories:Men:Men's Clothing:"

describe('policy definitions', () => {
  test('all four bands have a distinct, non-empty id', () => {
    const ids = allPolicyIds().map((p) => p.id)
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4, 'two bands share an id')
    for (const id of ids) assert.match(id, /^\d+$/)
  })

  test('an env var overrides a band, for a second account or sandbox', () => {
    const original = process.env.EBAY_POLICY_HEAVY
    process.env.EBAY_POLICY_HEAVY = '999999'
    try {
      assert.equal(policyIdFor('heavy'), '999999')
    } finally {
      if (original === undefined) delete process.env.EBAY_POLICY_HEAVY
      else process.env.EBAY_POLICY_HEAVY = original
    }
  })

  test('without an override it uses the account id', () => {
    assert.equal(policyIdFor('sweatshirts'), FULFILLMENT_POLICIES.sweatshirts.id)
  })
})

describe('banding by mapped category', () => {
  const cases: Array<[string, string, string]> = [
    [MENS + 'Shirts:T-Shirts', 'Men', 'tshirts-shorts'],
    [MENS + 'Shirts:Polos', 'Men', 'tshirts-shorts'],
    [MENS + 'Shorts', 'Men', 'tshirts-shorts'],
    [MENS + 'Sweaters', 'Men', 'sweatshirts'],
    [MENS + 'Activewear:Hoodies & Sweatshirts', 'Men', 'sweatshirts'],
    [MENS + 'Jeans', 'Men', 'light-coats-jeans'],
    [MENS + 'Coats, Jackets & Vests', 'Men', 'light-coats-jeans'],
    [MENS + 'Suits & Suit Separates', 'Men', 'heavy'],
    [MENS.replace("Men's Clothing:", "Men's Shoes:") + 'Athletic Shoes', 'Men', 'heavy'],
  ]

  for (const [category, department, expected] of cases) {
    test(`${category.split(':').pop()} -> ${expected}`, () => {
      const result = resolveShippingPolicy({ category, subcategory: department })
      assert.equal(result.band, expected)
      assert.equal(result.source, 'category')
      assert.equal(result.assumed, false)
    })
  }

  test('a jacket costs more to ship than a t-shirt', () => {
    // The whole point of banding.
    const tshirt = resolveShippingPolicy({ category: MENS + 'Shirts:T-Shirts', subcategory: 'Men' })
    const jacket = resolveShippingPolicy({ category: MENS + 'Coats, Jackets & Vests', subcategory: 'Men' })
    assert.notEqual(tshirt.policyId, jacket.policyId)
  })
})

describe('title fallback', () => {
  test('rescues apparel whose category has no department', () => {
    // 102 of 402 items had no mappable category. Left alone they would all
    // ship on the t-shirt rate, jackets included.
    const jacket = resolveShippingPolicy({
      category: 'Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:College-NCAA',
      subcategory: null,
      title: 'Missouri Tiger Nike Full Zip Jacket Size Medium',
    })
    assert.equal(jacket.band, 'light-coats-jeans')
    assert.equal(jacket.source, 'title')
    assert.equal(jacket.assumed, false)
  })

  test('a sweatshirt is not shipped at the t-shirt rate', () => {
    const result = resolveShippingPolicy({
      category: 'Collectibles:Something:Unmapped',
      subcategory: null,
      title: 'Adidas Los Angeles Lakers Sweatshirt XXL Purple',
    })
    assert.equal(result.band, 'sweatshirts')
  })

  test('a mapped category BEATS the title', () => {
    // The category is the stronger signal; a misleading title must not
    // override it.
    const result = resolveShippingPolicy({
      category: MENS + 'Shirts:T-Shirts',
      subcategory: 'Men',
      title: 'Heavy Winter Coat Boots Parka',
    })
    assert.equal(result.band, 'tshirts-shorts')
    assert.equal(result.source, 'category')
  })

  test('heavier wording wins when a title says two things', () => {
    // "hooded jacket" is a jacket. Ordered heaviest-first so the more
    // expensive band is chosen, which errs toward not under-charging.
    assert.equal(inferBandFromTitle('Vintage Hooded Jacket Mens L'), 'light-coats-jeans')
    assert.equal(inferBandFromTitle('Denim Jacket'), 'light-coats-jeans')
  })

  test('matches whole words only', () => {
    // Without word boundaries "dress" matches "dresser" and "hat" matches
    // "that" - both would silently misband.
    assert.equal(inferBandFromTitle('Antique Dresser Drawer Pull'), null)
    assert.equal(inferBandFromTitle('A Sign That Says Hello'), null)
    assert.equal(inferBandFromTitle('Capri Sun Pouch'), null)
  })

  test('returns null when a title says nothing useful', () => {
    assert.equal(inferBandFromTitle('Star Wars Mug'), null)
    assert.equal(inferBandFromTitle(null), null)
    assert.equal(inferBandFromTitle(''), null)
  })
})

describe('the unknown case', () => {
  test('falls to the default band and SAYS it assumed', () => {
    // Reported rather than silent, so a heavy collectible can be spotted.
    const result = resolveShippingPolicy({
      category: 'Collectibles:Holiday & Seasonal:Ornaments',
      subcategory: null,
      title: 'Hallmark Ornament 2002',
    })
    assert.equal(result.band, DEFAULT_BAND)
    assert.equal(result.source, 'default')
    assert.equal(result.assumed, true)
  })

  test('an item with nothing at all still resolves to a real policy', () => {
    // A publish must never be handed an empty fulfillment policy.
    const result = resolveShippingPolicy({})
    assert.ok(result.policyId)
    assert.match(result.policyId, /^\d+$/)
  })
})

describe('every band is reachable', () => {
  test('no band is orphaned by the garment table', () => {
    // A band nothing maps to is either a dead policy or a missing rule.
    const reached = new Set<string>()
    const probes: Array<[string, string]> = [
      [MENS + 'Shirts:T-Shirts', 'Men'],
      [MENS + 'Sweaters', 'Men'],
      [MENS + 'Jeans', 'Men'],
      [MENS + 'Suits & Suit Separates', 'Men'],
    ]
    for (const [category, department] of probes) {
      reached.add(resolveShippingPolicy({ category, subcategory: department }).band)
    }
    assert.deepEqual(
      [...reached].sort(),
      Object.keys(FULFILLMENT_POLICIES).sort(),
    )
  })
})

describe('policy costs are recorded from the live account', () => {
  test('T Shirts/Shorts charges $6 despite being NAMED $5', () => {
    // The rate was deliberately raised from $5 to $6 when postage went up;
    // the policy name was never changed to match. $6 is correct. This test
    // exists so nobody "fixes" the value back to $5 to agree with the label.
    assert.equal(FULFILLMENT_POLICIES['tshirts-shorts'].costUsd, 6)
    assert.match(FULFILLMENT_POLICIES['tshirts-shorts'].label, /\$5/)
  })

  test('cost rises monotonically with band weight', () => {
    // If a heavier band ever costs less, the banding is pointless.
    const order: Array<keyof typeof FULFILLMENT_POLICIES> = [
      'tshirts-shorts',
      'sweatshirts',
      'light-coats-jeans',
      'heavy',
    ]
    for (let i = 1; i < order.length; i++) {
      const lighter = FULFILLMENT_POLICIES[order[i - 1]].costUsd
      const heavier = FULFILLMENT_POLICIES[order[i]].costUsd
      assert.ok(
        heavier > lighter,
        `${order[i]} ($${heavier}) should cost more than ${order[i - 1]} ($${lighter})`,
      )
    }
  })

  test('every band has a real cost', () => {
    for (const policy of Object.values(FULFILLMENT_POLICIES)) {
      assert.ok(policy.costUsd > 0, `${policy.band} has no cost`)
    }
  })
})
