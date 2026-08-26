import type { PlatformAdapter, CreatedListing } from '@/lib/platforms/adapter'
import type { Inventory, Platform } from '@/lib/types'

/**
 * Placeholder adapter.
 *
 * eBay is the only one of the four with a public listing API; Poshmark,
 * Depop and Mercari have no official write API, so those will ultimately
 * need a browser-automation worker. Until credentials and that worker
 * exist, every platform runs through this stub: it produces deterministic
 * fake ids and URLs so the full operational loop - crosspost, sell,
 * auto-delist, relist, health check - is exercisable end to end against
 * real database state.
 */
export class StubAdapter implements PlatformAdapter {
  constructor(public platform: Platform) {}

  private id(item: Inventory) {
    return `stub-${this.platform}-${item.id.slice(0, 8)}`
  }

  async createListing(
    item: Inventory,
    _price: number | null,
  ): Promise<CreatedListing> {
    const platformListingId = this.id(item)
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
    item: Inventory,
    price: number | null,
  ): Promise<CreatedListing> {
    return this.createListing(item, price)
  }
}
