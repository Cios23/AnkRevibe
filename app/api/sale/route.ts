import { NextResponse } from 'next/server'

import { badRequest, requireUser, serverError } from '@/lib/api'
import { isPlatform } from '@/lib/platforms'
import { recordSale } from '@/lib/operations'
import { runHealthCheck } from '@/lib/health'
import type { Platform } from '@/lib/types'

export const runtime = 'nodejs'
// Hashing every candidate photo can outrun the default budget on a big
// catalogue; 2 users' worth of inventory stays well inside this.
export const maxDuration = 60

/**
 * Record a sale: marks the item sold, opens an order, auto-delists every
 * other platform, then runs sync-failure detection.
 */
export async function POST(request: Request) {
  const { supabase, response } = await requireUser()
  if (response) return response

  let body: {
    inventoryId?: string
    platform?: string
    salePrice?: number
    buyerInfo?: Record<string, unknown>
  }
  try {
    body = await request.json()
  } catch {
    return badRequest('Body must be JSON')
  }

  if (!body.inventoryId) return badRequest('inventoryId is required')
  if (!body.platform || !isPlatform(body.platform)) {
    return badRequest('platform must be one of ebay, poshmark, depop, mercari')
  }

  try {
    const sale = await recordSale(
      supabase,
      body.inventoryId,
      body.platform as Platform,
      body.salePrice ?? null,
      body.buyerInfo ?? null,
    )

    // The sale is already durable at this point. A health-check failure is
    // reported but never fails the request.
    let health = null
    let healthError: string | null = null
    try {
      health = await runHealthCheck(body.inventoryId)
    } catch (cause) {
      healthError = cause instanceof Error ? cause.message : String(cause)
    }

    return NextResponse.json({ sale, health, healthError })
  } catch (cause) {
    return serverError(cause)
  }
}
