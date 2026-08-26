import { resolveCategoryId } from '@/lib/ebay/categories'
import { ebayFetch, EbayApiError, type EbayFetchOptions } from '@/lib/ebay/client'
import {
  ebayEnv,
  listingPolicyIds,
  marketplaceId,
  merchantLocationKey,
} from '@/lib/ebay/config'
import {
  conditionDescription,
  resolveConditionForCategory,
} from '@/lib/ebay/conditions'
import type {
  CreatedListing,
  ListingContext,
  PlatformAdapter,
} from '@/lib/platforms/adapter'
import { endItem, TradingApiError } from '@/lib/ebay/trading'
import {
  getLegacyListingDetail,
  isLegacyItemId,
  mergeAspects,
} from '@/lib/ebay/enrich'
import type { Inventory, Platform } from '@/lib/types'

/**
 * Real eBay integration, over the Sell Inventory API.
 *
 * The publish path is three calls, because eBay separates the *what* from
 * the *where it is sold*:
 *
 *   PUT  /inventory_item/{sku}   the garment - title, photos, condition
 *   POST /offer                  price, category, policies, quantity
 *   POST /offer/{id}/publish     makes it live, returns the item number
 *
 * We key everything off a deterministic SKU derived from our inventory id,
 * which makes the whole flow idempotent: re-running a crosspost replaces
 * the inventory item and updates the existing offer rather than creating a
 * duplicate listing.
 *
 * `platformListingId` stores the OFFER id, not the public item number,
 * because the offer is what withdraw/republish operate on. The item number
 * only appears in platform_url.
 */

const CURRENCY = () => process.env.EBAY_CURRENCY ?? 'USD'

/** eBay SKUs allow up to 50 chars; our uuid fits comfortably. */
export function skuFor(item: Pick<Inventory, 'id'>): string {
  return `ankrevibe-${item.id}`
}

function itemUrl(listingId: string): string {
  return ebayEnv() === 'sandbox'
    ? `https://sandbox.ebay.com/itm/${listingId}`
    : `https://www.ebay.com/itm/${listingId}`
}

/**
 * eBay item specifics. Empty values are omitted, except Brand and MPN.
 *
 * Many categories make the Brand/MPN pair mandatory and reject a publish
 * with error 25002 "Input data for tag <BrandMPN> is invalid or missing"
 * when either is absent - which is a *publish*-time failure, after the
 * inventory item and offer have already been created. Resale inventory
 * rarely has a manufacturer part number at all, so the accepted convention
 * is to state that explicitly rather than omit the field.
 */
export function buildAspects(item: Inventory): Record<string, string[]> {
  const aspects: Record<string, string[]> = {}
  const add = (name: string, value: string | null | undefined) => {
    const trimmed = value?.trim()
    if (trimmed) aspects[name] = [trimmed]
  }
  add('Size', item.size)
  add('Color', item.color)
  add('Style', item.style_era)
  add('Department', item.subcategory)

  aspects.Brand = [item.brand?.trim() || 'Unbranded']

  return aspects
}

export function buildDescription(item: Inventory): string {
  const parts: string[] = []
  if (item.description?.trim()) parts.push(item.description.trim())

  if (item.measurements && typeof item.measurements === 'object') {
    const rows = Object.entries(item.measurements as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `<li>${k}: ${String(v)}</li>`)
    if (rows.length) {
      parts.push(`<p><strong>Measurements</strong></p><ul>${rows.join('')}</ul>`)
    }
  }

  if (item.flaw_notes?.trim()) {
    parts.push(`<p><strong>Condition notes:</strong> ${item.flaw_notes.trim()}</p>`)
  }

  // eBay requires a non-empty description.
  return parts.join('\n') || item.title?.trim() || 'See photos.'
}

export class EbayAdapter implements PlatformAdapter {
  readonly platform: Platform = 'ebay'

  /** Injected in tests so no request leaves the process. */
  constructor(private fetchOptions: EbayFetchOptions = {}) {}

  private opts(extra: EbayFetchOptions = {}): EbayFetchOptions {
    return { ...this.fetchOptions, ...extra }
  }

  // ---------------------------------------------------------------- create

  async createListing(context: ListingContext): Promise<CreatedListing> {
    const { item, photos, price } = context

    if (price === null || price === undefined) {
      throw new Error(`Cannot list ${item.id} on eBay: no ebay_price set.`)
    }
    if (photos.length === 0) {
      throw new Error(`Cannot list ${item.id} on eBay: at least one photo is required.`)
    }

    // If eBay already carries this item, take its category and specifics
    // rather than inferring them. Categories require specifics we do not
    // model, and a wrong one only surfaces at publish - after the inventory
    // item and offer already exist.
    let categoryId: string | null = null
    let recoveredAspects: Record<string, string[]> = {}

    if (isLegacyItemId(context.existingPlatformListingId)) {
      try {
        const legacy = await getLegacyListingDetail(
          context.existingPlatformListingId!,
          this.tradingOptions(),
        )
        categoryId = legacy.categoryId
        recoveredAspects = legacy.aspects
      } catch {
        // Fall through to inference - a listing may have been ended since.
      }
    }

    // Category also decides the valid condition set, so it must be settled
    // before the inventory item is written.
    if (!categoryId) {
      categoryId = (await resolveCategoryId(item, this.opts())).categoryId
    }

    const sku = skuFor(item)
    await this.putInventoryItem(sku, context, categoryId, recoveredAspects)

    const offerId = await this.findOrCreateOffer(sku, context, categoryId)
    const listingId = await this.publishOffer(offerId)

    return { platformListingId: offerId, platformUrl: itemUrl(listingId) }
  }

  /** Idempotent by design - PUT replaces whatever is there. */
  /** Trading API transport, sharing the injected fetch used for REST. */
  private tradingOptions() {
    return {
      fetchImpl: this.fetchOptions.fetchImpl,
      getToken: this.fetchOptions.getToken,
      sleep: this.fetchOptions.sleep,
    }
  }

  private async putInventoryItem(
    sku: string,
    context: ListingContext,
    categoryId: string,
    recoveredAspects: Record<string, string[]> = {},
  ) {
    const { item, photos } = context

    const condition = await resolveConditionForCategory(
      item.condition,
      categoryId,
      this.opts(),
    )

    const imageUrls = [...photos]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((p) => p.url)
      .slice(0, 24) // eBay's per-listing image cap

    await ebayFetch(
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      this.opts({
        method: 'PUT',
        // Required on inventory item writes; eBay 400s without it.
        headers: { 'Content-Language': 'en-US' },
        body: {
          availability: {
            shipToLocationAvailability: { quantity: 1 },
          },
          condition,
          conditionDescription: conditionDescription(
            item.condition,
            item.flaw_notes,
          ),
          product: {
            title: (item.title ?? 'Untitled').slice(0, 80), // eBay title cap
            description: buildDescription(item),
            brand: item.brand?.trim() || 'Unbranded',
            // Product identifiers, NOT aspects. Many categories require one
            // and reject the publish with error 25002 "<BrandMPN> is invalid
            // or missing" when none is present - a publish-time failure,
            // after the inventory item and offer already exist. Second-hand
            // clothing has no manufacturer part number or barcode, so the
            // accepted convention is to say so explicitly.
            mpn: 'Does Not Apply',
            upc: ['Does not apply'],
            aspects: mergeAspects(buildAspects(item), recoveredAspects),
            imageUrls,
          },
        },
      }),
    )
  }

  private async findOfferId(sku: string): Promise<string | null> {
    try {
      const result = await ebayFetch<{ offers?: Array<{ offerId?: string }> }>(
        `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}` +
          `&marketplace_id=${marketplaceId()}`,
        this.opts(),
      )
      return result?.offers?.[0]?.offerId ?? null
    } catch (cause) {
      // No offer yet is a 404 here, not an error condition.
      if (cause instanceof EbayApiError && cause.isNotFound) return null
      throw cause
    }
  }

  private async findOrCreateOffer(
    sku: string,
    context: ListingContext,
    categoryId: string,
  ): Promise<string> {
    const { item, price } = context

    const payload = {
      sku,
      marketplaceId: marketplaceId(),
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      categoryId,
      listingDescription: buildDescription(item),
      listingPolicies: listingPolicyIds(),
      merchantLocationKey: merchantLocationKey(),
      pricingSummary: {
        price: { value: String(price), currency: CURRENCY() },
      },
    }

    const existing = await this.findOfferId(sku)

    if (existing) {
      await ebayFetch(
        `/sell/inventory/v1/offer/${existing}`,
        this.opts({ method: 'PUT', body: payload }),
      )
      return existing
    }

    const created = await ebayFetch<{ offerId?: string }>(
      '/sell/inventory/v1/offer',
      this.opts({ method: 'POST', body: payload }),
    )

    if (!created?.offerId) {
      throw new Error(`eBay created an offer for ${sku} but returned no offerId`)
    }
    return created.offerId
  }

  private async publishOffer(offerId: string): Promise<string> {
    const published = await ebayFetch<{ listingId?: string }>(
      `/sell/inventory/v1/offer/${offerId}/publish`,
      this.opts({ method: 'POST' }),
    )
    if (!published?.listingId) {
      throw new Error(`eBay published offer ${offerId} but returned no listingId`)
    }
    return published.listingId
  }

  // ---------------------------------------------------------------- delist

  /**
   * Withdraw the offer, ending the live listing but keeping the offer and
   * inventory item so a relist is a republish rather than a rebuild.
   *
   * Idempotent: a 404, or eBay's "offer is not published" (25002), both
   * mean the listing is already down, which is the desired end state.
   */
  async delist(platformListingId: string | null): Promise<void> {
    if (!platformListingId) return

    try {
      await ebayFetch(
        `/sell/inventory/v1/offer/${platformListingId}/withdraw`,
        this.opts({ method: 'POST' }),
      )
      return
    } catch (cause) {
      if (cause instanceof EbayApiError) {
        // 25002: offer exists but is not published - already down.
        if (cause.errors.some((e) => e.errorId === 25002)) return

        // No such offer. This is the normal case for a listing IMPORTED
        // from the account rather than published by us: it is a legacy
        // listing identified by ItemID, with no offer behind it. Returning
        // here would silently leave it live, so fall through to EndItem.
        if (cause.isNotFound || cause.errors.some((e) => e.errorId === 25713)) {
          await this.endLegacyListing(platformListingId)
          return
        }
      }
      throw cause
    }
  }

  /** Ends a legacy (UI- or import-originated) listing via the Trading API. */
  private async endLegacyListing(itemId: string): Promise<void> {
    try {
      // Pass the injected transport through so tests never reach eBay.
      await endItem(itemId, 'NotAvailable', this.tradingOptions())
    } catch (cause) {
      if (cause instanceof TradingApiError) {
        // 1047 / 1048: auction already ended or item not found - the
        // desired end state already holds.
        if (cause.errors.some((e) => e.code === '1047' || e.code === '1048')) {
          return
        }
      }
      throw cause
    }
  }

  // ---------------------------------------------------------------- relist

  async relist(
    platformListingId: string | null,
    context: ListingContext,
  ): Promise<CreatedListing> {
    // Rebuilding from the SKU covers both cases - an offer we withdrew and
    // one that never existed - and picks up any price or photo edits made
    // since the original listing.
    return this.createListing(context)
  }
}
