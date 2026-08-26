import Link from 'next/link'

import { signOut } from '@/app/login/actions'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-sm font-semibold tracking-tight">AnK ReVibe</span>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/dashboard/listings"
              className="rounded-lg px-3 py-1.5 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
            >
              Listings
            </Link>
            <Link
              href="/dashboard/health"
              className="rounded-lg px-3 py-1.5 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
            >
              Health
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-lg px-3 py-1.5 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
              >
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  )
}
