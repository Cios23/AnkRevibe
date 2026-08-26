/**
 * Lists the eBay business policies on the account so their IDs can be
 * saved into .env.local.
 *
 * Run: npm run ebay:policies
 *
 * Authenticates through lib/ebay/oauth.ts, so it uses EBAY_REFRESH_TOKEN
 * if present (see `npm run ebay:auth`) and falls back to a manually pasted
 * EBAY_USER_ACCESS_TOKEN otherwise.
 */

try {
  process.loadEnvFile('.env.local')
} catch {
  // Fall through to the ambient environment.
}

const { ebayFetch, EbayApiError } = await import('../lib/ebay/client')
const { ebayEnv, apiHost, marketplaceId } = await import('../lib/ebay/config')

type PolicyKind = {
  path: string
  listKey: string
  idKey: string
  envVar: string
}

const KINDS: PolicyKind[] = [
  {
    path: 'fulfillment_policy',
    listKey: 'fulfillmentPolicies',
    idKey: 'fulfillmentPolicyId',
    envVar: 'EBAY_FULFILLMENT_POLICY_ID',
  },
  {
    path: 'payment_policy',
    listKey: 'paymentPolicies',
    idKey: 'paymentPolicyId',
    envVar: 'EBAY_PAYMENT_POLICY_ID',
  },
  {
    path: 'return_policy',
    listKey: 'returnPolicies',
    idKey: 'returnPolicyId',
    envVar: 'EBAY_RETURN_POLICY_ID',
  },
]

console.log(`environment   ${ebayEnv()}`)
console.log(`host          ${apiHost()}`)
console.log(`marketplace   ${marketplaceId()}\n`)

const chosen: string[] = []
let failed = false

for (const kind of KINDS) {
  console.log(`── ${kind.path} ${'─'.repeat(Math.max(0, 46 - kind.path.length))}`)
  try {
    const body = await ebayFetch<Record<string, any>>(
      `/sell/account/v1/${kind.path}?marketplace_id=${marketplaceId()}`,
    )
    const policies: Array<Record<string, any>> = body?.[kind.listKey] ?? []

    if (policies.length === 0) {
      console.log('  (none — create one at ebay.com → Account → Business policies)\n')
      failed = true
      continue
    }

    for (const policy of policies) {
      const id = String(policy[kind.idKey])
      const name = String(policy.name ?? '(unnamed)')
      console.log(`  ${id.padEnd(24)} ${name}`)
    }

    chosen.push(`${kind.envVar}=${String(policies[0][kind.idKey])}`)
    if (policies.length > 1) {
      console.log(
        `  ↑ ${policies.length} found — pick one; the line below is just the first`,
      )
    }
    console.log()
  } catch (cause) {
    failed = true
    if (cause instanceof EbayApiError) {
      console.error(`  ERROR ${cause.message}`)
      if (cause.status === 401) {
        console.error('  → token invalid or expired. Run: npm run ebay:auth')
      } else if (cause.status === 403) {
        console.error('  → missing the sell.account scope. Re-consent via npm run ebay:auth')
      }
    } else {
      console.error(`  ERROR ${cause instanceof Error ? cause.message : cause}`)
    }
    console.error()
  }
}

if (chosen.length) {
  console.log('Add to .env.local:\n')
  console.log(chosen.join('\n'))
  console.log()
}

process.exit(failed ? 1 : 0)
