export type JobStatus =
  | 'pending'
  | 'clarifying'
  | 'evaluating'
  | 'scripting'
  | 'rendering'
  | 'done'
  | 'needs_shots'
  | 'failed'

export interface MediaAsset {
  id: string
  name: string
  mimeType: string
  webViewLink: string
  url: string
  thumbnailLink?: string
  size?: string
  score?: number
  feedback?: string
}

export interface AdBrief {
  product: string
  concept: string
  tone?: string
  // Image ad fields gathered from clarifying questions
  features?: Array<{ label: string; value: string }>
  staffName?: string
  staffRole?: string
  tagline?: string
  yearFounded?: string
  location?: string
  ctaText?: string
  caption?: string
}

export interface Job {
  id: string
  status: JobStatus
  brief: AdBrief
  assets: MediaAsset[]
  imageUrl?: string
  driveLink?: string
  missingShots?: string[]
  error?: string
  createdAt: string
  updatedAt: string
  discordChannelId: string
  discordUserId: string
  conversationStep: 'brief' | 'clarifying' | 'ready'
}
