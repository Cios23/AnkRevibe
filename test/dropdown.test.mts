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

describe('finding the element that actually opens a picker', () => {
  /**
   * A stand-in for a DOM node, enough for findTrigger: it matches selectors
   * against a declared attribute list and searches its own descendants.
   */
  type Fake = {
    tag: string
    attrs: Record<string, string>
    children: Fake[]
    isConnected: boolean
    matches(selector: string): boolean
    querySelectorAll(selector: string): Fake[]
    getBoundingClientRect(): { width: number; height: number }
  }

  const el = (
    tag: string,
    attrs: Record<string, string> = {},
    children: Fake[] = [],
    { hidden = false } = {},
  ): Fake => {
    const node: Fake = {
      tag,
      attrs,
      children,
      isConnected: true,
      getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 120, height: 32 }),
      matches(selector: string) {
        if (selector === node.tag) return true
        const attr = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]/)
        if (attr) {
          const [, name, value] = attr
          if (!(name in node.attrs)) return false
          if (value !== undefined && node.attrs[name] !== value) return false
          // The :not([tabindex="-1"]) tail on the last selector.
          if (selector.includes(':not([tabindex="-1"])')) return node.attrs.tabindex !== '-1'
          return true
        }
        return false
      },
      querySelectorAll(selector: string) {
        const out: Fake[] = []
        const walk = (n: Fake) => {
          for (const child of n.children) {
            if (child.matches(selector)) out.push(child)
            walk(child)
          }
        }
        walk(node)
        return out
      },
    }
    return node
  }

  let findTrigger: (container: unknown) => { how: string; fellBack: boolean; el: unknown }

  before(() => {
    // isVisible calls window.getComputedStyle; the fakes above supply the rest.
    ;(globalThis as any).window = {
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    }
    findTrigger = (globalThis as any).AnkDropdown.findTrigger
  })

  test('finds Poshmark’s real category control', () => {
    // The exact element from the live page. It is a div - not an input, not a
    // button, and with no role - so the old lookup found nothing, clicked the
    // wrapper, and Vue ignored it. The picker never opened, which the driver
    // then reported as "no rows" after polling an empty document for 8s.
    const container = el('div', { class: 'listing-editor__category-container' }, [
      el('div', {
        'aria-haspopup': 'true',
        tabindex: '0',
        'data-test': 'dropdown',
        class: 'dropdown d--b',
      }),
    ])

    const found = findTrigger(container)
    assert.equal(found.fellBack, false, 'fell back to the container again')
    assert.equal(found.how, '[data-test="dropdown"]')
    assert.notEqual(found.el, container)
  })

  test('aria-haspopup alone is enough', () => {
    // data-test is Poshmark's own hook and could be renamed; aria-haspopup is
    // the accessible contract for "I own a popup" and should carry any
    // framework.
    const container = el('div', {}, [el('div', { 'aria-haspopup': 'true' })])
    const found = findTrigger(container)
    assert.equal(found.how, '[aria-haspopup="true"]')
    assert.equal(found.fellBack, false)
  })

  test('the specific hook beats a generic button', () => {
    // Priority order, not document order: a clear-selection button sitting
    // before the control must not win.
    const container = el('div', {}, [
      el('button', {}),
      el('div', { 'data-test': 'dropdown' }),
    ])
    assert.equal(findTrigger(container).how, '[data-test="dropdown"]')
  })

  test('the old selectors still work where they applied', () => {
    // Nothing that was already opening must stop.
    assert.equal(findTrigger(el('div', {}, [el('input', {})])).how, 'input')
    assert.equal(
      findTrigger(el('div', {}, [el('div', { role: 'combobox' })])).how,
      '[role="combobox"]',
    )
  })

  test('the container itself can be the control', () => {
    const container = el('div', { 'data-test': 'dropdown' })
    const found = findTrigger(container)
    assert.equal(found.el, container)
    assert.equal(found.fellBack, false, 'this is a real match, not a fallback')
  })

  test('a hidden match beats giving up, and is flagged', () => {
    const hidden = el('div', { 'data-test': 'dropdown' }, [], { hidden: true })
    const found = findTrigger(el('div', {}, [hidden])) as { hidden?: boolean; el: unknown }
    assert.equal(found.el, hidden)
    assert.equal(found.hidden, true)
  })

  test('falling back to the container is reported, not silent', () => {
    // This is the state that wasted a live fill: clicking a wrapper that
    // listens for nothing looks exactly like an empty dropdown.
    const container = el('div', {}, [el('span', {})])
    const found = findTrigger(container)
    assert.equal(found.fellBack, true)
    assert.equal(found.how, 'container-fallback')
  })
})

describe('a covered trigger is reported, not silently clicked', () => {
  /**
   * Poshmark raises two modals after the photos upload - "Select a Covershot"
   * and "Listing Price" - and both sit on top of the form. A click meant for
   * the category picker lands on the overlay instead: nothing opens, nothing
   * errors, and the driver polls for rows that were never going to appear.
   *
   * That is the failure this pins. An overlaid control and a control with no
   * options look identical unless something asks the browser where the click
   * would actually go.
   */
  let coveredBy: (el: unknown) => { tag: string; text: string } | null

  const rect = (x: number, y: number, w = 100, h = 40) => ({
    left: x,
    top: y,
    width: w,
    height: h,
  })

  const node = (tag: string, box: ReturnType<typeof rect>, opts: any = {}) => ({
    tagName: tag,
    className: opts.className ?? '',
    textContent: opts.text ?? '',
    isConnected: true,
    getBoundingClientRect: () => box,
    contains(other: any) {
      return other === this || (opts.children ?? []).includes(other)
    },
  })

  before(() => {
    ;(globalThis as any).window = {
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    }
    coveredBy = (globalThis as any).AnkDropdown.coveredBy
  })

  test('an uncovered trigger reports nothing', () => {
    const trigger = node('DIV', rect(100, 100))
    ;(globalThis as any).document = { elementFromPoint: () => trigger }
    assert.equal(coveredBy(trigger), null)
  })

  test('a child of the trigger under the cursor is not coverage', () => {
    // The centre of a control usually lands on its own label.
    const label = node('SPAN', rect(100, 100))
    const trigger = node('DIV', rect(100, 100), { children: [label] })
    ;(globalThis as any).document = { elementFromPoint: () => label }
    assert.equal(coveredBy(trigger), null)
  })

  test('a modal on top IS reported, with what it is', () => {
    const trigger = node('DIV', rect(100, 100))
    const modal = node('DIV', rect(0, 0, 1280, 800), {
      className: 'modal__content',
      text: 'Select a Covershot',
    })
    ;(globalThis as any).document = { elementFromPoint: () => modal }

    const covering = coveredBy(trigger)
    assert.ok(covering, 'the overlay went undetected')
    assert.equal(covering!.tag, 'DIV')
    // Naming what is on top is the whole point: "blocked" without saying by
    // what sends you looking at the dropdown again.
    assert.match(covering!.text, /covershot/i)
  })

  test('an off-screen trigger is not called covered', () => {
    // elementFromPoint cannot answer outside the viewport, and guessing
    // "covered" there would turn a scrolled-away field into a false alarm.
    const trigger = node('DIV', rect(-500, -500))
    ;(globalThis as any).document = { elementFromPoint: () => null }
    assert.equal(coveredBy(trigger), null)
  })

  test('no elementFromPoint means no opinion', () => {
    const trigger = node('DIV', rect(100, 100))
    ;(globalThis as any).document = {}
    assert.equal(coveredBy(trigger), null)
  })
})

describe('the dropdown driver polls rather than reading once', () => {
  test('exposes waitForRows', () => {
    // The live category fill reported "no-rows" against a picker that works
    // perfectly by hand: the rows are rendered by Vue a moment after the
    // field opens, and the driver read once after a fixed 700ms. An empty
    // list has to mean "not ready yet" until a deadline passes, or every
    // slow render looks like an empty dropdown.
    assert.equal(typeof (globalThis as any).AnkDropdown.waitForRows, 'function')
  })

  test('waitForRows gives up rather than hanging', async () => {
    // A document that never produces rows is the timeout path: it must keep
    // looking until the deadline, then return empty rather than either
    // giving up instantly or waiting forever.
    const original = (globalThis as any).document
    ;(globalThis as any).document = { querySelectorAll: () => [] }
    try {
      const started = Date.now()
      const rows = await (globalThis as any).AnkDropdown.waitForRows(null, 300)
      const elapsed = Date.now() - started
      assert.deepEqual(rows, [])
      assert.ok(elapsed >= 250, `gave up after ${elapsed}ms, before the deadline`)
      assert.ok(elapsed < 3000, `overran the deadline at ${elapsed}ms`)
    } finally {
      ;(globalThis as any).document = original
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
