/**
 * One live publish against production eBay, then take it straight down.
 *
 *   npm run ebay:live-test -- --inventory-id <uuid>
 *   npm run ebay:live-test -- --inventory-id <uuid> --keep
 *
 * Exercises the real path: crosspost() -> EbayAdapter -> PUT inventory_item
 * / POST offer / POST publish, then delist() to withdraw it again.
 *
 * Every imported item is ALREADY live on eBay under a legacy ItemID, so
 * this necessarily creates a duplicate listing. Two safeguards:
 *
 *   1. Unless --keep is passed, the new listing is withdrawn immediately.
 *   2. The item's platform_listings row is captured before and restored
 *      after, because crosspost() upserts on (inventory_id, platform) and
 *      would otherwise overwrite the imported legacy ItemID with the new
 *      offer id - losing the link to the listing that was already live.
 */

import { createClient } from '@supabase/supabase-js'

try {
  process.loadEnvFile('.env.local')
} catch {
  /* ambient env */
}

const { crosspost } = await import('../lib/operations')
const { EbayAdapter } = await import('../lib/platforms/ebay')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return process.argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
}

const INVENTORY_ID = arg('inventory-id')
const KEEP = process.argv.includes('--keep')

if (!INVENTORY_ID) {
  console.error('Pass --inventory-id <uuid>')
  process.exit(1)
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const { data: item, error: itemError } = await supabase
  .from('inventory')
  .select('*')
  .eq('id', INVENTORY_ID)
  .single()
if (itemError || !item) {
  console.error(`No such inventory row: ${itemError?.message}`)
  process.exit(1)
}

const { data: photos } = await supabase
  .from('listing_photos')
  .select('url, position')
  .eq('inventory_id', INVENTORY_ID)
  .order('position', { ascending: true })

console.log(`item        ${item.title}`)
console.log(`condition   ${item.condition}`)
console.log(`category    ${item.category}`)
console.log(`price       $${item.ebay_price}`)
console.log(`photos      ${photos?.length ?? 0}`)

// Snapshot the imported listing row so it can be put back afterwards.
const { data: original } = await supabase
  .from('platform_listings')
  .select('*')
  .eq('inventory_id', INVENTORY_ID)
  .eq('platform', 'ebay')
  .single()

console.log(`\nexisting eBay listing (imported): ${original?.platform_listing_id}`)
console.log(`  ${original?.platform_url}\n`)

console.log('── publishing ───────────────────────────────────')

let newOfferId: string | null = null

try {
  const results = await crosspost(supabase as any, INVENTORY_ID, ['ebay'])
  const result = results[0]

  if (result.status !== 'active') {
    console.error(`\nPUBLISH FAILED: ${result.error}`)
    process.exit(1)
  }

  const { data: after } = await supabase
    .from('platform_listings')
    .select('platform_listing_id, platform_url')
    .eq('inventory_id', INVENTORY_ID)
    .eq('platform', 'ebay')
    .single()

  newOfferId = after?.platform_listing_id ?? null

  console.log('\n  PUBLISHED')
  console.log(`  offer id     ${newOfferId}`)
  console.log(`  LIVE URL     ${after?.platform_url}`)

  // Confirm eBay really serves it, rather than trusting our own write.
  if (after?.platform_url) {
    const probe = await fetch(after.platform_url, { redirect: 'follow' })
    console.log(`  URL check    HTTP ${probe.status}`)
  }
} catch (cause) {
  console.error(`\nPUBLISH THREW: ${cause instanceof Error ? cause.message : cause}`)
}

// ------------------------------------------------------------- teardown

if (newOfferId && !KEEP) {
  console.log('\n── withdrawing the duplicate ────────────────────')
  try {
    await new EbayAdapter().delist(newOfferId)
    console.log('  withdrawn')
  } catch (cause) {
    console.error(
      `  WITHDRAW FAILED - end it manually in Seller Hub: ` +
        `${cause instanceof Error ? cause.message : cause}`,
    )
  }
} else if (KEEP) {
  console.log('\n--keep: the duplicate listing is still LIVE.')
}

if (original) {
  const { error } = await supabase
    .from('platform_listings')
    .update({
      platform_listing_id: original.platform_listing_id,
      platform_url: original.platform_url,
      status: original.status,
      listed_price: original.listed_price,
      listed_at: original.listed_at,
      delisted_at: original.delisted_at,
    })
    .eq('id', original.id)
  console.log(
    error
      ? `\nrestore FAILED: ${error.message}`
      : `\nplatform_listings restored to imported ItemID ${original.platform_listing_id}`,
  )
}
