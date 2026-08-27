import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { computeProfit, platformFee, describeFee, PLATFORM_FEES } from '../lib/fees'
import type { Platform } from '../lib/types'

describe('platformFee', () => {
  test('eBay takes 13.25%', () => {
    assert.equal(platformFee('ebay', 100), 13.25)
    assert.equal(platformFee('ebay', 40), 5.3)
  })

  test('Depop and Mercari take 10%', () => {
    assert.equal(platformFee('depop', 100), 10)
    assert.equal(platformFee('mercari', 45), 4.5)
  })

  test('Poshmark is a flat $2.95 below $15', () => {
    assert.equal(platformFee('poshmark', 10), 2.95)
    assert.equal(platformFee('poshmark', 14.99), 2.95)
  })

  test('Poshmark switches to 20% at exactly $15', () => {
    // The boundary matters: at $15 the flat fee would take 2.95 and the
    // percentage takes 3.00, so an off-by-one here misstates every sale
    // in the $15-20 band.
    assert.equal(platformFee('poshmark', 15), 3)
    assert.equal(platformFee('poshmark', 100), 20)
  })

  test('rounds to cents rather than leaking float drift', () => {
    // 0.1 + 0.2 territory: 19.99 * 0.1325 = 2.648675
    assert.equal(platformFee('ebay', 19.99), 2.65)
    assert.equal(platformFee('depop', 33.33), 3.33)
  })

  test('nonsense prices produce no fee rather than NaN', () => {
    assert.equal(platformFee('ebay', 0), 0)
    assert.equal(platformFee('ebay', -10), 0)
    assert.equal(platformFee('ebay', Number.NaN), 0)
  })

  test('every platform has a fee model', () => {
    for (const p of ['ebay', 'poshmark', 'depop', 'mercari'] as Platform[]) {
      assert.ok(PLATFORM_FEES[p], `${p} missing a fee model`)
      assert.ok(platformFee(p, 50) > 0, `${p} produced no fee`)
    }
  })
})

describe('computeProfit', () => {
  test('profit is sale minus fee minus cost', () => {
    // $100 on eBay: 13.25 fee, $40 cost -> 46.75
    const result = computeProfit('ebay', 100, 40)!
    assert.equal(result.fee, 13.25)
    assert.equal(result.profit, 46.75)
    assert.equal(result.salePrice, 100)
    assert.equal(result.purchaseCost, 40)
  })

  test('a sale can be a loss', () => {
    // $20 on Poshmark: 20% = $4 fee, $25 cost -> -9
    const result = computeProfit('poshmark', 20, 25)!
    assert.equal(result.profit, -9)
  })

  test('the Poshmark flat fee dominates small sales', () => {
    // $12 sale, $9 cost: fee 2.95 -> 0.05 profit, not 3.00.
    const result = computeProfit('poshmark', 12, 9)!
    assert.equal(result.fee, 2.95)
    assert.equal(result.profit, 0.05)
  })

  test('returns null rather than guessing when cost is unknown', () => {
    // A profit figure computed from an assumed cost looks authoritative and
    // is wrong; no figure is the honest answer.
    assert.equal(computeProfit('ebay', 100, null), null)
    assert.equal(computeProfit('ebay', 100, undefined), null)
  })

  test('returns null when the sale price is unknown', () => {
    assert.equal(computeProfit('ebay', null, 40), null)
  })

  test('a zero cost is a real cost, not a missing one', () => {
    const result = computeProfit('ebay', 100, 0)
    assert.notEqual(result, null)
    assert.equal(result!.profit, 86.75)
  })

  test('rejects non-numeric inputs', () => {
    assert.equal(computeProfit('ebay', 'abc' as unknown as number, 10), null)
  })

  test('fee differs by platform for the same sale', () => {
    const price = 100
    const cost = 20
    const ebay = computeProfit('ebay', price, cost)!
    const depop = computeProfit('depop', price, cost)!
    assert.ok(
      depop.profit > ebay.profit,
      'Depop takes 10% vs eBay 13.25%, so it must net more',
    )
  })
})

describe('describeFee', () => {
  test('states the rule for the UI', () => {
    assert.match(describeFee('ebay'), /13\.25%/)
    assert.match(describeFee('poshmark'), /\$2\.95 under \$15/)
    assert.match(describeFee('depop'), /10/)
  })
})

describe('fee model agreement with the extension', () => {
  test('lib/fees.ts and extension/lib/margin.js agree on Poshmark', () => {
    // Two copies of the same rule in different languages. If one changes and
    // the other does not, offers get made on numbers the dashboard will
    // later contradict.
    const source = readFileSync('extension/lib/margin.js', 'utf8')
    new Function(source).call(globalThis)
    const net = (globalThis as any).AnkMargin.poshmarkNetProceeds as (
      p: number,
    ) => number

    for (const price of [5, 10, 14.99, 15, 20, 100]) {
      const extensionFee = price - net(price)
      const serverFee = platformFee('poshmark', price)
      assert.ok(
        Math.abs(extensionFee - serverFee) < 0.01,
        `Poshmark fee disagrees at $${price}: extension ${extensionFee.toFixed(
          2,
        )} vs server ${serverFee.toFixed(2)}`,
      )
    }
  })
})
