import { NextResponse } from 'next/server'

import { badRequest, requireUser, serverError } from '@/lib/api'
import { isPlatform } from '@/lib/platforms'
import { relist } from '@/lib/operations'
import type { Platform } from '@/lib/types'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const { supabase, response } = await requireUser()
  if (response) return response

  let body: { inventoryId?: string; platforms?: string[] }
  try {
    body = await request.json()
  } catch {
    return badRequest('Body must be JSON')
  }

  if (!body.inventoryId) return badRequest('inventoryId is required')

  const invalid = (body.platforms ?? []).filter((p) => !isPlatform(p))
  if (invalid.length) return badRequest(`Unknown platform: ${invalid.join(', ')}`)

  try {
    const results = await relist(
      supabase,
      body.inventoryId,
      body.platforms as Platform[] | undefined,
    )
    return NextResponse.json({ results })
  } catch (cause) {
    return serverError(cause)
  }
}
