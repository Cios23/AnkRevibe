import type { PlatformAdapter } from '@/lib/platforms/adapter'
import { DepopAdapter } from '@/lib/platforms/depop'
import { EbayAdapter } from '@/lib/platforms/ebay'
import { StubAdapter } from '@/lib/platforms/stub'
import { PLATFORMS, type Platform } from '@/lib/types'

/**
 * eBay runs against the real Sell API. If it is not configured the adapter
 * throws a specific error at call time rather than silently pretending to
 * list - a fake "success" that never reaches eBay is the worst outcome
 * here. Set EBAY_USE_STUB=true to opt into the fake for local work.
 *
 * The other three have no official write API and stay stubbed until a
 * browser-automation worker exists.
 */
function ebayAdapter(): PlatformAdapter {
  return process.env.EBAY_USE_STUB === 'true'
    ? new StubAdapter('ebay')
    : new EbayAdapter()
}

const registry: Record<Platform, () => PlatformAdapter> = {
  ebay: ebayAdapter,
  poshmark: () => new StubAdapter('poshmark'),
  // Depop cannot be delisted from a server; its adapter queues the work for
  // the extension and reports 'queued' rather than claiming it is done.
  depop: () =>
    process.env.EBAY_USE_STUB === 'true'
      ? new StubAdapter('depop')
      : new DepopAdapter(),
  mercari: () => new StubAdapter('mercari'),
}

export function getAdapter(platform: Platform): PlatformAdapter {
  return registry[platform]()
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as string[]).includes(value)
}
