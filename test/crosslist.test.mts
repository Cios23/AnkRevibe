import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CATEGORY_DEPTH,
  inferDepartmentFromTitle,
  inferGarmentFromTitle,
  mapCategory,
  normaliseDepartment,
  toInternalCategory,
} from '../lib/crosslist/categories'
import {
  DEPOP_AGES,
  DEPOP_COLORS,
  DEPOP_CONDITIONS,
  DEPOP_SOURCES,
  DEPOP_STYLES,
  MERCARI_COLORS,
  buildStyleTags,
  mapDepopAge,
  mapDepopSource,
  POSHMARK_COLORS,
  mapColors,
  mapCondition,
  mapSize,
} from '../lib/crosslist/attributes'
import {
  compileDescription,
  estimatePackageSize,
  estimateWeightOz,
  formatWeight,
} from '../lib/crosslist/description'
import {
  TITLE_LIMIT,
  describeErrors,
  deriveOriginalPrice,
  mapListing,
} from '../lib/crosslist'
import { CROSSLIST_PLATFORMS } from '../lib/crosslist/types'
import type { CrosslistItem, CrosslistPlatform } from '../lib/crosslist/types'

/** A complete, valid item. Tests remove fields to isolate one failure. */
const ITEM: CrosslistItem = {
  title: "90s Levi's Denim Trucker Jacket",
  description: 'Classic trucker jacket in great shape.',
  brand: "Levi's",
  category: 'Clothing, Shoes & Accessories:Men:Men\'s Clothing:Coats, Jackets & Vests',
  subcategory: 'Men',
  size: 'L',
  color: 'Blue',
  condition: 'Pre-owned - Excellent',
  material: 'Cotton denim',
  measurements: { chest: '22in', length: '26in' },
  flawNotes: 'Small paint fleck on left cuff.',
  styleEra: '1990s',
  price: 78,
  photoCount: 5,
}

const item = (over: Partial<CrosslistItem> = {}): CrosslistItem => ({ ...ITEM, ...over })

// ------------------------------------------------------------ departments

describe('normaliseDepartment', () => {
  test('handles the values the catalogue actually holds', () => {
    assert.equal(normaliseDepartment('Men', null), 'men')
    assert.equal(normaliseDepartment('Women', null), 'women')
    assert.equal(normaliseDepartment('Boys', null), 'boys')
    assert.equal(normaliseDepartment('Girls', null), 'girls')
    assert.equal(normaliseDepartment('Unisex Kids', null), 'unisex-kids')
    assert.equal(normaliseDepartment('Unisex Baby & Toddler', null), 'baby')
  })

  test('unisex adult falls to menswear, where these platforms put it', () => {
    assert.equal(normaliseDepartment('Unisex Adults', null), 'men')
    assert.equal(normaliseDepartment('Unisex Adult', null), 'men')
    assert.equal(normaliseDepartment('Adult', null), 'men')
  })

  test('falls back to the category path when subcategory is useless', () => {
    // "Does not apply" is a real value in the data.
    assert.equal(
      normaliseDepartment('Does not apply', "Clothing, Shoes & Accessories:Men:Men's Clothing:Jeans"),
      'men',
    )
    assert.equal(normaliseDepartment(null, "Clothing:Women:Women's Clothing:Tops"), 'women')
  })

  test('returns null when there is genuinely nothing to go on', () => {
    assert.equal(normaliseDepartment(null, 'Collectibles:Holiday & Seasonal:Ornaments'), null)
  })
})

// -------------------------------------------------------------- categories

describe('toInternalCategory', () => {
  const cases: Array<[string, string, string]> = [
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Shirts:T-Shirts", 'Men', 'tshirts'],
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Shirts:Casual Button-Down Shirts", 'Men', 'casual-shirts'],
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Sweaters", 'Men', 'sweaters'],
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Activewear:Hoodies & Sweatshirts", 'Men', 'hoodies'],
    ["Clothing, Shoes & Accessories:Women:Women's Clothing:Coats, Jackets & Vests", 'Women', 'coats-jackets'],
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Jeans", 'Men', 'jeans'],
    ["Clothing, Shoes & Accessories:Men:Men's Clothing:Shirts:Polos", 'Men', 'polos'],
    ["Clothing, Shoes & Accessories:Women:Women's Shoes:Athletic Shoes", 'Women', 'athletic-shoes'],
    ["Clothing, Shoes & Accessories:Men:Men's Accessories:Hats", 'Men', 'hats'],
  ]

  for (const [path, dept, expected] of cases) {
    test(`maps ${expected}`, () => {
      assert.equal(toInternalCategory(path, dept)?.garment, expected)
    })
  }

  test('specific rules beat general ones', () => {
    // "Activewear:Hoodies & Sweatshirts" must not fall through to a generic
    // activewear rule, and "Shirts:T-Shirts" must not land on casual-shirts.
    assert.equal(
      toInternalCategory("Men's Clothing:Activewear:Hoodies & Sweatshirts", 'Men')?.garment,
      'hoodies',
    )
    assert.equal(
      toInternalCategory("Men's Clothing:Shirts:T-Shirts", 'Men')?.garment,
      'tshirts',
    )
  })

  test('non-apparel is unmapped rather than forced', () => {
    // Collectibles have no clothing category on these platforms.
    assert.equal(toInternalCategory('Collectibles:Holiday & Seasonal:Ornaments', null), null)
  })
})

describe('mapCategory', () => {
  for (const platform of CROSSLIST_PLATFORMS) {
    test(`${platform} returns a path of the right depth`, () => {
      const result = mapCategory(platform, ITEM.category, ITEM.subcategory)
      assert.ok(result, `${platform} should map a men's jacket`)
      assert.equal(result!.path.length, CATEGORY_DEPTH[platform])
    })
  }

  test('Mercari is four tiers where the others are three', () => {
    assert.equal(CATEGORY_DEPTH.mercari, 4)
    assert.equal(mapCategory('mercari', ITEM.category, 'Men')!.path.length, 4)
    assert.equal(mapCategory('poshmark', ITEM.category, 'Men')!.path.length, 3)
  })

  test('department changes the branch, not just the leaf', () => {
    const mens = mapCategory('poshmark', "Men's Clothing:Jeans", 'Men')!
    const womens = mapCategory('poshmark', "Women's Clothing:Jeans", 'Women')!
    assert.equal(mens.path[0], 'Men')
    assert.equal(womens.path[0], 'Women')
  })

  test('returns null for a garment a platform has no home for', () => {
    // Depop lists skirts under womenswear only, so there is nowhere to put a
    // menswear skirt - and a null is what makes the validator block rather
    // than the fill picking some adjacent row.
    assert.equal(
      mapCategory('depop', "Clothing, Shoes & Accessories:Women:Women's Clothing:Skirts", 'Men'),
      null,
    )
  })
})

// ------------------------------------------------------------------ sizes

describe('mapSize', () => {
  test('normalises the letter sizes the catalogue uses', () => {
    assert.equal(mapSize('depop', 'M').value, 'M')
    assert.equal(mapSize('depop', 'Small').value, 'S')
    assert.equal(mapSize('depop', 'large').value, 'L')
  })

  test('plus sizes take each platform’s own spelling', () => {
    // "2XL" is 25 items in the catalogue.
    assert.equal(mapSize('poshmark', '2XL').value, '2X')
    assert.equal(mapSize('depop', '2XL').value, 'XXL')
    assert.equal(mapSize('mercari', '2XL').value, 'XXL')
  })

  test('One Size passes through', () => {
    assert.equal(mapSize('poshmark', 'One Size').value, 'One Size')
  })

  test('an age range resolves to a single bucket', () => {
    // Platforms offer one option, so "18-24 Months" cannot be sent as-is.
    assert.equal(mapSize('mercari', '18-24 Months').value, '24 Months')
  })

  test('waist x inseam keeps the waist and warns about the inseam', () => {
    const result = mapSize('poshmark', '34x30')
    assert.equal(result.value, '34')
    assert.match(result.warning!, /inseam 30/i)
  })

  test('bare numbers pass through - the form decides the scale', () => {
    assert.equal(mapSize('mercari', '44').value, '44')
    assert.equal(mapSize('mercari', '9.5').value, '9.5')
  })

  test('an unrecognised size is passed with a warning, not dropped', () => {
    const result = mapSize('depop', 'Tall Fit')
    assert.equal(result.value, 'Tall Fit')
    assert.ok(result.warning)
  })

  test('no size yields null and no warning', () => {
    assert.equal(mapSize('depop', null).value, null)
    assert.equal(mapSize('depop', '').warning, undefined)
  })
})

// ---------------------------------------------------------------- colours

describe('mapColors', () => {
  test('passes through a colour every palette has', () => {
    for (const platform of CROSSLIST_PLATFORMS) {
      assert.deepEqual(mapColors(platform, 'Blue').values, ['Blue'])
    }
  })

  test('handles both spellings of multicolour in the data', () => {
    // The catalogue contains "Multicolor" (35) and "Multi-Color" (3).
    assert.deepEqual(mapColors('poshmark', 'Multicolor').values, ['Multi'])
    assert.deepEqual(mapColors('poshmark', 'Multi-Color').values, ['Multi'])
  })

  test('reduces a colour no palette offers to the nearest one', () => {
    // Depop is no longer the example here: it offers Navy and Burgundy, so
    // reduction is exactly what must NOT happen there.
    assert.deepEqual(mapColors('poshmark', 'Navy').values, ['Blue'])
    assert.deepEqual(mapColors('poshmark', 'Burgundy').values, ['Red'])
    assert.deepEqual(mapColors('mercari', 'Olive').values, ['Green'])
  })

  test('spells grey the way each platform does', () => {
    assert.deepEqual(mapColors('depop', 'Gray').values, ['Grey'])
    assert.deepEqual(mapColors('mercari', 'Gray').values, ['Gray'])
    assert.deepEqual(mapColors('poshmark', 'Gray').values, ['Gray'])
  })

  test('Beige maps to Tan on Poshmark, which has no Beige', () => {
    // 9 items are Beige.
    assert.deepEqual(mapColors('poshmark', 'Beige').values, ['Tan'])
    assert.deepEqual(mapColors('mercari', 'Beige').values, ['Beige'])
  })

  test('splits a compound colour and caps at the platform limit', () => {
    const result = mapColors('poshmark', 'Blue/White/Red')
    assert.equal(result.values.length, 2, 'Poshmark takes at most 2')
    assert.deepEqual(result.values, ['Blue', 'White'])
    assert.match(result.warning!, /dropped Red/i)
  })

  test('deduplicates colours that reduce to the same palette entry', () => {
    // On Poshmark, Navy and Royal both become Blue; say Blue once. Depop
    // keeps them apart because it offers Navy, so it cannot show the dedup.
    assert.deepEqual(mapColors('poshmark', 'Navy/Royal').values, ['Blue'])
  })

  test('reports a colour it could not place', () => {
    const result = mapColors('depop', 'Chartreuse')
    assert.ok(result.warning, 'should say it could not map it')
  })

  test('every palette value is a valid member of itself', () => {
    for (const [platform, palette] of [
      ['poshmark', POSHMARK_COLORS],
      ['depop', DEPOP_COLORS],
      ['mercari', MERCARI_COLORS],
    ] as Array<[CrosslistPlatform, string[]]>) {
      for (const color of palette) {
        assert.deepEqual(
          mapColors(platform, color).values,
          [color],
          `${platform} should accept its own "${color}"`,
        )
      }
    }
  })
})

// ------------------------------------------------------------- conditions

describe('mapCondition', () => {
  test('maps eBay display names onto Depop’s 5 tiers', () => {
    assert.equal(mapCondition('depop', 'New with tags').value, 'Brand new')
    assert.equal(mapCondition('depop', 'New without tags').value, 'Like new')
    assert.equal(mapCondition('depop', 'Pre-owned - Excellent').value, 'Used - Excellent')
    assert.equal(mapCondition('depop', 'Very Good').value, 'Used - Good')
    assert.equal(mapCondition('depop', 'Pre-owned - Good').value, 'Used - Good')
    assert.equal(mapCondition('depop', 'Pre-owned - Fair').value, 'Used - Fair')
  })

  test('maps onto Mercari’s 6 tiers', () => {
    assert.equal(mapCondition('mercari', 'New').value, 'New')
    assert.equal(mapCondition('mercari', 'Pre-owned - Excellent').value, 'Like new')
    assert.equal(mapCondition('mercari', 'Pre-owned - Good').value, 'Good')
    assert.equal(mapCondition('mercari', 'Pre-owned - Fair').value, 'Fair')
  })

  test('Poshmark is a boolean, not a tier', () => {
    assert.equal(mapCondition('poshmark', 'New with tags').nwt, true)
    assert.equal(mapCondition('poshmark', 'Pre-owned - Good').nwt, false)
    assert.equal(mapCondition('poshmark', 'New with tags').value, null)
  })

  test('handles the messy real values', () => {
    // The catalogue has bare "Used", "Pre-owned", lowercase "good", "Ungraded".
    assert.equal(mapCondition('depop', 'Used').value, 'Used - Good')
    assert.equal(mapCondition('depop', 'Pre-owned').value, 'Used - Good')
    assert.equal(mapCondition('depop', 'good').value, 'Used - Good')
    assert.equal(mapCondition('mercari', 'Ungraded').value, 'Good')
    assert.equal(mapCondition('mercari', 'Open box').value, 'Like new')
  })

  test('every Depop value it can emit is one the form actually offers', () => {
    // The hand-written table had "Excellent", "Very good" and "Good"; the
    // live form offers "Used - Excellent", "Used - Good" and "Used - Fair"
    // and no "Very good" at all, so three of five were strings Depop would
    // reject. This pins every reachable output to the verified list.
    const inputs = [
      'New with tags', 'New without tags', 'New', 'Open box', 'Like new',
      'Pre-owned - Excellent', 'Very Good', 'Pre-owned - Good', 'Used',
      'Pre-owned', 'good', 'Pre-owned - Fair', 'For parts', 'Ungraded',
    ]
    for (const raw of inputs) {
      const value = mapCondition('depop', raw).value
      assert.ok(
        value && (DEPOP_CONDITIONS as readonly string[]).includes(value),
        `"${raw}" -> "${value}", which Depop does not offer`,
      )
    }
  })

  test('an unrecognised condition warns rather than guessing a tier', () => {
    const result = mapCondition('depop', 'slightly crunchy')
    assert.equal(result.value, null)
    assert.ok(result.warning)
  })

  test('the same item never ranks better on one platform than another', () => {
    // A single internal ranking drives all three, so an item cannot read as
    // "Excellent" on Depop and "Fair" on Mercari.
    const better = mapCondition('depop', 'Pre-owned - Excellent').value
    const worse = mapCondition('depop', 'Pre-owned - Fair').value
    assert.notEqual(better, worse)
    const mBetter = mapCondition('mercari', 'Pre-owned - Excellent').value
    const mWorse = mapCondition('mercari', 'Pre-owned - Fair').value
    assert.notEqual(mBetter, mWorse)
  })
})

// -------------------------------------------- Depop's fixed vocabularies

/**
 * Every Depop field is a fixed list except brand, and each hand-written
 * table was checked against the live form on 2026-08-28. Condition was wrong
 * on three of five values and Style was being fed free text, so these tests
 * pin every reachable output to what the form actually offers. A value that
 * is not on the list is not "close enough" - the form rejects it.
 */
// ------------------------------------------------- title-based rescue

/**
 * Reading the garment out of the title when the category will not say.
 *
 * This decides whether 102 of 402 active items are listable at all, so the
 * risk is not a miss - it is a confident wrong read putting a coat in the
 * t-shirt category. Every rule is pinned, including the ones that must NOT
 * fire.
 */
describe('inferGarmentFromTitle', () => {
  test('reads the garment out of real catalogue titles', () => {
    assert.equal(inferGarmentFromTitle('Nike Tee T-Shirt White Sox Frank Thomas HOF'), 'tshirts')
    assert.equal(inferGarmentFromTitle('Missouri Tiger Nike Full Zip Jacket Size Medium'), 'coats-jackets')
    assert.equal(inferGarmentFromTitle('Vintage Walls Blizzard Pruf Coveralls Boys 8'), 'coveralls')
    assert.equal(inferGarmentFromTitle('VTG Y2K Toddler Overalls Vitaminkids 18months'), 'coveralls')
    assert.equal(inferGarmentFromTitle('Chicago Bulls Jordan Jersey XL'), 'tshirts')
  })

  test('a jacket in fan apparel is a jacket, not a t-shirt', () => {
    // The coarse rule calls everything under Fan Apparel a t-shirt. If that
    // beat the title, this jacket would ship at the tee rate and list in the
    // wrong category.
    const internal = toInternalCategory(
      'Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:College-NCAA',
      null,
      'Missouri Tiger Nike Full Zip Jacket Size Medium',
    )
    assert.equal(internal?.garment, 'coats-jackets')
    assert.equal(internal?.garmentSource, 'title')
  })

  test('the coarse rule still catches a title that says nothing', () => {
    const internal = toInternalCategory(
      'Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:Baseball-MLB',
      null,
      'White Sox 2005 World Series Commemorative',
    )
    assert.equal(internal?.garment, 'tshirts')
    assert.equal(internal?.garmentSource, 'coarse')
  })

  test('matches whole words only', () => {
    // Without boundaries "dress" matches "dresser" and "cap" matches "capri".
    assert.equal(inferGarmentFromTitle('Antique Dresser Drawer Pull'), null)
    assert.equal(inferGarmentFromTitle('Capri Sun Pouch 12ct'), null)
    assert.equal(inferGarmentFromTitle('Star Wars Mug'), null)
    assert.equal(inferGarmentFromTitle('1968 Cadeco All Star Baseball Game'), null)
  })

  test('a dress shirt is a shirt, not a dress', () => {
    assert.equal(inferGarmentFromTitle('Ralph Lauren Dress Shirt 16.5'), 'dress-shirts')
    assert.equal(inferGarmentFromTitle('Floral Midi Dress Size 6'), 'dresses')
  })
})

describe('inferDepartmentFromTitle', () => {
  test('reads kids sizing, which titles carry and the import did not', () => {
    assert.equal(inferDepartmentFromTitle('Vintage Walls Coveralls Boys 8'), 'boys')
    assert.equal(inferDepartmentFromTitle('VTG Y2K Toddler Overalls 18months'), 'baby')
    assert.equal(inferDepartmentFromTitle('Nike Youth Hoodie L'), 'unisex-kids')
    assert.equal(inferDepartmentFromTitle("Women's Levi's 501"), 'women')
    assert.equal(inferDepartmentFromTitle('Mens Carhartt Jacket XL'), 'men')
  })

  test('says nothing when the title says nothing', () => {
    assert.equal(inferDepartmentFromTitle('Nike Tee White Sox'), null)
    assert.equal(inferDepartmentFromTitle(null), null)
  })

  test('a known garment with no department still lands somewhere', () => {
    // Two-department trees force a side. Listing it as menswear beats not
    // listing it, and the source records that it was assumed.
    const internal = toInternalCategory(
      'Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:Baseball-MLB',
      null,
      'Nike Tee T-Shirt White Sox',
    )
    assert.equal(internal?.department, 'men')
    assert.equal(internal?.departmentSource, 'assumed')
  })

  test('a dress assumed into womenswear, not menswear', () => {
    const internal = toInternalCategory('Collectibles:Whatever', null, 'Floral Midi Dress')
    assert.equal(internal?.department, 'women')
  })
})

describe('the title fallback does not disturb existing mappings', () => {
  test('a category that already resolves is untouched by the title', () => {
    // A misleading title must not override a category that named the garment.
    const internal = toInternalCategory(
      "Clothing, Shoes & Accessories:Men:Men's Clothing:Shirts:T-Shirts",
      'Men',
      'Heavy Winter Parka Boots',
    )
    assert.equal(internal?.garment, 'tshirts')
    assert.equal(internal?.garmentSource, 'field')
    assert.equal(internal?.departmentSource, 'field')
  })

  test('without a title the old behaviour is exact', () => {
    // lib/ebay/shipping.ts resolves bands through here, and its assignment
    // has been applied to 360 live listings. Rescuing a category must not
    // silently re-band them.
    assert.equal(toInternalCategory('Collectibles:Holiday & Seasonal:Ornaments', null), null)
    assert.equal(
      toInternalCategory('Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:College-NCAA', null),
      null,
    )
  })
})

describe("Depop's fixed vocabularies", () => {
  const ERAS = [
    '1990s', '90s', '1985', '2003', 'Y2K', '2015', '1940s',
    'Vintage', 'Modern', 'Antique', null, '', 'sometime in the past',
  ]

  test('every Age it can emit is one the form offers', () => {
    for (const era of ERAS) {
      const value = mapDepopAge(era).value
      assert.ok(
        value === null || (DEPOP_AGES as readonly string[]).includes(value),
        `era "${era}" -> "${value}", which Depop does not offer`,
      )
    }
  })

  test('decades land in the right bucket', () => {
    assert.equal(mapDepopAge('1990s').value, '90s')
    assert.equal(mapDepopAge('90s').value, '90s')
    assert.equal(mapDepopAge('1985').value, '80s')
    assert.equal(mapDepopAge('2003').value, '00s')
    assert.equal(mapDepopAge('Y2K').value, '00s')
    // Depop's list stops at 50s in one direction and Modern in the other.
    assert.equal(mapDepopAge('2015').value, 'Modern')
    assert.equal(mapDepopAge('1940s').value, 'Antique')
  })

  test('"Vintage" alone warns rather than inventing a decade', () => {
    // It says second-hand, not which decade - and Age is a decade field.
    const result = mapDepopAge('Vintage')
    assert.equal(result.value, null)
    assert.ok(result.warning)
  })

  test('every Source it can emit is one the form offers', () => {
    const inputs = [
      { title: 'Reworked Levi denim jacket' },
      { title: 'Handmade knit scarf' },
      { title: 'Deadstock 90s tee', styleEra: '1995' },
      { description: 'small repaired tear on the hem', condition: 'Used' },
      { title: 'Custom painted jacket' },
      { styleEra: '1980s', condition: 'Used' },
      { condition: 'Pre-owned - Good' },
      { condition: 'New with tags' },
      {},
    ]
    for (const input of inputs) {
      const value = mapDepopSource(input).value
      assert.ok(
        value === null || (DEPOP_SOURCES as readonly string[]).includes(value),
        `${JSON.stringify(input)} -> "${value}", which Depop does not offer`,
      )
    }
  })

  test('Source prefers the most specific claim', () => {
    assert.equal(mapDepopSource({ title: 'Reworked denim' }).value, 'Reworked / Upcycled')
    assert.equal(mapDepopSource({ title: 'Handmade scarf' }).value, 'Handmade')
    assert.equal(mapDepopSource({ styleEra: '1985', condition: 'Used' }).value, 'Vintage')
    assert.equal(mapDepopSource({ condition: 'Pre-owned - Good' }).value, 'Preloved')
    // Nothing to go on is a blank field, not a guess.
    assert.equal(mapDepopSource({}).value, null)
  })

  test('the slash spacing in "Reworked / Upcycled" is preserved', () => {
    // Depop matches the exact string; tidying the spaces breaks the fill.
    assert.ok((DEPOP_SOURCES as readonly string[]).includes('Reworked / Upcycled'))
    assert.equal(mapDepopSource({ title: 'upcycled tee' }).value, 'Reworked / Upcycled')
  })

  test('every Style tag it can emit is one the form offers', () => {
    // Style used to receive the era, the brand and the garment as free text -
    // "1990s", "Nike", "tshirts" - none of which are Style values.
    const items = [
      { title: 'Nike track jacket', brand: 'Nike', styleEra: '1990s', garmentHint: 'activewear-tops' },
      { title: 'Carhartt cargo pants', brand: 'Carhartt', styleEra: '2003' },
      { title: 'Vintage flannel shirt', brand: 'Wrangler', styleEra: '1995' },
      { title: 'Plain white tee', brand: 'Hanes', styleEra: null },
      { title: 'Cowboy boots', brand: null, styleEra: '1975' },
      { title: 'Sequin party dress', brand: 'BCBG', styleEra: '2005' },
    ]
    for (const item of items) {
      for (const tag of buildStyleTags('depop', item)) {
        assert.ok(
          (DEPOP_STYLES as readonly string[]).includes(tag),
          `"${tag}" from ${item.title} is not a Depop Style value`,
        )
      }
    }
  })

  test('Style never emits the brand, era or garment', () => {
    const tags = buildStyleTags('depop', {
      title: 'Nike track jacket',
      brand: 'Nike',
      styleEra: '1990s',
      garmentHint: 'activewear-tops',
    })
    assert.ok(!tags.includes('Nike'))
    assert.ok(!tags.includes('1990s'))
    assert.ok(!tags.includes('activewear-tops'))
    assert.ok(tags.includes('Sportswear'))
    assert.ok(tags.length <= 2, 'Depop takes at most 2 style tags')
  })

  test('Style is left empty rather than guessed', () => {
    // A wrong tag puts the item in front of the wrong buyers; a missing one
    // costs nothing, and the field is optional.
    assert.deepEqual(
      buildStyleTags('depop', { title: 'Plain white tee', brand: 'Hanes' }),
      [],
    )
  })

  test('Poshmark keeps free-text style tags', () => {
    // Only Depop's Style is a fixed list; changing it must not change theirs.
    const tags = buildStyleTags('poshmark', {
      styleEra: '1990s',
      brand: 'Nike',
      garmentHint: 'tshirts',
    })
    assert.deepEqual(tags, ['1990s', 'Nike', 'tshirts'])
  })

  test('every colour it can emit is on the right palette', () => {
    const raws = [
      'Navy', 'Burgundy', 'Khaki', 'Tan', 'Beige', 'Grey', 'Gray', 'Cream',
      'Olive', 'Teal', 'Maroon', 'Camel', 'Lavender', 'Blue/White', 'Rainbow',
    ]
    const palettes = {
      depop: DEPOP_COLORS,
      poshmark: POSHMARK_COLORS,
      mercari: MERCARI_COLORS,
    } as const
    for (const [platform, palette] of Object.entries(palettes)) {
      for (const raw of raws) {
        for (const value of mapColors(platform as CrosslistPlatform, raw).values) {
          assert.ok(
            palette.includes(value),
            `${platform}: "${raw}" -> "${value}", not on its palette`,
          )
        }
      }
    }
  })

  test('a colour survives wherever the platform offers it', () => {
    // Navy, Burgundy and Khaki were collapsing before they reached the
    // palette, so Depop lost detail it accepts - and khaki was dropped
    // entirely, reducing to a Tan that was missing from the table too.
    assert.deepEqual(mapColors('depop', 'Navy').values, ['Navy'])
    assert.deepEqual(mapColors('depop', 'Burgundy').values, ['Burgundy'])
    assert.deepEqual(mapColors('depop', 'Khaki').values, ['Khaki'])
    assert.deepEqual(mapColors('depop', 'Tan').values, ['Tan'])
  })

  test('and still reduces where the platform does not', () => {
    assert.deepEqual(mapColors('poshmark', 'Navy').values, ['Blue'])
    assert.deepEqual(mapColors('mercari', 'Navy').values, ['Blue'])
    assert.deepEqual(mapColors('poshmark', 'Burgundy').values, ['Red'])
    // Khaki reaches Beige on Mercari transitively, via Tan.
    assert.deepEqual(mapColors('mercari', 'Khaki').values, ['Beige'])
    assert.deepEqual(mapColors('poshmark', 'Khaki').values, ['Tan'])
  })
})

// ------------------------------------------------------------ description

describe('compileDescription', () => {
  const input = {
    description: 'Classic trucker jacket.',
    material: 'Cotton denim',
    measurements: { chest: '22in', length: '26in' },
    flawNotes: 'Small paint fleck on left cuff.',
  }

  test('appends the detail eBay carries structurally', () => {
    const result = compileDescription('depop', input)
    assert.match(result.text, /Classic trucker jacket/)
    assert.match(result.text, /Material: Cotton denim/)
    assert.match(result.text, /chest: 22in/)
    assert.match(result.text, /Small paint fleck/)
  })

  test('Poshmark keeps the description as authored', () => {
    // It has its own structured fields; appending would duplicate them.
    const result = compileDescription('poshmark', input)
    assert.equal(result.text, 'Classic trucker jacket.')
  })

  test('respects Mercari’s 1000-character limit', () => {
    const result = compileDescription('mercari', {
      ...input,
      description: 'x'.repeat(900),
    })
    assert.ok(result.text.length <= 1000, `got ${result.text.length}`)
  })

  test('truncates appended detail first, never the core description', () => {
    const core = 'y'.repeat(980)
    const result = compileDescription('mercari', { ...input, description: core })
    assert.ok(result.text.startsWith(core), 'the seller’s own words survive intact')
    assert.ok(result.truncated)
    assert.ok(result.dropped.length > 0)
  })

  test('drops material before condition notes', () => {
    // An undisclosed flaw is a dispute; the fabric is not.
    const core = 'z'.repeat(940)
    const result = compileDescription('mercari', { ...input, description: core })
    assert.ok(result.dropped.includes('Material'))
    assert.ok(
      !result.dropped.includes('Condition notes') || result.dropped.length === 3,
      'condition notes must be the last thing dropped',
    )
  })

  test('trims the core only when it alone exceeds the limit', () => {
    const result = compileDescription('mercari', {
      description: 'w'.repeat(1200),
      material: 'Cotton',
    })
    assert.equal(result.text.length, 1000)
    assert.ok(result.truncated)
  })

  test('an item with no extra detail is left alone', () => {
    const result = compileDescription('depop', { description: 'Just this.' })
    assert.equal(result.text, 'Just this.')
    assert.equal(result.truncated, false)
    assert.deepEqual(result.dropped, [])
  })
})

// ------------------------------------------------------- Mercari shipping

describe('shipping estimates', () => {
  test('uses the specified weights', () => {
    assert.equal(estimateWeightOz('tshirts'), 8)
    assert.equal(estimateWeightOz('jeans'), 20) // 1 lb 4 oz
    assert.equal(estimateWeightOz('athletic-shoes'), 40) // 2 lb 8 oz
  })

  test('falls back for an unknown garment', () => {
    assert.equal(estimateWeightOz(null), 16)
  })

  test('a coat is not shipped at the t-shirt weight', () => {
    // Under-declaring costs money on every shipment.
    assert.ok(estimateWeightOz('coats-jackets') > estimateWeightOz('tshirts'))
  })

  test('package size follows weight', () => {
    assert.equal(estimatePackageSize(8), 'Small')
    assert.equal(estimatePackageSize(20), 'Medium')
    assert.equal(estimatePackageSize(40), 'Large')
  })

  test('formats pounds and ounces', () => {
    assert.equal(formatWeight(8), '8 oz')
    assert.equal(formatWeight(20), '1 lb 4 oz')
    assert.equal(formatWeight(40), '2 lb 8 oz')
    assert.equal(formatWeight(32), '2 lb')
  })
})

// -------------------------------------------------------------- validation

describe('mapListing validation', () => {
  for (const platform of CROSSLIST_PLATFORMS) {
    test(`${platform} accepts a complete item`, () => {
      const result = mapListing(platform, ITEM)
      assert.equal(result.ok, true, describeErrors(result))
      assert.equal(result.errors.length, 0)
    })
  }

  test('blocks with every missing field named at once', () => {
    // One pass should tell you everything to fix, not the first problem.
    const result = mapListing('mercari', item({
      title: null,
      price: null,
      photoCount: 0,
      size: null,
      color: null,
      condition: null,
    }))
    assert.equal(result.ok, false)
    const fields = result.errors.map((e) => e.field).sort()
    assert.deepEqual(fields, ['color', 'condition', 'photos', 'price', 'size', 'title'])
  })

  test('an unmappable category blocks the listing', () => {
    // The title has to name no garment either, or the fallback rescues it -
    // which is the point of the fallback. A mug is genuinely not apparel.
    const result = mapListing('poshmark', item({
      title: 'Star Wars Mug',
      category: 'Collectibles:Holiday & Seasonal:Ornaments',
      subcategory: null,
    }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.field === 'category'))
  })

  test('a garment named only in the title is still listed', () => {
    // 102 active items sit under categories that describe the subject rather
    // than the garment - "Sports Mem, Cards & Fan Shop" and the like. Left
    // alone every one of them is unlistable, though most are ordinary
    // apparel.
    const result = mapListing('poshmark', item({
      title: 'Nike Tee T-Shirt White Sox Frank Thomas HOF Size L',
      category: 'Sports Mem, Cards & Fan Shop:Fan Apparel & Souvenirs:Baseball-MLB',
      subcategory: null,
    }))
    assert.ok(result.listing.category, 'expected the title to rescue it')
    assert.deepEqual(result.listing.category!.path, ['Men', 'Shirts', 'Tees - Short Sleeve'])
    // Flagged as inferred, so a listing filed oddly is traceable.
    assert.equal(result.listing.category!.source, 'department-fallback')
  })

  test('accessories do not require a size', () => {
    const result = mapListing('poshmark', item({
      category: "Clothing, Shoes & Accessories:Men:Men's Accessories:Hats",
      size: null,
    }))
    assert.ok(!result.errors.some((e) => e.field === 'size'))
  })

  test('Mercari requires a colour where the others only warn', () => {
    const noColor = item({ color: null })
    assert.equal(mapListing('mercari', noColor).ok, false)
    assert.equal(mapListing('depop', noColor).ok, true)
    assert.ok(
      mapListing('depop', noColor).warnings.some((w) => w.field === 'color'),
    )
  })

  test('Poshmark derives an original price at or above the list price', () => {
    const result = mapListing('poshmark', ITEM)
    assert.ok(result.listing.originalPrice! >= ITEM.price!)
    assert.equal(result.listing.originalPrice, Math.round(78 * 1.8))
  })

  test('an explicit original price below list is not trusted', () => {
    // Poshmark rejects an original below the listing price.
    assert.ok(deriveOriginalPrice(78, 40)! >= 78)
    assert.equal(deriveOriginalPrice(78, 200), 200)
  })

  test('title is truncated per platform, and warned about', () => {
    const long = item({ title: 'A'.repeat(120) })
    for (const platform of CROSSLIST_PLATFORMS) {
      const result = mapListing(platform, long)
      assert.equal(result.listing.title.length, TITLE_LIMIT[platform])
      assert.ok(result.warnings.some((w) => w.field === 'title'))
    }
    // Mercari is much tighter than the others.
    assert.equal(TITLE_LIMIT.mercari, 40)
  })

  test('warnings never block a listing', () => {
    const result = mapListing('depop', item({ color: 'Chartreuse' }))
    assert.equal(result.ok, true)
    assert.ok(result.warnings.length > 0)
  })

  test('Mercari always carries a shipping weight', () => {
    const result = mapListing('mercari', ITEM)
    assert.equal(typeof result.listing.shippingWeightOz, 'number')
    assert.ok(result.listing.packageSize)
  })

  test('style tags respect each platform’s cap', () => {
    assert.ok(mapListing('poshmark', ITEM).listing.styleTags.length <= 3)
    assert.ok(mapListing('depop', ITEM).listing.styleTags.length <= 2)
    assert.equal(mapListing('mercari', ITEM).listing.styleTags.length, 0)
  })

  test('describeErrors reads as an instruction', () => {
    const result = mapListing('mercari', item({ price: null }))
    const message = describeErrors(result)
    assert.match(message, /Cannot list on mercari/)
    assert.match(message, /price/)
  })
})

// ------------------------------------------ verified against the real tree

describe('Poshmark paths match the scraped tree', () => {
  test('Kids is flat - no Boys/Girls/Baby departments', () => {
    // The real tree has one "Kids" department with garment categories under
    // it. Modelling boys/girls/baby as departments produced 20 wrong paths.
    for (const dept of ['Boys', 'Girls', 'Unisex Kids', 'Unisex Baby & Toddler']) {
      const path = mapCategory(
        'poshmark',
        "Clothing, Shoes & Accessories:Kids:Boys:Boys' Clothing (Sizes 4 & Up):Tops, Shirts & T-Shirts",
        dept,
      )
      if (path) assert.equal(path.path[0], 'Kids', `${dept} should land in Kids`)
    }
  })

  test('womenswear activewear is under Tops, not Athletic Apparel', () => {
    // "Athletic Apparel" does not exist in the real Women department.
    const path = mapCategory(
      'poshmark',
      "Clothing, Shoes & Accessories:Women:Women's Clothing:Activewear:Activewear Tops",
      'Women',
    )
    assert.ok(path)
    assert.equal(path!.path[1], 'Tops')
  })

  test('mens hoodies live under Shirts, where Poshmark puts them', () => {
    const path = mapCategory(
      'poshmark',
      "Clothing, Shoes & Accessories:Men:Men's Clothing:Activewear:Hoodies & Sweatshirts",
      'Men',
    )
    assert.deepEqual(path!.path, ['Men', 'Shirts', 'Sweatshirts & Hoodies'])
  })

  test('a coarse garment key uses "None" rather than guessing a subcategory', () => {
    // Our key cannot tell a denim jacket from a puffer, and filing it as the
    // wrong one is worse than filing it as none. Poshmark offers "None".
    const path = mapCategory(
      'poshmark',
      "Clothing, Shoes & Accessories:Men:Men's Clothing:Coats, Jackets & Vests",
      'Men',
    )
    assert.deepEqual(path!.path, ['Men', 'Jackets & Coats', 'None'])
  })
})
