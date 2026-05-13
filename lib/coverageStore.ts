import fs from 'fs'
import path from 'path'

const STORE_PATH = path.join(process.cwd(), 'coverage.json')

export interface CoverageEntry {
  templateKey: string
  label: string
  postedAt: string   // ISO — when scheduled/posted
  fbPhotoId?: string // FB photo attachment ID — used for existence check + boosting
  fbPostId?: string  // FB feed post ID (pageId_objectId) — used for insights
  concept?: string   // one-line concept/hook — used to avoid repeating similar angles
  boosted?: boolean  // true once auto-boost has fired for this post
  heroImageId?: string // Drive image ID used as hero — used to avoid repeating same background
}

function load(): CoverageEntry[] {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as CoverageEntry[]
    }
  } catch {}
  return []
}

function save(entries: CoverageEntry[]): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), 'utf8')
}

export function recordPost(templateKey: string, label: string, postedAt: Date = new Date(), fbPhotoId?: string, fbPostId?: string, concept?: string, heroImageId?: string): void {
  const entries = load()
  entries.push({ templateKey, label, postedAt: postedAt.toISOString(), fbPhotoId, fbPostId, concept, heroImageId })
  save(entries)
}

// Returns the most recent concept strings for a template, newest first.
export function getRecentConcepts(templateKey: string, limit = 5): string[] {
  return load()
    .filter(e => e.templateKey === templateKey && e.concept)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, limit)
    .map(e => e.concept!)
}

// Returns recently used hero image IDs across all templates, newest first.
export function getRecentHeroIds(limit = 10): string[] {
  return load()
    .filter(e => e.heroImageId)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, limit)
    .map(e => e.heroImageId!)
}

export function getLastPosted(templateKey: string): CoverageEntry | null {
  return load()
    .filter(e => e.templateKey === templateKey)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))[0] ?? null
}

// Remove a single entry by templateKey + exact postedAt timestamp
export function removeEntry(templateKey: string, postedAt: string): void {
  const entries = load()
  save(entries.filter(e => !(e.templateKey === templateKey && e.postedAt === postedAt)))
}

export function listAll(): CoverageEntry[] {
  return load()
}

export function resetAll(): void {
  save([])
}

export function resetByTemplateKey(templateKey: string): number {
  const entries = load()
  const filtered = entries.filter(e => e.templateKey !== templateKey)
  save(filtered)
  return entries.length - filtered.length
}

export function markBoosted(templateKey: string, postedAt: string): void {
  const entries = load()
  save(entries.map(e =>
    e.templateKey === templateKey && e.postedAt === postedAt ? { ...e, boosted: true } : e
  ))
}

// Mark every not-yet-boosted entry as boosted (used to silence retry loops on
// known-broken entries that we don't want auto-boost to keep retrying).
// onlyPast: if true, only mark entries whose postedAt is already in the past —
//           future scheduled posts stay eligible for future auto-boost.
export function markAllPendingBoosted(opts: { onlyPast?: boolean } = {}): number {
  const entries = load()
  const nowMs = Date.now()
  let updated = 0
  const next = entries.map(e => {
    if (e.boosted) return e
    if (opts.onlyPast && new Date(e.postedAt).getTime() >= nowMs) return e
    updated++
    return { ...e, boosted: true }
  })
  if (updated > 0) save(next)
  return updated
}

// Patch fbPostId onto entries that have fbPhotoId but no fbPostId.
// Returns the number of entries updated.
export function patchPostIds(photoToPostId: Map<string, string>): number {
  const entries = load()
  let patched = 0
  const updated = entries.map(e => {
    if (!e.fbPostId && e.fbPhotoId && photoToPostId.has(e.fbPhotoId)) {
      patched++
      return { ...e, fbPostId: photoToPostId.get(e.fbPhotoId)! }
    }
    return e
  })
  if (patched > 0) save(updated)
  return patched
}

// Deduplicate entries — keep only the most recent entry per (templateKey, fbPostId) pair.
// Entries without fbPostId are kept as-is (they may be scheduled posts not yet published).
export function deduplicateEntries(): number {
  const entries = load()
  const seen = new Set<string>()
  const kept: CoverageEntry[] = []
  // Process newest-first so we keep the most recent
  const sorted = [...entries].sort((a, b) => b.postedAt.localeCompare(a.postedAt))
  for (const e of sorted) {
    const key = e.fbPostId ? `${e.templateKey}::${e.fbPostId}` : `${e.templateKey}::${e.postedAt}`
    if (!seen.has(key)) { seen.add(key); kept.push(e) }
  }
  const removed = entries.length - kept.length
  if (removed > 0) save(kept)
  return removed
}
