import { NextResponse } from 'next/server'

import { badRequest, requireUser, serverError } from '@/lib/api'
import { isPlatform } from '@/lib/platforms'
import { crosspost } from '@/lib/operations'
import { PLATFORMS, type Platform } from '@/lib/types'

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

  const requested = body.platforms ?? PLATFORMS
  const invalid = requested.filter((p) => !isPlatform(p))
  if (invalid.length) return badRequest(`Unknown platform: ${invalid.join(', ')}`)

  try {
    const results = await crosspost(
      supabase,
      body.inventoryId,
      requested as Platform[],
    )
    return NextResponse.json({ results })
  } catch (cause) {
    return serverError(cause)
  }
}
