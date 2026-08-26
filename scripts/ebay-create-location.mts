/**
 * Creates an eBay inventory location and saves its key to .env.local.
 *
 * Publishing an offer requires a merchant location, and most seller
 * accounts have no UI for creating one - it is API-only.
 *
 * Run:
 *   npm run ebay:create-location -- \
 *     --key home \
 *     --line1 "123 Main St" \
 *     --city "Springfield" \
 *     --state IL \
 *     --postal 62704 \
 *     [--country US] [--name "Home"] [--type WAREHOUSE]
 *
 * The address is the one eBay shows buyers as the item location and uses
 * for calculated shipping, so it must be real.
 */

import { readFileSync, writeFileSync } from 'node:fs'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Fall through to the ambient environment.
}

const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')
const { ebayEnv, apiHost } = await import('../lib/ebay/config')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  const inline = process.argv.find((a) => a.startsWith(`--${flag}=`))
  return inline?.slice(flag.length + 3)
}

const key = arg('key') ?? 'home'
const line1 = arg('line1')
const line2 = arg('line2')
const city = arg('city')
const state = arg('state')
const postal = arg('postal')
const country = arg('country') ?? 'US'
const name = arg('name') ?? 'Home'
const locationType = arg('type') ?? 'WAREHOUSE'

const missing = Object.entries({ line1, city, state, postal })
  .filter(([, v]) => !v)
  .map(([k]) => `--${k}`)

if (missing.length) {
  console.error(`Missing required address parts: ${missing.join(', ')}\n`)
  console.error('Example:\n')
  console.error(
    '  npm run ebay:create-location -- --key home \\\n' +
      '    --line1 "123 Main St" --city "Springfield" \\\n' +
      '    --state IL --postal 62704\n',
  )
  console.error(
    'This address is shown to buyers as the item location and drives\n' +
      'calculated shipping, so it needs to be your real ship-from address.',
  )
  process.exit(1)
}

/** eBay wants a 2-letter state/province code for US addresses. */
if (country === 'US' && !/^[A-Za-z]{2}$/.test(state!)) {
  console.error(
    `--state must be a 2-letter code for US addresses (got "${state}").`,
  )
  process.exit(1)
}

function upsertEnv(envKey: string, value: string) {
  let lines: string[] = []
  try {
    lines = readFileSync('.env.local', 'utf8').split(/\r?\n/)
  } catch {
    lines = []
  }
  const line = `${envKey}="${value}"`
  const index = lines.findIndex((l) => l.startsWith(`${envKey}=`))
  if (index >= 0) lines[index] = line
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(line)
  }
  writeFileSync('.env.local', lines.join('\n').replace(/\n*$/, '\n'), 'utf8')
}

console.log(`environment   ${ebayEnv()}`)
console.log(`host          ${apiHost()}`)
console.log(`location key  ${key}\n`)

const payload = {
  location: {
    address: {
      addressLine1: line1,
      ...(line2 ? { addressLine2: line2 } : {}),
      city,
      stateOrProvince: state,
      postalCode: postal,
      country,
    },
  },
  locationTypes: [locationType],
  name,
  merchantLocationStatus: 'ENABLED',
}

try {
  // Returns 204 with no body on success.
  await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: payload,
  })

  console.log('Location created.\n')

  // Read it back so we report what eBay actually stored, not what we sent.
  const created = await ebayFetch<any>(
    `/sell/inventory/v1/location/${encodeURIComponent(key)}`,
  )
  if (created) {
    const address = created.location?.address ?? {}
    console.log(`  name     ${created.name ?? name}`)
    console.log(`  status   ${created.merchantLocationStatus ?? 'unknown'}`)
    console.log(
      `  address  ${[
        address.addressLine1,
        address.city,
        address.stateOrProvince,
        address.postalCode,
        address.country,
      ]
        .filter(Boolean)
        .join(', ')}`,
    )
    console.log()
  }

  upsertEnv('EBAY_MERCHANT_LOCATION_KEY', key)
  console.log(`EBAY_MERCHANT_LOCATION_KEY="${key}" saved to .env.local`)
} catch (cause) {
  if (cause instanceof EbayApiError) {
    console.error(`ERROR ${cause.message}`)
    // 25801: a location with this key already exists.
    if (cause.errors.some((e) => e.errorId === 25801)) {
      console.error(
        `→ a location keyed "${key}" already exists. ` +
          `Run npm run ebay:locations to see it, or pass a different --key.`,
      )
    } else if (cause.status === 401) {
      console.error('→ token invalid or expired. Run: npm run ebay:auth')
    } else if (cause.status === 403) {
      console.error('→ missing the sell.inventory scope. Re-run npm run ebay:auth')
    }
  } else {
    console.error(`ERROR ${cause instanceof Error ? cause.message : cause}`)
  }
  process.exit(1)
}
