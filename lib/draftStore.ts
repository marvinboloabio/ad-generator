import fs from 'fs'
import path from 'path'

const STORE_PATH = path.join(process.cwd(), 'post-drafts.json')

export type DraftStatus = 'pending_asset' | 'pending_review' | 'approved' | 'rejected' | 'published'

export interface AssetBrief {
  subject: string
  location: string
  moodLighting: string
  deadline: string       // ISO date string
  assignedTo: string
}

export interface PostDraft {
  id: string
  concept: string
  objective?: string           // awareness | inquiry | grief | promo
  caption: string
  hashtags: string[]
  ctaText: string
  engagementHook?: string
  assetBrief: AssetBrief
  status: DraftStatus
  revisionNotes?: string
  createdAt: string
  updatedAt: string
  discordUserId: string
  discordChannelId?: string
  fulfilledAssetUrl?: string   // Discord CDN URL of the scored asset that fulfilled this brief
}

function load(): PostDraft[] {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as PostDraft[]
    }
  } catch {
    // ignore
  }
  return []
}

function save(drafts: PostDraft[]): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(drafts, null, 2), 'utf8')
}

export function addDraft(draft: PostDraft): void {
  const drafts = load()
  drafts.push(draft)
  save(drafts)
}

export function updateDraft(id: string, patch: Partial<PostDraft>): PostDraft | null {
  const drafts = load()
  const idx = drafts.findIndex(d => d.id === id)
  if (idx === -1) return null
  drafts[idx] = { ...drafts[idx], ...patch, updatedAt: new Date().toISOString() }
  save(drafts)
  return drafts[idx]
}

export function getDraft(id: string): PostDraft | null {
  return load().find(d => d.id === id) ?? null
}

export function listDrafts(status?: DraftStatus | DraftStatus[]): PostDraft[] {
  const drafts = load()
  return (status ? drafts.filter(d => Array.isArray(status) ? status.includes(d.status) : d.status === status) : drafts)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
