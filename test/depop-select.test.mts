import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Tests the row chooser in extension/lib/depop-select.js.
 *
 * Depop's fields are react-select controls, so a value is set by clicking a
 * row - which means picking the WRONG row silently files the listing under
 * the wrong category, or claims a condition the item is not in. Clicking
 * needs a browser; choosing does not, and choosing is where the risk is.
 *
 * The values our tables hold were read off this very form, so a near miss
 * means the table is wrong. These tests pin that a near miss is REPORTED
 * rather than resolved to whatever looked closest - the same discipline that
 * caught three of Depop's five condition values being wrong.
 */

type Row = { text: string }
type Choice = { index: number; reason: string; candidates?: string[] }

let chooseRow: (rows: Row[], wanted: string) => Choice

before(() => {
  const source = readFileSync('extension/lib/depop-select.js', 'utf8')
  // The module reaches for browser globals only inside functions, so
  // evaluating it to capture the pure chooser needs no DOM.
  new Function(source).call(globalThis)
  chooseRow = (globalThis as any).AnkDepopSelect.chooseRow
})

const rows = (...texts: string[]): Row[] => texts.map((text) => ({ text }))

describe('chooseRow', () => {
  test('takes an exact match', () => {
    const result = chooseRow(rows('Brand new', 'Like new', 'Used - Good'), 'Like new')
    assert.equal(result.index, 1)
    assert.equal(result.reason, 'exact')
  })

  test('is case- and whitespace-insensitive', () => {
    const result = chooseRow(rows('  Used - Excellent '), 'used - excellent')
    assert.equal(result.index, 0)
  })

  test('matches across punctuation differences', () => {
    // Our table says "Used - Good"; the form may render an en dash.
    const result = chooseRow(rows('Used – Good'), 'Used - Good')
    assert.equal(result.index, 0)
    assert.equal(result.reason, 'punctuation')
  })

  test('matches Depop’s spaced slash', () => {
    // "Reworked / Upcycled" is Depop's own spacing. Both forms must land on
    // the same row, since the exact string is what the form matches on.
    assert.equal(chooseRow(rows('Reworked / Upcycled'), 'Reworked / Upcycled').index, 0)
    assert.equal(chooseRow(rows('Reworked / Upcycled'), 'Reworked/Upcycled').index, 0)
  })

  test('refuses a near miss rather than guessing', () => {
    // "Excellent" was in our table for months; the form offers
    // "Used - Excellent". Selecting the nearest row would have hidden that
    // for months more - and the wrong condition is a returned item.
    const result = chooseRow(rows('Brand new', 'Like new', 'Used - Excellent'), 'Excellent')
    assert.equal(result.index, -1)
    assert.equal(result.reason, 'no-match')
  })

  test('reports what it saw, so a wrong table value is fixable', () => {
    const result = chooseRow(rows('Modern', '00s', '90s'), 'Very good')
    assert.equal(result.index, -1)
    assert.deepEqual(result.candidates, ['Modern', '00s', '90s'])
  })

  test('does not match a row that merely contains the value', () => {
    // "Good" must not select "Used - Good": on a form where both could
    // exist, a substring match picks whichever came first.
    const result = chooseRow(rows('Used - Good', 'Used - Fair'), 'Good')
    assert.equal(result.index, -1)
  })

  test('an empty list matches nothing', () => {
    const result = chooseRow([], 'Brand new')
    assert.equal(result.index, -1)
    assert.deepEqual(result.candidates, [])
  })
})

describe('the values our tables emit are choosable', () => {
  test('every Depop condition matches its own row exactly', () => {
    // The live five, in the form's own words.
    const live = rows('Brand new', 'Like new', 'Used - Excellent', 'Used - Good', 'Used - Fair')
    for (const value of live.map((r) => r.text)) {
      const result = chooseRow(live, value)
      assert.ok(result.index >= 0, `"${value}" did not match itself`)
      assert.equal(result.reason, 'exact')
    }
  })

  test('every Depop age matches its own row exactly', () => {
    const live = rows('Modern', '00s', '90s', '80s', '70s', '60s', '50s', 'Antique')
    for (const value of live.map((r) => r.text)) {
      assert.ok(chooseRow(live, value).index >= 0, `"${value}" did not match itself`)
    }
  })
})
