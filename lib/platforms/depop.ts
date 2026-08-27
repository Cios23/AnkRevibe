import type {
  CreatedListing,
  DelistOutcome,
  ListingContext,
  PlatformAdapter,
} from '@/lib/platforms/adapter'
import type { Platform } from '@/lib/types'

/**
 * Depop adapter.
 *
 * Depop has no seller API at all - no listing, no delisting, nothing. Every
 * write happens by driving their web UI, which only the browser extension
 * can do. So this adapter does not perform work; it records intent, and the
 * extension picks it up.
 *
 * The important part is what delist() REPORTS. Returning 'delisted' would
 * write into our own records that a listing is down while it is still live
 * and sellable - and the sync-failure detector reads exactly that field, so
 * the one system meant to catch a failed delist would be told there was
 * nothing to catch. It returns 'queued' instead, and recordSale marks the
 * row `pending_delist` until the extension confirms otherwise.
 */
export class DepopAdapter implements PlatformAdapter {
  readonly platform: Platform = 'depop'

  async createListing(context: ListingContext): Promise<CreatedListing> {
    // Creating is also extension work; the popup drives it directly rather
    // than going through crosspost(), so this should not be reached.
    throw new Error(
      `Depop listings are created through the browser extension, not the ` +
        `server. Use the extension popup for ${context.item.id}.`,
    )
  }

  /**
   * Queue a delist for the extension.
   *
   * No network call: the caller marks the row `pending_delist`, which is
   * what the extension polls for. Returning 'queued' is the whole point -
   * see the class comment.
   */
  async delist(platformListingId: string | null): Promise<DelistOutcome> {
    if (!platformListingId) return 'delisted'
    return 'queued'
  }

  async relist(
    _platformListingId: string | null,
    context: ListingContext,
  ): Promise<CreatedListing> {
    throw new Error(
      `Depop relisting runs in the browser extension, not the server ` +
        `(item ${context.item.id}).`,
    )
  }
}
