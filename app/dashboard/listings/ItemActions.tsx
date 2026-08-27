'use client'

import { useState, useTransition } from 'react'

import {
  crosspostAction,
  markSoldAction,
  relistAction,
  type ActionResult,
} from './actions'
import { PLATFORMS, type Platform } from '@/lib/types'

const buttonClass =
  'rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:opacity-50'

export function ItemActions({
  inventoryId,
  isSold,
  hasPurchaseCost,
}: {
  inventoryId: string
  isSold: boolean
  hasPurchaseCost: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [platform, setPlatform] = useState<Platform>('ebay')
  const [error, setError] = useState<string | null>(null)

  if (isSold) {
    return <span className="text-xs text-neutral-400">Sold</span>
  }

  const run = (action: () => Promise<ActionResult>) => {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) setError(result.error)
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => crosspostAction(inventoryId))}
          className={buttonClass}
        >
          Crosspost
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => relistAction(inventoryId))}
          className={buttonClass}
        >
          Relist
        </button>
        <select
          value={platform}
          disabled={pending}
          onChange={(event) => setPlatform(event.target.value as Platform)}
          aria-label="Sold on platform"
          className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs"
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(() => markSoldAction(inventoryId, platform))
          }
          className="rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
        >
          Mark sold
        </button>
      </div>

      {!hasPurchaseCost ? (
        <p className="text-xs text-neutral-500">
          No purchase cost — listing still works, but profit and ROI stay
          unknown for this item until one is entered.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}
