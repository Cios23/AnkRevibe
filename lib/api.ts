import 'server-only'

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

/**
 * Every route handler is behind middleware already; this is the second
 * gate, so a mistake in the matcher can't expose a write endpoint.
 */
export async function requireUser() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      supabase,
      user: null,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  return { supabase, user, response: null }
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export function serverError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return NextResponse.json({ error: message }, { status: 500 })
}
