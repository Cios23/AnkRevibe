import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

before(() => {
  const source = readFileSync('extension/lib/dropdown.js', 'utf8')
  new Function(source).call(globalThis)
  chooseOption = (globalThis as any).AnkDropdown.chooseOption
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

describe('generated category map', () => {
  let lookup: (
    platform: string,
    category: string | null,
    subcategory: string | null,
  ) => string[] | null

  before(() => {
    const source = readFileSync('extension/lib/category-map.generated.js', 'utf8')
    new Function(source).call(globalThis)
    lookup = (globalThis as any).AnkCategoryMap.lookup
  })

  test('resolves a real catalogue category to a three-tier path', () => {
    const path = lookup(
      'poshmark',
      "Clothing, Shoes & Accessories:Men:Men's Clothing:Shirts:T-Shirts",
      'Men',
    )
    assert.ok(path, 'expected a mapping for a menswear t-shirt')
    assert.equal(path!.length, 3)
    assert.equal(path![0], 'Men')
  })

  test('Mercari gets four tiers where Poshmark gets three', () => {
    const args = [
      "Clothing, Shoes & Accessories:Men:Men's Clothing:Jeans",
      'Men',
    ] as const
    assert.equal(lookup('poshmark', ...args)!.length, 3)
    assert.equal(lookup('mercari', ...args)!.length, 4)
  })

  test('returns null for a category with no clothing home', () => {
    // Collectibles are not listable on these platforms; a null here is what
    // makes the validator block rather than the fill guessing.
    assert.equal(
      lookup('poshmark', 'Collectibles:Holiday & Seasonal:Ornaments', null),
      null,
    )
  })

  test('an unknown category is null, not a crash', () => {
    assert.equal(lookup('poshmark', 'Nonsense:Path', 'Men'), null)
    assert.equal(lookup('poshmark', null, null), null)
    assert.equal(lookup('nosuchplatform', 'x', 'y'), null)
  })
})
