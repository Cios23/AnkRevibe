import Link from 'next/link'

import { computeRoi, formatRoi, partitionRankable } from '@/lib/fees'
import { createClient } from '@/lib/supabase/server'
import type { Inventory, Order, PlatformListing } from '@/lib/types'

import { ItemActions } from './ItemActions'

export const dynamic = 'force-dynamic'

const statusStyles: Record<string, string> = {
  draft: 'bg-neutral-100 text-neutral-600',
  active: 'bg-green-100 text-green-700',
  sold: 'bg-blue-100 text-blue-700',
  archived: 'bg-neutral-100 text-neutral-400',
}

function money(value: number | null) {
  return value === null ? '—' : `$${Number(value).toFixed(2)}`
}

type Sort = 'recent' | 'roi' | 'profit'

const SORTS: Array<{ key: Sort; label: string }> = [
  { key: 'recent', label: 'Recent' },
  { key: 'roi', label: 'ROI' },
  { key: 'profit', label: 'Profit' },
]

/** Everything the view needs about one item's economics. */
type Economics = {
  order: Order | undefined
  profit: number | null
  fee: number | null
  cost: number | null
  roi: number | null
  /** Sold, but we cannot rank it - no cost recorded. */
  unknownCost: boolean
}

function economicsFor(item: Inventory, order: Order | undefined): Economics {
  const cost = item.purchase_cost === null ? null : Number(item.purchase_cost)
  const profit = order?.profit == null ? null : Number(order.profit)
  const fee = order?.platform_fee == null ? null : Number(order.platform_fee)
  return {
    order,
    profit,
    fee,
    cost,
    roi: computeRoi(profit, cost),
    unknownCost: item.status === 'sold' && cost === null,
  }
}

/**
 * Sale economics for a sold item.
 *
 * Shows fee and cost alongside profit: a bare profit figure cannot be
 * checked against a payout report, and these are fee ESTIMATES rather than
 * reconciled numbers.
 */
function ProfitLine({ econ }: { econ: Economics }) {
  if (!econ.order) return null

  if (econ.profit === null) {
    return (
      <div className="mt-3 border-t border-neutral-100 pt-3 text-xs">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-500">
          no cost data
        </span>
        <span className="ml-2 text-neutral-500">
          Sold for {money(econ.order.sale_price)} on{' '}
          {econ.order.platform ?? 'unknown'} — profit unknown until a purchase
          cost is entered.
        </span>
      </div>
    )
  }

  return (
    <div className="mt-3 border-t border-neutral-100 pt-3 text-xs">
      <span
        className={`font-medium ${
          econ.profit >= 0 ? 'text-green-700' : 'text-red-600'
        }`}
      >
        {money(econ.profit)} profit
      </span>
      {econ.roi !== null ? (
        <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700">
          {formatRoi(econ.roi)} ROI
        </span>
      ) : null}
      <span className="ml-2 text-neutral-500">
        {money(econ.order.sale_price)} sale
        {econ.fee !== null
          ? ` − ${money(econ.fee)} ${econ.order.platform ?? ''} fee`
          : ''}
        {econ.cost !== null ? ` − ${money(econ.cost)} cost` : ''}
      </span>
    </div>
  )
}

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: { sort?: string }
}) {
  const supabase = createClient()
  const sort: Sort = SORTS.some((s) => s.key === searchParams.sort)
    ? (searchParams.sort as Sort)
    : 'recent'

  const [{ data: items, error }, { data: listings }, { data: orders }] =
    await Promise.all([
      supabase.from('inventory').select('*').order('created_at', { ascending: false }),
      supabase.from('platform_listings').select('*'),
      supabase.from('orders').select('*'),
    ])

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load inventory: {error.message}
      </p>
    )
  }

  const byItem = new Map<string, PlatformListing[]>()
  for (const listing of (listings ?? []) as PlatformListing[]) {
    if (!listing.inventory_id) continue
    const existing = byItem.get(listing.inventory_id) ?? []
    existing.push(listing)
    byItem.set(listing.inventory_id, existing)
  }

  // Most recent order per item - an item can sell more than once if it was
  // relisted after a cancelled sale.
  const orderByItem = new Map<string, Order>()
  for (const order of (orders ?? []) as Order[]) {
    if (!order.inventory_id) continue
    const seen = orderByItem.get(order.inventory_id)
    if (!seen || (order.created_at ?? '') > (seen.created_at ?? '')) {
      orderByItem.set(order.inventory_id, order)
    }
  }

  const inventory = (items ?? []) as Inventory[]
  const econOf = new Map<string, Economics>(
    inventory.map((i) => [i.id, economicsFor(i, orderByItem.get(i.id))]),
  )

  const soldItems = inventory.filter((i) => i.status === 'sold')

  // Totals only from items whose cost we actually know. Counting an
  // unknown-cost sale as zero-cost would overstate profit.
  const knownProfit = soldItems.filter(
    (i) => econOf.get(i.id)!.profit !== null,
  )
  const totalProfit = knownProfit.reduce(
    (sum, i) => sum + econOf.get(i.id)!.profit!,
    0,
  )

  // Ranked views cover sold items only, and split off the ones that cannot
  // honestly be ranked rather than sorting them as if cost were zero.
  let ordered: Inventory[]
  let unrankable: Inventory[] = []

  if (sort === 'recent') {
    ordered = inventory
  } else {
    const { rankable, unknown } = partitionRankable(soldItems, (i) => {
      const e = econOf.get(i.id)!
      return { profit: e.profit, purchaseCost: e.cost, roi: e.roi }
    })
    const key = (i: Inventory) =>
      sort === 'roi' ? econOf.get(i.id)!.roi! : econOf.get(i.id)!.profit!
    ordered = [...rankable].sort((a, b) => key(b) - key(a))
    unrankable = unknown
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Listings</h1>
        <span className="text-sm text-neutral-500">
          {inventory.length} items
          {soldItems.length > 0 ? (
            <>
              {' · '}
              {soldItems.length} sold
              {knownProfit.length > 0 ? (
                <>
                  {' · '}
                  <span
                    className={totalProfit >= 0 ? 'text-green-700' : 'text-red-600'}
                  >
                    {money(totalProfit)} profit
                  </span>
                  {knownProfit.length < soldItems.length ? (
                    <span className="text-neutral-400">
                      {' '}
                      (from {knownProfit.length}/{soldItems.length} with cost data)
                    </span>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </span>
      </div>

      <nav className="mt-3 flex gap-1 text-xs">
        {SORTS.map((option) => (
          <Link
            key={option.key}
            href={`/dashboard/listings?sort=${option.key}`}
            className={`rounded-lg px-2.5 py-1 transition ${
              sort === option.key
                ? 'bg-neutral-900 font-medium text-white'
                : 'border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {option.label}
          </Link>
        ))}
        {sort !== 'recent' ? (
          <span className="self-center pl-2 text-neutral-400">
            sold items only, ranked by {sort === 'roi' ? 'return on cost' : 'profit'}
          </span>
        ) : null}
      </nav>

      {ordered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          {sort === 'recent'
            ? 'No inventory yet.'
            : 'Nothing to rank yet — needs a sale and a recorded purchase cost.'}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {ordered.map((item) => {
            const itemListings = byItem.get(item.id) ?? []
            const econ = econOf.get(item.id)!
            return (
              <li
                key={item.id}
                className="rounded-xl border border-neutral-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.title ?? 'Untitled'}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {[item.brand, item.size, item.condition]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
                      {' · '}
                      {econ.cost === null ? (
                        <span className="text-neutral-400">cost unknown</span>
                      ) : (
                        <span>cost {money(econ.cost)}</span>
                      )}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      statusStyles[item.status ?? 'draft'] ?? statusStyles.draft
                    }`}
                  >
                    {item.status ?? 'draft'}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {itemListings.length === 0 ? (
                    <span className="text-xs text-neutral-400">
                      Not listed anywhere
                    </span>
                  ) : (
                    itemListings.map((listing) => (
                      <span
                        key={listing.id}
                        title={listing.platform_url ?? undefined}
                        className={`rounded-md border px-2 py-0.5 text-xs ${
                          listing.status === 'active'
                            ? 'border-green-200 bg-green-50 text-green-700'
                            : listing.status === 'error'
                              ? 'border-red-200 bg-red-50 text-red-700'
                              : 'border-neutral-200 bg-neutral-50 text-neutral-500'
                        }`}
                      >
                        {listing.platform} · {listing.status}
                        {listing.listed_price !== null
                          ? ` · ${money(listing.listed_price)}`
                          : ''}
                      </span>
                    ))
                  )}
                </div>

                {item.status === 'sold' ? (
                  <ProfitLine econ={econ} />
                ) : null}

                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <ItemActions
                    inventoryId={item.id}
                    isSold={item.status === 'sold'}
                    hasPurchaseCost={econ.cost !== null}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {unrankable.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-600">
            Not ranked — {unrankable.length} sold{' '}
            {unrankable.length === 1 ? 'item' : 'items'} without cost data
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Excluded from the ranking above rather than treated as zero-cost.
            Enter a purchase cost and they join it.
          </p>
          <ul className="mt-3 space-y-2">
            {unrankable.map((item) => {
              const econ = econOf.get(item.id)!
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm text-neutral-600">
                    {item.title ?? 'Untitled'}
                  </span>
                  <span className="text-xs text-neutral-500">
                    sold {money(econ.order?.sale_price ?? null)} ·{' '}
                    <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium text-neutral-600">
                      no cost data
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
