export type Platform = 'ebay' | 'poshmark' | 'depop' | 'mercari'

export const PLATFORMS: Platform[] = ['ebay', 'poshmark', 'depop', 'mercari']

export type InventoryStatus = 'draft' | 'active' | 'sold' | 'archived'
export type PlatformListingStatus = 'active' | 'delisted' | 'error'
export type OrderStatus = 'pending' | 'shipped' | 'completed'
export type HealthFlagStatus = 'open' | 'dismissed' | 'resolved'

export type Inventory = {
  id: string
  title: string | null
  description: string | null
  brand: string | null
  size: string | null
  color: string | null
  condition: string | null
  flaw_notes: string | null
  measurements: Record<string, unknown> | null
  purchase_cost: number | null
  ebay_price: number | null
  poshmark_price: number | null
  depop_price: number | null
  mercari_price: number | null
  status: InventoryStatus | null
  category: string | null
  subcategory: string | null
  style_era: string | null
  created_at: string | null
  sold_at: string | null
  sold_platform: string | null
  sold_price: number | null
}

export type ListingPhoto = {
  id: string
  inventory_id: string | null
  url: string
  position: number | null
  phash: string | null
  created_at: string | null
}

export type PlatformListing = {
  id: string
  inventory_id: string | null
  platform: string
  platform_listing_id: string | null
  platform_url: string | null
  status: PlatformListingStatus | null
  listed_price: number | null
  listed_at: string | null
  delisted_at: string | null
  last_relisted_at: string | null
}

export type Order = {
  id: string
  inventory_id: string | null
  platform: string | null
  sale_price: number | null
  buyer_info: Record<string, unknown> | null
  status: OrderStatus | null
  shipped_at: string | null
  tracking_number: string | null
  created_at: string | null
  /** Estimated marketplace fee at sale time. Added by migration 0002. */
  platform_fee: number | null
  /** sale_price - platform_fee - purchase_cost, at sale time. */
  profit: number | null
}

export type InventoryHealthFlag = {
  id: string
  sold_inventory_id: string | null
  flagged_inventory_id: string | null
  similarity_score: number | null
  status: HealthFlagStatus | null
  created_at: string | null
}

/**
 * Mirrors the shape `supabase gen types typescript` emits. `Relationships`
 * is required - without it postgrest-js fails to recognise the schema and
 * silently degrades every row type to `never`.
 */
type Table<Row> = {
  Row: Row
  Insert: Partial<Row>
  Update: Partial<Row>
  Relationships: []
}

type Empty = { [_ in never]: never }

export type Database = {
  public: {
    Tables: {
      inventory: Table<Inventory>
      listing_photos: Table<ListingPhoto>
      platform_listings: Table<PlatformListing>
      orders: Table<Order>
      inventory_health_flags: Table<InventoryHealthFlag>
    }
    Views: Empty
    Functions: Empty
    Enums: Empty
    CompositeTypes: Empty
  }
}

/** Per-platform price column on `inventory`. */
export function priceColumn(platform: Platform) {
  return `${platform}_price` as const
}
