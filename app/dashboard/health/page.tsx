import { createClient } from '@/lib/supabase/server'
import { PHASH_MATCH_THRESHOLD } from '@/lib/phash'

import { FlagActions, RescanButton } from './HealthActions'

export const dynamic = 'force-dynamic'

type FlagRow = {
  id: string
  similarity_score: number | null
  status: string | null
  created_at: string | null
  sold: { id: string; title: string | null; sold_platform: string | null } | null
  flagged: { id: string; title: string | null; status: string | null } | null
}

export default async function HealthPage() {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('inventory_health_flags')
    .select(
      `id, similarity_score, status, created_at,
       sold:inventory!inventory_health_flags_sold_inventory_id_fkey (id, title, sold_platform),
       flagged:inventory!inventory_health_flags_flagged_inventory_id_fkey (id, title, status)`,
    )
    .order('created_at', { ascending: false })

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load health flags: {error.message}
      </p>
    )
  }

  const flags = (data ?? []) as unknown as FlagRow[]
  const open = flags.filter((f) => f.status === 'open')

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inventory Health</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Photo matches within {PHASH_MATCH_THRESHOLD} bits of a sold item —
            likely still live somewhere it shouldn&apos;t be.
          </p>
        </div>
        <RescanButton />
      </div>

      <p className="mt-4 text-sm text-neutral-500">
        {open.length} open · {flags.length} total
      </p>

      {flags.length === 0 ? (
        <p className="mt-4 rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          No flags. Either nothing has sold yet, or every sale delisted cleanly.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {flags.map((flag) => (
            <li
              key={flag.id}
              className={`rounded-xl border bg-white p-4 ${
                flag.status === 'open'
                  ? 'border-amber-300'
                  : 'border-neutral-200 opacity-60'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <p>
                    <span className="font-medium">
                      {flag.flagged?.title ?? 'Untitled'}
                    </span>{' '}
                    <span className="text-neutral-500">
                      may be the same item as
                    </span>{' '}
                    <span className="font-medium">
                      {flag.sold?.title ?? 'Untitled'}
                    </span>
                    <span className="text-neutral-500">
                      , sold on {flag.sold?.sold_platform ?? 'unknown'}.
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Hamming distance {flag.similarity_score ?? '—'} · flagged item
                    status {flag.flagged?.status ?? 'unknown'}
                  </p>
                </div>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                  {flag.status}
                </span>
              </div>

              {flag.status === 'open' ? (
                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <FlagActions flagId={flag.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
