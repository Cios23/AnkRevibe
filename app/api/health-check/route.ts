import { NextResponse } from 'next/server'

import { badRequest, requireUser, serverError } from '@/lib/api'
import { runHealthCheck } from '@/lib/health'

// sharp is a native module - this must not run on the edge runtime.
export const runtime = 'nodejs'
export const maxDuration = 60

/** Manually re-run sync-failure detection for one sold item. */
export async function POST(request: Request) {
  const { response } = await requireUser()
  if (response) return response

  let body: { inventoryId?: string }
  try {
    body = await request.json()
  } catch {
    return badRequest('Body must be JSON')
  }

  if (!body.inventoryId) return badRequest('inventoryId is required')

  try {
    return NextResponse.json(await runHealthCheck(body.inventoryId))
  } catch (cause) {
    return serverError(cause)
  }
}
