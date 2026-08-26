/**
 * One-time eBay OAuth bootstrap.
 *
 *   npm run ebay:auth                 -> prints the consent URL
 *   npm run ebay:auth -- --code "..." -> exchanges the code, saves the
 *                                        refresh token to .env.local
 *
 * The access token eBay hands you in the developer console lasts ~2 hours,
 * which is useless for a background integration. The refresh token this
 * produces lasts ~18 months, and lib/ebay/oauth.ts mints access tokens
 * from it on demand.
 *
 * Requires EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME in
 * .env.local first - all three come from the eBay developer console.
 */

import { readFileSync, writeFileSync } from 'node:fs'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Fall through to the ambient environment.
}

const { consentUrl, exchangeCodeForTokens } = await import('../lib/ebay/oauth')
const { ebayEnv } = await import('../lib/ebay/config')

const ENV_PATH = '.env.local'

function upsertEnv(key: string, value: string) {
  let lines: string[] = []
  try {
    lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
  } catch {
    lines = []
  }

  const line = `${key}="${value}"`
  const index = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (index >= 0) lines[index] = line
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(line)
  }

  writeFileSync(ENV_PATH, lines.join('\n').replace(/\n*$/, '\n'), 'utf8')
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`))
  return inline?.slice(flag.length + 1)
}

const code = argValue('--code')

if (!code) {
  let url: string
  try {
    url = consentUrl()
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exit(1)
  }

  console.log(`environment: ${ebayEnv()}\n`)
  console.log('1. Open this URL and approve access:\n')
  console.log(`   ${url}\n`)
  console.log('2. eBay redirects to your RuName. Copy the ENTIRE `code`')
  console.log('   query parameter out of the address bar - it is long and')
  console.log('   URL-encoded, and it expires in a few minutes.\n')
  console.log('3. Then run:\n')
  console.log('   npm run ebay:auth -- --code "PASTE_CODE_HERE"\n')
  process.exit(0)
}

console.log('Exchanging authorization code...')

try {
  const tokens = await exchangeCodeForTokens(code)

  if (!tokens.refreshToken) {
    console.error(
      'eBay returned an access token but no refresh token.\n' +
        'That happens when the consent used the client-credentials flow. ' +
        'Re-run without --code and use the printed consent URL.',
    )
    process.exit(1)
  }

  upsertEnv('EBAY_REFRESH_TOKEN', tokens.refreshToken)

  const days = tokens.refreshTokenExpiresIn
    ? Math.round(tokens.refreshTokenExpiresIn / 86400)
    : null

  console.log(`\n  refresh token saved to ${ENV_PATH}`)
  console.log(`  length          ${tokens.refreshToken.length} chars`)
  if (days) console.log(`  valid for       ~${days} days`)
  console.log(`  access token    ${tokens.expiresIn}s (minted on demand from now on)`)
  console.log('\nNext: npm run ebay:policies')
} catch (cause) {
  console.error(`\n${cause instanceof Error ? cause.message : String(cause)}`)
  console.error(
    '\nCommon causes: the code was truncated on paste, it already expired ' +
      '(they last minutes), or EBAY_RUNAME does not match the one used for consent.',
  )
  process.exit(1)
}
