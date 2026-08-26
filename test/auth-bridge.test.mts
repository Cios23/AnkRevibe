import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Tests the cookie parser in extension/content-scripts/ankrevibe.js.
 *
 * This shipped broken: @supabase/ssr writes the session as
 * `base64-<payload>`, and the single-cookie path fed that straight to
 * JSON.parse, so the bridge recovered nothing and the popup would have sat
 * on "not signed in" forever. Nothing caught it because the extension had
 * never been loaded. These tests run the real parser over the real cookie
 * shape so a regression fails here instead of silently in a browser.
 */

const PROJECT_REF = 'bmgjqnrazdfgjcbmtasp'
const SESSION_KEY = `sb-${PROJECT_REF}-auth-token`

/** Extract the parser verbatim rather than reimplementing what's under test. */
function loadParser(documentCookie: string, storage: Record<string, string> = {}) {
  const source = readFileSync('extension/content-scripts/ankrevibe.js', 'utf8')
  const start = source.indexOf('  function tokenFromValue(raw)')
  const end = source.indexOf('  function getToken()')
  assert.ok(start > 0 && end > start, 'parser block not found - did the file move?')

  const harness = `
    const PROJECT_REF = ${JSON.stringify(PROJECT_REF)};
    const SESSION_KEY = "sb-" + PROJECT_REF + "-auth-token";
    const EXPLICIT_KEY = "ankrevibe_extension_token";
    const document = { cookie: ${JSON.stringify(documentCookie)} };
    const store = ${JSON.stringify(storage)};
    const keys = Object.keys(store);
    const localStorage = {
      get length() { return keys.length },
      getItem: (k) => (k in store ? store[k] : null),
      key: (i) => keys[i] ?? null,
    };
    ${source.slice(start, end)}
    return { fromCookie, fromExplicitKey, fromLocalStorage, tokenFromValue };
  `
  return new Function(harness)() as {
    fromCookie: () => string | null
    fromExplicitKey: () => string | null
    fromLocalStorage: () => string | null
    tokenFromValue: (raw: string | null) => string | null
  }
}

const ACCESS_TOKEN = 'header.payload.signature'

/** Exactly how @supabase/ssr encodes a session into a cookie. */
function ssrCookieValue(session: Record<string, unknown>): string {
  const json = JSON.stringify(session)
  return 'base64-' + Buffer.from(json, 'utf8').toString('base64')
}

describe('auth bridge cookie parsing', () => {
  test('recovers the token from a base64- session cookie', () => {
    const value = ssrCookieValue({ access_token: ACCESS_TOKEN, token_type: 'bearer' })
    const { fromCookie } = loadParser(`${SESSION_KEY}=${value}`)
    assert.equal(fromCookie(), ACCESS_TOKEN)
  })

  test('a raw base64- value is NOT treated as the token itself', () => {
    // The original bug: JSON.parse failed, and the fallback returned the
    // undecoded blob because it happened to contain a dot.
    const value = ssrCookieValue({ access_token: ACCESS_TOKEN })
    const { fromCookie } = loadParser(`${SESSION_KEY}=${value}`)
    const result = fromCookie()
    assert.ok(!result?.startsWith('base64-'), 'must decode, not pass through')
    assert.equal(result, ACCESS_TOKEN)
  })

  test('joins chunked cookies in numeric order before decoding', () => {
    // Chunks split one base64 string, so each piece is not valid base64 on
    // its own - they must be concatenated first.
    const value = ssrCookieValue({ access_token: ACCESS_TOKEN })
    const mid = Math.floor(value.length / 2)
    const cookie = [
      `${SESSION_KEY}.1=${value.slice(mid)}`, // deliberately out of order
      `${SESSION_KEY}.0=${value.slice(0, mid)}`,
    ].join('; ')

    const { fromCookie } = loadParser(cookie)
    assert.equal(fromCookie(), ACCESS_TOKEN)
  })

  test('orders chunks numerically, not lexically (.10 after .9)', () => {
    const value = ssrCookieValue({ access_token: ACCESS_TOKEN })
    const size = Math.ceil(value.length / 11)
    const parts: string[] = []
    for (let i = 0; i < 11; i++) {
      parts.push(`${SESSION_KEY}.${i}=${value.slice(i * size, (i + 1) * size)}`)
    }
    // Shuffle so only correct numeric sorting reassembles it.
    const cookie = parts.reverse().join('; ')
    const { fromCookie } = loadParser(cookie)
    assert.equal(fromCookie(), ACCESS_TOKEN)
  })

  test('handles the currentSession wrapper shape', () => {
    const value = ssrCookieValue({ currentSession: { access_token: ACCESS_TOKEN } })
    const { fromCookie } = loadParser(`${SESSION_KEY}=${value}`)
    assert.equal(fromCookie(), ACCESS_TOKEN)
  })

  test('handles the [access, refresh] array shape', () => {
    const value = ssrCookieValue([ACCESS_TOKEN, 'refresh'] as unknown as Record<string, unknown>)
    const { fromCookie } = loadParser(`${SESSION_KEY}=${value}`)
    assert.equal(fromCookie(), ACCESS_TOKEN)
  })

  test('ignores unrelated cookies', () => {
    const { fromCookie } = loadParser('other=1; _ga=GA1.2.3; theme=dark')
    assert.equal(fromCookie(), null)
  })

  test('survives a malformed cookie without throwing', () => {
    const { fromCookie } = loadParser(`${SESSION_KEY}=base64-!!!not-base64!!!`)
    assert.equal(fromCookie(), null)
  })

  test('the explicit localStorage key wins when present', () => {
    const { fromExplicitKey } = loadParser('', {
      ankrevibe_extension_token: 'explicit.token.value',
    })
    assert.equal(fromExplicitKey(), 'explicit.token.value')
  })
})
