import type { Inventory, Platform } from '@/lib/types'

export type CreatedListing = {
  platformListingId: string
  platformUrl: string
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
  createListing(item: Inventory, price: number | null): Promise<CreatedListing>
  delist(platformListingId: string | null): Promise<void>
  relist(
    platformListingId: string | null,
    item: Inventory,
    price: number | null,
  ): Promise<CreatedListing>
}
