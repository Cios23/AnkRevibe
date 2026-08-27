import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  computeProfit,
  computeRoi,
  describeFee,
  formatRoi,
  partitionRankable,
  platformFee,
  PLATFORM_FEES,
} from '../lib/fees'
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

// ------------------------------------------------------------------- ROI

describe('computeRoi', () => {
  test('is profit as a fraction of cost', () => {
    assert.equal(computeRoi(50, 25), 2) // 200%
    assert.equal(computeRoi(10, 40), 0.25) // 25%
  })

  test('a loss is negative ROI', () => {
    assert.equal(computeRoi(-10, 20), -0.5)
  })

  test('unknown cost yields null, never a number', () => {
    // The whole point: an item with no cost must not rank as if cost were 0,
    // which would make every such item look infinitely profitable.
    assert.equal(computeRoi(50, null), null)
    assert.equal(computeRoi(50, undefined), null)
  })

  test('an unsold item has no ROI', () => {
    assert.equal(computeRoi(null, 25), null)
  })

  test('zero cost is unrankable rather than infinite', () => {
    // A free item has a real profit but an undefined ratio; returning
    // Infinity would sort it above every genuine result.
    assert.equal(computeRoi(50, 0), null)
    assert.equal(computeRoi(50, -5), null)
  })

  test('rejects non-numeric input', () => {
    assert.equal(computeRoi('x' as unknown as number, 10), null)
  })
})

describe('formatRoi', () => {
  test('renders a percentage', () => {
    assert.equal(formatRoi(2), '200%')
    assert.equal(formatRoi(0.25), '25%')
  })

  test('unknown renders as a dash, not 0%', () => {
    assert.equal(formatRoi(null), '—')
  })

  test('a loss is signed', () => {
    assert.match(formatRoi(-0.5), /50%/)
    assert.ok(formatRoi(-0.5).startsWith('−'))
  })
})

describe('partitionRankable', () => {
  type Row = { id: string; profit: number | null; cost: number | null }
  const read = (r: Row) => ({
    profit: r.profit,
    purchaseCost: r.cost,
    roi: computeRoi(r.profit, r.cost),
  })

  test('separates items that cannot be honestly ranked', () => {
    const rows: Row[] = [
      { id: 'known', profit: 50, cost: 25 },
      { id: 'no-cost', profit: null, cost: null },
      { id: 'free', profit: 50, cost: 0 },
    ]
    const { rankable, unknown } = partitionRankable(rows, read)

    assert.deepEqual(rankable.map((r) => r.id), ['known'])
    // Both the unknown-cost and the zero-cost item are unrankable, for
    // different reasons, and neither belongs in a sorted list.
    assert.deepEqual(unknown.map((r) => r.id).sort(), ['free', 'no-cost'])
  })

  test('no item is silently dropped', () => {
    const rows: Row[] = [
      { id: 'a', profit: 10, cost: 5 },
      { id: 'b', profit: null, cost: null },
      { id: 'c', profit: 1, cost: 100 },
    ]
    const { rankable, unknown } = partitionRankable(rows, read)
    assert.equal(rankable.length + unknown.length, rows.length)
  })

  test('sorting the rankable set orders by return, not raw profit', () => {
    const rows: Row[] = [
      { id: 'big-profit-low-roi', profit: 100, cost: 500 }, // 20%
      { id: 'small-profit-high-roi', profit: 30, cost: 10 }, // 300%
    ]
    const { rankable } = partitionRankable(rows, read)
    const byRoi = [...rankable].sort(
      (a, b) => computeRoi(b.profit, b.cost)! - computeRoi(a.profit, a.cost)!,
    )
    assert.equal(byRoi[0].id, 'small-profit-high-roi')
  })
})
