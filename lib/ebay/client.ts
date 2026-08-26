import { apiHost, marketplaceId } from '@/lib/ebay/config'
import { clearTokenCache, getAccessToken } from '@/lib/ebay/oauth'

/**
 * Thin eBay REST client: auth, marketplace headers, error normalisation and
 * a narrow retry policy.
 *
 * Retries are deliberately conservative. 429 and 5xx are transient and safe
 * to repeat; 4xx is a bug in our request and repeating it just burns rate
 * limit. A 401 gets exactly one retry after dropping the cached token,
 * which covers a token expiring mid-flight.
 */

export type EbayErrorDetail = {
  errorId?: number
  domain?: string
  message?: string
  longMessage?: string
  parameters?: Array<{ name?: string; value?: string }>
}

export class EbayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: EbayErrorDetail[],
    readonly path: string,
    readonly body: string,
  ) {
    super(message)
    this.name = 'EbayApiError'
  }

  /** First eBay error id, which is what their docs index on. */
  get errorId(): number | undefined {
    return this.errors[0]?.errorId
  }

  /** Retrying an identical request will not help. */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }

  /** True when the item/offer simply is not there - safe to treat as a no-op. */
  get isNotFound(): boolean {
    return this.status === 404
  }
}

function parseErrors(text: string): EbayErrorDetail[] {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed?.errors)) return parsed.errors
  } catch {
    // Not JSON.
  }
  return []
}

function describe(status: number, errors: EbayErrorDetail[], text: string) {
  if (errors.length) {
    return errors
      .map((e) => `[${e.errorId ?? '?'}] ${e.longMessage ?? e.message ?? ''}`.trim())
      .join('; ')
  }
  return text.slice(0, 400) || `HTTP ${status}`
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export type EbayFetchOptions = {
  method?: string
  body?: unknown
  /** Extra headers, e.g. Content-Language for inventory item writes. */
  headers?: Record<string, string>
  /** Total attempts including the first. */
  attempts?: number
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  getToken?: () => Promise<string>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Performs an authenticated eBay REST call.
 *
 * Returns parsed JSON, or null for 204/empty bodies (publish/withdraw
 * sometimes answer with no content).
 */
export async function ebayFetch<T = unknown>(
  path: string,
  options: EbayFetchOptions = {},
): Promise<T | null> {
  const {
    method = 'GET',
    body,
    headers = {},
    attempts = 3,
    fetchImpl = fetch,
    sleep = defaultSleep,
    getToken = getAccessToken,
  } = options

  const url = path.startsWith('http') ? path : `${apiHost()}${path}`
  let lastError: EbayApiError | null = null
  let retriedAuth = false

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const token = await getToken()

    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (response.status === 204) return null

    const text = await response.text()

    if (response.ok) {
      if (!text) return null
      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    }

    const errors = parseErrors(text)
    lastError = new EbayApiError(
      `${method} ${path} -> ${response.status}: ${describe(response.status, errors, text)}`,
      response.status,
      errors,
      path,
      text,
    )

    // A token that expired mid-flight: drop the cache and try once more.
    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true
      clearTokenCache()
      continue
    }

    if (!RETRYABLE.has(response.status) || attempt === attempts) {
      throw lastError
    }

    // Exponential backoff: 500ms, 1s, 2s...
    await sleep(500 * 2 ** (attempt - 1))
  }

  throw lastError ?? new Error(`${method} ${path} failed`)
}
