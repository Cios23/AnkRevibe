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
  // Fan apparel is unlabelled by garment on eBay; a shirt is the safe read.
  { match: /fan apparel & souvenirs/i, garment: 'tshirts' },
]

export function toInternalCategory(
  categoryPath: string | null | undefined,
  subcategory: string | null | undefined,
): InternalCategory | null {
  const department = normaliseDepartment(subcategory, categoryPath)
  if (!department) return null

  const path = categoryPath ?? ''
  for (const rule of GARMENT_RULES) {
    if (rule.match.test(path)) return { department, garment: rule.garment }
  }
  return null
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

/** Depop: Category > Subcategory > Type. */
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
    women: ['Womenswear', 'Tops', 'Shirts & Blouses'],
  },
  'dress-shirts': {
    men: ['Menswear', 'Tops', 'Shirts'],
    women: ['Womenswear', 'Tops', 'Shirts & Blouses'],
  },
  polos: { men: ['Menswear', 'Tops', 'Polo shirts'], women: ['Womenswear', 'Tops', 'T-shirts'] },
  sweaters: {
    men: ['Menswear', 'Tops', 'Jumpers & Sweaters'],
    women: ['Womenswear', 'Tops', 'Jumpers & Sweaters'],
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
  pants: { men: ['Menswear', 'Bottoms', 'Trousers'], women: ['Womenswear', 'Bottoms', 'Trousers'], boys: ['Menswear', 'Bottoms', 'Trousers'] },
  shorts: { men: ['Menswear', 'Bottoms', 'Shorts'], women: ['Womenswear', 'Bottoms', 'Shorts'] },
  skirts: { women: ['Womenswear', 'Bottoms', 'Skirts'] },
  dresses: { women: ['Womenswear', 'Dresses', 'Midi dresses'], girls: ['Womenswear', 'Dresses', 'Midi dresses'] },
  'activewear-tops': { men: ['Menswear', 'Tops', 'T-shirts'], women: ['Womenswear', 'Tops', 'T-shirts'] },
  'activewear-pants': { men: ['Menswear', 'Bottoms', 'Joggers'], women: ['Womenswear', 'Bottoms', 'Joggers'] },
  swimwear: { men: ['Menswear', 'Bottoms', 'Swimwear'], women: ['Womenswear', 'Swimwear', 'Bikinis'] },
  sleepwear: { women: ['Womenswear', 'Other', 'Sleepwear'] },
  suits: { men: ['Menswear', 'Suits', 'Suit jackets'] },
  'athletic-shoes': { men: ['Menswear', 'Shoes', 'Trainers'], women: ['Womenswear', 'Shoes', 'Trainers'], 'unisex-kids': ['Menswear', 'Shoes', 'Trainers'], boys: ['Menswear', 'Shoes', 'Trainers'], girls: ['Womenswear', 'Shoes', 'Trainers'] },
  'casual-shoes': { men: ['Menswear', 'Shoes', 'Trainers'], women: ['Womenswear', 'Shoes', 'Trainers'], boys: ['Menswear', 'Shoes', 'Trainers'], girls: ['Womenswear', 'Shoes', 'Trainers'], 'unisex-kids': ['Menswear', 'Shoes', 'Trainers'] },
  hats: { men: ['Menswear', 'Accessories', 'Hats'], women: ['Womenswear', 'Accessories', 'Hats'] },
  bags: { women: ['Womenswear', 'Bags', 'Tote bags'] },
  coveralls: { men: ['Menswear', 'Other', 'Other'] },
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
): PlatformCategory | null {
  const internal = toInternalCategory(categoryPath, subcategory)
  if (!internal) return null

  const byGarment = TREES[platform][internal.garment]
  if (!byGarment) return null

  const path = byGarment[internal.department]
  if (!path) return null

  return { path: [...path], source: 'mapped' }
}
