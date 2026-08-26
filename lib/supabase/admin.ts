import 'server-only'

import { createClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/types'

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only for server-side background work that must see across the whole
 * table regardless of the caller - the health check compares a sold item
 * against every other active listing. Never import this into a Client
 * Component; the `server-only` guard turns that into a build error.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
