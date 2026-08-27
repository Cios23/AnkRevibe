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

/**
 * Sale economics for a sold item.
 *
 * Shows the fee and cost as well as the profit: a bare profit number cannot
 * be checked against a payout report, and these are fee ESTIMATES rather
 * than reconciled figures.
 */
function ProfitLine({
  item,
  order,
}: {
  item: Inventory
  order: Order | undefined
}) {
  if (!order) return null

  const profit = order.profit == null ? null : Number(order.profit)
  const fee = order.platform_fee == null ? null : Number(order.platform_fee)

  if (profit === null) {
    return (
      <p className="mt-3 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
        Sold for {money(order.sale_price)} on {order.platform ?? 'unknown'} —
        profit unavailable
        {item.purchase_cost === null ? ' (no purchase cost recorded)' : ''}.
      </p>
    )
  }

  return (
    <div className="mt-3 border-t border-neutral-100 pt-3 text-xs">
      <span
        className={`font-medium ${profit >= 0 ? 'text-green-700' : 'text-red-600'}`}
      >
        {money(profit)} profit
      </span>
      <span className="text-neutral-500">
        {' — '}
        {money(order.sale_price)} sale
        {fee !== null ? ` − ${money(fee)} ${order.platform ?? ''} fee` : ''}
        {item.purchase_cost !== null
          ? ` − ${money(item.purchase_cost)} cost`
          : ''}
      </span>
    </div>
  )
}

export default async function ListingsPage() {
  const supabase = createClient()

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

  // Most recent order per item - an item can in principle sell more than
  // once if it was relisted after a cancelled sale.
  const orderByItem = new Map<string, Order>()
  for (const order of (orders ?? []) as Order[]) {
    if (!order.inventory_id) continue
    const seen = orderByItem.get(order.inventory_id)
    if (!seen || (order.created_at ?? '') > (seen.created_at ?? '')) {
      orderByItem.set(order.inventory_id, order)
    }
  }

  const inventory = (items ?? []) as Inventory[]

  const sold = inventory.filter((i) => i.status === 'sold')
  const totalProfit = sold.reduce((sum, item) => {
    const profit = orderByItem.get(item.id)?.profit
    return profit == null ? sum : sum + Number(profit)
  }, 0)
  const profitKnown = sold.filter(
    (i) => orderByItem.get(i.id)?.profit != null,
  ).length

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Listings</h1>
        <span className="text-sm text-neutral-500">
          {inventory.length} items
          {sold.length > 0 ? (
            <>
              {' · '}
              {sold.length} sold
              {profitKnown > 0 ? (
                <>
                  {' · '}
                  <span
                    className={
                      totalProfit >= 0 ? 'text-green-700' : 'text-red-600'
                    }
                  >
                    {money(totalProfit)} profit
                  </span>
                  {profitKnown < sold.length ? (
                    <span className="text-neutral-400">
                      {' '}
                      (from {profitKnown}/{sold.length})
                    </span>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </span>
      </div>

      {inventory.length === 0 ? (
        <p className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          No inventory yet. Seed a few rows in the Supabase dashboard, or run{' '}
          <code className="rounded bg-neutral-100 px-1">supabase/seed.sql</code>.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {inventory.map((item) => {
            const itemListings = byItem.get(item.id) ?? []
            return (
              <li
                key={item.id}
                className="rounded-xl border border-neutral-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {item.title ?? 'Untitled'}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {[item.brand, item.size, item.condition]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
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
                  <ProfitLine item={item} order={orderByItem.get(item.id)} />
                ) : null}

                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <ItemActions
                    inventoryId={item.id}
                    isSold={item.status === 'sold'}
                    hasPurchaseCost={item.purchase_cost !== null}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
