import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { computeProfit } from '@/lib/fees'
import { getAdapter as defaultGetAdapter } from '@/lib/platforms'
import type { PlatformAdapter } from '@/lib/platforms/adapter'
import type { ListingContext } from '@/lib/platforms/adapter'
import type { Database, Inventory, ListingPhoto, Platform } from '@/lib/types'

type Client = SupabaseClient<Database>

/**
 * Injectable seam. Production passes nothing and gets the real registry;
 * tests pass a fake so no marketplace call is ever made.
 */
export type OperationDeps = {
  getAdapter?: (platform: Platform) => PlatformAdapter
}

function priceFor(item: Inventory, platform: Platform): number | null {
  switch (platform) {
    case 'ebay':
      return item.ebay_price
    case 'poshmark':
      return item.poshmark_price
    case 'depop':
      return item.depop_price
    case 'mercari':
      return item.mercari_price
  }
}

async function loadItem(supabase: Client, inventoryId: string) {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .eq('id', inventoryId)
    .single()
  if (error) throw new Error(error.message)
  return data as Inventory
}

async function loadPhotos(supabase: Client, inventoryId: string) {
  const { data, error } = await supabase
    .from('listing_photos')
    .select('*')
    .eq('inventory_id', inventoryId)
    .order('position', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as ListingPhoto[]
}

function contextFor(
  item: Inventory,
  photos: ListingPhoto[],
  platform: Platform,
  existingPlatformListingId?: string | null,
): ListingContext {
  return {
    item,
    photos,
    price: priceFor(item, platform),
    existingPlatformListingId: existingPlatformListingId ?? null,
  }
}

/** Existing per-platform handles, so adapters can recognise a known listing. */
async function loadExistingListingIds(
  supabase: Client,
  inventoryId: string,
): Promise<Map<string, string | null>> {
  const { data, error } = await supabase
    .from('platform_listings')
    .select('platform, platform_listing_id')
    .eq('inventory_id', inventoryId)
  if (error) throw new Error(error.message)
  return new Map((data ?? []).map((r) => [r.platform, r.platform_listing_id]))
}

/**
 * Refusing to list without a cost basis is a business rule, not a
 * validation nicety: an item listed with no purchase_cost cannot have its
 * profit computed when it sells, and cannot be reasoned about by the
 * offer automation - which would silently skip it forever.
 */
export class MissingPurchaseCostError extends Error {
  constructor(readonly inventoryId: string, readonly title: string | null) {
    super(
      `Cannot crosspost "${title ?? inventoryId}": purchase_cost is not set. ` +
        `Set a purchase cost on the item first - without it we cannot ` +
        `compute profit when it sells or evaluate offers against margin.`,
    )
    this.name = 'MissingPurchaseCostError'
  }
}

export type CrosspostResult = {
  platform: Platform
  status: 'active' | 'error'
  platformUrl?: string
  error?: string
}

/**
 * Push an item live on the given platforms and flip it to `active`.
 * Idempotent - the unique (inventory_id, platform) constraint means a
 * repeat crosspost updates the existing row rather than duplicating it.
 */
export async function crosspost(
  supabase: Client,
  inventoryId: string,
  platforms: Platform[],
  deps: OperationDeps = {},
): Promise<CrosspostResult[]> {
  const getAdapter = deps.getAdapter ?? defaultGetAdapter
  const item = await loadItem(supabase, inventoryId)

  // Blocks every platform, before any marketplace call is made.
  if (item.purchase_cost === null || item.purchase_cost === undefined) {
    throw new MissingPurchaseCostError(inventoryId, item.title)
  }

  const photos = await loadPhotos(supabase, inventoryId)
  const existing = await loadExistingListingIds(supabase, inventoryId)
  const results: CrosspostResult[] = []

  for (const platform of platforms) {
    const price = priceFor(item, platform)
    try {
      const listing = await getAdapter(platform).createListing(
        contextFor(item, photos, platform, existing.get(platform)),
      )

      const { error } = await supabase.from('platform_listings').upsert(
        {
          inventory_id: inventoryId,
          platform,
          platform_listing_id: listing.platformListingId,
          platform_url: listing.platformUrl,
          status: 'active',
          listed_price: price,
          listed_at: new Date().toISOString(),
          delisted_at: null,
        },
        { onConflict: 'inventory_id,platform' },
      )
      if (error) throw new Error(error.message)

      results.push({
        platform,
        status: 'active',
        platformUrl: listing.platformUrl,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await supabase
        .from('platform_listings')
        .upsert(
          { inventory_id: inventoryId, platform, status: 'error' },
          { onConflict: 'inventory_id,platform' },
        )
      results.push({ platform, status: 'error', error: message })
    }
  }

  if (results.some((r) => r.status === 'active')) {
    await supabase
      .from('inventory')
      .update({ status: 'active' })
      .eq('id', inventoryId)
  }

  return results
}

export type SaleResult = {
  inventoryId: string
  soldPlatform: Platform
  orderId: string | null
  /** null when purchase_cost is unknown - never guessed. */
  profit: number | null
  platformFee: number | null
  delisted: Array<{ platform: string; status: 'delisted' | 'error'; error?: string }>
}

/**
 * Record a sale and take the item down everywhere else.
 *
 * The selling platform's own listing is closed by that marketplace, so it
 * is marked delisted without an adapter call; every other active listing
 * gets an explicit delist. Health checking is deliberately NOT run here -
 * the caller triggers it separately so a hashing failure can never roll
 * back or block the sale being recorded.
 */
export async function recordSale(
  supabase: Client,
  inventoryId: string,
  soldPlatform: Platform,
  salePrice: number | null,
  buyerInfo: Record<string, unknown> | null = null,
  deps: OperationDeps = {},
): Promise<SaleResult> {
  const getAdapter = deps.getAdapter ?? defaultGetAdapter
  const soldAt = new Date().toISOString()
  const item = await loadItem(supabase, inventoryId)

  const { error: inventoryError } = await supabase
    .from('inventory')
    .update({
      status: 'sold',
      sold_at: soldAt,
      sold_platform: soldPlatform,
      sold_price: salePrice,
    })
    .eq('id', inventoryId)
  if (inventoryError) throw new Error(inventoryError.message)

  // Booked at sale time so a later fee-rate change cannot restate history.
  const breakdown = computeProfit(soldPlatform, salePrice, item.purchase_cost)

  const orderRow: Record<string, unknown> = {
    inventory_id: inventoryId,
    platform: soldPlatform,
    sale_price: salePrice,
    buyer_info: buyerInfo,
    status: 'pending',
  }
  if (breakdown) {
    orderRow.platform_fee = breakdown.fee
    orderRow.profit = breakdown.profit
  }

  let { data: order, error: orderError } = await supabase
    .from('orders')
    .insert(orderRow)
    .select('id')
    .single()

  // Migration 0002 adds platform_fee/profit. If it has not been applied,
  // record the sale anyway - losing a sale over a reporting column would
  // be a far worse failure than losing the profit figure.
  if (orderError && /platform_fee|profit|PGRST204/i.test(orderError.message)) {
    delete orderRow.platform_fee
    delete orderRow.profit
    ;({ data: order, error: orderError } = await supabase
      .from('orders')
      .insert(orderRow)
      .select('id')
      .single())
  }
  if (orderError) throw new Error(orderError.message)

  const { data: listings, error: listingsError } = await supabase
    .from('platform_listings')
    .select('*')
    .eq('inventory_id', inventoryId)
    .eq('status', 'active')
  if (listingsError) throw new Error(listingsError.message)

  const delisted: SaleResult['delisted'] = []

  for (const listing of listings ?? []) {
    try {
      if (listing.platform !== soldPlatform) {
        await getAdapter(listing.platform as Platform).delist(
          listing.platform_listing_id,
        )
      }
      const { error } = await supabase
        .from('platform_listings')
        .update({ status: 'delisted', delisted_at: soldAt })
        .eq('id', listing.id)
      if (error) throw new Error(error.message)

      delisted.push({ platform: listing.platform, status: 'delisted' })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await supabase
        .from('platform_listings')
        .update({ status: 'error' })
        .eq('id', listing.id)
      delisted.push({ platform: listing.platform, status: 'error', error: message })
    }
  }

  return {
    inventoryId,
    soldPlatform,
    orderId: order?.id ?? null,
    profit: breakdown?.profit ?? null,
    platformFee: breakdown?.fee ?? null,
    delisted,
  }
}

export type RelistResult = {
  platform: string
  status: 'active' | 'error'
  platformUrl?: string
  error?: string
}

/**
 * Re-push listings that went stale or were delisted in error. Refreshes
 * `last_relisted_at`, which is what a future staleness sweep will read.
 */
export async function relist(
  supabase: Client,
  inventoryId: string,
  platforms?: Platform[],
  deps: OperationDeps = {},
): Promise<RelistResult[]> {
  const getAdapter = deps.getAdapter ?? defaultGetAdapter
  const item = await loadItem(supabase, inventoryId)
  const photos = await loadPhotos(supabase, inventoryId)

  let query = supabase
    .from('platform_listings')
    .select('*')
    .eq('inventory_id', inventoryId)
  if (platforms?.length) query = query.in('platform', platforms)

  const { data: listings, error } = await query
  if (error) throw new Error(error.message)

  const now = new Date().toISOString()
  const results: RelistResult[] = []

  for (const listing of listings ?? []) {
    const platform = listing.platform as Platform
    const price = priceFor(item, platform)
    try {
      const created = await getAdapter(platform).relist(
        listing.platform_listing_id,
        contextFor(item, photos, platform, listing.platform_listing_id),
      )
      const { error: updateError } = await supabase
        .from('platform_listings')
        .update({
          platform_listing_id: created.platformListingId,
          platform_url: created.platformUrl,
          status: 'active',
          listed_price: price,
          delisted_at: null,
          last_relisted_at: now,
        })
        .eq('id', listing.id)
      if (updateError) throw new Error(updateError.message)

      results.push({
        platform,
        status: 'active',
        platformUrl: created.platformUrl,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      results.push({ platform, status: 'error', error: message })
    }
  }

  return results
}
