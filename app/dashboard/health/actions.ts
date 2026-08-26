'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/supabase/server'
import { runHealthCheck } from '@/lib/health'
import type { HealthFlagStatus } from '@/lib/types'

export async function setFlagStatus(flagId: string, status: HealthFlagStatus) {
  const supabase = createClient()
  await supabase
    .from('inventory_health_flags')
    .update({ status })
    .eq('id', flagId)
  revalidatePath('/dashboard/health')
}

/** Re-run detection for every sold item. Manual trigger for now. */
export async function rescanAction() {
  const supabase = createClient()
  const { data: sold } = await supabase
    .from('inventory')
    .select('id')
    .eq('status', 'sold')

  for (const item of sold ?? []) {
    try {
      await runHealthCheck(item.id)
    } catch {
      // One bad image URL shouldn't abort the whole sweep.
    }
  }
  revalidatePath('/dashboard/health')
}
