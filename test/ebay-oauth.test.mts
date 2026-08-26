import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.EBAY_ENV = 'production'
process.env.EBAY_CLIENT_ID = 'client-id'
process.env.EBAY_CLIENT_SECRET = 'client-secret'
process.env.EBAY_RUNAME = 'Kody-RuName-12345'

const { getAccessToken, clearTokenCache, consentUrl } = await import(
  '../lib/ebay/oauth'
)

function tokenSet(accessToken: string, expiresIn = 7200) {
  return { accessToken, expiresIn }
}

beforeEach(() => {
  clearTokenCache()
  delete process.env.EBAY_REFRESH_TOKEN
  delete process.env.EBAY_USER_ACCESS_TOKEN
})

describe('consentUrl', () => {
  test('targets the auth host with the RuName as redirect_uri', () => {
    const url = new URL(consentUrl())
    assert.equal(url.origin, 'https://auth.ebay.com')
    assert.equal(url.pathname, '/oauth2/authorize')
    assert.equal(url.searchParams.get('client_id'), 'client-id')
    // eBay takes the RuName here, not a real URL - a common trip-up.
    assert.equal(url.searchParams.get('redirect_uri'), 'Kody-RuName-12345')
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.match(url.searchParams.get('scope')!, /sell\.inventory/)
    assert.match(url.searchParams.get('scope')!, /sell\.account/)
  })
})

describe('getAccessToken', () => {
  test('mints from the refresh token', async () => {
    process.env.EBAY_REFRESH_TOKEN = 'refresh-abc'

    const seen: string[] = []
    const token = await getAccessToken({
      refresh: async (rt) => {
        seen.push(rt)
        return tokenSet('minted-1')
      },
    })

    assert.equal(token, 'minted-1')
    assert.deepEqual(seen, ['refresh-abc'])
  })

  test('caches - a second call does not hit the token endpoint', async () => {
    process.env.EBAY_REFRESH_TOKEN = 'refresh-abc'
    let refreshes = 0
    const refresh = async () => {
      refreshes++
      return tokenSet(`minted-${refreshes}`)
    }

    assert.equal(await getAccessToken({ refresh }), 'minted-1')
    assert.equal(await getAccessToken({ refresh }), 'minted-1')
    assert.equal(refreshes, 1)
  })

  test('re-mints once the cached token nears expiry', async () => {
    process.env.EBAY_REFRESH_TOKEN = 'refresh-abc'
    let refreshes = 0
    let clock = 1_000_000
    const deps = {
      now: () => clock,
      refresh: async () => {
        refreshes++
        return tokenSet(`minted-${refreshes}`, 7200)
      },
    }

    assert.equal(await getAccessToken(deps), 'minted-1')

    // Still comfortably valid.
    clock += 3_600_000
    assert.equal(await getAccessToken(deps), 'minted-1')
    assert.equal(refreshes, 1)

    // Inside the 60s safety margin before the 2h expiry.
    clock += 3_541_000
    assert.equal(await getAccessToken(deps), 'minted-2')
    assert.equal(refreshes, 2)
  })

  test('falls back to a manually pasted token when no refresh token exists', async () => {
    process.env.EBAY_USER_ACCESS_TOKEN = 'manual-token'
    const token = await getAccessToken({
      refresh: async () => {
        throw new Error('must not be called')
      },
    })
    assert.equal(token, 'manual-token')
  })

  test('prefers the refresh flow over a stale manual token', async () => {
    process.env.EBAY_REFRESH_TOKEN = 'refresh-abc'
    process.env.EBAY_USER_ACCESS_TOKEN = 'manual-token'
    const token = await getAccessToken({ refresh: async () => tokenSet('minted-1') })
    assert.equal(token, 'minted-1')
  })

  test('throws a directive error when nothing is configured', async () => {
    await assert.rejects(
      () => getAccessToken({ refresh: async () => tokenSet('x') }),
      /ebay:auth/,
    )
  })

  test('clearTokenCache forces a re-mint', async () => {
    process.env.EBAY_REFRESH_TOKEN = 'refresh-abc'
    let refreshes = 0
    const refresh = async () => {
      refreshes++
      return tokenSet(`minted-${refreshes}`)
    }

    await getAccessToken({ refresh })
    clearTokenCache()
    await getAccessToken({ refresh })
    assert.equal(refreshes, 2)
  })
})
