'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'
import { crosspost, recordSale, relist } from '@/lib/operations'
import { runHealthCheck } from '@/lib/health'
import { PLATFORMS, type Platform } from '@/lib/types'

export async function crosspostAction(inventoryId: string) {
  const supabase = createClient()
  await crosspost(supabase, inventoryId, PLATFORMS)
  revalidatePath('/dashboard/listings')
}

export async function relistAction(inventoryId: string) {
  const supabase = createClient()
  await relist(supabase, inventoryId)
  revalidatePath('/dashboard/listings')
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
