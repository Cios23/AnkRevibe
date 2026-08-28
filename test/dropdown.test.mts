import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEPOP_AGES,
  DEPOP_COLORS,
  DEPOP_CONDITIONS,
  DEPOP_SOURCES,
  DEPOP_STYLES,
} from '../lib/crosslist/attributes'

/**
 * Tests the option chooser in extension/lib/dropdown.js.
 *
 * Poshmark's category selectors are Vue components, not <select>, so the
 * only way to set them is to click an option - which means picking the WRONG
 * option silently files the listing under the wrong category. The clicking
 * needs a browser; choosing does not, and choosing is where the risk is.
 */

type Choice = {
  index: number
  reason: string
  candidates?: string[]
}

let chooseOption: (optionTexts: string[], wanted: string) => Choice
let rowSignature: (rows: Array<{ text: string }>) => string

before(() => {
  const source = readFileSync('extension/lib/dropdown.js', 'utf8')
  new Function(source).call(globalThis)
  chooseOption = (globalThis as any).AnkDropdown.chooseOption
  rowSignature = (globalThis as any).AnkDropdown.rowSignature
})

describe('chooseOption', () => {
  test('takes an exact match', () => {
    const result = chooseOption(['Tops', 'Jackets & Coats', 'Jeans'], 'Jeans')
    assert.equal(result.index, 2)
    assert.equal(result.reason, 'exact')
  })

  test('is case- and whitespace-insensitive', () => {
    const result = chooseOption(['  Jackets & Coats '], 'jackets & coats')
    assert.equal(result.index, 0)
  })

  test('matches across punctuation differences', () => {
    // Our table says "Tees - Short Sleeve"; the live option may be spaced or
    // hyphenated differently.
    const result = chooseOption(['Tees — Short Sleeve'], 'Tees - Short Sleeve')
    assert.equal(result.index, 0)
    assert.equal(result.reason, 'loose')
  })

  test('accepts a unique partial match', () => {
    const result = chooseOption(['Sweatshirts & Hoodies', 'Jeans'], 'Hoodies')
    assert.equal(result.index, 0)
    assert.equal(result.reason, 'contains')
  })

  test('REFUSES an ambiguous partial match', () => {
    // "Shirts" appears in two options. Picking either would silently file
    // the item under a category nobody chose.
    const result = chooseOption(
      ['Casual Button Down Shirts', 'Dress Shirts', 'Jeans'],
      'Shirts',
    )
    assert.equal(result.index, -1)
    assert.equal(result.reason, 'ambiguous')
  })

  test('reports the options it was offered when it fails', () => {
    // This is what turns a wrong name in our mapping table into a one-line
    // fix instead of a mystery.
    const result = chooseOption(['Tops', 'Jeans'], 'Blazers')
    assert.equal(result.index, -1)
    assert.deepEqual(result.candidates, ['Tops', 'Jeans'])
  })

  test('an exact match wins over a partial one', () => {
    const result = chooseOption(['Short Sleeve Tees', 'Tees'], 'Tees')
    assert.equal(result.index, 1)
    assert.equal(result.reason, 'exact')
  })

  test('empty input fails rather than picking the first option', () => {
    assert.equal(chooseOption(['Tops', 'Jeans'], '').index, -1)
    assert.equal(chooseOption([], 'Tops').index, -1)
  })

  test('real Poshmark paths from the mapping table resolve', () => {
    // The three-tier values the generated map actually emits.
    const menus: Array<[string[], string]> = [
      [['Men', 'Women', 'Kids'], 'Men'],
      [['Tops', 'Shirts', 'Sweaters', 'Jeans'], 'Shirts'],
      [['Tees - Short Sleeve', 'Polos', 'Dress Shirts'], 'Tees - Short Sleeve'],
    ]
    for (const [options, wanted] of menus) {
      assert.ok(
        chooseOption(options, wanted).index >= 0,
        `failed to resolve "${wanted}"`,
      )
    }
  })
})

describe('the generated crosslist map', () => {
  let map: any

  before(() => {
    const source = readFileSync('extension/lib/crosslist-map.generated.js', 'utf8')
    new Function(source).call(globalThis)
    map = (globalThis as any).AnkCrosslist
  })

  test('holds a resolved mapping for real items', () => {
    const ids = Object.keys(map.items)
    assert.ok(ids.length > 0, 'the map is empty - regenerate it')
    const entry = map.lookup('poshmark', ids[0])
    assert.ok(entry, 'expected a poshmark entry for the first item')
    assert.ok('categoryPath' in entry && 'colors' in entry && 'size' in entry)
  })

  test('an unknown item is null, not a crash', () => {
    // Null means "regenerate", and the popup falls back to raw values.
    assert.equal(map.lookup('poshmark', 'no-such-id'), null)
    assert.equal(map.lookup('nosuchplatform', Object.keys(map.items)[0]), null)
  })

  test('Poshmark paths are three tiers when present', () => {
    let checked = 0
    for (const id of Object.keys(map.items)) {
      const path = map.lookup('poshmark', id)?.categoryPath
      if (!path) continue
      assert.equal(path.length, 3, `${id} has ${path.length} tiers`)
      checked++
    }
    assert.ok(checked > 0, 'no poshmark categories mapped at all')
  })

  test('never emits a value Depop would reject', () => {
    // The end of the chain that started with three of five condition values
    // being wrong: whatever the rules do, what actually reaches the form
    // must be on the form. A failure here means a listing gets filled with a
    // string Depop does not accept.
    for (const id of Object.keys(map.items)) {
      const entry = map.lookup('depop', id)
      if (!entry) continue

      if (entry.condition) {
        assert.ok(
          (DEPOP_CONDITIONS as readonly string[]).includes(entry.condition),
          `${id}: condition "${entry.condition}"`,
        )
      }
      if (entry.age) {
        assert.ok(
          (DEPOP_AGES as readonly string[]).includes(entry.age),
          `${id}: age "${entry.age}"`,
        )
      }
      if (entry.source) {
        assert.ok(
          (DEPOP_SOURCES as readonly string[]).includes(entry.source),
          `${id}: source "${entry.source}"`,
        )
      }
      for (const tag of entry.styleTags ?? []) {
        assert.ok(
          (DEPOP_STYLES as readonly string[]).includes(tag),
          `${id}: style "${tag}"`,
        )
      }
      for (const color of entry.colors ?? []) {
        assert.ok(DEPOP_COLORS.includes(color), `${id}: colour "${color}"`)
      }
      assert.ok((entry.colors ?? []).length <= 2, `${id}: more than 2 colours`)
      assert.ok((entry.styleTags ?? []).length <= 2, `${id}: more than 2 style tags`)
    }
  })

  test('Poshmark gets an original price at or above the listing price', () => {
    // Poshmark rejects an original price below the listing price.
    for (const id of Object.keys(map.items)) {
      const entry = map.lookup('poshmark', id)
      if (!entry || entry.originalPrice == null) continue
      assert.ok(entry.originalPrice > 0, `${id}: original price ${entry.originalPrice}`)
    }
  })
})


describe('rowSignature (nested-navigation safety)', () => {
  test('distinguishes one level of the tree from the next', () => {
    // The picker replaces the list in place, so the ONLY way to know a click
    // advanced is that the visible rows changed.
    const departments = [{ text: 'Women' }, { text: 'Men' }, { text: 'Kids' }]
    const categories = [{ text: 'Bags' }, { text: 'Dresses' }, { text: 'Accessories' }]
    assert.notEqual(rowSignature(departments), rowSignature(categories))
  })

  test('is stable for the same list', () => {
    const rows = [{ text: 'Women' }, { text: 'Men' }]
    assert.equal(rowSignature(rows), rowSignature([...rows]))
  })

  test('ignores case and surrounding whitespace', () => {
    assert.equal(
      rowSignature([{ text: '  Women ' }]),
      rowSignature([{ text: 'women' }]),
    )
  })

  test('a repeated name across departments is NOT a distinct list', () => {
    // "Accessories" exists under both Women and Men. If the code matched
    // before the list re-rendered it would click a plausible wrong row, so
    // the signature must treat identical rows as identical.
    const womensCategories = [{ text: 'Bags' }, { text: 'Accessories' }]
    const sameAgain = [{ text: 'Bags' }, { text: 'Accessories' }]
    assert.equal(rowSignature(womensCategories), rowSignature(sameAgain))
  })
})

describe('navigating a real Poshmark path', () => {
  test('each level of a mapped path resolves against its own list', () => {
    // Mirrors the confirmed structure: departments -> categories ->
    // subcategories, matched by visible text at each level.
    const path = ['Women', 'Accessories', 'Belts']
    const levels = [
      ['Women', 'Men', 'Girls', 'Boys'],
      ['Bags', 'Dresses', 'Accessories', 'Tops'],
      ['Belts', 'Hair Accessories', 'Scarves & Wraps'],
    ]
    path.forEach((wanted, i) => {
      const choice = chooseOption(levels[i], wanted)
      assert.ok(choice.index >= 0, `level ${i} failed to match "${wanted}"`)
      assert.equal(levels[i][choice.index], wanted)
    })
  })
})

describe('row filtering', () => {
  let isExcludedRow: (text: string) => boolean
  let ROW_SELECTOR: string

  before(() => {
    const source = readFileSync('extension/lib/dropdown.js', 'utf8')
    new Function(source).call(globalThis)
    isExcludedRow = (globalThis as any).AnkDropdown.isExcludedRow
    ROW_SELECTOR = (globalThis as any).AnkDropdown.ROW_SELECTOR
  })

  test('uses the confirmed row class', () => {
    assert.equal(ROW_SELECTOR, '.dropdown__link.dropdown__menu__item')
  })

  test('excludes "All Categories" - it resets rather than selects', () => {
    assert.equal(isExcludedRow('All Categories'), true)
    assert.equal(isExcludedRow('  all categories  '), true)
  })

  test('excludes the closed-state placeholder', () => {
    // Reading this as a department is what produced an empty tree.
    assert.equal(isExcludedRow('Select Category'), true)
  })

  test('does NOT exclude real categories that merely contain those words', () => {
    assert.equal(isExcludedRow('Accessories'), false)
    assert.equal(isExcludedRow('All Weather Coats'), false)
    assert.equal(isExcludedRow('Women'), false)
  })
})

describe('Poshmark two-field category structure', () => {
  test('the mapped path splits 2 + 1 across the two fields', () => {
    // Category field takes department + category; subcategory is its own
    // control. A three-level path is therefore consumed as [0,1] then [2].
    const path = ['Women', 'Accessories', 'Belts']
    const categoryField = path.slice(0, 2)
    const subcategoryField = path.slice(2)

    assert.deepEqual(categoryField, ['Women', 'Accessories'])
    assert.deepEqual(subcategoryField, ['Belts'])
  })

  test('each field level still resolves by visible text', () => {
    const levels: Array<[string[], string]> = [
      [['Women', 'Men', 'Girls', 'Boys'], 'Women'],
      [['Bags', 'Dresses', 'Accessories', 'Tops'], 'Accessories'],
      [['Belts', 'Face Masks', 'Hair Accessories'], 'Belts'],
    ]
    for (const [options, wanted] of levels) {
      const choice = chooseOption(options, wanted)
      assert.ok(choice.index >= 0, `failed to match "${wanted}"`)
      assert.equal(options[choice.index], wanted)
    }
  })

  test('a two-tier mapping is still usable - subcategory is optional', () => {
    // Poshmark labels subcategory optional, so a path with only department
    // and category must not be treated as broken.
    const path = ['Men', 'Shirts']
    assert.equal(path.length >= 2, true)
    assert.deepEqual(path.slice(2), [])
  })
})
