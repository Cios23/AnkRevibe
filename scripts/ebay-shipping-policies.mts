/**
 * Shipping-policy assignment: what each item would get, and whether the
 * policies still exist.
 *
 *   npm run ebay:shipping                 what every active item would get
 *   npm run ebay:shipping -- --verify     check the ids against eBay only
 *   npm run ebay:shipping -- --band heavy list just one band
 *
 * READ-ONLY. Nothing is written here and no listing is touched - the policy
 * is applied at publish time by lib/platforms/ebay.ts. This is the "show me
 * what would change before changing it" pass.
 *
 * The verify step is not decoration: the previous flat default
 * (259353376018, "Clothing Items") had been deleted from the account, so
 * every publish would have failed on an invalid policy. A deleted policy is
 * silent until the moment it costs you a listing.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { allPolicyIds, resolveShippingPolicy, FULFILLMENT_POLICIES } = await import(
  '../lib/ebay/shipping'
)
const { ebayFetch } = await import('../lib/ebay/client')
const { marketplaceId } = await import('../lib/ebay/config')

const VERIFY_ONLY = process.argv.includes('--verify')
const bandArg = process.argv.indexOf('--band')
const BAND_FILTER = bandArg >= 0 ? process.argv[bandArg + 1] : null

// ------------------------------------------------ do the policies exist?

console.log('── policies on the account ──────────────────────')

const live = await ebayFetch<{
  fulfillmentPolicies?: Array<{ fulfillmentPolicyId?: string; name?: string }>
}>(`/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId()}`)

const liveById = new Map(
  (live?.fulfillmentPolicies ?? []).map((p) => [
    String(p.fulfillmentPolicyId),
    String(p.name ?? ''),
  ]),
)

let invalid = 0
for (const policy of allPolicyIds()) {
  const name = liveById.get(policy.id)
  if (name) {
    const drifted = name !== policy.label
    console.log(
      `  OK      ${policy.band.padEnd(18)} ${policy.id}  ${name}` +
        (drifted ? `   (we call it "${policy.label}")` : ''),
    )
  } else {
    invalid++
    console.log(
      `  MISSING ${policy.band.padEnd(18)} ${policy.id}  not on the account`,
    )
  }
}

if (invalid) {
  console.log(
    `\n  ${invalid} policy id(s) do not exist. Publishing with one of these ` +
      `fails the offer, so fix lib/ebay/shipping.ts before listing.`,
  )
}

if (VERIFY_ONLY) process.exit(invalid ? 1 : 0)

// -------------------------------------------------- what each item gets

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

type Row = {
  id: string
  title: string | null
  category: string | null
  subcategory: string | null
}

const rows: Row[] = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('inventory')
    .select('id, title, category, subcategory')
    .eq('status', 'active')
    .range(from, from + 999)
  if (error) throw new Error(error.message)
  rows.push(...((data ?? []) as Row[]))
  if (!data || data.length < 1000) break
}

const byBand = new Map<string, Row[]>()
const assumed: Row[] = []
const bySource = { category: 0, title: 0, default: 0 }

for (const row of rows) {
  const resolution = resolveShippingPolicy(row)
  bySource[resolution.source]++
  if (resolution.assumed) assumed.push(row)
  const list = byBand.get(resolution.band) ?? []
  list.push(row)
  byBand.set(resolution.band, list)
}

console.log(`\n── assignment for ${rows.length} active items ────────────`)

for (const band of Object.keys(FULFILLMENT_POLICIES) as Array<
  keyof typeof FULFILLMENT_POLICIES
>) {
  const items = byBand.get(band) ?? []
  const policy = FULFILLMENT_POLICIES[band]
  console.log(
    `\n  ${policy.label}  (${policy.id})  -  ${items.length} items`,
  )

  if (BAND_FILTER && BAND_FILTER !== band) {
    console.log('    (use --band ' + band + ' to list them)')
    continue
  }

  const show = BAND_FILTER === band ? items : items.slice(0, 6)
  for (const item of show) {
    console.log(`      ${(item.title ?? item.id).slice(0, 62)}`)
  }
  if (!BAND_FILTER && items.length > show.length) {
    console.log(`      ... and ${items.length - show.length} more`)
  }
}

console.log(
  `\n  ${assumed.length} item(s) matched neither category nor title and took ` +
    `the default band - mostly non-apparel. Spot-check any heavy ones:`,
)
for (const item of assumed.slice(0, 8)) {
  console.log(`      ${(item.title ?? item.id).slice(0, 62)}`)
}
if (assumed.length > 8) console.log(`      ... and ${assumed.length - 8} more`)

console.log('\nRead-only: nothing was changed.')
process.exit(invalid ? 1 : 0)
