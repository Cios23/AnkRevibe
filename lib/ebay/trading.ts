import { XMLParser } from 'fast-xml-parser'

import { ebayEnv } from '@/lib/ebay/config'
import { getAccessToken } from '@/lib/ebay/oauth'

/**
 * Legacy Trading API client.
 *
 * The modern Sell Inventory API only knows about listings created through
 * it, so for an account whose listings were made in the eBay UI it returns
 * nothing (verified: inventory_item total = 0 on this account). The Trading
 * API is the only path to that existing inventory.
 *
 * It speaks XML over a single endpoint, and accepts our OAuth access token
 * through the X-EBAY-API-IAF-TOKEN header - no separate Auth'n'Auth token
 * is needed.
 */

const COMPAT_LEVEL = '1193'
const SITE_ID = '0' // EBAY_US

function tradingHost(): string {
  return ebayEnv() === 'sandbox'
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Values like SKUs and item ids must not be coerced to numbers - a
  // leading zero or a 19-digit id would be corrupted.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

/**
 * Parsed XML is structurally dynamic - eBay omits absent nodes entirely and
 * collapses single-element lists - so callers narrow it themselves rather
 * than us pretending to a schema the API does not guarantee.
 */
export type TradingEnvelope = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export class TradingApiError extends Error {
  constructor(
    message: string,
    readonly errors: Array<{ code: string; message: string; severity: string }>,
  ) {
    super(message)
    this.name = 'TradingApiError'
  }
}

/** fast-xml-parser collapses single-element lists; this re-expands them. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export type TradingOptions = {
  fetchImpl?: typeof fetch
  getToken?: () => Promise<string>
  attempts?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function tradingCall(
  callName: string,
  innerXml: string,
  options: TradingOptions = {},
): Promise<TradingEnvelope> {
  const {
    fetchImpl = fetch,
    getToken = getAccessToken,
    attempts = 3,
    sleep = defaultSleep,
  } = options

  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">\n` +
    innerXml +
    `\n</${callName}Request>`

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const token = await getToken()

    const response = await fetchImpl(tradingHost(), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': SITE_ID,
        'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body,
    })

    const text = await response.text()

    if (!response.ok) {
      lastError = new Error(`${callName} HTTP ${response.status}`)
      if (attempt < attempts && response.status >= 500) {
        await sleep(500 * 2 ** (attempt - 1))
        continue
      }
      throw lastError
    }

    const parsed = parser.parse(text)
    const envelope = parsed[`${callName}Response`]

    if (!envelope) {
      throw new Error(`${callName}: unrecognised response shape`)
    }

    const errors = asArray(envelope.Errors).map((e: TradingEnvelope) => ({
      code: String(e.ErrorCode ?? ''),
      message: String(e.LongMessage ?? e.ShortMessage ?? ''),
      severity: String(e.SeverityCode ?? ''),
    }))

    // Warnings ride along with successful calls; only Failure is fatal.
    if (envelope.Ack === 'Failure') {
      const fatal = errors.filter((e) => e.severity !== 'Warning')
      throw new TradingApiError(
        `${callName} failed: ${fatal.map((e) => `[${e.code}] ${e.message}`).join('; ')}`,
        errors,
      )
    }

    return envelope
  }

  throw lastError ?? new Error(`${callName} failed`)
}

// --------------------------------------------------------------------------

export type ActiveListingSummary = {
  itemId: string
  title: string
  price: number | null
  currency: string | null
  viewUrl: string | null
  galleryUrl: string | null
  quantityAvailable: number | null
}

/**
 * One page of active listings.
 *
 * ActiveList is deliberately sparse - it carries no category, condition,
 * description or item specifics, and only a single GalleryURL rather than
 * the full photo set. Those require a GetItem call per item.
 */
export async function getMyeBaySellingActive(
  page: number,
  perPage = 200,
  options: TradingOptions = {},
): Promise<{ items: ActiveListingSummary[]; total: number; totalPages: number }> {
  const envelope = await tradingCall(
    'GetMyeBaySelling',
    `  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${perPage}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>`,
    options,
  )

  const list = envelope.ActiveList ?? {}
  const items = asArray(list.ItemArray?.Item).map(
    (item: TradingEnvelope): ActiveListingSummary => ({
      itemId: String(item.ItemID ?? ''),
      title: String(item.Title ?? ''),
      price: toNumber(item.SellingStatus?.CurrentPrice?.['#text']),
      currency: item.SellingStatus?.CurrentPrice?.['@currencyID'] ?? null,
      viewUrl: item.ListingDetails?.ViewItemURL ?? null,
      galleryUrl: item.PictureDetails?.GalleryURL ?? null,
      quantityAvailable: toNumber(item.QuantityAvailable),
    }),
  )

  return {
    items,
    total: toNumber(list.PaginationResult?.TotalNumberOfEntries) ?? 0,
    totalPages: toNumber(list.PaginationResult?.TotalNumberOfPages) ?? 0,
  }
}

export type SoldListingSummary = {
  itemId: string
  title: string
  salePrice: number | null
  saleDate: string | null
  transactionId: string | null
  buyerId: string | null
  quantity: number | null
}

export async function getMyeBaySellingSold(
  page: number,
  perPage = 200,
  options: TradingOptions = {},
): Promise<{ items: SoldListingSummary[]; total: number; totalPages: number }> {
  const envelope = await tradingCall(
    'GetMyeBaySelling',
    `  <SoldList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${perPage}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </SoldList>`,
    options,
  )

  const list = envelope.SoldList ?? {}

  // SoldList nests transactions under OrderTransactionArray, and single
  // sales and multi-item orders have different shapes.
  const transactions = [
    ...asArray(list.OrderTransactionArray?.OrderTransaction),
    ...asArray(list.TransactionArray?.Transaction).map((t: TradingEnvelope) => ({
      Transaction: t,
    })),
  ]

  const items = transactions
    .map((entry: TradingEnvelope): SoldListingSummary | null => {
      const tx = entry.Transaction ?? entry.Order?.TransactionArray?.Transaction
      const one = Array.isArray(tx) ? tx[0] : tx
      if (!one?.Item?.ItemID) return null
      return {
        itemId: String(one.Item.ItemID),
        title: String(one.Item.Title ?? ''),
        salePrice: toNumber(one.TransactionPrice?.['#text']),
        saleDate: one.PaidTime ?? one.CreatedDate ?? null,
        transactionId: one.TransactionID ? String(one.TransactionID) : null,
        buyerId: one.Buyer?.UserID ? String(one.Buyer.UserID) : null,
        quantity: toNumber(one.QuantityPurchased),
      }
    })
    .filter((x): x is SoldListingSummary => x !== null)

  return {
    items,
    total: toNumber(list.PaginationResult?.TotalNumberOfEntries) ?? 0,
    totalPages: toNumber(list.PaginationResult?.TotalNumberOfPages) ?? 0,
  }
}

export type ItemDetail = {
  itemId: string
  title: string | null
  description: string | null
  categoryId: string | null
  categoryName: string | null
  conditionId: string | null
  conditionName: string | null
  price: number | null
  quantity: number | null
  sku: string | null
  viewUrl: string | null
  pictureUrls: string[]
  specifics: Record<string, string>
}

/** Full detail for one listing - the only source of photos and specifics. */
export async function getItem(
  itemId: string,
  options: TradingOptions = {},
): Promise<ItemDetail> {
  const envelope = await tradingCall(
    'GetItem',
    `  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>`,
    options,
  )

  const item = envelope.Item ?? {}

  const specifics: Record<string, string> = {}
  for (const nv of asArray<TradingEnvelope>(item.ItemSpecifics?.NameValueList)) {
    const name = nv?.Name
    const value = asArray(nv?.Value)[0]
    if (name && value !== undefined) specifics[String(name)] = String(value)
  }

  return {
    itemId: String(item.ItemID ?? itemId),
    title: item.Title ?? null,
    description: item.Description ?? null,
    categoryId: item.PrimaryCategory?.CategoryID
      ? String(item.PrimaryCategory.CategoryID)
      : null,
    categoryName: item.PrimaryCategory?.CategoryName ?? null,
    conditionId: item.ConditionID ? String(item.ConditionID) : null,
    conditionName: item.ConditionDisplayName ?? null,
    price: toNumber(item.SellingStatus?.CurrentPrice?.['#text'] ?? item.StartPrice?.['#text']),
    quantity: toNumber(item.Quantity),
    sku: item.SKU ? String(item.SKU) : null,
    viewUrl: item.ListingDetails?.ViewItemURL ?? null,
    pictureUrls: asArray(item.PictureDetails?.PictureURL).map(String),
    specifics,
  }
}

/** Ends a legacy listing. Imported listings have no offer to withdraw. */
export async function endItem(
  itemId: string,
  reason = 'NotAvailable',
  options: TradingOptions = {},
): Promise<void> {
  await tradingCall(
    'EndItem',
    `  <ItemID>${itemId}</ItemID>
  <EndingReason>${reason}</EndingReason>`,
    options,
  )
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
