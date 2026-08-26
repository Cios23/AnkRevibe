import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from '@/lib/supabase/admin'
import { hammingDistance, hashImageUrl, PHASH_MATCH_THRESHOLD } from '@/lib/phash'
import type { Database, ListingPhoto } from '@/lib/types'

export type HealthCheckResult = {
  soldInventoryId: string
  photosHashed: number
  candidatesCompared: number
  flagsCreated: number
  flags: Array<{
    flaggedInventoryId: string
    similarityScore: number
  }>
}

/** Injectable seams so the pipeline is testable without a DB or network. */
export type HealthCheckDeps = {
  supabase?: SupabaseClient<Database>
  /** Resolves a photo URL to a perceptual hash, or null if it can't be read. */
  hashUrl?: (url: string) => Promise<string | null>
  threshold?: number
}

/**
 * The comparison itself, as a pure function: for each candidate item, the
 * closest distance between any of its photos and any photo of the sold
 * item. Items whose best distance is within `threshold` are matches.
 *
 * Kept separate from all I/O because this is the part with the actual
 * judgement in it, and the part worth testing exhaustively.
 */
export function findPhashMatches(
  soldPhotos: Pick<ListingPhoto, 'phash'>[],
  candidatePhotos: Pick<ListingPhoto, 'phash' | 'inventory_id'>[],
  threshold: number = PHASH_MATCH_THRESHOLD,
): Array<{ inventoryId: string; distance: number }> {
  const bestByItem = new Map<string, number>()

  for (const candidate of candidatePhotos) {
    if (!candidate.phash || !candidate.inventory_id) continue
    for (const sold of soldPhotos) {
      if (!sold.phash) continue
      const distance = hammingDistance(sold.phash, candidate.phash)
      const current = bestByItem.get(candidate.inventory_id)
      if (current === undefined || distance < current) {
        bestByItem.set(candidate.inventory_id, distance)
      }
    }
  }

  return Array.from(bestByItem.entries())
    .filter(([, distance]) => distance <= threshold)
    .map(([inventoryId, distance]) => ({ inventoryId, distance }))
    .sort((a, b) => a.distance - b.distance || a.inventoryId.localeCompare(b.inventoryId))
}

/**
 * Fills in any missing perceptual hashes, writing them back so the work is
 * done once per photo rather than once per check.
 */
async function ensureHashes(
  supabase: SupabaseClient<Database>,
  photos: ListingPhoto[],
  hashUrl: (url: string) => Promise<string | null>,
): Promise<{ photos: ListingPhoto[]; hashed: number }> {
  let hashed = 0
  const resolved: ListingPhoto[] = []

  for (const photo of photos) {
    if (photo.phash) {
      resolved.push(photo)
      continue
    }
    const phash = await hashUrl(photo.url)
    if (!phash) continue

    await supabase.from('listing_photos').update({ phash }).eq('id', photo.id)
    hashed++
    resolved.push({ ...photo, phash })
  }

  return { photos: resolved, hashed }
}

/**
 * Sync-failure detection.
 *
 * Compares every photo of the just-sold item against the photos of every
 * OTHER item that still has an active platform listing. A close perceptual
 * match means the same physical garment is probably still live somewhere
 * it should not be - either a delist call silently failed, or the item was
 * entered twice and only one copy was taken down.
 *
 * Defaults to the service-role client deliberately: the check has to see
 * the whole table, not the subset a given request's user can read.
 */
export async function runHealthCheck(
  soldInventoryId: string,
  deps: HealthCheckDeps = {},
): Promise<HealthCheckResult> {
  const supabase = deps.supabase ?? createAdminClient()
  const hashUrl = deps.hashUrl ?? hashImageUrl
  const threshold = deps.threshold ?? PHASH_MATCH_THRESHOLD

  const { data: soldPhotosRaw, error: soldError } = await supabase
    .from('listing_photos')
    .select('*')
    .eq('inventory_id', soldInventoryId)
  if (soldError) throw new Error(soldError.message)

  const sold = await ensureHashes(supabase, soldPhotosRaw ?? [], hashUrl)

  // Candidates: items other than the sold one that still have an active
  // listing on at least one platform.
  const { data: activeListings, error: listingsError } = await supabase
    .from('platform_listings')
    .select('inventory_id')
    .eq('status', 'active')
  if (listingsError) throw new Error(listingsError.message)

  const candidateIds = Array.from(
    new Set(
      (activeListings ?? [])
        .map((l) => l.inventory_id)
        .filter((id): id is string => !!id && id !== soldInventoryId),
    ),
  )

  if (candidateIds.length === 0 || sold.photos.length === 0) {
    return {
      soldInventoryId,
      photosHashed: sold.hashed,
      candidatesCompared: 0,
      flagsCreated: 0,
      flags: [],
    }
  }

  const { data: candidatePhotosRaw, error: candidateError } = await supabase
    .from('listing_photos')
    .select('*')
    .in('inventory_id', candidateIds)
  if (candidateError) throw new Error(candidateError.message)

  const candidates = await ensureHashes(
    supabase,
    candidatePhotosRaw ?? [],
    hashUrl,
  )

  const matches = findPhashMatches(sold.photos, candidates.photos, threshold)

  // Don't pile up duplicates if the check is run more than once.
  const { data: existing } = await supabase
    .from('inventory_health_flags')
    .select('flagged_inventory_id')
    .eq('sold_inventory_id', soldInventoryId)
    .eq('status', 'open')

  const alreadyFlagged = new Set(
    (existing ?? []).map((f) => f.flagged_inventory_id),
  )

  const toInsert = matches
    .filter((m) => !alreadyFlagged.has(m.inventoryId))
    .map((m) => ({
      sold_inventory_id: soldInventoryId,
      flagged_inventory_id: m.inventoryId,
      similarity_score: m.distance,
      status: 'open' as const,
    }))

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from('inventory_health_flags')
      .insert(toInsert)
    if (insertError) throw new Error(insertError.message)
  }

  return {
    soldInventoryId,
    photosHashed: sold.hashed + candidates.hashed,
    candidatesCompared: candidateIds.length,
    flagsCreated: toInsert.length,
    flags: matches.map((m) => ({
      flaggedInventoryId: m.inventoryId,
      similarityScore: m.distance,
    })),
  }
}
