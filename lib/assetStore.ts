import fs from 'fs'
import path from 'path'

const STORE_PATH = path.join(process.cwd(), 'asset-library.json')

export type AssetScore = 'low' | 'medium' | 'high' | 'featured'
export type AssetStatus = 'approved' | 'rejected'
export type AssetType = 'photo' | 'logo' | 'avatar' | 'background' | 'illustration' | 'other'

export interface StoredAsset {
  id: string
  fileName: string
  discordUrl: string
  driveUrl?: string
  submittedBy: string
  submittedByName: string
  caption: string           // Claude's own description of the image
  submitterNote?: string    // original text from the contributor (optional context)
  assetType: AssetType
  qualityScore: number
  relevanceScore: number
  brandScore: number
  overallScore: AssetScore | null
  status: AssetStatus
  rejectionReason?: string
  qualityNotes: string
  relevanceNotes: string
  brandNotes: string
  tags: string[]
  linkedBriefId?: string
  createdAt: string
  updatedAt: string
}

function load(): StoredAsset[] {
  try {
    if (fs.existsSync(STORE_PATH))
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoredAsset[]
  } catch { /* ignore */ }
  return []
}

function save(assets: StoredAsset[]): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(assets, null, 2), 'utf8')
}

export function addAsset(asset: StoredAsset): void {
  const assets = load()
  assets.push(asset)
  save(assets)
}

export function getAsset(id: string): StoredAsset | null {
  return load().find(a => a.id === id) ?? null
}

export function updateAsset(id: string, patch: Partial<StoredAsset>): void {
  const assets = load()
  const idx = assets.findIndex(a => a.id === id)
  if (idx === -1) return
  assets[idx] = { ...assets[idx], ...patch, updatedAt: new Date().toISOString() }
  save(assets)
}

export function listAssets(status?: AssetStatus, score?: AssetScore, type?: AssetType): StoredAsset[] {
  return load()
    .filter(a =>
      (!status || a.status === status) &&
      (!score  || a.overallScore === score) &&
      (!type   || a.assetType === type)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
