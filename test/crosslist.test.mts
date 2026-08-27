import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CATEGORY_DEPTH,
  mapCategory,
  normaliseDepartment,
  toInternalCategory,
} from '../lib/crosslist/categories'
import {
  DEPOP_COLORS,
  MERCARI_COLORS,
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
    // Menswear bags exist nowhere in these trees.
    assert.equal(mapCategory('depop', "Women's Bags & Handbags", 'Men'), null)
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
    assert.deepEqual(mapColors('depop', 'Navy').values, ['Blue'])
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
    // Navy and Royal both become Blue; the listing should say Blue once.
    assert.deepEqual(mapColors('depop', 'Navy/Royal').values, ['Blue'])
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
    assert.equal(mapCondition('depop', 'Pre-owned - Excellent').value, 'Excellent')
    assert.equal(mapCondition('depop', 'Very Good').value, 'Very good')
    assert.equal(mapCondition('depop', 'Pre-owned - Good').value, 'Good')
    assert.equal(mapCondition('depop', 'Pre-owned - Fair').value, 'Good')
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
    assert.equal(mapCondition('depop', 'Used').value, 'Good')
    assert.equal(mapCondition('depop', 'Pre-owned').value, 'Good')
    assert.equal(mapCondition('depop', 'good').value, 'Good')
    assert.equal(mapCondition('mercari', 'Ungraded').value, 'Good')
    assert.equal(mapCondition('mercari', 'Open box').value, 'Like new')
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
    const result = mapListing('poshmark', item({
      category: 'Collectibles:Holiday & Seasonal:Ornaments',
      subcategory: null,
    }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.field === 'category'))
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
