import type { Inventory, ListingPhoto, Platform } from '@/lib/types'

/**
 * What actually happened when we asked a platform to take a listing down.
 *
 * Not every platform can be delisted from a server. Depop has no API for it,
 * so the work has to happen in the browser extension - the server can only
 * record the intent. Reporting that as 'delisted' would state, in our own
 * records, that a listing is down while it is still live and sellable.
 */
export type DelistOutcome =
  /** The listing is down now. */
  | 'delisted'
  /** Handed to the extension; still live until it runs. */
  | 'queued'

export type CreatedListing = {
  /**
   * The handle we need to later delist or relist. Per-platform this is
   * whatever that marketplace's write operations key on - for eBay it is
   * the offerId, not the public item number.
   */
  platformListingId: string
  platformUrl: string
}

/**
 * Everything an adapter needs to build a listing.
 *
 * Photos travel with the item because every real marketplace requires at
 * least one image; an adapter that only received the inventory row could
 * not publish.
 */
export type ListingContext = {
  item: Inventory
  photos: Pick<ListingPhoto, 'url' | 'position'>[]
  price: number | null
  /**
   * The platform's existing handle for this item, if we already have one.
   *
   * For eBay this is how an imported listing is recognised: a legacy numeric
   * ItemID means the item is already listed and eBay holds its true category
   * and full item specifics, which are better than anything we can infer.
   */
  existingPlatformListingId?: string | null
}

/**
 * The contract every marketplace integration implements.
 *
 * Swapping a stub for a real integration means writing one of these and
 * registering it - nothing in the crosspost / delist / relist orchestration
 * changes.
 */
export interface PlatformAdapter {
  platform: Platform
  createListing(context: ListingContext): Promise<CreatedListing>
  /**
   * Take the listing down.
   *
   * Must be idempotent - delisting something already gone is not an error -
   * and must report 'queued' rather than 'delisted' if the work has only
   * been scheduled.
   */
  delist(platformListingId: string | null): Promise<DelistOutcome>
  relist(
    platformListingId: string | null,
    context: ListingContext,
  ): Promise<CreatedListing>
}
