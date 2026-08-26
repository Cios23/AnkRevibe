import type { PlatformAdapter } from '@/lib/platforms/adapter'
import { StubAdapter } from '@/lib/platforms/stub'
import { PLATFORMS, type Platform } from '@/lib/types'

const registry: Record<Platform, PlatformAdapter> = {
  ebay: new StubAdapter('ebay'),
  poshmark: new StubAdapter('poshmark'),
  depop: new StubAdapter('depop'),
  mercari: new StubAdapter('mercari'),
}

export function getAdapter(platform: Platform): PlatformAdapter {
  return registry[platform]
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as string[]).includes(value)
}
