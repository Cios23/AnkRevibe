import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DepopAdapter } from '../lib/platforms/depop'

/**
 * Depop delist.
 *
 * The DOM automation itself cannot be tested here - it needs a real Depop
 * page behind a login, and Depop 403s any scripted request. What IS testable
 * is the part that decides which control to click, and the contract that
 * stops a queued delist being recorded as a completed one.
 */

type Candidate = { text?: string; label?: string; id?: string }

let matchesLabel: (text: string, wanted: string) => boolean
let findByLabels: (
  candidates: Candidate[],
  labels: string[],
) => { candidate: Candidate; matched: string; via: string } | null

before(() => {
  const source = readFileSync('extension/lib/labels.js', 'utf8')
  new Function(source).call(globalThis)
  const api = (globalThis as any).AnkLabels
  matchesLabel = api.matchesLabel
  findByLabels = api.findByLabels
})

describe('matchesLabel', () => {
  test('matches a whole word regardless of case', () => {
    assert.equal(matchesLabel('Delete listing', 'delete'), true)
    assert.equal(matchesLabel('DELETE', 'delete'), true)
  })

  test('does NOT match a word it is merely inside', () => {
    // The reason this is not a substring check. On a page of destructive
    // controls, "Deleted items" must not answer a search for "delete".
    assert.equal(matchesLabel('Deleted items', 'delete'), false)
    assert.equal(matchesLabel('Undelete', 'delete'), false)
    assert.equal(matchesLabel('Removed', 'remove'), false)
  })

  test('matches a multi-word label', () => {
    assert.equal(matchesLabel('Mark as sold now', 'mark as sold'), true)
  })

  test('handles empty input without throwing', () => {
    assert.equal(matchesLabel('', 'delete'), false)
    assert.equal(matchesLabel('delete', ''), false)
  })

  test('treats regex characters in a label as literal text', () => {
    assert.equal(matchesLabel('Delete (permanent)', 'delete'), true)
    assert.equal(matchesLabel('anything', '.*'), false)
  })
})

describe('findByLabels', () => {
  test('prefers the earlier label over document order', () => {
    // A page offering both must resolve by priority, not by which renders
    // first - "Mark as sold" records a sale, which is not what we asked for.
    const candidates: Candidate[] = [
      { text: 'mark as sold', id: 'sold' },
      { text: 'delete listing', id: 'delete' },
    ]
    const hit = findByLabels(candidates, ['delete listing', 'mark as sold'])
    assert.equal(hit?.candidate.id, 'delete')
  })

  test('falls through to a later label when the first is absent', () => {
    const candidates: Candidate[] = [{ text: 'mark as sold', id: 'sold' }]
    const hit = findByLabels(candidates, ['delete listing', 'mark as sold'])
    assert.equal(hit?.candidate.id, 'sold')
    assert.equal(hit?.matched, 'mark as sold')
  })

  test('matches on aria-label / data-testid as well as text', () => {
    const candidates: Candidate[] = [{ text: '', label: 'delete', id: 'icon' }]
    const hit = findByLabels(candidates, ['delete'])
    assert.equal(hit?.candidate.id, 'icon')
    assert.equal(hit?.via, 'label')
  })

  test('returns null rather than a near-miss', () => {
    // Clicking something approximately right on a page with a delete button
    // is worse than doing nothing.
    const candidates: Candidate[] = [
      { text: 'edit' },
      { text: 'share' },
      { text: 'deleted items' },
    ]
    assert.equal(findByLabels(candidates, ['delete', 'remove']), null)
  })

  test('an empty page yields null', () => {
    assert.equal(findByLabels([], ['delete']), null)
  })
})

describe('DepopAdapter', () => {
  test('reports a delist as QUEUED, not delisted', async () => {
    // The whole point. Depop cannot be delisted from a server, and claiming
    // otherwise writes into our records that a live listing is down.
    const outcome = await new DepopAdapter().delist('abc123')
    assert.equal(outcome, 'queued')
  })

  test('nothing to delist is genuinely done', async () => {
    assert.equal(await new DepopAdapter().delist(null), 'delisted')
  })

  test('refuses to create or relist from the server', async () => {
    const adapter = new DepopAdapter()
    const context = {
      item: { id: 'item-1' } as never,
      photos: [],
      price: 10,
    }
    await assert.rejects(() => adapter.createListing(context), /extension/)
    await assert.rejects(() => adapter.relist('x', context), /extension/)
  })
})
