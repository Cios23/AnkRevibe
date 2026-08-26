import { createClient } from '@/lib/supabase/server'
import type { Inventory, PlatformListing } from '@/lib/types'

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

export default async function ListingsPage() {
  const supabase = createClient()

  const [{ data: items, error }, { data: listings }] = await Promise.all([
    supabase.from('inventory').select('*').order('created_at', { ascending: false }),
    supabase.from('platform_listings').select('*'),
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

  const inventory = (items ?? []) as Inventory[]

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Listings</h1>
        <span className="text-sm text-neutral-500">{inventory.length} items</span>
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

                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <ItemActions
                    inventoryId={item.id}
                    isSold={item.status === 'sold'}
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
