/**
 * eBay environment configuration.
 *
 * Production is the default; set EBAY_ENV=sandbox to point everything at
 * the sandbox hosts. Nothing here reads a token - see oauth.ts.
 */

export type EbayEnv = 'production' | 'sandbox'

export function ebayEnv(): EbayEnv {
  return process.env.EBAY_ENV === 'sandbox' ? 'sandbox' : 'production'
}

export function apiHost(): string {
  return ebayEnv() === 'sandbox'
    ? 'https://api.sandbox.ebay.com'
    : 'https://api.ebay.com'
}

export function authHost(): string {
  return ebayEnv() === 'sandbox'
    ? 'https://auth.sandbox.ebay.com'
    : 'https://auth.ebay.com'
}

export function marketplaceId(): string {
  return process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
}

/**
 * Scopes the integration needs.
 *
 * api_scope       - Taxonomy API: category tree + category suggestions
 * sell.inventory  - create/replace inventory items, offers, publish, withdraw
 * sell.account    - read business policies
 *
 * These must match the scopes granted at consent time; adding one later
 * means re-running `npm run ebay:auth` to mint a new refresh token.
 */
export const EBAY_SCOPES = [
  // Base scope. The Taxonomy API (category suggestions) requires this one
  // specifically - the sell.* scopes alone return 403 [1100].
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
]

export class MissingConfigError extends Error {
  constructor(names: string[]) {
    super(
      `Missing required eBay config: ${names.join(', ')}.\n` +
        `Add them to .env.local. See .env.example for what each one is.`,
    )
    this.name = 'MissingConfigError'
  }
}

export function requireEnv(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) throw new MissingConfigError(missing)
  return Object.fromEntries(names.map((n) => [n, process.env[n]!]))
}

/**
 * Business policy + location IDs required to publish an offer.
 *
 * FUTURE WORK: fulfillment policy is currently one flat default
 * ("Clothing Items"), but shipping cost on this account is banded by
 * garment weight and there are per-band policies already set up:
 *
 *   261742192018  T-Shirts/Shorts   $5
 *   261742395018  Sweatshirts       $8
 *   261742420018  Light Coats/Jeans $10
 *   261742440018  Heavy Coat
 *   262546430018  Free Apparel
 *
 * Picking per category (or per weight on the inventory row) would stop us
 * under-charging shipping on heavy items. Deliberately deferred.
 */
export function listingPolicyIds() {
  const env = requireEnv([
    'EBAY_FULFILLMENT_POLICY_ID',
    'EBAY_PAYMENT_POLICY_ID',
    'EBAY_RETURN_POLICY_ID',
  ])
  return {
    fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID,
    paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
    returnPolicyId: env.EBAY_RETURN_POLICY_ID,
  }
}

export function merchantLocationKey(): string {
  return requireEnv(['EBAY_MERCHANT_LOCATION_KEY'])
    .EBAY_MERCHANT_LOCATION_KEY
}
