import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { hammingDistance, hashImageUrl, PHASH_MATCH_THRESHOLD } from '@/lib/phash'
import type { ListingPhoto } from '@/lib/types'

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

/**
 * Fills in any missing perceptual hashes, writing them back so the work is
 * done once per photo rather than once per check.
 */
async function ensureHashes(
  supabase: ReturnType<typeof createAdminClient>,
  photos: ListingPhoto[],
): Promise<{ photos: ListingPhoto[]; hashed: number }> {
  let hashed = 0
  const resolved: ListingPhoto[] = []

  for (const photo of photos) {
    if (photo.phash) {
      resolved.push(photo)
      continue
    }
    const phash = await hashImageUrl(photo.url)
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
 * Uses the service-role client deliberately: the check has to see the whole
 * table, not the subset a given request's user can read.
 */
export async function runHealthCheck(
  soldInventoryId: string,
): Promise<HealthCheckResult> {
  const supabase = createAdminClient()

  const { data: soldPhotosRaw, error: soldError } = await supabase
    .from('listing_photos')
    .select('*')
    .eq('inventory_id', soldInventoryId)
  if (soldError) throw new Error(soldError.message)

  const sold = await ensureHashes(supabase, soldPhotosRaw ?? [])

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

  const candidates = await ensureHashes(supabase, candidatePhotosRaw ?? [])

  // Best (lowest) distance per candidate item.
  const bestByItem = new Map<string, number>()
  for (const candidate of candidates.photos) {
    if (!candidate.phash || !candidate.inventory_id) continue
    for (const soldPhoto of sold.photos) {
      if (!soldPhoto.phash) continue
      const distance = hammingDistance(soldPhoto.phash, candidate.phash)
      const current = bestByItem.get(candidate.inventory_id)
      if (current === undefined || distance < current) {
        bestByItem.set(candidate.inventory_id, distance)
      }
    }
  }

  const matches = Array.from(bestByItem.entries()).filter(
    ([, distance]) => distance <= PHASH_MATCH_THRESHOLD,
  )

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
    .filter(([id]) => !alreadyFlagged.has(id))
    .map(([id, distance]) => ({
      sold_inventory_id: soldInventoryId,
      flagged_inventory_id: id,
      similarity_score: distance,
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
    flags: matches.map(([flaggedInventoryId, similarityScore]) => ({
      flaggedInventoryId,
      similarityScore,
    })),
  }
}
