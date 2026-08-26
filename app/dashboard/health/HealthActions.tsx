'use client'

import { useTransition } from 'react'

import { rescanAction, setFlagStatus } from './actions'
import type { HealthFlagStatus } from '@/lib/types'

const buttonClass =
  'rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:opacity-50'

export function RescanButton() {
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => rescanAction())}
      className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
    >
      {pending ? 'Scanning…' : 'Re-run scan'}
    </button>
  )
}

export function FlagActions({ flagId }: { flagId: string }) {
  const [pending, startTransition] = useTransition()

  const update = (status: HealthFlagStatus) =>
    startTransition(() => setFlagStatus(flagId, status))

  return (
    <div className="flex gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => update('resolved')}
        className={buttonClass}
      >
        Resolved
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => update('dismissed')}
        className={buttonClass}
      >
        Dismiss
      </button>
    </div>
  )
}
