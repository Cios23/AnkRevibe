'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'
import { crosspost, recordSale, relist } from '@/lib/operations'
import { runHealthCheck } from '@/lib/health'
import { PLATFORMS, type Platform } from '@/lib/types'

export type ActionResult = { ok: true } | { ok: false; error: string }

export async function crosspostAction(
  inventoryId: string,
): Promise<ActionResult> {
  const supabase = createClient()
  try {
    await crosspost(supabase, inventoryId, PLATFORMS)
  } catch (cause) {
    // Surfaced in the UI rather than thrown, so a missing cost basis reads
    // as an instruction instead of a crash.
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
  revalidatePath('/dashboard/listings')
  return { ok: true }
}

export async function relistAction(
  inventoryId: string,
): Promise<ActionResult> {
  const supabase = createClient()
  try {
    await relist(supabase, inventoryId)
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
  revalidatePath('/dashboard/listings')
  return { ok: true }
}

/**
 * Marks the item sold on `platform`, auto-delists everywhere else, then
 * runs sync-failure detection. Health failures are swallowed so a bad
 * image URL can't make a sale look like it failed.
 */
export async function markSoldAction(inventoryId: string, platform: Platform) {
  const supabase = createClient()
  const { data: item } = await supabase
    .from('inventory')
    .select('*')
    .eq('id', inventoryId)
    .single()

  const price =
    item && platform === 'ebay'
      ? item.ebay_price
      : item && platform === 'poshmark'
        ? item.poshmark_price
        : item && platform === 'depop'
          ? item.depop_price
          : (item?.mercari_price ?? null)

  await recordSale(supabase, inventoryId, platform, price ?? null)

  try {
    await runHealthCheck(inventoryId)
  } catch {
    // Surfaced on the Health page's manual re-run instead.
  }

  revalidatePath('/dashboard/listings')
  revalidatePath('/dashboard/health')
}
