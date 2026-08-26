import type { Inventory, ListingPhoto, Platform } from '@/lib/types'

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
  /** Must be idempotent: delisting something already gone is not an error. */
  delist(platformListingId: string | null): Promise<void>
  relist(
    platformListingId: string | null,
    context: ListingContext,
  ): Promise<CreatedListing>
}
