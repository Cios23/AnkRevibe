import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Tests extension/lib/margin.js, which decides what we are willing to sell
 * for. It is a plain browser script attached to globalThis, so evaluate it
 * and read what it exports.
 */

type Evaluate = (
  offerPrice: unknown,
  purchaseCost: unknown,
  options?: { minProfit?: number; requireKnownCost?: boolean },
) => { ok: boolean; reason: string; margin: number | null; net?: number }

let poshmarkNetProceeds: (price: unknown) => number
let evaluateOffer: Evaluate

before(() => {
  const source = readFileSync('extension/lib/margin.js', 'utf8')
  new Function(source).call(globalThis)
  const api = (globalThis as any).AnkMargin
  poshmarkNetProceeds = api.poshmarkNetProceeds
  evaluateOffer = api.evaluateOffer
})

describe('poshmarkNetProceeds', () => {
  test('flat $2.95 fee below $15', () => {
    assert.equal(poshmarkNetProceeds(10), 10 - 2.95)
    assert.equal(poshmarkNetProceeds(14.99), 14.99 - 2.95)
  })

  test('20% commission at $15 and above', () => {
    assert.equal(poshmarkNetProceeds(15), 12)
    assert.equal(poshmarkNetProceeds(100), 80)
  })

  test('the $15 boundary favours the seller', () => {
    // At $15 the flat fee would net 12.05 and the percentage nets 12.00, so
    // the switchover must land on the percentage side, not keep the flat fee.
    assert.equal(poshmarkNetProceeds(15), 12)
    assert.ok(poshmarkNetProceeds(14.99) > poshmarkNetProceeds(15))
  })

  test('nonsense prices yield 0 rather than NaN', () => {
    assert.equal(poshmarkNetProceeds(0), 0)
    assert.equal(poshmarkNetProceeds(-5), 0)
    assert.equal(poshmarkNetProceeds('abc'), 0)
    assert.equal(poshmarkNetProceeds(null), 0)
  })
})

describe('evaluateOffer', () => {
  test('accepts when margin clears the floor', () => {
    // $40 offer -> $32 net, minus $10 cost = $22 margin.
    const result = evaluateOffer(40, 10, { minProfit: 10 })
    assert.equal(result.ok, true)
    assert.equal(result.margin, 22)
  })

  test('rejects when the fee eats the margin', () => {
    // The case the old price-floor check got wrong: a $12 offer on a $9 item
    // looks like $3 of profit, but the flat $2.95 fee nets $9.05 - five
    // cents of actual margin, nowhere near a $1 floor.
    const result = evaluateOffer(12, 9, { minProfit: 1 })
    assert.equal(result.ok, false)
    assert.ok(
      Math.abs(result.margin! - 0.05) < 1e-9,
      'margin should be the 5c the fee leaves, not the $3 the price implies',
    )
  })

  test('a genuine loss is reported as negative', () => {
    // $10 nets $7.05 against a $9 cost.
    const result = evaluateOffer(10, 9, { minProfit: 0 })
    assert.equal(result.ok, false)
    assert.ok(result.margin! < 0)
  })

  test('the old raw-price check would have accepted that same offer', () => {
    // Pins the behaviour change: price >= minProfit was the old gate.
    assert.ok(12 >= 1, 'old gate passed')
    assert.equal(evaluateOffer(12, 9, { minProfit: 1 }).ok, false)
  })

  test('margin is inclusive at the floor', () => {
    // $40 -> $32 net, $22 cost = exactly $10.
    const result = evaluateOffer(40, 22, { minProfit: 10 })
    assert.equal(result.margin, 10)
    assert.equal(result.ok, true)
    assert.equal(evaluateOffer(40, 22, { minProfit: 10.01 }).ok, false)
  })

  test('refuses to guess when purchase_cost is unknown', () => {
    const result = evaluateOffer(40, null, { minProfit: 10 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no purchase_cost')
    assert.equal(result.margin, null)
  })

  test('falls back to a price floor only when explicitly allowed', () => {
    const allowed = evaluateOffer(40, null, {
      minProfit: 10,
      requireKnownCost: false,
    })
    assert.equal(allowed.ok, true)
    assert.match(allowed.reason, /price floor/)
    assert.equal(allowed.margin, null, 'must not claim a margin it cannot know')
  })

  test('a zero cost is a real cost, not a missing one', () => {
    const result = evaluateOffer(40, 0, { minProfit: 10 })
    assert.equal(result.ok, true)
    assert.equal(result.margin, 32)
    assert.notEqual(result.reason, 'no purchase_cost')
  })

  test('rejects an invalid price outright', () => {
    assert.equal(evaluateOffer(0, 5, { minProfit: 1 }).ok, false)
    assert.equal(evaluateOffer('abc', 5, { minProfit: 1 }).reason, 'invalid price')
  })

  test('reports the margin so a run can explain itself', () => {
    assert.match(evaluateOffer(40, 10, { minProfit: 5 }).reason, /margin 22\.00/)
  })
})
