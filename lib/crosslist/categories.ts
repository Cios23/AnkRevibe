import type { CrosslistPlatform, PlatformCategory } from '@/lib/crosslist/types'

/**
 * Category mapping, in two steps.
 *
 *   1. eBay's category path  ->  an internal key ("mens/tshirts")
 *   2. internal key          ->  each platform's own tiered category
 *
 * The indirection matters. Our categories are eBay leaf paths inherited from
 * the import, and there are 80+ distinct ones across 408 items. Mapping each
 * of those to three platforms directly would be 240 entries, most for
 * categories holding a single item. The internal key collapses them to the
 * ~25 garment types that actually recur.
 *
 * Built from the real inventory, not guessed: the keys below cover the
 * apparel categories present in the catalogue, which is 276 of 408 items.
 * Everything else (collectibles, electronics, toys) has no clothing category
 * on these platforms and is reported as unmappable rather than forced.
 */

/** Internal garment types. Deliberately coarse - these are what the three platforms agree exist. */
export type GarmentKey =
  | 'tshirts'
  | 'casual-shirts'
  | 'dress-shirts'
  | 'polos'
  | 'sweaters'
  | 'hoodies'
  | 'coats-jackets'
  | 'jeans'
  | 'pants'
  | 'shorts'
  | 'skirts'
  | 'dresses'
  | 'activewear-tops'
  | 'activewear-pants'
  | 'swimwear'
  | 'sleepwear'
  | 'suits'
  | 'athletic-shoes'
  | 'casual-shoes'
  | 'hats'
  | 'bags'
  | 'coveralls'
  | 'onepiece'

export type Department = 'men' | 'women' | 'boys' | 'girls' | 'unisex-kids' | 'baby'

export type InternalCategory = {
  department: Department
  garment: GarmentKey
  /**
   * Where each half came from. 'field' is the item's own data, 'title' was
   * read out of the title, 'coarse' is a whole-category guess, and 'assumed'
   * means a two-department tree forced a side. Only ever anything other than
   * 'field' when a title is supplied.
   */
  garmentSource?: 'field' | 'title' | 'coarse'
  departmentSource?: 'field' | 'title' | 'assumed'
}

/**
 * Department, from the `subcategory` column as the import left it.
 *
 * Real values seen: Men, Women, Boys, Girls, Unisex Adults, Unisex Adult,
 * Unisex Kids, Unisex Baby & Toddler, Unisex Children, Boys & Girls, Teens,
 * Adult, "Does not apply".
 */
export function normaliseDepartment(
  subcategory: string | null | undefined,
  categoryPath: string | null | undefined,
): Department | null {
  const raw = (subcategory ?? '').toLowerCase().trim()
  const path = (categoryPath ?? '').toLowerCase()

  if (raw.includes('baby') || raw.includes('toddler') || path.includes(':baby:')) {
    return 'baby'
  }
  if (raw === 'boys' || path.includes(':boys')) return 'boys'
  if (raw === 'girls' || path.includes(':girls')) return 'girls'
  if (raw.includes('kids') || raw.includes('children') || raw === 'teens') {
    return 'unisex-kids'
  }
  if (raw.includes('boys & girls')) return 'unisex-kids'
  if (raw.startsWith('men') || path.includes(":men's") || path.includes(':men:')) {
    return 'men'
  }
  if (raw.startsWith('women') || path.includes(":women's") || path.includes(':women:')) {
    return 'women'
  }
  // "Unisex Adults" / "Adult" carry no gender; these platforms have no
  // unisex adult department, so treat as menswear, which is where unisex
  // apparel conventionally sits on all three.
  if (raw.includes('unisex') || raw === 'adult') return 'men'
  return null
}

/**
 * eBay leaf path -> garment type.
 *
 * Ordered most specific first: "Activewear:Hoodies & Sweatshirts" must beat
 * the generic "Hoodies" rule, and "Shirts:T-Shirts" must beat "Shirts".
 */
const GARMENT_RULES: Array<{ match: RegExp; garment: GarmentKey }> = [
  { match: /activewear:hoodies|sweatshirts & hoodies|hoodies & sweatshirts/i, garment: 'hoodies' },
  { match: /activewear:activewear (pants|leggings)/i, garment: 'activewear-pants' },
  { match: /activewear:activewear (tops|shirts)/i, garment: 'activewear-tops' },
  { match: /activewear:activewear shorts/i, garment: 'shorts' },
  { match: /activewear:activewear jackets/i, garment: 'coats-jackets' },
  { match: /shirts:t-shirts|tops & t-shirts|tops, shirts & t-shirts|:t-shirts/i, garment: 'tshirts' },
  { match: /casual button-down|casual shirts/i, garment: 'casual-shirts' },
  { match: /dress shirts/i, garment: 'dress-shirts' },
  { match: /polos/i, garment: 'polos' },
  { match: /sweaters/i, garment: 'sweaters' },
  { match: /coats, jackets|outerwear|coats, jackets, outerwear/i, garment: 'coats-jackets' },
  { match: /jeans/i, garment: 'jeans' },
  { match: /baseball pants|pants & bibs|:pants$|golf.*:pants/i, garment: 'pants' },
  { match: /:shorts$/i, garment: 'shorts' },
  { match: /skirts/i, garment: 'skirts' },
  { match: /dresses/i, garment: 'dresses' },
  { match: /swimwear/i, garment: 'swimwear' },
  { match: /sleepwear|intimates & sleep/i, garment: 'sleepwear' },
  { match: /suits & suit separates/i, garment: 'suits' },
  { match: /athletic shoes|shoes:youth/i, garment: 'athletic-shoes' },
  { match: /casual shoes|comfort shoes|(boys|girls|unisex kids)' shoes/i, garment: 'casual-shoes' },
  { match: /hats/i, garment: 'hats' },
  { match: /bags & handbags|equipment bags/i, garment: 'bags' },
  { match: /coveralls|jumpsuits & rompers/i, garment: 'coveralls' },
  { match: /one-pieces|outfits & sets/i, garment: 'onepiece' },
  { match: /shirts & tops|:tops$/i, garment: 'casual-shirts' },
]

/**
 * Last-resort rules for categories that name no garment at all.
 *
 * Tried only AFTER the title, because these are guesses about a whole
 * department rather than readings of a leaf. "Fan Apparel & Souvenirs" holds
 * tees, jerseys, hoodies and jackets alike, so calling everything in it a
 * t-shirt is right more often than not and wrong often enough that a title
 * saying "Full Zip Jacket" must win.
 */
const COARSE_GARMENT_RULES: Array<{ match: RegExp; garment: GarmentKey }> = [
  { match: /fan apparel & souvenirs/i, garment: 'tshirts' },
]

/**
 * Garment from the title, when the eBay category names none.
 *
 * 102 of 402 active items sit under categories like "Sports Mem, Cards & Fan
 * Shop" or "Collectibles" that describe the SUBJECT rather than the garment.
 * The same technique already rescues shipping bands for that population; the
 * titles are the only place the garment appears.
 *
 * Ordered most specific first, and every rule is anchored on word boundaries:
 * without them "dress" matches "dresser" and "cap" matches "capri", which is
 * how a coffee table ends up filed as a dress.
 */
const TITLE_GARMENTS: Array<{ match: RegExp; garment: GarmentKey }> = [
  { match: /\bcoveralls?\b|\boveralls?\b|\bsnowsuit\b|\bjumpsuit\b|\bdungarees\b/i, garment: 'coveralls' },
  { match: /\bromper\b|\bonesie\b|\bbodysuit\b|\bone.?piece\b/i, garment: 'onepiece' },
  { match: /\bblazer\b|\bsport coat\b|\bsuit jacket\b/i, garment: 'suits' },
  { match: /\bhoodie\b|\bhooded\b|\bsweatshirt\b|\bcrewneck\b|\bpullover\b|\bfleece\b/i, garment: 'hoodies' },
  { match: /\bcardigan\b|\bsweater\b|\bknit\b/i, garment: 'sweaters' },
  { match: /\bjacket\b|\bcoat\b|\bparka\b|\bpuffer\b|\bwindbreaker\b|\banorak\b|\bvest\b/i, garment: 'coats-jackets' },
  { match: /\bjeans\b|\bdenim pants\b/i, garment: 'jeans' },
  { match: /\bpants\b|\btrousers\b|\bjoggers\b|\bsweatpants\b|\bchinos\b|\bslacks\b|\bleggings\b/i, garment: 'pants' },
  { match: /\bshorts\b/i, garment: 'shorts' },
  { match: /\bskirt\b/i, garment: 'skirts' },
  { match: /\bswimsuit\b|\bbikini\b|\btrunks\b|\bswim\b/i, garment: 'swimwear' },
  { match: /\bpajamas?\b|\bpyjamas?\b|\bsleepwear\b|\bnightgown\b|\brobe\b/i, garment: 'sleepwear' },
  // Before the generic dress rule, so "dress shirt" is a shirt.
  { match: /\bdress shirt\b|\boxford\b/i, garment: 'dress-shirts' },
  { match: /\bdress\b|\bgown\b/i, garment: 'dresses' },
  { match: /\bpolo\b/i, garment: 'polos' },
  { match: /\bbutton.?down\b|\bbutton.?up\b|\bflannel\b/i, garment: 'casual-shirts' },
  // A sports jersey is a shirt, and fan apparel is full of them.
  { match: /\btee\b|\btees\b|\bt.?shirts?\b|\bjersey\b|\btank top\b/i, garment: 'tshirts' },
  { match: /\bsneakers?\b|\btrainers?\b|\bcleats?\b/i, garment: 'athletic-shoes' },
  { match: /\bboots?\b|\bloafers?\b|\bsandals?\b|\bshoes?\b/i, garment: 'casual-shoes' },
  { match: /\bbeanie\b|\bsnapback\b|\bball cap\b|\bhat\b|\bcap\b/i, garment: 'hats' },
  { match: /\bbackpack\b|\bcrossbody\b|\bhandbag\b|\btote\b|\bpurse\b|\bbag\b/i, garment: 'bags' },
  // Deliberately last: "shirt" alone says less than every rule above it.
  { match: /\bshirt\b/i, garment: 'casual-shirts' },
]

export function inferGarmentFromTitle(
  title: string | null | undefined,
): GarmentKey | null {
  if (!title) return null
  for (const rule of TITLE_GARMENTS) {
    if (rule.match.test(title)) return rule.garment
  }
  return null
}

/**
 * Department from the title, when the item's own field does not say.
 *
 * Kids sizing is the strongest signal in this catalogue - "Boys 8",
 * "18months", "Youth L" - and it appears in titles far more reliably than in
 * the subcategory column the import populated.
 */
export function inferDepartmentFromTitle(
  title: string | null | undefined,
): Department | null {
  if (!title) return null
  const text = title.toLowerCase()

  if (/\bbaby\b|\binfant\b|\btoddler\b|\bnewborn\b|\b\d+\s*months?\b|\b\d+mo\b/.test(text)) {
    return 'baby'
  }
  if (/\bboys?\b/.test(text)) return 'boys'
  if (/\bgirls?\b/.test(text)) return 'girls'
  if (/\byouth\b|\bkids?\b|\bjuniors?\b|\bchildren'?s?\b/.test(text)) return 'unisex-kids'
  if (/\bwomens?\b|\bwomen's\b|\bladies\b|\bwmns\b/.test(text)) return 'women'
  if (/\bmens?\b|\bmen's\b/.test(text)) return 'men'
  return null
}

/**
 * The department a garment implies when nothing else says.
 *
 * Only consulted once a garment is known, so this is not a guess about what
 * the item IS - only about which side of a two-department tree it belongs
 * on. Dresses and skirts sit in womenswear; everything else follows the
 * existing convention that unisex adult apparel is listed as menswear.
 */
function departmentForGarment(garment: GarmentKey): Department {
  if (garment === 'dresses' || garment === 'skirts') return 'women'
  return 'men'
}

/**
 * Resolve an eBay category to our own department + garment.
 *
 * `title` is optional and changes the outcome only where the category alone
 * fails. Callers that pass nothing get exactly the behaviour they had before
 * it existed - which matters, because lib/ebay/shipping.ts resolves bands
 * through here and its assignment has already been applied to 360 live
 * listings. Rescuing a category must not silently re-band them.
 *
 * With a title, the order is: the leaf's own garment, then the title, then a
 * whole-category guess. The title beats the coarse rule deliberately - a
 * "Full Zip Jacket" under Fan Apparel is a jacket, and calling it a t-shirt
 * because of where eBay filed it would under-declare its shipping too.
 */
export function toInternalCategory(
  categoryPath: string | null | undefined,
  subcategory: string | null | undefined,
  title?: string | null,
): InternalCategory | null {
  const path = categoryPath ?? ''

  let garment: GarmentKey | null = null
  let garmentSource: InternalCategory['garmentSource'] = 'field'
  for (const rule of GARMENT_RULES) {
    if (rule.match.test(path)) {
      garment = rule.garment
      break
    }
  }

  if (!garment && title) {
    const fromTitle = inferGarmentFromTitle(title)
    if (fromTitle) {
      garment = fromTitle
      garmentSource = 'title'
    }
  }

  if (!garment) {
    for (const rule of COARSE_GARMENT_RULES) {
      if (rule.match.test(path)) {
        garment = rule.garment
        garmentSource = 'coarse'
        break
      }
    }
  }

  if (!garment) return null

  let department = normaliseDepartment(subcategory, categoryPath)
  let departmentSource: InternalCategory['departmentSource'] = 'field'

  if (!department && title) {
    const fromTitle = inferDepartmentFromTitle(title)
    if (fromTitle) {
      department = fromTitle
      departmentSource = 'title'
    }
  }

  // Without a title this stays null and the item is unmapped, exactly as
  // before. With one, a known garment is worth listing on the likelier side
  // of the tree rather than not at all.
  if (!department) {
    if (!title) return null
    department = departmentForGarment(garment)
    departmentSource = 'assumed'
  }

  return { department, garment, garmentSource, departmentSource }
}

// ---------------------------------------------------------------- platforms

type Tree = Partial<Record<GarmentKey, Partial<Record<Department, string[]>>>>

/**
 * Poshmark: Department > Category > Subcategory.
 *
 * VERIFIED against the live tree scraped from create-listing on 2026-08-27
 * (6 departments, 87 categories, 712 subcategories). Every path below exists
 * in that tree; `npm run poshmark:verify` re-checks them.
 *
 * Two things the real tree corrected in the previous hand-written table:
 *
 *   - Kids is FLAT. There is no Boys/Girls/Baby split; the department is
 *     "Kids" and the garment type is the category. Modelling those as
 *     separate departments accounted for 20 of its 25 wrong paths.
 *   - Women has no "Athletic Apparel" category. Activewear sits under the
 *     ordinary Tops / Pants & Jumpsuits.
 *
 * "None" is a real option Poshmark offers in 79 of 87 categories, used here
 * where our garment key is too coarse to choose honestly - a denim jacket
 * filed under "Puffers" is worse than one filed under none. Subcategory is
 * optional on Poshmark, so this is a supported choice rather than a gap.
 */
const POSHMARK: Tree = {
  tshirts: {
    men: ['Men', 'Shirts', 'Tees - Short Sleeve'],
    women: ['Women', 'Tops', 'Tees - Short Sleeve'],
    boys: ['Kids', 'Shirts & Tops', 'Tees - Short Sleeve'],
    girls: ['Kids', 'Shirts & Tops', 'Tees - Short Sleeve'],
    'unisex-kids': ['Kids', 'Shirts & Tops', 'Tees - Short Sleeve'],
    baby: ['Kids', 'One Pieces', 'Bodysuits'],
  },
  'casual-shirts': {
    men: ['Men', 'Shirts', 'Casual Button Down Shirts'],
    women: ['Women', 'Tops', 'Button Down Shirts'],
    boys: ['Kids', 'Shirts & Tops', 'Button Down Shirts'],
    girls: ['Kids', 'Shirts & Tops', 'Button Down Shirts'],
    'unisex-kids': ['Kids', 'Shirts & Tops', 'Button Down Shirts'],
  },
  'dress-shirts': {
    men: ['Men', 'Shirts', 'Dress Shirts'],
    women: ['Women', 'Tops', 'Blouses'],
  },
  polos: {
    men: ['Men', 'Shirts', 'Polos'],
    women: ['Women', 'Tops', 'Tees - Short Sleeve'],
    boys: ['Kids', 'Shirts & Tops', 'Polos'],
    'unisex-kids': ['Kids', 'Shirts & Tops', 'Polos'],
  },
  sweaters: {
    men: ['Men', 'Sweaters', 'Crewneck'],
    women: ['Women', 'Sweaters', 'Crew & Scoop Necks'],
    boys: ['Kids', 'Shirts & Tops', 'Sweaters'],
    girls: ['Kids', 'Shirts & Tops', 'Sweaters'],
    'unisex-kids': ['Kids', 'Shirts & Tops', 'Sweaters'],
    baby: ['Kids', 'Shirts & Tops', 'Sweaters'],
  },
  hoodies: {
    men: ['Men', 'Shirts', 'Sweatshirts & Hoodies'],
    women: ['Women', 'Tops', 'Sweatshirts & Hoodies'],
    boys: ['Kids', 'Shirts & Tops', 'Sweatshirts & Hoodies'],
    girls: ['Kids', 'Shirts & Tops', 'Sweatshirts & Hoodies'],
    'unisex-kids': ['Kids', 'Shirts & Tops', 'Sweatshirts & Hoodies'],
  },
  'coats-jackets': {
    // Generic on purpose: the category spans puffers, pea coats, jean
    // jackets, trench coats and more, and our key cannot tell them apart.
    men: ['Men', 'Jackets & Coats', 'None'],
    women: ['Women', 'Jackets & Coats', 'None'],
    boys: ['Kids', 'Jackets & Coats', 'None'],
    girls: ['Kids', 'Jackets & Coats', 'None'],
    'unisex-kids': ['Kids', 'Jackets & Coats', 'None'],
  },
  jeans: {
    men: ['Men', 'Jeans', 'Straight'],
    women: ['Women', 'Jeans', 'Straight Leg'],
    boys: ['Kids', 'Bottoms', 'Jeans'],
    girls: ['Kids', 'Bottoms', 'Jeans'],
    'unisex-kids': ['Kids', 'Bottoms', 'Jeans'],
  },
  pants: {
    men: ['Men', 'Pants', 'Chinos & Khakis'],
    women: ['Women', 'Pants & Jumpsuits', 'Trousers'],
    boys: ['Kids', 'Bottoms', 'Casual'],
    girls: ['Kids', 'Bottoms', 'Casual'],
    'unisex-kids': ['Kids', 'Bottoms', 'Casual'],
  },
  shorts: {
    men: ['Men', 'Shorts', 'Athletic'],
    women: ['Women', 'Shorts', 'Athletic Shorts'],
    boys: ['Kids', 'Bottoms', 'Shorts'],
    girls: ['Kids', 'Bottoms', 'Shorts'],
    'unisex-kids': ['Kids', 'Bottoms', 'Shorts'],
  },
  skirts: {
    women: ['Women', 'Skirts', 'Midi'],
    girls: ['Kids', 'Bottoms', 'Skirts'],
  },
  dresses: {
    women: ['Women', 'Dresses', 'Midi'],
    girls: ['Kids', 'Dresses', 'Casual'],
  },
  'activewear-tops': {
    men: ['Men', 'Shirts', 'Tees - Short Sleeve'],
    women: ['Women', 'Tops', 'Tees - Short Sleeve'],
  },
  'activewear-pants': {
    men: ['Men', 'Pants', 'Sweatpants & Joggers'],
    women: ['Women', 'Pants & Jumpsuits', 'Track Pants & Joggers'],
    boys: ['Kids', 'Bottoms', 'Sweatpants & Joggers'],
    'unisex-kids': ['Kids', 'Bottoms', 'Sweatpants & Joggers'],
  },
  swimwear: {
    men: ['Men', 'Swim', 'Swim Trunks'],
    women: ['Women', 'Swim', 'One Pieces'],
    boys: ['Kids', 'Swim', 'Swim Trunks'],
    girls: ['Kids', 'Swim', 'One Piece'],
    'unisex-kids': ['Kids', 'Swim', 'None'],
  },
  sleepwear: {
    women: ['Women', 'Intimates & Sleepwear', 'Pajamas'],
    boys: ['Kids', 'Pajamas', 'Pajama Sets'],
    girls: ['Kids', 'Pajamas', 'Pajama Sets'],
    'unisex-kids': ['Kids', 'Pajamas', 'Pajama Sets'],
    baby: ['Kids', 'Pajamas', 'Sleep Sacks'],
  },
  suits: {
    men: ['Men', 'Suits & Blazers', 'Suits'],
  },
  'athletic-shoes': {
    men: ['Men', 'Shoes', 'Athletic Shoes'],
    women: ['Women', 'Shoes', 'Athletic Shoes'],
    boys: ['Kids', 'Shoes', 'Sneakers'],
    girls: ['Kids', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Kids', 'Shoes', 'Sneakers'],
  },
  'casual-shoes': {
    men: ['Men', 'Shoes', 'Sneakers'],
    women: ['Women', 'Shoes', 'Sneakers'],
    boys: ['Kids', 'Shoes', 'Sneakers'],
    girls: ['Kids', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Kids', 'Shoes', 'Sneakers'],
    baby: ['Kids', 'Shoes', 'Baby & Walker'],
  },
  hats: {
    men: ['Men', 'Accessories', 'Hats'],
    women: ['Women', 'Accessories', 'Hats'],
    boys: ['Kids', 'Accessories', 'Hats'],
    girls: ['Kids', 'Accessories', 'Hats'],
    'unisex-kids': ['Kids', 'Accessories', 'Hats'],
  },
  bags: {
    women: ['Women', 'Bags', 'Totes'],
    men: ['Men', 'Bags', 'Backpacks'],
  },
  coveralls: {
    men: ['Men', 'Pants', 'Cargo'],
    women: ['Women', 'Pants & Jumpsuits', 'Jumpsuits & Rompers'],
    boys: ['Kids', 'Bottoms', 'Overalls'],
    'unisex-kids': ['Kids', 'Bottoms', 'Overalls'],
  },
  onepiece: {
    baby: ['Kids', 'One Pieces', 'Bodysuits'],
    boys: ['Kids', 'Matching Sets', 'None'],
    girls: ['Kids', 'Matching Sets', 'None'],
    'unisex-kids': ['Kids', 'Matching Sets', 'None'],
  },
}

/**
 * Depop: Category > Subcategory > Type.
 *
 * The LEAF of every path below exists in lib/crosslist/data/depop-tree.json,
 * captured from the live create page on 2026-08-28; `npm run depop:verify`
 * re-checks them. The two tiers above the leaf are NOT verified - the branch
 * walk failed during capture, so there is no record of them and inventing one
 * would be worse than admitting the gap.
 *
 * The table was originally hand-written in British English - Trainers,
 * Trousers, Joggers, Jumpers - for a form that says Sneakers, Pants,
 * Sweatpants and Sweaters. Sixteen of thirty paths in use named a row the
 * picker does not contain, so they could not be selected at all. Take the
 * names from the capture, not from what Depop sounds like it should say.
 */
const DEPOP: Tree = {
  tshirts: {
    men: ['Menswear', 'Tops', 'T-shirts'],
    women: ['Womenswear', 'Tops', 'T-shirts'],
    boys: ['Menswear', 'Tops', 'T-shirts'],
    girls: ['Womenswear', 'Tops', 'T-shirts'],
    'unisex-kids': ['Menswear', 'Tops', 'T-shirts'],
  },
  'casual-shirts': {
    men: ['Menswear', 'Tops', 'Shirts'],
    women: ['Womenswear', 'Tops', 'Shirts'],
  },
  'dress-shirts': {
    men: ['Menswear', 'Tops', 'Shirts'],
    // Depop lists Shirts and Blouses separately; a woman's dress shirt is the
    // blouse row.
    women: ['Womenswear', 'Tops', 'Blouses'],
  },
  polos: { men: ['Menswear', 'Tops', 'Polo shirts'], women: ['Womenswear', 'Tops', 'Polo shirts'] },
  sweaters: {
    men: ['Menswear', 'Tops', 'Sweaters'],
    women: ['Womenswear', 'Tops', 'Sweaters'],
    boys: ['Menswear', 'Tops', 'Sweaters'],
    girls: ['Womenswear', 'Tops', 'Sweaters'],
    'unisex-kids': ['Menswear', 'Tops', 'Sweaters'],
  },
  hoodies: {
    men: ['Menswear', 'Tops', 'Hoodies'],
    women: ['Womenswear', 'Tops', 'Hoodies'],
    'unisex-kids': ['Menswear', 'Tops', 'Hoodies'],
    boys: ['Menswear', 'Tops', 'Hoodies'],
    girls: ['Womenswear', 'Tops', 'Hoodies'],
  },
  'coats-jackets': {
    men: ['Menswear', 'Outerwear', 'Jackets'],
    women: ['Womenswear', 'Outerwear', 'Jackets'],
    boys: ['Menswear', 'Outerwear', 'Jackets'],
    girls: ['Womenswear', 'Outerwear', 'Jackets'],
    'unisex-kids': ['Menswear', 'Outerwear', 'Jackets'],
  },
  jeans: { men: ['Menswear', 'Bottoms', 'Jeans'], women: ['Womenswear', 'Bottoms', 'Jeans'] },
  pants: {
    men: ['Menswear', 'Bottoms', 'Pants'],
    women: ['Womenswear', 'Bottoms', 'Pants'],
    boys: ['Menswear', 'Bottoms', 'Pants'],
    girls: ['Womenswear', 'Bottoms', 'Pants'],
    'unisex-kids': ['Menswear', 'Bottoms', 'Pants'],
  },
  shorts: { men: ['Menswear', 'Bottoms', 'Shorts'], women: ['Womenswear', 'Bottoms', 'Shorts'] },
  skirts: { women: ['Womenswear', 'Bottoms', 'Skirts'], girls: ['Womenswear', 'Bottoms', 'Skirts'] },
  dresses: {
    // Depop splits dresses by occasion - Casual, Formal, Prom, Summer and a
    // dozen more. Nothing in our data says which, and the generic "Dresses"
    // row exists, so use it rather than guessing an occasion.
    women: ['Womenswear', 'Dresses', 'Dresses'],
    girls: ['Womenswear', 'Dresses', 'Dresses'],
  },
  'activewear-tops': { men: ['Menswear', 'Tops', 'T-shirts'], women: ['Womenswear', 'Tops', 'T-shirts'] },
  'activewear-pants': {
    men: ['Menswear', 'Bottoms', 'Sweatpants'],
    women: ['Womenswear', 'Bottoms', 'Sweatpants'],
  },
  swimwear: {
    men: ['Menswear', 'Bottoms', 'Swim briefs and shorts'],
    women: ['Womenswear', 'Swimwear', 'Swimsuits'],
  },
  sleepwear: {
    men: ['Menswear', 'Other', 'Pajamas'],
    women: ['Womenswear', 'Other', 'Pajamas'],
  },
  suits: { men: ['Menswear', 'Suits', 'Suits'], women: ['Womenswear', 'Suits', 'Suits'] },
  'athletic-shoes': {
    men: ['Menswear', 'Shoes', 'Sneakers'],
    women: ['Womenswear', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Menswear', 'Shoes', 'Sneakers'],
    boys: ['Menswear', 'Shoes', 'Sneakers'],
    girls: ['Womenswear', 'Shoes', 'Sneakers'],
  },
  'casual-shoes': {
    men: ['Menswear', 'Shoes', 'Sneakers'],
    women: ['Womenswear', 'Shoes', 'Sneakers'],
    boys: ['Menswear', 'Shoes', 'Sneakers'],
    girls: ['Womenswear', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Menswear', 'Shoes', 'Sneakers'],
  },
  hats: { men: ['Menswear', 'Accessories', 'Hats and caps'], women: ['Womenswear', 'Accessories', 'Hats and caps'] },
  bags: { men: ['Menswear', 'Bags', 'Bags'], women: ['Womenswear', 'Bags', 'Bags'] },
  // Depop has no kids department, so children's items sit under Menswear or
  // Womenswear. "Overalls" and "Rompers" are real rows on the form - the
  // earlier "Other" was a placeholder written before the capture existed.
  coveralls: {
    men: ['Menswear', 'Other', 'Overalls'],
    women: ['Womenswear', 'Other', 'Overalls'],
    boys: ['Menswear', 'Other', 'Overalls'],
    girls: ['Womenswear', 'Other', 'Overalls'],
    'unisex-kids': ['Menswear', 'Other', 'Overalls'],
    baby: ['Menswear', 'Other', 'Overalls'],
  },
  onepiece: {
    men: ['Menswear', 'Other', 'Rompers'],
    women: ['Womenswear', 'Other', 'Rompers'],
    boys: ['Menswear', 'Other', 'Rompers'],
    girls: ['Womenswear', 'Other', 'Rompers'],
    'unisex-kids': ['Menswear', 'Other', 'Rompers'],
    // Depop has a row for exactly this.
    baby: ['Menswear', 'Other', 'Onesies and sleepers'],
  },
}


/** Mercari: 4 tiers - Department > Category > Subcategory > Type. */
const MERCARI: Tree = {
  tshirts: {
    men: ['Men', 'Tops', 'T-shirts', 'Short sleeve'],
    women: ['Women', 'Tops & blouses', 'T-shirts', 'Short sleeve'],
    boys: ['Kids', 'Boys', 'Tops', 'T-shirts'],
    girls: ['Kids', 'Girls', 'Tops', 'T-shirts'],
    'unisex-kids': ['Kids', 'Boys', 'Tops', 'T-shirts'],
    baby: ['Kids', 'Baby', 'Boys', 'Tops'],
  },
  'casual-shirts': {
    men: ['Men', 'Tops', 'Button-front shirts', 'Casual'],
    women: ['Women', 'Tops & blouses', 'Button-front shirts', 'Casual'],
  },
  'dress-shirts': { men: ['Men', 'Tops', 'Button-front shirts', 'Dress'] },
  polos: { men: ['Men', 'Tops', 'Polos', 'Short sleeve'] },
  sweaters: {
    men: ['Men', 'Sweaters', 'Crewneck', 'Pullover'],
    women: ['Women', 'Sweaters', 'Crewneck', 'Pullover'],
    baby: ['Kids', 'Baby', 'Boys', 'Sweaters'],
  },
  hoodies: {
    men: ['Men', 'Sweats & hoodies', 'Hoodies', 'Pullover'],
    women: ['Women', 'Sweats & hoodies', 'Hoodies', 'Pullover'],
    boys: ['Kids', 'Boys', 'Tops', 'Sweatshirts & hoodies'],
    girls: ['Kids', 'Girls', 'Tops', 'Sweatshirts & hoodies'],
    'unisex-kids': ['Kids', 'Boys', 'Tops', 'Sweatshirts & hoodies'],
  },
  'coats-jackets': {
    men: ['Men', 'Coats & jackets', 'Jackets', 'Casual'],
    women: ['Women', 'Coats & jackets', 'Jackets', 'Casual'],
    boys: ['Kids', 'Boys', 'Outerwear', 'Jackets'],
    girls: ['Kids', 'Girls', 'Outerwear', 'Jackets'],
    'unisex-kids': ['Kids', 'Boys', 'Outerwear', 'Jackets'],
  },
  jeans: {
    men: ['Men', 'Pants', 'Jeans', 'Straight'],
    women: ['Women', 'Pants', 'Jeans', 'Straight'],
  },
  pants: {
    men: ['Men', 'Pants', 'Casual pants', 'Chinos'],
    women: ['Women', 'Pants', 'Casual pants', 'Trousers'],
    boys: ['Kids', 'Boys', 'Bottoms', 'Pants'],
  },
  shorts: { men: ['Men', 'Shorts', 'Athletic', 'Shorts'], women: ['Women', 'Shorts', 'Athletic', 'Shorts'] },
  skirts: { women: ['Women', 'Skirts', 'Midi', 'Skirts'] },
  dresses: { women: ['Women', 'Dresses', 'Midi', 'Dresses'], girls: ['Kids', 'Girls', 'Dresses', 'Dresses'] },
  'activewear-tops': { men: ['Men', 'Athletic apparel', 'Tops', 'T-shirts'], women: ['Women', 'Athletic apparel', 'Tops', 'T-shirts'] },
  'activewear-pants': { men: ['Men', 'Athletic apparel', 'Bottoms', 'Sweatpants'], women: ['Women', 'Athletic apparel', 'Bottoms', 'Leggings'] },
  swimwear: { men: ['Men', 'Swimwear', 'Trunks', 'Swim trunks'], women: ['Women', 'Swimwear', 'One-piece', 'Swimsuits'] },
  sleepwear: { women: ['Women', 'Sleepwear & robes', 'Pajamas', 'Sets'], baby: ['Kids', 'Baby', 'Boys', 'Sleepwear'] },
  suits: { men: ['Men', 'Suits', 'Suit sets', 'Suits'] },
  'athletic-shoes': {
    men: ['Men', 'Shoes', 'Athletic', 'Sneakers'],
    women: ['Women', 'Shoes', 'Athletic', 'Sneakers'],
    boys: ['Kids', 'Boys', 'Shoes', 'Sneakers'],
    girls: ['Kids', 'Girls', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Kids', 'Boys', 'Shoes', 'Sneakers'],
  },
  'casual-shoes': {
    men: ['Men', 'Shoes', 'Casual', 'Sneakers'],
    women: ['Women', 'Shoes', 'Casual', 'Sneakers'],
    boys: ['Kids', 'Boys', 'Shoes', 'Sneakers'],
    girls: ['Kids', 'Girls', 'Shoes', 'Sneakers'],
    'unisex-kids': ['Kids', 'Boys', 'Shoes', 'Sneakers'],
  },
  hats: { men: ['Men', 'Accessories', 'Hats', 'Caps'], women: ['Women', 'Accessories', 'Hats', 'Caps'] },
  bags: { women: ['Women', 'Handbags', 'Totes', 'Totes'] },
  coveralls: { men: ['Men', 'Pants', 'Casual pants', 'Cargo'] },
  onepiece: { baby: ['Kids', 'Baby', 'Boys', 'One-pieces'], 'unisex-kids': ['Kids', 'Boys', 'Sets', 'Outfits'] },
}

const TREES: Record<CrosslistPlatform, Tree> = {
  poshmark: POSHMARK,
  depop: DEPOP,
  mercari: MERCARI,
}

/** Expected depth per platform. A short path is a mapping bug, not a listing. */
export const CATEGORY_DEPTH: Record<CrosslistPlatform, number> = {
  poshmark: 3,
  depop: 3,
  mercari: 4,
}

export function mapCategory(
  platform: CrosslistPlatform,
  categoryPath: string | null | undefined,
  subcategory: string | null | undefined,
  title?: string | null,
): PlatformCategory | null {
  const internal = toInternalCategory(categoryPath, subcategory, title)
  if (!internal) return null

  const byGarment = TREES[platform][internal.garment]
  if (!byGarment) return null

  const path = byGarment[internal.department]
  if (!path) return null

  // A path reached only because the title or a fallback filled a gap is
  // still a real path, but worth distinguishing from one the category gave
  // outright when a listing later turns out to be filed oddly.
  const inferred =
    internal.garmentSource !== 'field' || internal.departmentSource !== 'field'

  return { path: [...path], source: inferred ? 'department-fallback' : 'mapped' }
}
