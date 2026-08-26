import {
  EBAY_SCOPES,
  apiHost,
  authHost,
  requireEnv,
} from '@/lib/ebay/config'

/**
 * eBay OAuth - Authorization Code grant with refresh tokens.
 *
 * The manual flow (copy a 2-hour access token out of the developer console)
 * is not viable for a background integration. Instead:
 *
 *   1. `npm run ebay:auth` prints a consent URL, you approve it once, and
 *      the returned code is exchanged for a REFRESH token (~18 months).
 *   2. The refresh token lives in .env.local.
 *   3. Everything else calls getAccessToken(), which mints a short-lived
 *      access token on demand and caches it until just before it expires.
 *
 * Note eBay's redirect_uri parameter takes the RuName, not an actual URL.
 */

export type TokenSet = {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  refreshTokenExpiresIn?: number
}

function basicAuthHeader(): string {
  const env = requireEnv(['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'])
  const raw = `${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`
  return `Basic ${Buffer.from(raw).toString('base64')}`
}

/** The URL to open in a browser to grant consent. */
export function consentUrl(state?: string): string {
  const env = requireEnv(['EBAY_CLIENT_ID', 'EBAY_RUNAME'])
  const params = new URLSearchParams({
    client_id: env.EBAY_CLIENT_ID,
    redirect_uri: env.EBAY_RUNAME,
    response_type: 'code',
    scope: EBAY_SCOPES.join(' '),
  })
  if (state) params.set('state', state)
  return `${authHost()}/oauth2/authorize?${params.toString()}`
}

export class EbayOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'EbayOAuthError'
  }
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const response = await fetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  const text = await response.text()

  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      detail =
        [parsed.error, parsed.error_description].filter(Boolean).join(': ') ||
        text
    } catch {
      // Leave the raw body.
    }
    throw new EbayOAuthError(
      `eBay token endpoint returned ${response.status}: ${detail}`,
      response.status,
      text,
    )
  }

  const parsed = JSON.parse(text)
  return {
    accessToken: parsed.access_token,
    expiresIn: parsed.expires_in,
    refreshToken: parsed.refresh_token,
    refreshTokenExpiresIn: parsed.refresh_token_expires_in,
  }
}

/**
 * One-time: swap the ?code= from the consent redirect for a refresh token.
 *
 * The code arrives URL-encoded in the browser's address bar and is only
 * valid for a few minutes.
 */
export async function exchangeCodeForTokens(code: string): Promise<TokenSet> {
  const env = requireEnv(['EBAY_RUNAME'])
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: decodeURIComponent(code),
      redirect_uri: env.EBAY_RUNAME,
    }),
  )
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: EBAY_SCOPES.join(' '),
    }),
  )
}

// --------------------------------------------------------------------------

type CachedToken = { token: string; expiresAt: number }

let cache: CachedToken | null = null

/** Refresh this many ms before actual expiry, so a call never races it. */
const EXPIRY_MARGIN_MS = 60_000

export type TokenProviderDeps = {
  now?: () => number
  refresh?: (refreshToken: string) => Promise<TokenSet>
}

/** Drops the cached access token. Exposed for tests and for auth changes. */
export function clearTokenCache() {
  cache = null
}

/**
 * Returns a usable access token, minting one if needed.
 *
 * Prefers the refresh-token flow. Falls back to a manually-pasted
 * EBAY_USER_ACCESS_TOKEN so a quick console-token test still works, but
 * that path is a convenience, not the intended mode.
 */
export async function getAccessToken(
  deps: TokenProviderDeps = {},
): Promise<string> {
  const now = deps.now ?? Date.now
  const refresh = deps.refresh ?? refreshAccessToken

  if (cache && cache.expiresAt - EXPIRY_MARGIN_MS > now()) {
    return cache.token
  }

  const refreshToken = process.env.EBAY_REFRESH_TOKEN
  if (refreshToken) {
    const tokens = await refresh(refreshToken)
    cache = {
      token: tokens.accessToken,
      expiresAt: now() + tokens.expiresIn * 1000,
    }
    return cache.token
  }

  const staticToken = process.env.EBAY_USER_ACCESS_TOKEN
  if (staticToken) return staticToken

  throw new Error(
    'No eBay credentials. Set EBAY_REFRESH_TOKEN (run `npm run ebay:auth`), ' +
      'or EBAY_USER_ACCESS_TOKEN for a one-off manual test.',
  )
}
