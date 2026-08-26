import type {
  CreatedListing,
  ListingContext,
  PlatformAdapter,
} from '@/lib/platforms/adapter'
import type { Platform } from '@/lib/types'

/**
 * Placeholder adapter.
 *
 * Poshmark, Depop and Mercari have no official write API, so those will
 * ultimately need a browser-automation worker. Until that exists they run
 * through this stub: it produces deterministic fake ids and URLs so the
 * full operational loop - crosspost, sell, auto-delist, relist, health
 * check - is exercisable end to end against real database state.
 *
 * eBay no longer uses this; see lib/platforms/ebay.ts.
 */
export class StubAdapter implements PlatformAdapter {
  constructor(public platform: Platform) {}

  private id(context: ListingContext) {
    return `stub-${this.platform}-${context.item.id.slice(0, 8)}`
  }

  async createListing(context: ListingContext): Promise<CreatedListing> {
    const platformListingId = this.id(context)
    return {
      platformListingId,
      platformUrl: `https://example.invalid/${this.platform}/${platformListingId}`,
    }
  }

  async delist(_platformListingId: string | null): Promise<void> {
    // No-op until a real integration exists.
  }

  async relist(
    _platformListingId: string | null,
    context: ListingContext,
  ): Promise<CreatedListing> {
    return this.createListing(context)
  }
}
