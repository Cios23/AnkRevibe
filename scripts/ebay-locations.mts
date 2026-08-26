/**
 * Lists the inventory locations on the eBay account.
 *
 * Run: npm run ebay:locations
 *
 * Publishing an offer requires EBAY_MERCHANT_LOCATION_KEY to name a real
 * location, and it is the one prerequisite with no sensible default. This
 * shows what already exists so the key can be copied into .env.local.
 *
 * Authenticates through lib/ebay/oauth.ts, so it uses EBAY_REFRESH_TOKEN
 * when present and falls back to EBAY_USER_ACCESS_TOKEN otherwise.
 */

try {
  process.loadEnvFile('.env.local')
} catch {
  // Fall through to the ambient environment.
}

const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')
const { ebayEnv, apiHost, marketplaceId } = await import('../lib/ebay/config')

type Address = {
  addressLine1?: string
  city?: string
  stateOrProvince?: string
  postalCode?: string
  country?: string
}

type Location = {
  merchantLocationKey?: string
  name?: string
  merchantLocationStatus?: string
  locationTypes?: string[]
  location?: { address?: Address }
}

function formatAddress(address: Address | undefined): string {
  if (!address) return '(no address)'
  return (
    [
      address.addressLine1,
      address.city,
      address.stateOrProvince,
      address.postalCode,
      address.country,
    ]
      .filter(Boolean)
      .join(', ') || '(no address)'
  )
}

console.log(`environment   ${ebayEnv()}`)
console.log(`host          ${apiHost()}`)
console.log(`marketplace   ${marketplaceId()}\n`)

try {
  const body = await ebayFetch<{ locations?: Location[]; total?: number }>(
    '/sell/inventory/v1/location?limit=100&offset=0',
  )

  const locations = body?.locations ?? []

  if (locations.length === 0) {
    console.log('No inventory locations on this account.\n')
    console.log('Create one before publishing — eBay has no UI for this on')
    console.log('most accounts, so it is an API call:\n')
    console.log('  POST /sell/inventory/v1/location/{merchantLocationKey}')
    console.log('  {')
    console.log('    "location": { "address": {')
    console.log('      "addressLine1": "...", "city": "...",')
    console.log('      "stateOrProvince": "..", "postalCode": ".....",')
    console.log('      "country": "US" } },')
    console.log('    "locationTypes": ["WAREHOUSE"],')
    console.log('    "name": "Home"')
    console.log('  }\n')
    console.log('Say the word and I will add a script for that too.')
    process.exit(1)
  }

  console.log(`${locations.length} location${locations.length === 1 ? '' : 's'}:\n`)

  for (const loc of locations) {
    const key = loc.merchantLocationKey ?? '(no key)'
    const status = loc.merchantLocationStatus ?? 'UNKNOWN'
    const types = loc.locationTypes?.join(', ') ?? '—'
    console.log(`  ${key}`)
    console.log(`    name     ${loc.name ?? '(unnamed)'}`)
    console.log(`    status   ${status}`)
    console.log(`    types    ${types}`)
    console.log(`    address  ${formatAddress(loc.location?.address)}`)
    console.log()
  }

  const enabled = locations.filter(
    (l) => l.merchantLocationStatus === 'ENABLED' && l.merchantLocationKey,
  )

  if (enabled.length === 0) {
    console.log(
      'None are ENABLED. A disabled location cannot back a published offer.',
    )
    process.exit(1)
  }

  console.log('Add to .env.local:\n')
  console.log(`EBAY_MERCHANT_LOCATION_KEY=${enabled[0].merchantLocationKey}`)
  if (enabled.length > 1) {
    console.log(`\n(${enabled.length} enabled — the line above is just the first)`)
  }
  console.log()
} catch (cause) {
  if (cause instanceof EbayApiError) {
    console.error(`ERROR ${cause.message}`)
    if (cause.status === 401) {
      console.error('→ token invalid or expired. Run: npm run ebay:auth')
    } else if (cause.status === 403) {
      console.error(
        '→ missing the sell.inventory scope. Re-consent via npm run ebay:auth',
      )
    }
  } else {
    console.error(`ERROR ${cause instanceof Error ? cause.message : cause}`)
  }
  process.exit(1)
}
