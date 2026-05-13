import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
  DMChannel,
  NewsChannel,
  Attachment,
  AttachmentBuilder,
} from 'discord.js'

type SendableChannel = TextChannel | DMChannel | NewsChannel

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { createJob, getJob, updateJob } from './jobStore'
import { uploadImage, uploadImageFromUrl, listFolderImages, downloadDriveFile } from './googleDrive'
import { evaluateMedia, generateClarifyingQuestions, parseClarifyingAnswers } from './claude'
import { generateImageAd, downloadToBuffer } from './imageGen'
import { postToFacebook, scheduleImageToFacebook, scheduleTextToFacebook, boostPost, checkPhotoExists, fetchPagePosts, FBPost, fetchScheduledPosts, deletePost, updateScheduledPostTime, pauseBoostCampaign, deleteCampaign, ScheduledPost } from './facebook'
import { generateConceptImage, generateVideoAd, generateVideoFromImage } from './runway'
import { loadSettings, saveSettings } from './brandSettings'
import { generatePost, generateContentPlan, generateWeeklyBriefs, generateBatchDrafts, WeeklyBrief, formatDraftForDiscord, formatDraftForMetaBusiness, buildFacebookCaption, LibraryAsset, ContentPlan } from './contentGenerator'
import { addDraft, updateDraft, getDraft, listDrafts, PostDraft } from './draftStore'
import { scoreAsset, scoreAssetFromBuffer } from './assetScorer'
import { addAsset, updateAsset, getAsset, listAssets, StoredAsset, AssetType } from './assetStore'
import { recordPost, getLastPosted, getRecentConcepts, getRecentHeroIds, removeEntry, resetAll, resetByTemplateKey, patchPostIds, deduplicateEntries, listAll, markBoosted, markAllPendingBoosted } from './coverageStore'
import { fetchCategoryInsights, formatInsightsTable, formatInsightsForClaude, fetchBoostCampaignInsights, formatBoostInsightsTable, analyzeBoostScaler, formatBoostScaler } from './fbInsights'
import { runSurfacePull, runDeepPull, getQualifiedSignals, formatSignalsForDiscord, loadToneMap } from './signalStore'
import { generateSpeech, mixVideoAudio, stitchVideoClips } from './tts'
import { generateVideoScript } from './videoScript'
import { AdBrief, Job, MediaAsset } from '@/types'

interface BatchPlanItem {
  templateKey: string
  label: string
  localPath: string
  fileName: string
  caption: string
  hashtags: string[]
  ctaText: string
  engagementHook: string
  fullCaption: string
  scheduledTime: Date
  concept?: string
  heroImageId?: string
}

interface PendingEntry {
  job: Job
  awaitingReply: boolean
  assets: MediaAsset[]
  facebookConfirm?: {
    localPath: string
    fileName: string
    caption: string
    approvedDraftId?: string
    scheduledTime?: Date
    adBrief?: AdBrief
    heroAsset?: MediaAsset
    adCategoryDirective?: string
  }
  scheduleTextConfirm?: {
    caption: string
    scheduledTime: Date
    approvedDraftId?: string
  }
  postReview?: {
    draft: PostDraft
    revisionCount: number
    adCategoryDirective?: string
  }
  postPublish?: {
    draft: PostDraft
  }
  // Gap 1a: audience level selection
  audiencePick?: {
    concept: string
  }
  // Gap 1b: objective/problem selection
  objectivePick?: {
    concept: string
    awareness?: string
    problemText?: string
  }
  // Gap 2: brand frame review (after problem pick, before content plan)
  brandFrameReview?: {
    concept: string
    awareness?: string
    problemText: string
    objective: string
    analysis: string
    adCategoryDirective?: string
  }
  // Gap 2b: ad category pick (Q3 — after brand frame review)
  adCategoryPick?: {
    concept: string
    awareness?: string
    problemText: string
    objective: string
    brandFrameAnalysis: string
  }
  // Gap 3: content plan review
  contentPlanReview?: {
    concept: string
    objective: string
    plan: ContentPlan
    revisionCount: number
    revisionNotes?: string
    awareness?: string
    brandFrameAnalysis?: string
    adCategoryDirective?: string
  }
  approvedPostDraft?: PostDraft
  boostConfirm?: {
    postId: string
    fbUrl: string
    approvedDraftId?: string
  }
  batchPlanConfirm?: {
    items: BatchPlanItem[]
  }
  batchAudiencePick?: {
    count: number
    heroDataUris: string[]
  }
  batchProblemPick?: {
    count: number
    awareness: string
    problems: Array<{ text: string; objective: string }>
    heroDataUris: string[]
  }
  batchCategoryPick?: {
    awareness: string
    selectedProblems: Array<{ text: string; objective: string }>
    categories: Array<{ label: string; designDirective: string; objective: string }>
    heroDataUris: string[]
  }
  batchDraftReview?: {
    awareness: string
    drafts: WeeklyBrief[]
    heroDataUris: string[]
  }
  coverageScan?: {
    posts: FBPost[]
    tagged: Map<number, { templateKey: string; label: string }> // postIndex → category
  }
  coverageFillConfirm?: {
    missing: Array<{
      templateKey: string
      label: string
      awareness: string
      problem: { text: string; objective: string }
      category: { label: string; designDirective: string; objective: string }
    }>
  }
  coverageFillDraftReview?: {
    drafts: WeeklyBrief[]
    heroDataUris: string[]
    slots: Date[]
    missing: CoverageMissingItem[]
  }
  brandConcept?: string
  brandAwareness?: 'problem-aware' | 'solution-aware' | 'unaware' | 'product-aware' | 'most-aware'
  photoPick?: {
    draft: PostDraft
    revisionCount: number
    adCategoryDirective?: string
    candidates: Array<{
      rank: number
      assetId: string
      driveUrl: string
      discordUrl?: string
      caption: string
      score: string
    }>
  }
  cancelPostConfirm?: {
    post: ScheduledPost
    num: number
  }
}

type CoverageMissingItem = {
  templateKey: string
  label: string
  awareness: string
  problem: { text: string; objective: string }
  category: { label: string; designDirective: string; objective: string }
}

// Persist state across Next.js hot reloads using globalThis
const g = globalThis as typeof globalThis & {
  __discordClient?: Client | null
  __pendingBriefs?: Map<string, PendingEntry>
  __processedIds?: Set<string>
  __channelBatchConfirm?: Map<string, { items: BatchPlanItem[] }> // keyed by channelId — any user can schedule
  __scheduledPostsCache?: Map<string, { posts: ScheduledPost[]; fetchedAt: number }> // userId → cached list
  __lastAdBuffer?: Buffer          // last rendered image ad — used by 'animate ad' command
  __lastAdCaption?: string         // last ad caption — used for TTS narration
  __lastConceptImageUri?: string   // raw Runway concept image data URI (before template compositing)
}
if (!g.__discordClient) g.__discordClient = null
if (!g.__pendingBriefs) g.__pendingBriefs = new Map()
if (!g.__processedIds) g.__processedIds = new Set()
if (!g.__channelBatchConfirm) g.__channelBatchConfirm = new Map()
if (!g.__scheduledPostsCache) g.__scheduledPostsCache = new Map()

// Extract Google Drive file ID from any Drive URL variant
function extractDriveFileId(url: string): string | null {
  const ucMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (ucMatch) return ucMatch[1]
  const fileMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
  if (fileMatch) return fileMatch[1]
  return null
}

// Download image from any URL — uses authenticated Drive API for Drive URLs
async function downloadImage(url: string): Promise<Buffer> {
  const driveId = extractDriveFileId(url)
  if (driveId) return downloadDriveFile(driveId)
  return downloadToBuffer(url)
}

const TRIGGER_PHRASES = [
  'generate ad for',
  'generate an ad for',
  'create ad for',
  'create an ad for',
  'make ad for',
  'make an ad for',
  'new ad for',
]

const POST_TRIGGER_PHRASES = [
  'create post for',
  'generate post for',
  'make post for',
  'new post for',
  'write post for',
]


// Convert a Google Drive webViewLink to a direct download URL
function driveToDirectUrl(url: string): string {
  const match = url.match(/\/file\/d\/([^/?#]+)/)
  if (match) return `https://drive.google.com/uc?export=download&id=${match[1]}`
  return url
}

// Return the best downloadable URL for a stored asset
function assetDownloadUrl(asset: StoredAsset): string {
  if (asset.driveUrl) return driveToDirectUrl(asset.driveUrl)
  return asset.discordUrl
}

function pickBestHeroAsset(): StoredAsset | null {
  const rank: Record<string, number> = { featured: 4, high: 3, medium: 2, low: 1 }
  const heroTypes: AssetType[] = ['photo', 'background', 'illustration', 'other']
  const sorted = listAssets('approved')
    .filter(a => heroTypes.includes(a.assetType as AssetType))
    .sort((a, b) => (rank[b.overallScore ?? 'low'] ?? 0) - (rank[a.overallScore ?? 'low'] ?? 0))
  if (sorted.length === 0) return null
  const pool = sorted.slice(0, 3)
  return pool[Math.floor(Math.random() * pool.length)]
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const OBJECTIVES: Record<string, { label: string; desc: string }> = {
  awareness: { label: 'Awareness',     desc: 'Brand recognition & community presence' },
  inquiry:   { label: 'Inquiry',       desc: 'Drive service inquiries & lead generation' },
  grief:     { label: 'Grief Support', desc: 'Compassionate content for bereaved families' },
  promo:     { label: 'Promo',         desc: 'Promotional offers & specific services' },
}

const TEMPLATE_PREVIEW_LIST = [
  { key: 'VISUAL_METAPHOR_TEMPLATE',    label: 'Visual Metaphor',        needsPhoto: false },
  { key: 'EDUCATIONAL_TEMPLATE',        label: 'Educational',             needsPhoto: false },
  { key: 'OFFER_PROMO_TEMPLATE',        label: 'Offer / Promo',           needsPhoto: true  },
  { key: 'LIFESTYLE_TEMPLATE',          label: 'Lifestyle',               needsPhoto: true  },
  { key: 'LIGHT_EMOTIONAL_TEMPLATE',    label: 'Light Emotional',         needsPhoto: true  },
  { key: 'EMOTIONAL_TEMPLATE',          label: 'Emotional',               needsPhoto: true  },
  { key: 'STORY_TEMPLATE',             label: 'Story',                   needsPhoto: true  },
  { key: 'AUTHORITY_TEMPLATE',          label: 'Authority',               needsPhoto: true  },
  { key: 'SOFT_DR_TEMPLATE',            label: 'Soft Direct Response',    needsPhoto: true  },
  { key: 'DIRECT_RESPONSE_TEMPLATE',    label: 'Direct Response',         needsPhoto: true  },
  { key: 'COMPARISON_TEMPLATE',         label: 'Comparison',              needsPhoto: true  },
  { key: 'RETARGETING_TEMPLATE',        label: 'Retargeting',             needsPhoto: true  },
  { key: 'CONVERSATIONAL_TEMPLATE',     label: 'Conversational',          needsPhoto: true  },
  { key: 'SOCIAL_PROOF_TEMPLATE',       label: 'Social Proof',            needsPhoto: true  },
  { key: 'PROBLEM_SOLUTION_TEMPLATE',   label: 'Problem → Solution',      needsPhoto: true  },
]

const TEMPLATE_NAME_MAP: Record<string, string> = {
  'visual metaphor': 'VISUAL_METAPHOR_TEMPLATE',
  'vm': 'VISUAL_METAPHOR_TEMPLATE',
  'educational': 'EDUCATIONAL_TEMPLATE',
  'edu': 'EDUCATIONAL_TEMPLATE',
  'offer': 'OFFER_PROMO_TEMPLATE',
  'promo': 'OFFER_PROMO_TEMPLATE',
  'offer promo': 'OFFER_PROMO_TEMPLATE',
  'lifestyle': 'LIFESTYLE_TEMPLATE',
  'light emotional': 'LIGHT_EMOTIONAL_TEMPLATE',
  'light': 'LIGHT_EMOTIONAL_TEMPLATE',
  'emotional': 'EMOTIONAL_TEMPLATE',
  'story': 'STORY_TEMPLATE',
  'authority': 'AUTHORITY_TEMPLATE',
  'soft dr': 'SOFT_DR_TEMPLATE',
  'soft direct response': 'SOFT_DR_TEMPLATE',
  'direct response': 'DIRECT_RESPONSE_TEMPLATE',
  'dr': 'DIRECT_RESPONSE_TEMPLATE',
  'comparison': 'COMPARISON_TEMPLATE',
  'retargeting': 'RETARGETING_TEMPLATE',
  'conversational': 'CONVERSATIONAL_TEMPLATE',
  'social proof': 'SOCIAL_PROOF_TEMPLATE',
  'testimonial': 'SOCIAL_PROOF_TEMPLATE',
  'problem solution': 'PROBLEM_SOLUTION_TEMPLATE',
  'problem': 'PROBLEM_SOLUTION_TEMPLATE',
}

const OBJECTIVE_ALIASES: Record<string, string> = {
  '1': 'awareness', 'awareness': 'awareness', 'brand': 'awareness',
  '2': 'inquiry',   'inquiry': 'inquiry',     'inquire': 'inquiry', 'lead': 'inquiry',
  '3': 'grief',     'grief': 'grief',         'grief support': 'grief', 'support': 'grief',
  '4': 'promo',     'promo': 'promo',         'promotional': 'promo', 'promotion': 'promo',
}

function hasApprovedVisuals(): boolean {
  const visualTypes: AssetType[] = ['photo', 'background', 'illustration', 'other']
  return listAssets('approved').some(a => visualTypes.includes(a.assetType as AssetType))
}

function parseDuration(text: string): number | undefined {
  const minMatch = text.match(/(\d+)\s*m(?:in(?:ute)?s?)?(?!\w)/i)
  if (minMatch) return parseInt(minMatch[1]) * 60

  const secMatch = text.match(/(\d+)\s*s(?:ec(?:ond)?s?)?(?!\w)/i)
  if (secMatch) return parseInt(secMatch[1])

  return undefined
}

function getNextBestPostTime(): Date {
  const slotsByDow: Record<number, number[]> = {
    0: [8, 12, 19],  // Sunday
    1: [8, 12, 19],  // Monday–Friday
    2: [8, 12, 19],
    3: [8, 12, 19],
    4: [8, 12, 19],
    5: [8, 12, 19],
    6: [9, 20],      // Saturday
  }
  const now = new Date()
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const base = new Date(now)
    base.setDate(base.getDate() + dayOffset)
    // Get YYYY-MM-DD in PHT
    const phtDate = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
    const dow = new Date(`${phtDate}T12:00:00+08:00`).getDay()
    for (const hour of slotsByDow[dow]) {
      const slot = new Date(`${phtDate}T${String(hour).padStart(2, '0')}:00:00+08:00`)
      if (slot.getTime() > now.getTime() + 15 * 60 * 1000) return slot
    }
  }
  return new Date(now.getTime() + 60 * 60 * 1000)
}

function getWeekSlots(n: number, bookedDays?: Set<string>, windowDays = 21): Date[] {
  const slots: Date[] = []
  const now = new Date()
  const slotsByDow: Record<number, number[]> = {
    0: [8, 12, 19],  // Sunday
    1: [8, 12, 19],  // Monday–Friday
    2: [8, 12, 19],
    3: [8, 12, 19],
    4: [8, 12, 19],
    5: [8, 12, 19],
    6: [9, 20],      // Saturday
  }
  for (let dayOffset = 0; dayOffset < windowDays && slots.length < n; dayOffset++) {
    const base = new Date(now)
    base.setDate(base.getDate() + dayOffset)
    const phtDate = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
    if (bookedDays?.has(phtDate)) continue
    const dow = new Date(`${phtDate}T12:00:00+08:00`).getDay()
    for (const hour of slotsByDow[dow]) {
      const slot = new Date(`${phtDate}T${String(hour).padStart(2, '0')}:00:00+08:00`)
      if (slot.getTime() > now.getTime() + 15 * 60 * 1000) {
        slots.push(slot)
        break
      }
    }
  }
  return slots
}

function bookedDaysSet(posts: ScheduledPost[]): Set<string> {
  return new Set(posts.map(p => p.scheduledTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })))
}

function formatPHT(date: Date): string {
  return date.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function collectAttachments(message: Message): MediaAsset[] {
  return Array.from(message.attachments.values())
    .filter(
      (a): a is Attachment & { contentType: string } =>
        !!a.contentType && a.contentType.startsWith('image/')
    )
    .map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.contentType,
      webViewLink: a.url,
      url: a.url,
      size: a.size?.toString(),
    }))
}

function mergeAssets(existing: MediaAsset[], incoming: MediaAsset[]): MediaAsset[] {
  const ids = new Set(existing.map((a) => a.id))
  return [...existing, ...incoming.filter((a) => !ids.has(a.id))]
}

export function getBot(): Client | null {
  return g.__discordClient ?? null
}

// Millennials get 2 of 4 slots — primary buyers (planning for aging parents / OFW)
const GENERATION_ROTATION = ['millennial', 'boomer', 'millennial', 'genz'] as const
const GENERATION_LABEL: Record<string, string> = {
  boomer:     '🧓 Boomer',
  millennial: '👨‍👩‍👧 Millennial',
  genz:       '⚡ Gen Z',
  all:        '👥 All',
}

const TONE_TO_TEMPLATE: Record<string, string> = {
  quiet_grief:        'EMOTIONAL_TEMPLATE',
  generational_pride: 'STORY_TEMPLATE',
  aging_softness:     'LIGHT_EMOTIONAL_TEMPLATE',
  ofw_longing:        'EMOTIONAL_TEMPLATE',
  parental_sacrifice: 'STORY_TEMPLATE',
  hopeful_legacy:     'PROBLEM_SOLUTION_TEMPLATE',
}

async function runPairingRun(channel: SendableChannel): Promise<void> {
  const signals = getQualifiedSignals(5)
  if (signals.length === 0) {
    await channel.send('📭 **Pairing run:** No qualified signals (score ≥ 7, cleared all checkers). Run `signals refresh` to pull from sources.')
    return
  }

  const toneMap = loadToneMap()
  const toneMapStr = toneMap
    ? `Current month dominant tones: ${toneMap.entries.map(e => `${e.tag} (weight ${e.weight})`).join(', ')}. ${toneMap.rawSummary}`
    : undefined

  await channel.send(`🔄 **Weekly Pairing Run** — pairing ${signals.length} qualified signal(s) into ad drafts...`)

  const allCategories = Object.values(AD_CATEGORIES_BY_LEVEL).flat()

  for (const sig of signals) {
    const templateKey = TONE_TO_TEMPLATE[sig.toneTag ?? ''] ?? 'EMOTIONAL_TEMPLATE'
    const category = allCategories.find(c => c.designDirective === templateKey)
      ?? AD_CATEGORIES_BY_LEVEL['problem-aware'][0]

    try {
      const targetGeneration = sig.generationTag ?? 'millennial'
      const [draft] = await generateBatchDrafts(
        'problem-aware',
        [{ text: sig.text, objective: category.objective }],
        [category],
        undefined,
        undefined,
        { signals: [sig.text], toneMap: toneMapStr, targetGeneration },
      )

      const fullCaption = buildFacebookCaption({
        caption: draft.caption,
        hashtags: draft.hashtags ?? [],
        ctaText: draft.ctaText ?? '',
        engagementHook: draft.engagementHook ?? '',
      })

      const genLabel = GENERATION_LABEL[targetGeneration] ?? ''
      const header = [
        `**📡 Paired — ${sig.toneTag?.replace(/_/g, ' ')} · score ${sig.fitScore} · ${draft.label}** · ${genLabel}`,
        `_Signal: "${sig.text.slice(0, 100)}${sig.text.length > 100 ? '…' : ''}"_`,
        `_Topic: ${sig.topicTag?.replace(/_/g, ' ')} · ${sig.fitReason?.slice(0, 80)}_`,
        '',
      ].join('\n')

      const body = `> _${draft.concept}_\n\n${fullCaption}`
      const full = header + body

      if (full.length <= 1900) {
        await channel.send(full)
      } else {
        await channel.send(header.length <= 1900 ? header : header.slice(0, 1900))
        for (let i = 0; i < body.length; i += 1900) await channel.send(body.slice(i, i + 1900))
      }
    } catch (err: any) {
      await channel.send(`⚠️ Pairing failed for "${sig.text.slice(0, 50)}…": ${err.message}`)
    }
  }

  await channel.send('✅ **Pairing run complete.** Review drafts above — editorial deadline: Tuesday morning.')
}

export async function startBot(): Promise<void> {
  if (g.__discordClient) return

  g.__discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message],
  })

  g.__discordClient.once('clientReady', (client) => {
    console.log(`[Discord] Logged in as ${client.user.tag}`)
    console.log(`[Discord] In ${client.guilds.cache.size} server(s):`)
    client.guilds.cache.forEach((guild) => console.log(`  - ${guild.name} (${guild.id})`))
  })

  g.__discordClient.on('error', (err) => {
    console.error('[Discord] Client error:', err)
  })

  g.__discordClient.on('messageCreate', handleMessage)

  // Scheduled coverage check — ticks every minute, fires at the configured PHT hour
  setInterval(async () => {
    const s = loadSettings()
    if (!s.coverageCheckIntervalDays || !s.coverageCheckChannelId) return

    const nowPHT = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Manila', hour12: false })
    // nowPHT format: "2026-05-07, 09:05:00" — extract date and hour
    const [phtDate, phtTime] = nowPHT.split(', ')
    const phtHour = parseInt(phtTime.slice(0, 2), 10)
    const targetHour = s.coverageCheckHourPHT ?? 9

    if (phtHour !== targetHour) return

    // Check if already ran today (or within the interval window)
    const lastRun = s.coverageCheckLastRun ? new Date(s.coverageCheckLastRun) : null
    if (lastRun) {
      const lastRunPHTDate = lastRun.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
      const intervalDays = s.coverageCheckIntervalDays
      const daysSinceLastRun = Math.floor((Date.now() - lastRun.getTime()) / (24 * 60 * 60 * 1000))
      if (lastRunPHTDate === phtDate || daysSinceLastRun < intervalDays) return
    }

    saveSettings({ ...s, coverageCheckLastRun: new Date().toISOString() })
    try {
      const channel = await g.__discordClient!.channels.fetch(s.coverageCheckChannelId)
      if (channel?.isTextBased()) await runScheduledCoverageCheck(channel as SendableChannel)
    } catch (err) {
      console.error('[Coverage schedule] Failed to run scheduled check:', err)
    }
  }, 60 * 1000) // check every minute

  // Auto-boost — ticks every minute, boosts any post that has gone live and hasn't been boosted yet
  setInterval(async () => {
    const s = loadSettings()
    if (!s.autoBoostEnabled) return
    if (!s.boostBudgetPHP || !s.boostAgeMin || !s.boostAgeMax || !s.boostCountry) return
    const pageId = process.env.FACEBOOK_PAGE_ID
    if (!pageId) return

    const now = Date.now()
    const toBoost = listAll().filter(e =>
      (e.fbPostId || e.fbPhotoId) &&
      !e.boosted &&
      new Date(e.postedAt).getTime() < now
    )
    if (toBoost.length === 0) return

    for (const entry of toBoost) {
      // Prefer the real post_id (correct format: pageId_postId) — fall back to
      // building one from the photo ID, which works for most photo posts but not all.
      const objectStoryId = entry.fbPostId ?? `${pageId}_${entry.fbPhotoId}`
      try {
        const adsUrl = await boostPost(objectStoryId, s.boostBudgetPHP, s.boostAgeMin, s.boostAgeMax, s.boostCountry)
        markBoosted(entry.templateKey, entry.postedAt)
        console.log(`[AutoBoost] Boosted ${entry.label} (${objectStoryId})`)
        if (s.coverageCheckChannelId) {
          const ch = await g.__discordClient!.channels.fetch(s.coverageCheckChannelId).catch(() => null)
          if (ch?.isTextBased()) {
            await (ch as SendableChannel).send(
              `🚀 **Auto-boosted:** ${entry.label}\n` +
              `> ₱${s.boostBudgetPHP}/day · ages ${s.boostAgeMin}–${s.boostAgeMax} · ${s.boostCountry}\n` +
              `[View in Ads Manager](${adsUrl})`
            )
          }
        }
      } catch (err: any) {
        console.error(`[AutoBoost] Failed for ${entry.label}:`, err.message)
        if (s.coverageCheckChannelId) {
          const ch = await g.__discordClient!.channels.fetch(s.coverageCheckChannelId).catch(() => null)
          if (ch?.isTextBased()) {
            await (ch as SendableChannel).send(`⚠️ **Auto-boost failed** for **${entry.label}**: ${err.message}`)
          }
        }
      }
    }
  }, 60 * 1000)

  // Signal surface pull — runs every 4 hours
  setInterval(async () => {
    try {
      await runSurfacePull()
      console.log('[Signals] Surface pull complete')
    } catch (err) {
      console.error('[Signals] Surface pull failed:', err)
    }
  }, 4 * 60 * 60 * 1000)

  // Signal deep pull — runs on the 1st of each month
  setInterval(async () => {
    const now = new Date()
    if (now.getDate() !== 1) return
    const lastDeepKey = `__signalDeepLastMonth__`
    const monthKey = `${now.getFullYear()}-${now.getMonth()}`
    if ((g as any)[lastDeepKey] === monthKey) return
    ;(g as any)[lastDeepKey] = monthKey
    try {
      await runDeepPull()
      console.log('[Signals] Deep pull complete')
    } catch (err) {
      console.error('[Signals] Deep pull failed:', err)
    }
  }, 60 * 60 * 1000) // check every hour

  // Monday pairing run — checked hourly, fires once per Monday
  setInterval(async () => {
    const now = new Date()
    if (now.getDay() !== 1) return // 1 = Monday
    const weekKey = `${now.getFullYear()}-${now.getMonth()}-W${Math.ceil(now.getDate() / 7)}`
    if ((g as any).__lastPairingRunWeek === weekKey) return
    ;(g as any).__lastPairingRunWeek = weekKey

    const s = loadSettings()
    const channelId = s.coverageCheckChannelId
    if (!channelId || !g.__discordClient) return
    try {
      const ch = await g.__discordClient.channels.fetch(channelId).catch(() => null)
      if (ch?.isTextBased()) await runPairingRun(ch as SendableChannel)
    } catch (err) {
      console.error('[Signals] Monday pairing run failed:', err)
    }
  }, 60 * 60 * 1000) // check every hour

  // Fallback for DM messages — discord.js doesn't always emit messageCreate for uncached DM channels
  g.__discordClient.ws.on('MESSAGE_CREATE' as any, async (data: any) => {
    if (data.guild_id) return
    if (data.author?.bot) return

    try {
      const channel = await g.__discordClient!.channels.fetch(data.channel_id)
      if (!channel?.isTextBased()) return
      const message = await (channel as TextChannel).messages.fetch(data.id)
      await handleMessage(message)
    } catch (err) {
      console.error('[Discord] Failed to process DM raw event:', err)
    }
  })

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set in environment')
  await g.__discordClient.login(token)
}

export async function stopBot(): Promise<void> {
  if (!g.__discordClient) return
  await g.__discordClient.destroy()
  g.__discordClient = null
}

async function handleMessage(message: Message) {
  if (g.__processedIds!.has(message.id)) return
  g.__processedIds!.add(message.id)
  setTimeout(() => g.__processedIds!.delete(message.id), 60_000)

  if (message.author.bot) return
  if (!message.content.trim() && message.attachments.size === 0) return

  console.log(`[Discord] Message from ${message.author.tag}: "${message.content}"`)

  const content = message.content.toLowerCase().trim()
  const userId = message.author.id

  const pending = g.__pendingBriefs!.get(userId)

  // Channel-level schedule confirm — any user can approve rendered ads from scheduled coverage check
  const channelBatch = g.__channelBatchConfirm!.get(message.channelId)
  if (channelBatch) {
    const ch = message.channel as SendableChannel
    const scheduleAllMatch = content === 'schedule all'
    const schedulePickMatch = content.match(/^schedule\s+([\d,\s]+)$/)
    if (scheduleAllMatch || schedulePickMatch) {
      g.__channelBatchConfirm!.delete(message.channelId)
      let selectedItems = channelBatch.items
      if (schedulePickMatch) {
        const indexes = schedulePickMatch[1].split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < channelBatch.items.length)
        selectedItems = indexes.map(i => channelBatch.items[i])
      }
      if (selectedItems.length === 0) {
        await ch.send('No valid ad numbers. Try again with `schedule all` or `schedule 1,3`.')
        g.__channelBatchConfirm!.set(message.channelId, channelBatch)
        return
      }
      // No gaps — reassign selected items to the earliest available slots from
      // the original batch (sorted chronologically). This way if the user picks
      // a subset OR some renders failed, the picked ads still fill consecutive
      // days instead of leaving holes.
      const allSlots = channelBatch.items.map(it => it.scheduledTime).sort((a, b) => a.getTime() - b.getTime())
      selectedItems = selectedItems.map((item, i) => ({ ...item, scheduledTime: allSlots[i] ?? item.scheduledTime }))
      await ch.send(`Scheduling **${selectedItems.length} ad${selectedItems.length > 1 ? 's' : ''}**...`)
      const scheduled: string[] = [], failed: string[] = []
      for (const item of selectedItems) {
        try {
          await uploadImage(item.localPath, item.fileName, process.env.GOOGLE_DRIVE_ADS_FOLDER_ID)
          const fbResult = await scheduleImageToFacebook(item.localPath, item.fullCaption, item.scheduledTime)
          if (item.templateKey.endsWith('_TEMPLATE')) {
            recordPost(item.templateKey, item.label, item.scheduledTime, fbResult.photoId, fbResult.postId ?? undefined, item.concept, item.heroImageId)
          }
          scheduled.push(`📅 ${formatPHT(item.scheduledTime)} — **${item.label}**`)
        } catch (err: any) { failed.push(`${item.label}: ${err.message}`) }
      }
      if (scheduled.length > 0) await ch.send(`✅ Scheduled **${scheduled.length} ad${scheduled.length > 1 ? 's' : ''}**:\n${scheduled.join('\n')}`)
      if (failed.length > 0) await ch.send(`⚠️ Failed:\n${failed.map(f => `• ${f}`).join('\n')}`)
      return
    }
    if (content === 'no' || content === 'cancel') {
      g.__channelBatchConfirm!.delete(message.channelId)
      await (message.channel as SendableChannel).send('Cancelled — no ads were scheduled.')
      return
    }
  }

  // Cancel command — works at any point in the flow
  if (/^(cancel|stop|\/cancel|\/stop)$/i.test(content) && pending?.awaitingReply) {
    g.__pendingBriefs!.set(userId, { job: pending.job, assets: pending.assets ?? [], awaitingReply: false })
    await (message.channel as SendableChannel).send('❌ Flow cancelled. Start a new one anytime with a new concept.')
    return
  }

  // Boost confirmation takes priority over everything
  if (pending?.awaitingReply && pending.boostConfirm) {
    await handleBoostConfirm(message, pending.job, pending.boostConfirm)
    return
  }

  // Coverage auto-fill confirmation
  if (pending?.awaitingReply && pending.coverageFillConfirm) {
    await handleCoverageFillConfirm(message, pending.job, pending.coverageFillConfirm)
    return
  }

  // Coverage fill draft review — approve/revise before rendering
  if (pending?.awaitingReply && pending.coverageFillDraftReview) {
    await handleCoverageFillDraftReview(message, pending.job, pending.coverageFillDraftReview)
    return
  }

  // Cancel scheduled post — yes/no confirm
  if (pending?.awaitingReply && pending.cancelPostConfirm) {
    await handleCancelPostConfirm(message, pending.job, pending.cancelPostConfirm)
    return
  }

  // Coverage scan — tagging FB posts with categories
  if (pending?.awaitingReply && pending.coverageScan) {
    await handleCoverageScanReply(message, pending.job, pending.coverageScan)
    return
  }

  // Batch plan — audience level pick
  if (pending?.awaitingReply && pending.batchAudiencePick) {
    await handleBatchAudiencePick(message, pending.job, pending.batchAudiencePick)
    return
  }

  // Batch plan — pain point pick
  if (pending?.awaitingReply && pending.batchProblemPick) {
    await handleBatchProblemPick(message, pending.job, pending.batchProblemPick)
    return
  }

  // Batch plan — ad category pick (one per pain point)
  if (pending?.awaitingReply && pending.batchCategoryPick) {
    await handleBatchCategoryPick(message, pending.job, pending.batchCategoryPick)
    return
  }

  // Batch plan — draft review
  if (pending?.awaitingReply && pending.batchDraftReview) {
    await handleBatchDraftReview(message, pending.job, pending.batchDraftReview)
    return
  }

  // Batch plan confirmation
  if (pending?.awaitingReply && pending.batchPlanConfirm) {
    await handleBatchPlanConfirm(message, pending.job, pending.batchPlanConfirm)
    return
  }

  // Facebook confirmation takes priority
  if (pending?.awaitingReply && pending.facebookConfirm) {
    await handleFacebookConfirm(message, pending.job, pending.facebookConfirm)
    return
  }

  // Scheduled text-only post confirmation
  if (pending?.awaitingReply && pending.scheduleTextConfirm) {
    await handleScheduleTextConfirm(message, pending.scheduleTextConfirm)
    return
  }

  // Post publish decision (post now / schedule / copy)
  if (pending?.awaitingReply && pending.postPublish) {
    await handlePostPublish(message, pending.postPublish.draft)
    return
  }

  // Photo pick (1 / 2 / 3 to choose from top candidates)
  if (pending?.awaitingReply && pending.photoPick) {
    await handlePhotoPick(message, pending.photoPick)
    return
  }

  // Post review (approve / revise / reject)
  if (pending?.awaitingReply && pending.postReview) {
    await handlePostReview(message, pending.postReview.draft, pending.postReview.revisionCount, pending.postReview.adCategoryDirective)
    return
  }

  // Content plan review (ok / adjust:)
  if (pending?.awaitingReply && pending.contentPlanReview) {
    await handleContentPlanReview(message, pending.contentPlanReview)
    return
  }

  // Audience level pick (Q1)
  if (pending?.awaitingReply && pending.audiencePick) {
    await handleAudiencePick(message, pending.audiencePick)
    return
  }

  // Problem pick (Q2)
  if (pending?.awaitingReply && pending.objectivePick) {
    await handleObjectivePick(message, pending.objectivePick)
    return
  }

  // Ad category pick (Q3 — after brand frame review)
  if (pending?.awaitingReply && pending.adCategoryPick) {
    await handleAdCategoryPick(message, pending.adCategoryPick)
    return
  }

  // Brand frame review (after Q2, before content plan)
  if (pending?.awaitingReply && pending.brandFrameReview) {
    await handleBrandFrameReview(message, pending.brandFrameReview)
    return
  }

  // Generate ad from brand: pain point
  if (pending?.awaitingReply && pending.brandConcept) {
    if (content === 'generate ad') {
      const concept = pending.brandConcept
      const awareness = pending.brandAwareness
      g.__pendingBriefs!.set(userId, { ...pending, brandConcept: undefined, brandAwareness: undefined, awaitingReply: false })
      await askAudienceLevel(message, concept, awareness)
    } else {
      await (message.channel as SendableChannel).send(`Reply **generate ad** to create a post, or type \`brand: <new question>\` to ask something else.`)
    }
    return
  }

  // Ongoing clarification conversation
  if (pending?.awaitingReply) {
    await handleClarification(message, pending.job, pending.assets)
    return
  }

  // Manual photo brief assignment: "assign brief: [draftId]" (multi-line fields)
  if (content.startsWith('assign brief:')) {
    await handleAssignBrief(message)
    return
  }

  // Ad prompt management
  if (content.startsWith('set ad prompt:')) {
    const prompt = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!prompt) {
      await message.reply('Add your prompt after the colon. Example: *set ad prompt: You are writing for a luxury memorial park...*')
      return
    }
    const s = loadSettings()
    saveSettings({ ...s, adPrompt: prompt })
    await message.reply(`Ad prompt saved. Every image ad from now on will use your custom prompt.\n\nUse \`show ad prompt\` to review it, or \`clear ad prompt\` to revert to default.`)
    return
  }

  if (content === 'show ad prompt') {
    const s = loadSettings()
    if (s.adPrompt?.trim()) {
      const mode = s.adPrompt.includes('{{HERO_URI}}')
        ? '🎨 **HTML mode** — Claude generates the full layout'
        : s.adPrompt.includes('"eyebrow"')
          ? '📋 **Absolute JSON mode** — your schema, no overrides'
          : '✏️ **Context mode** — your instructions + schema appended'
      await message.reply(`${mode}\n\n**Current ad prompt:**\n\`\`\`\n${s.adPrompt}\n\`\`\``)
    } else {
      await message.reply('No custom prompt set — using the built-in default. Use `set ad prompt: [text]` to set one.')
    }
    return
  }

  if (content === 'clear ad prompt') {
    const s = loadSettings()
    saveSettings({ ...s, adPrompt: '' })
    await message.reply('Custom ad prompt cleared — back to the built-in default.')
    return
  }

  // Boost settings
  if (content.startsWith('set boost budget:')) {
    const val = parseInt(message.content.slice(message.content.indexOf(':') + 1).trim(), 10)
    if (isNaN(val) || val <= 0) { await message.reply('Please provide a valid amount. Example: `set boost budget: 200`'); return }
    const s = loadSettings(); saveSettings({ ...s, boostBudgetPHP: val })
    await message.reply(`Boost budget set to ₱${val}.`)
    return
  }
  if (content.startsWith('set boost age:')) {
    const range = message.content.slice(message.content.indexOf(':') + 1).trim()
    const [minStr, maxStr] = range.split('-').map(s => s.trim())
    const min = parseInt(minStr, 10), max = parseInt(maxStr, 10)
    if (isNaN(min) || isNaN(max) || min >= max) { await message.reply('Use format: `set boost age: 25-60`'); return }
    const s = loadSettings(); saveSettings({ ...s, boostAgeMin: min, boostAgeMax: max })
    await message.reply(`Boost age range set to ${min}–${max}.`)
    return
  }
  if (content.startsWith('set boost country:')) {
    const val = message.content.slice(message.content.indexOf(':') + 1).trim().toUpperCase()
    if (!val) { await message.reply('Example: `set boost country: PH`'); return }
    const s = loadSettings(); saveSettings({ ...s, boostCountry: val })
    await message.reply(`Boost country set to ${val}.`)
    return
  }
  if (content === 'boost auto on') {
    const s = loadSettings(); saveSettings({ ...s, autoBoostEnabled: true })
    // Skip any already-live posts so auto-boost only catches future scheduled posts
    // going forward. Future-dated (still-scheduled) entries stay eligible — they'll
    // be picked up automatically the moment they go live on Facebook.
    const skipped = markAllPendingBoosted({ onlyPast: true })
    await message.reply(
      `✅ Auto-boost **enabled** — only scheduled posts will be boosted, one at a time, as they go live.` +
      (skipped > 0 ? `\n\n_Silenced ${skipped} already-live post${skipped === 1 ? '' : 's'} — they won't be auto-boosted retroactively._` : '')
    )
    return
  }
  if (content === 'boost auto off') {
    const s = loadSettings(); saveSettings({ ...s, autoBoostEnabled: false })
    await message.reply('⏸️ Auto-boost **disabled**.')
    return
  }
  if (content === 'boost skip pending') {
    const skipped = markAllPendingBoosted()
    await message.reply(
      skipped === 0
        ? 'Nothing to skip — no pending boosts found.'
        : `✅ Marked **${skipped} entr${skipped === 1 ? 'y' : 'ies'}** as boosted. Auto-boost will no longer retry them.`
    )
    return
  }
  if (content === 'show boost settings') {
    const s = loadSettings()
    const accountId = process.env.FB_AD_ACCOUNT_ID
    await message.reply(
      `**Boost settings:**\n` +
      `Budget: ₱${s.boostBudgetPHP}/day · Ages: ${s.boostAgeMin}–${s.boostAgeMax} · Country: ${s.boostCountry}\n` +
      `Ad Account: ${accountId ? `\`${accountId}\`` : '⚠️ not set — add FB_AD_ACCOUNT_ID to .env.local'}\n` +
      `Auto-boost: ${s.autoBoostEnabled ? '✅ enabled' : '⏸️ disabled'}\n\n` +
      `Commands: \`set boost budget: 200\` · \`set boost age: 25-60\` · \`set boost country: PH\` · \`boost auto on/off\``
    )
    return
  }

  if (content === 'reprompts') {
    await sendRepromptList(message.channel as SendableChannel)
    return
  }

  // Coverage check schedule setup
  if (content.startsWith('schedule coverage check')) {
    const ch = message.channel as SendableChannel
    const arg = message.content.slice('schedule coverage check'.length).trim()
    const s = loadSettings()
    if (/^off|disable$/i.test(arg)) {
      saveSettings({ ...s, coverageCheckIntervalDays: 0 })
      await ch.send('Coverage check schedule disabled.')
      return
    }
    // Parse interval: daily / weekly / N days
    const intervalStr = arg.match(/^(daily|weekly|\d+)/i)?.[1] ?? ''
    const days = /daily/i.test(intervalStr) ? 1 : /weekly/i.test(intervalStr) ? 7 : parseInt(intervalStr, 10)
    if (isNaN(days) || days < 1) {
      await ch.send('Usage: `schedule coverage check daily` · `schedule coverage check weekly` · `schedule coverage check daily every 9 AM` · `schedule coverage check off`')
      return
    }
    // Parse time: "9 AM", "9am", "21:00", "9", etc.
    const timeMatch = arg.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    let hourPHT = s.coverageCheckHourPHT ?? 9
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10)
      const period = timeMatch[3]?.toLowerCase()
      if (period === 'pm' && h < 12) h += 12
      if (period === 'am' && h === 12) h = 0
      hourPHT = Math.min(Math.max(h, 0), 23)
    }
    saveSettings({ ...s, coverageCheckIntervalDays: days, coverageCheckHourPHT: hourPHT, coverageCheckChannelId: message.channelId })
    const label = days === 1 ? 'every day' : days === 7 ? 'every week' : `every ${days} days`
    const hour12 = hourPHT === 0 ? '12 AM' : hourPHT < 12 ? `${hourPHT} AM` : hourPHT === 12 ? '12 PM' : `${hourPHT - 12} PM`
    await ch.send(`Coverage check scheduled **${label} at ${hour12} PHT** in this channel.`)
    return
  }

  if (content === 'show coverage schedule') {
    const ch = message.channel as SendableChannel
    const s = loadSettings()
    if (!s.coverageCheckIntervalDays) {
      await ch.send('No coverage check schedule set. Use `schedule coverage check daily` or `schedule coverage check weekly`.')
    } else {
      const label = s.coverageCheckIntervalDays === 1 ? 'daily' : s.coverageCheckIntervalDays === 7 ? 'weekly' : `every ${s.coverageCheckIntervalDays} days`
      const h = s.coverageCheckHourPHT ?? 9
      const hour12 = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
      const last = s.coverageCheckLastRun ? `Last ran: ${formatPHT(new Date(s.coverageCheckLastRun))}` : 'Not yet run.'
      await ch.send(`Coverage check runs **${label} at ${hour12} PHT** in <#${s.coverageCheckChannelId}>.\n${last}`)
    }
    return
  }

  // Coverage scan — fetch recent FB posts and tag them with categories
  if (content.startsWith('coverage scan')) {
    await handleCoverageScan(message)
    return
  }

  // Coverage check — which ad categories haven't been posted recently
  if (content.startsWith('coverage check')) {
    await handleCoverageCheck(message)
    return
  }

  // Insights — ad category performance ranked by engagement
  if (content === 'insights' || content === 'ad insights') {
    await handleInsights(message)
    return
  }

  // Scheduled posts — list all queued Facebook posts
  if (content === 'scheduled posts' || content === 'scheduled') {
    await handleScheduledPosts(message)
    return
  }

  // Cancel a specific scheduled post by number
  if (content.match(/^cancel post\s+\d+$/i)) {
    const num = parseInt(content.match(/\d+/)![0], 10)
    await handleCancelPost(message, num)
    return
  }

  // Shift posts — compact the schedule by moving future posts up to fill gaps
  if (content === 'shift posts') {
    await handleShiftPosts(message)
    return
  }

  // Reschedule a specific post to a new date
  // Formats: `reschedule post 1: 2026-05-23`         (defaults to 8 AM PHT)
  //          `reschedule post 1: 2026-05-23 9:00`
  //          `reschedule post 1: +10`                (push 10 days later, keep time)
  if (content.startsWith('reschedule post')) {
    await handleReschedulePost(message)
    return
  }

  // Coverage fix — patch missing fbPostIds from live page posts
  if (content === 'coverage fix') {
    await handleCoverageFix(message)
    return
  }

  // Coverage reset — clear stale entries after a deleted FB post
  if (content.startsWith('coverage reset')) {
    const ch = message.channel as SendableChannel
    const arg = message.content.slice('coverage reset'.length).trim()
    if (!arg) {
      resetAll()
      await ch.send('✅ Coverage history cleared — all categories will show as never posted on next check.')
    } else {
      const coverageMap = buildCoverageMap()
      const match = coverageMap.find(e =>
        e.label.toLowerCase().includes(arg.toLowerCase()) ||
        e.templateKey.toLowerCase().includes(arg.toLowerCase())
      )
      if (!match) {
        const names = coverageMap.map(e => `\`${e.label.toLowerCase()}\``).join(' · ')
        await ch.send(`No matching category found for "${arg}". Valid names:\n${names}`)
      } else {
        const removed = resetByTemplateKey(match.templateKey)
        await ch.send(`✅ Cleared **${removed}** record${removed !== 1 ? 's' : ''} for **${match.label}** — it will show as never posted on next check.`)
      }
    }
    return
  }

  // Batch weekly content plan — ask audience level first (same as single-ad flow)
  if (content === 'weekly plan' || content.startsWith('content plan')) {
    const ch = message.channel as SendableChannel
    const countMatch = content.match(/:\s*(\d+)/)
    const count = Math.min(Math.max(parseInt(countMatch?.[1] ?? '5'), 1), 7)

    await ch.send(
      `Got it. Ano ang audience level ng target audience para sa **${count}-ad weekly plan**?\n\n` +
      `**1 ·** Unaware — Hindi pa nila alam na may ganitong pangangailangan\n` +
      `**2 ·** Problem Aware — Alam na nila ang problema, naghahanap ng solusyon\n` +
      `**3 ·** Solution Aware — Inihahambing na nila ang mga opsyon\n` +
      `**4 ·** Product Aware — Pamilyar na sa brand, naghahanap ng detalye o presyo\n` +
      `**5 ·** Most Aware — Handang kumilos, kailangan lang ng tamang alok\n\n` +
      `I-reply ang numero.`
    )
    const heroDataUris = await fetchAllAttachmentHeroes(message)
    if (heroDataUris.length > 0) {
      await ch.send(`📸 Got **${heroDataUris.length} image${heroDataUris.length > 1 ? 's' : ''}** — will distribute one per ad.`)
    }
    const job = createJob({ status: 'pending', brief: { product: 'Renaissance Park & Chapels', concept: 'Weekly plan' }, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchAudiencePick: { count, heroDataUris } })
    return
  }

  // Preview all templates
  if (content === 'preview templates') {
    const ch = message.channel as SendableChannel
    const photoCount = TEMPLATE_PREVIEW_LIST.filter(t => t.needsPhoto).length
    await ch.send(`Generating previews for all **${TEMPLATE_PREVIEW_LIST.length} templates**... results appear one by one.\n_Tip: attach a park photo to get previews for all ${photoCount} photo templates._`)
    const heroDataUri = await fetchPreviewHero(message)
    if (!heroDataUri) {
      await ch.send(`⚠️ No usable hero photo found — photo templates will be skipped. Attach a park photo to this message and resend \`preview templates\`.`)
    }
    await runTemplatePreview(ch, null, heroDataUri)
    return
  }

  // Preview a single template by name
  if (content.startsWith('preview:')) {
    const ch = message.channel as SendableChannel
    const name = content.slice('preview:'.length).trim()
    const templateKey = TEMPLATE_NAME_MAP[name]
    if (!templateKey) {
      const names = TEMPLATE_PREVIEW_LIST.map(t => `\`${t.label.toLowerCase()}\``).join(' · ')
      await ch.send(`Unknown template. Valid names:\n${names}`)
      return
    }
    const t = TEMPLATE_PREVIEW_LIST.find(t => t.key === templateKey)!
    await ch.send(`Generating **${t.label}** preview...`)
    const heroDataUri = t.needsPhoto ? await fetchPreviewHero(message) : null
    if (t.needsPhoto && !heroDataUri) {
      await ch.send('⚠️ No hero photo available. Attach a park photo to this message and resend.')
      return
    }
    await runTemplatePreview(ch, templateKey, heroDataUri)
    return
  }

  // Post latest generated ad (recover after server restart)
  if (content === 'post latest') {
    const ch = message.channel as SendableChannel
    const userId = message.author.id

    // Find latest image in public/outputs
    const outputDir = path.join(process.cwd(), 'public', 'outputs')
    let latestImagePath: string | null = null
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.png'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(outputDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (files.length > 0) latestImagePath = path.join(outputDir, files[0].name)
    }

    if (!latestImagePath) {
      await ch.send('No generated ads found in outputs folder.')
      return
    }

    // Find latest non-published draft
    const draft = listDrafts(['pending_review', 'approved']).find(d => d.discordUserId === userId)
      ?? listDrafts(['pending_review', 'approved'])[0]

    if (!draft) {
      await ch.send('No pending drafts found. The ad image exists but the caption is missing — please run the full flow again.')
      return
    }

    const s = loadSettings()
    const caption = buildFacebookCaption(draft)
    const fileName = path.basename(latestImagePath)
    const adBrief: AdBrief = {
      product: `${s.footerRight1} ${s.footerRight2}`.trim() || 'Renaissance Park & Chapels',
      concept: draft.concept,
      caption: draft.caption,
    }
    const nextSlot = getNextBestPostTime()
    const job = createJob({ status: 'rendering', brief: adBrief, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })

    g.__pendingBriefs!.set(userId, {
      job,
      awaitingReply: true,
      assets: [],
      facebookConfirm: { localPath: latestImagePath, fileName, caption, approvedDraftId: draft.id, adBrief },
    })

    const attachment = new AttachmentBuilder(latestImagePath, { name: 'ad-preview.png' })
    await ch.send({
      content:
        `Here's your latest ad _(${draft.concept})_\n\n` +
        `Reply **yes** to post now, **schedule** to queue for ${formatPHT(nextSlot)}, **reprompt: [notes]** to redesign, or **no** to cancel.`,
      files: [attachment],
    })
    return
  }

  // Boost campaign analytics (debug mode)
  if (content === 'boost debug') {
    await message.reply('Running raw API debug...')
    const adAccountId = process.env.FB_AD_ACCOUNT_ID
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
    if (!adAccountId || !accessToken) { await message.reply('⚠️ FB_AD_ACCOUNT_ID or FACEBOOK_ACCESS_TOKEN not set'); return }
    const tok = encodeURIComponent(accessToken)
    // Pick the first ACTIVE campaign and dump raw responses
    const https = require('https') as typeof import('https')
    const get = (path: string) => new Promise<any>((res, rej) => {
      const req = https.request({ hostname: 'graph.facebook.com', path, method: 'GET' }, (r: any) => {
        const c: Buffer[] = []
        r.on('data', (d: Buffer) => c.push(d))
        r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())) } catch { rej(new Error('non-JSON')) } })
      })
      req.on('error', rej); req.end()
    })
    const campaigns = await get(`/v21.0/${adAccountId}/campaigns?fields=id,name,effective_status,created_time&limit=3&access_token=${tok}`)
    await message.reply(`**Campaigns (first 3):**\n\`\`\`json\n${JSON.stringify(campaigns, null, 2).slice(0, 1800)}\`\`\``)
    if (campaigns.data?.[0]) {
      const cid = campaigns.data[0].id
      const ins = await get(`/v21.0/${cid}/insights?fields=spend,reach,impressions,cpm,ctr,clicks&date_preset=maximum&access_token=${tok}`)
      await message.reply(`**Insights for campaign ${cid}:**\n\`\`\`json\n${JSON.stringify(ins, null, 2).slice(0, 1800)}\`\`\``)
      const adsets = await get(`/v21.0/${cid}/adsets?fields=daily_budget,lifetime_budget,budget_remaining&access_token=${tok}`)
      await message.reply(`**Adsets for campaign ${cid}:**\n\`\`\`json\n${JSON.stringify(adsets, null, 2).slice(0, 1800)}\`\`\``)
      const ads = await get(`/v21.0/${cid}/ads?fields=effective_status,creative{object_story_id}&access_token=${tok}`)
      await message.reply(`**Ads for campaign ${cid}:**\n\`\`\`json\n${JSON.stringify(ads, null, 2).slice(0, 1800)}\`\`\``)
    }
    return
  }

  // Boost campaign analytics
  if (content === 'boost stats') {
    await message.reply('Fetching boost analytics from Facebook...')
    try {
      const items = await fetchBoostCampaignInsights()
      const full = formatBoostInsightsTable(items)
      // Split into ≤1900-char chunks on campaign block boundaries
      const blocks = full.split('\n\n')
      const chunks: string[] = []
      let current = ''
      for (const block of blocks) {
        const next = current ? current + '\n\n' + block : block
        if (next.length > 1900) {
          if (current) chunks.push(current)
          current = block
        } else {
          current = next
        }
      }
      if (current) chunks.push(current)
      for (const chunk of chunks) await message.reply(chunk)
    } catch (err: any) {
      await message.reply(`⚠️ Could not fetch boost analytics: ${err.message}`)
    }
    return
  }

  // Pause every active boost campaign targeting a specific post ID
  if (content.startsWith('pause boost post:') || content.startsWith('unboost post:')) {
    const postId = message.content.slice(message.content.indexOf(':') + 1).trim().replace(/\D/g, '')
    if (!postId) {
      await message.reply('Usage: `pause boost post: 1372029201613949`')
      return
    }
    await message.reply(`Looking up active boosts for post **${postId}**...`)
    try {
      const items = await fetchBoostCampaignInsights()
      const matches = items.filter(c => c.postPhotoId === postId && c.campaignStatus === 'ACTIVE')
      if (matches.length === 0) {
        await message.reply(`No active boost found for post **${postId}**. (Already paused, or wrong ID.)`)
        return
      }
      const paused: string[] = []
      const failed: string[] = []
      for (const c of matches) {
        try {
          await pauseBoostCampaign(c.campaignId)
          paused.push(`📅 ${c.createdTime.slice(0, 10)} · campaign \`${c.campaignId}\` · spent ₱${c.spend.toFixed(2)}`)
        } catch (err: any) { failed.push(`${c.campaignId}: ${err.message}`) }
      }
      if (paused.length > 0) await message.reply(`✅ Paused **${paused.length}** campaign${paused.length === 1 ? '' : 's'}:\n${paused.join('\n')}`)
      if (failed.length > 0) await message.reply(`⚠️ Failed:\n${failed.map(f => `• ${f}`).join('\n')}`)
    } catch (err: any) {
      await message.reply(`⚠️ Could not pause boost: ${err.message}`)
    }
    return
  }

  // Boost scaler — winners vs losers across all measured boosts
  if (content === 'boost scaler' || content === 'scaler') {
    await message.reply('Analyzing boost performance — winners vs losers...')
    try {
      const scaler = await analyzeBoostScaler()
      const full = formatBoostScaler(scaler)
      const lines = full.split('\n')
      const chunks: string[] = []
      let current = ''
      for (const line of lines) {
        const next = current ? current + '\n' + line : line
        if (next.length > 1900) { if (current) chunks.push(current); current = line }
        else { current = next }
      }
      if (current) chunks.push(current)
      for (const chunk of chunks) await message.reply(chunk)
    } catch (err: any) {
      await message.reply(`⚠️ Could not run scaler: ${err.message}`)
    }
    return
  }

  // Delete every empty-shell campaign (campaign exists but has no ad — boost creation failed)
  if (content === 'cleanup shells') {
    await message.reply('Scanning for empty shells (campaigns with no ad)...')
    try {
      const items = await fetchBoostCampaignInsights()
      const shells = items.filter(c => c.adStatus === 'NO_AD' || c.adStatus === 'UNKNOWN')
      if (shells.length === 0) {
        await message.reply('✨ No empty shells found — everything is clean.')
        return
      }
      await message.reply(`Found **${shells.length}** empty shell${shells.length === 1 ? '' : 's'}. Deleting...`)
      const deleted: string[] = []
      const failed: string[] = []
      for (const c of shells) {
        try {
          await deleteCampaign(c.campaignId)
          deleted.push(c.campaignId)
        } catch (err: any) { failed.push(`${c.campaignId}: ${err.message}`) }
      }
      if (deleted.length > 0) await message.reply(`✅ Deleted **${deleted.length}** empty shell${deleted.length === 1 ? '' : 's'}. \`boost stats\` should now be much cleaner.`)
      if (failed.length > 0) await message.reply(`⚠️ Failed to delete ${failed.length}:\n${failed.slice(0, 5).map(f => `• ${f}`).join('\n')}`)
    } catch (err: any) {
      await message.reply(`⚠️ Could not run cleanup: ${err.message}`)
    }
    return
  }

  // Pause a single boost campaign by its campaign ID
  if (content.startsWith('pause boost:')) {
    const campaignId = message.content.slice(message.content.indexOf(':') + 1).trim().replace(/\D/g, '')
    if (!campaignId) {
      await message.reply('Usage: `pause boost: 120244538201080176`')
      return
    }
    await message.reply(`Pausing campaign **${campaignId}**...`)
    try {
      await pauseBoostCampaign(campaignId)
      await message.reply(`✅ Paused campaign \`${campaignId}\` — no more spend.`)
    } catch (err: any) {
      await message.reply(`⚠️ Could not pause: ${err.message}`)
    }
    return
  }

  // Signal store commands
  if (content === 'signals' || content === 'signals refresh') {
    if (content === 'signals refresh') {
      await message.reply('Running surface signal pull...')
      try {
        await runSurfacePull()
      } catch (err: any) {
        await message.reply(`⚠️ Surface pull failed: ${err.message}`)
        return
      }
    }
    try {
      const full = formatSignalsForDiscord()
      const lines = full.split('\n')
      const chunks: string[] = []
      let current = ''
      for (const line of lines) {
        const next = current ? current + '\n' + line : line
        if (next.length > 1900) { if (current) chunks.push(current); current = line }
        else { current = next }
      }
      if (current) chunks.push(current)
      for (const chunk of chunks) await message.reply(chunk)
    } catch (err: any) {
      await message.reply(`⚠️ Could not load signals: ${err.message}`)
    }
    return
  }

  // Manual pairing run
  if (content === 'pairing run') {
    const ch = message.channel as SendableChannel
    try {
      await runPairingRun(ch)
    } catch (err: any) {
      await ch.send(`⚠️ Pairing run failed: ${err.message}`)
    }
    return
  }

  // Guide video — convert an attached PDF user guide into a 60s explainer video
  if (content === 'guide video') {
    const ch = message.channel as SendableChannel
    const attachment = message.attachments.find(a =>
      a.contentType?.includes('pdf') || a.name?.toLowerCase().endsWith('.pdf')
    )
    if (!attachment) {
      await ch.send('Attach a PDF to the message. Usage: type `guide video` with a PDF file attached.')
      return
    }

    const progressMsg = await ch.send('Starting guide video generation — this takes ~8 minutes...')
    const onProgress = async (text: string) => {
      try { await progressMsg.edit(text) } catch { await ch.send(text) }
    }

    try {
      const { buildGuideVideo, downloadBuffer } = await import('./guideVideo')
      const pdfBuffer = await downloadBuffer(attachment.url)
      const videoBuffer = await buildGuideVideo(pdfBuffer, onProgress)

      await onProgress('✅ Done! Sending video...')
      await ch.send({
        content: `🎬 **${attachment.name?.replace('.pdf', '') ?? 'Guide'} — 60s Explainer Video**`,
        files: [{ attachment: videoBuffer, name: 'guide_video.mp4' }],
      })
    } catch (err: any) {
      await ch.send(`⚠️ Guide video failed: ${err.message}`)
    }
    return
  }

  // Concept ad — generate one ad from a plain text brief, using Runway if emotional
  if (content.startsWith('concept ad:')) {
    const brief = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!brief) { await message.reply('Usage: `concept ad: [your brief here]`'); return }

    const ch = message.channel as SendableChannel
    await ch.send(`Writing draft for: _"${brief}"_...`)

    try {
      const s = loadSettings()
      const awareness = 'problem-aware'
      const categories = (AD_CATEGORIES_BY_LEVEL[awareness] ?? []).filter(c => c.designDirective.endsWith('_TEMPLATE'))
      const problem = { text: brief, objective: 'grief' }
      const [insights, heroDataUris] = await Promise.all([
        fetchCategoryInsights().catch(() => []),
        loadShuffledHeroUris(),
      ])
      const perfContext = formatInsightsForClaude(insights) || undefined
      const qualSigs = getQualifiedSignals(5)
      const sigCtx = qualSigs.length > 0 ? { signals: qualSigs.map(s => s.text) } : undefined

      const [draft] = await generateBatchDrafts(awareness, [problem], categories, perfContext, undefined, sigCtx)
      const fullCaption = buildFacebookCaption({ caption: draft.caption, hashtags: draft.hashtags ?? [], ctaText: draft.ctaText ?? '', engagementHook: draft.engagementHook ?? '' })
      await ch.send(`**${draft.label}** — _${draft.concept}_\n\n${fullCaption}`)

      const adBrief: AdBrief = {
        product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
        concept: draft.concept, caption: draft.caption, ctaText: draft.ctaText,
      }

      // Determine hero: Runway concept image or library photo
      let heroAsset: MediaAsset | null = heroDataUris.length > 0
        ? { id: heroDataUris[0].id, name: 'hero.jpg', mimeType: 'image/jpeg', url: heroDataUris[0].uri, webViewLink: heroDataUris[0].uri }
        : null

      if (draft.conceptImagePrompt) {
        await ch.send(`🎨 Generating concept image via Runway...`)
        try {
          const imgBuf = await generateConceptImage(draft.conceptImagePrompt)
          const conceptUri = `data:image/jpeg;base64,${imgBuf.toString('base64')}`
          g.__lastConceptImageUri = conceptUri
          heroAsset = { id: 'runway', name: 'hero_background.jpg', mimeType: 'image/jpeg', url: conceptUri, webViewLink: '' }
        } catch (err: any) {
          g.__lastConceptImageUri = undefined
          await ch.send(`⚠️ Concept image generation failed (${err.message}) — falling back to library hero photo.`)
        }
      } else {
        g.__lastConceptImageUri = undefined
      }

      const result = await generateImageAd(adBrief, heroAsset ? [heroAsset] : [], draft.templateKey)
      g.__lastAdBuffer = result.buffer
      g.__lastAdCaption = draft.caption
      const attachment = new AttachmentBuilder(result.buffer, { name: `concept_ad.png` })
      await ch.send({ content: `**Image Ad** _(${draft.label})_\nType \`animate ad\` to generate a 30s video ad with scene script + voiceover.`, files: [attachment] })
    } catch (err: any) {
      await message.reply(`⚠️ concept ad failed: ${err.message}`)
    }
    return
  }

  // 30-second video ad: scene script → 3 Runway clips → stitch → TTS narration → mix
  if (content === 'animate ad') {
    const ch = message.channel as SendableChannel
    const caption = g.__lastAdCaption
    if (!caption) {
      await ch.send('No ad in memory. Run `concept ad:` first.')
      return
    }

    try {
      // Step 1 — generate scene script + narration
      await ch.send('🎬 **Building 30s video ad...**\n_(Step 1/4) Writing scene script + narration via Claude..._')
      const script = await generateVideoScript(caption)
      await ch.send(
        `📜 **Scene Script Ready**\n` +
        script.scenes.map((s, i) => `**Scene ${i + 1}** _(${(i + 1) * 10 - 9}–${(i + 1) * 10}s)_: ${s.description}`).join('\n') +
        `\n\n🎙️ **Narration:** _"${script.narration.slice(0, 200)}${script.narration.length > 200 ? '…' : ''}"_\n\n_(Step 2/4) Generating 3 × 10s clips via Runway — this takes ~5 minutes..._`
      )

      // Step 2 — generate 3 clips sequentially (Runway rate limits)
      // Scene 1: concept image → image-to-video (emotional hook anchored to the concept visual)
      // Scene 2: text-to-video (reflection — fully prompt-driven, no fixed reference)
      // Scene 3: text-to-video (park resolution — let Runway render fresh cinematic park scene)
      // Park photos are only used as reference when there is no concept image (park-focused ad)
      const hasConceptImage = !!g.__lastConceptImageUri
      const heroUris = hasConceptImage ? [] : await loadShuffledHeroUris()

      const clips: Buffer[] = []
      for (let i = 0; i < 3; i++) {
        const scene = script.scenes[i]
        let clip: Buffer

        if (i === 0 && g.__lastConceptImageUri) {
          // Emotional ad — Scene 1 anchored to the concept image
          clip = await generateVideoFromImage(g.__lastConceptImageUri, scene.visualPrompt, 10)
        } else if (!hasConceptImage && heroUris[i]?.uri) {
          // Park-focused ad — all scenes use library photos as reference
          clip = await generateVideoFromImage(heroUris[i].uri, scene.visualPrompt, 10)
        } else {
          // Scenes 2 & 3 for emotional ads — fully prompt-driven
          clip = await generateVideoAd(scene.visualPrompt)
        }

        clips.push(clip)
        await ch.send(`✅ Scene ${i + 1}/3 rendered`)
      }

      // Step 4 — stitch + TTS in parallel, then mix
      await ch.send('_(Step 3/4) Stitching clips + generating voiceover..._')
      const [stitched, audioBuf] = await Promise.all([
        stitchVideoClips(clips),
        generateSpeech(script.narration).catch(async (err: any) => {
          await ch.send(`⚠️ TTS failed (${err.message}) — will send silent video`)
          return null as Buffer | null
        }),
      ])

      await ch.send('_(Step 4/4) Mixing video + voiceover..._')
      const finalBuf = audioBuf ? await mixVideoAudio(stitched, audioBuf) : stitched
      const attachment = new AttachmentBuilder(finalBuf, { name: 'rp_video_30s.mp4' })
      await ch.send({
        content:
          `🎬 **30-second Video Ad Ready**${audioBuf ? ' — with narration voiceover' : ' — silent (TTS failed)'}\n` +
          `_3 scenes · ${clips.length * 10}s · Renaissance Park & Chapels_`,
        files: [attachment],
      })
    } catch (err: any) {
      await ch.send(`⚠️ Video generation failed: ${err.message}`)
    }
    return
  }

  // Boost a specific post by URL or post ID
  if (content.startsWith('boost post:')) {
    const input = message.content.slice(message.content.indexOf(':') + 1).trim()
    // Extract fbid from URL (e.g. ?fbid=123) or treat as raw post ID
    const fbidMatch = input.match(/fbid=(\d+)/) ?? input.match(/\/(\d+)\/?$/)
    const postId = fbidMatch ? fbidMatch[1] : input.replace(/\D/g, '')
    if (!postId) {
      await message.reply('Could not parse post ID. Use: `boost post: https://www.facebook.com/photo/?fbid=123` or `boost post: 123`')
      return
    }
    const pageId = process.env.FACEBOOK_PAGE_ID
    if (!pageId) {
      await message.reply('⚠️ FACEBOOK_PAGE_ID not set in .env.local')
      return
    }
    const s = loadSettings()
    const objectStoryId = `${pageId}_${postId}`
    await message.reply(
      `Boost **post ${postId}**?\n` +
      `> ₱${s.boostBudgetPHP}/day · ages ${s.boostAgeMin}–${s.boostAgeMax} · ${s.boostCountry}\n\n` +
      `Reply **boost** to confirm or **skip** to cancel.`
    )
    const entry = g.__pendingBriefs!.get(userId)
    g.__pendingBriefs!.set(userId, {
      ...(entry ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      boostConfirm: { postId: objectStoryId, fbUrl: input },
    })
    return
  }

  // Brand knowledge Q&A
  if (content.startsWith('brand:')) {
    const question = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!question) { await message.reply('Ask a question after the colon. Example: `brand: Hassle in transferring from public cemetery`'); return }
    await handleBrandQuestion(message, question)
    return
  }

  // Scan Drive folder — score all unscored photos and add to asset library
  if (content === 'scan drive') {
    await handleScanDrive(message)
    return
  }

  // Asset submission — "submit: [caption]" or "brief: [draftId]: [caption]"
  if (content.startsWith('submit:') || content.startsWith('brief:')) {
    await handleAssetSubmission(message)
    return
  }
  if (content === 'submit asset' || content === 'upload asset') {
    await message.reply(
      '**How to submit assets:**\n' +
      '`submit:` + attach image(s) — Claude describes each image automatically\n' +
      '`submit: [context]` + attach image(s) — add context to help scoring (e.g. "brand assets batch")\n' +
      '`brief: [brief ID]:` + attach image — fulfil a specific asset brief\n\n' +
      'You can attach multiple images at once — each is scored and classified individually.'
    )
    return
  }

  // Detect post generation trigger → ask for objective first
  const postTrigger = POST_TRIGGER_PHRASES.find(p => content.includes(p))
  if (postTrigger) {
    const concept = message.content
      .slice(message.content.toLowerCase().indexOf(postTrigger) + postTrigger.length)
      .trim()
    if (!concept) {
      await message.reply('What should the post be about? Example: *create post for chapel blessing ceremony*')
      return
    }
    await askAudienceLevel(message, concept)
    return
  }

  // Image-only message with no matching command — treat as asset submission
  if (!content && message.attachments.size > 0) {
    await handleAssetSubmission(message)
    return
  }

  // Detect ad generation trigger
  const trigger = TRIGGER_PHRASES.find((p) => content.includes(p))
  if (!trigger) return

  const afterTrigger = message.content
    .slice(message.content.toLowerCase().indexOf(trigger) + trigger.length)
    .trim()

  if (!afterTrigger) {
    await message.reply(
      'Please tell me what the ad is for! Example: *generate ad for my coffee brand — concept: morning ritual*'
    )
    return
  }

  const [productPart, ...rest] = afterTrigger.split('—')
  const conceptMatch = rest.join('—').match(/concept[:\s]+(.+)/i)

  const brief: AdBrief = {
    product: productPart.trim(),
    concept: conceptMatch?.[1]?.trim() ?? afterTrigger,
  }

  const initialAssets = collectAttachments(message)

  const job = createJob({
    status: 'clarifying',
    brief,
    assets: initialAssets,
    discordChannelId: message.channelId,
    discordUserId: userId,
    conversationStep: 'clarifying',
  })

  g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: initialAssets })

  await message.reply(
    `On it — I'll build a Facebook ad for **${brief.product}**. A few questions first:\n\n_Attach product or venue images any time and I'll pull them into the ad._`
  )

  try {
    const questions = await generateClarifyingQuestions(brief)
    await (message.channel as SendableChannel).send(questions)
  } catch (err: any) {
    const hint = err?.message?.includes('credit balance')
      ? 'Anthropic API credit balance is too low. Please top up at console.anthropic.com.'
      : `Claude API error: ${err?.message ?? 'unknown error'}`
    // Keep the pending entry alive — user can still answer and type ready
    await (message.channel as SendableChannel).send(
      `⚠️ ${hint}\n\nYou can still answer these questions and type **ready** when done:\n\n` +
      `**1.** What 2 services/selling points to highlight?\n` +
      `*(e.g. Park Lots — Available Now | Chapel Services — 24/7 Support)*\n\n` +
      `**2.** Staff member to feature? (name + job title, or "skip")\n` +
      `*(e.g. Rey Mark Javier Tinaja, Renaissance Employee)*\n\n` +
      `**3.** Your tagline and year founded?\n` +
      `*(e.g. Where Every Life is Celebrated, 2001)*\n\n` +
      `**4.** What city/region for the footer?\n` +
      `*(e.g. Cagayan de Oro, Mindanao)*\n\n` +
      `**5.** What should the CTA button say?\n` +
      `*(e.g. INQUIRE NOW / BOOK NOW / CALL US TODAY)*`
    )
  }
}


async function handleBriefFulfilled(draft: PostDraft, imageUrl: string, submitterName: string) {
  if (!g.__discordClient) return

  const channel = await g.__discordClient.channels.fetch(draft.discordChannelId!).catch(() => null)
  if (!channel?.isTextBased()) return

  const ch = channel as SendableChannel

  await ch.send(
    `📸 **${submitterName}** just submitted the photo — regenerating the draft with the actual image...`
  )

  try {
    const generated = await generatePost({
      concept: draft.concept,
      objective: draft.objective,
      discordUserId: draft.discordUserId,
      discordUserName: submitterName,
      imageUrl,
    })

    const updatedDraft: PostDraft = {
      ...draft,
      caption: generated.caption,
      hashtags: generated.hashtags,
      ctaText: generated.ctaText,
      engagementHook: generated.engagementHook,
      assetBrief: generated.assetBrief,
      status: 'pending_review',
      fulfilledAssetUrl: imageUrl,
      updatedAt: new Date().toISOString(),
    }

    updateDraft(draft.id, {
      caption: updatedDraft.caption,
      hashtags: updatedDraft.hashtags,
      ctaText: updatedDraft.ctaText,
      engagementHook: updatedDraft.engagementHook,
      assetBrief: updatedDraft.assetBrief,
      status: 'pending_review',
      fulfilledAssetUrl: imageUrl,
    })

    // Re-engage the original poster with the updated draft
    g.__pendingBriefs!.set(draft.discordUserId, {
      job: g.__pendingBriefs!.get(draft.discordUserId)?.job ?? (null as any),
      awaitingReply: true,
      assets: [],
      postReview: { draft: updatedDraft, revisionCount: 0 },
    })

    await ch.send(
      `Here's the updated draft with the image attached:\n\n` +
      formatDraftForDiscord(updatedDraft, 0)
    )
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(
      isCredits
        ? `⚠️ API credit balance too low to regenerate the post. The image has been saved to the asset library.`
        : `⚠️ Failed to regenerate post with image: ${err.message}`
    )
  }
}

async function handleAssetSubmission(message: Message) {
  const ch = message.channel as SendableChannel
  const content = message.content.trim()
  const submitterName = message.member?.nickname ?? message.author.globalName ?? message.author.username

  // Parse optional context and optional brief ID
  let submitterContext = ''
  let linkedBriefId: string | undefined

  if (content.toLowerCase().startsWith('brief:')) {
    const rest = content.slice('brief:'.length).trim()
    const colonIdx = rest.indexOf(':')
    if (colonIdx !== -1) {
      linkedBriefId = rest.slice(0, colonIdx).trim()
      submitterContext = rest.slice(colonIdx + 1).trim()
    } else {
      // "brief: draft_xxx" with no caption — that's fine, Claude will describe the image
      linkedBriefId = rest
    }
  } else {
    const colonIdx = content.indexOf(':')
    submitterContext = colonIdx !== -1 ? content.slice(colonIdx + 1).trim() : ''
  }

  const assets = collectAttachments(message)
  if (assets.length === 0) {
    await message.reply(
      'Please attach at least one image with your submission.\n' +
      'Examples:\n' +
      '`submit:` + attach image(s) — Claude will describe each one automatically\n' +
      '`submit: chapel interior batch` + attach multiple images — context helps Claude score better\n' +
      '`brief: draft_xxx:` + attach image — fulfil a specific asset brief'
    )
    return
  }

  await ch.send(`Scoring ${assets.length} ${assets.length > 1 ? 'images' : 'image'}...`)

  // Score all images in parallel
  const scored = await Promise.all(
    assets.map(async (asset) => {
      try {
        const result = await scoreAsset(asset.url, submitterContext, submitterName)
        return { asset, result, error: null }
      } catch (err: any) {
        return { asset, result: null, error: err }
      }
    })
  )

  const results: string[] = []
  let briefFulfillmentAsset: { url: string; name: string } | null = null

  for (const { asset, result, error } of scored) {
    if (error) {
      const msg: string = error?.message ?? 'unknown error'
      const isCredits = msg.includes('credit balance')
      const isRate = msg.includes('rate limit') || msg.includes('429')
      const label = isCredits
        ? 'API credit balance too low — top up at console.anthropic.com'
        : isRate
          ? 'Rate limit hit — try again in a moment'
          : msg
      results.push(`⚠️ **${asset.name}** — Scoring failed: ${label}`)
      continue
    }

    const stored: StoredAsset = {
      id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      fileName: asset.name,
      discordUrl: asset.url,
      submittedBy: message.author.id,
      submittedByName: submitterName,
      caption: result!.imageDescription,      // Claude's own description
      submitterNote: submitterContext || undefined,
      assetType: result!.assetType,
      qualityScore: result!.qualityScore,
      relevanceScore: result!.relevanceScore,
      brandScore: result!.brandScore,
      overallScore: result!.overallScore,
      status: result!.passed ? 'approved' : 'rejected',
      rejectionReason: result!.rejectionReason,
      qualityNotes: result!.qualityNotes,
      relevanceNotes: result!.relevanceNotes,
      brandNotes: result!.brandNotes,
      tags: result!.tags,
      linkedBriefId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    addAsset(stored)

    // Upload approved assets to Google Drive in background — filename uses asset ID for traceability
    if (result!.passed && (process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_ACCESS_TOKEN)) {
      const driveFileName = `${stored.id}_${asset.name}`
      uploadImageFromUrl(asset.url, driveFileName)
        .then(driveUrl => updateAsset(stored.id, { driveUrl }))
        .catch(err => console.error(`[Drive] Upload failed for ${stored.id}:`, err))
    }

    const typeLabel = result!.assetType.toUpperCase()

    if (result!.passed) {
      const scoreEmoji: Record<string, string> = { featured: '⭐', high: '✅', medium: '🟡', low: '🔵' }
      const emoji = scoreEmoji[result!.overallScore!] ?? '✅'
      results.push(
        `${emoji} **${asset.name}** — **${result!.overallScore!.toUpperCase()}** · ${typeLabel}\n` +
        `> _${result!.imageDescription}_\n` +
        `> Quality ${result!.qualityScore}/10 · Relevance ${result!.relevanceScore}/10 · Brand ${result!.brandScore}/10\n` +
        (result!.tags.length ? `> Tags: ${result!.tags.join(', ')}` : '')
      )
      // For brief fulfilment, use the first passing asset
      if (linkedBriefId && !briefFulfillmentAsset) {
        briefFulfillmentAsset = { url: asset.url, name: asset.name }
      }
    } else {
      results.push(
        `❌ **${asset.name}** — **REJECTED** · ${typeLabel}\n` +
        `> _${result!.imageDescription}_\n` +
        `> ${result!.rejectionReason ?? 'Does not meet quality or relevance standards.'}\n` +
        `> Quality ${result!.qualityScore}/10 · Relevance ${result!.relevanceScore}/10 · Brand ${result!.brandScore}/10`
      )
    }
  }

  await ch.send(
    `Scored ${assets.length} ${assets.length > 1 ? 'images' : 'image'} from **${submitterName}**:\n\n` +
    results.join('\n\n') +
    (linkedBriefId ? `\n\n_Linked to brief \`${linkedBriefId}\`_` : '')
  )

  // Trigger brief re-run if a passing asset was submitted for a specific brief
  if (briefFulfillmentAsset && linkedBriefId) {
    const linkedDraft = getDraft(linkedBriefId)
    if (linkedDraft && linkedDraft.status === 'approved' && linkedDraft.discordChannelId) {
      handleBriefFulfilled(linkedDraft, briefFulfillmentAsset.url, submitterName).catch((err: any) =>
        console.error('[Discord] Brief fulfillment re-run failed:', err)
      )
    }
  }
}

// ─── Template preview ─────────────────────────────────────────────────────────
async function fetchPreviewHero(message: Message): Promise<string | null> {
  // Priority 1: image attached to the command message (always a fresh URL)
  const att = [...message.attachments.values()].find(a => a.contentType?.startsWith('image/'))
  if (att) {
    try {
      const raw = await downloadToBuffer(att.url)
      const jpeg = await sharp(raw)
        .resize(1200, 1500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
      console.log(`[Preview] Hero from attachment: ${att.name} (${jpeg.length} bytes)`)
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`
    } catch (err) {
      console.error('[Preview] Attachment download failed:', err)
    }
  }

  // Priority 2: best approved asset from library
  const hero = pickBestHeroAsset()
  if (hero) {
    try {
      const raw = await downloadImage(hero.driveUrl || hero.discordUrl)
      const jpeg = await sharp(raw)
        .resize(1200, 1500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
      console.log(`[Preview] Hero from library: ${hero.fileName} (${jpeg.length} bytes)`)
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`
    } catch (err) {
      console.error('[Preview] Library hero download failed:', err)
    }
  }

  return null
}

async function fetchAllAttachmentHeroes(message: Message): Promise<string[]> {
  const attachments = [...message.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
  if (attachments.length === 0) return []
  const uris: string[] = []
  for (const att of attachments) {
    try {
      const raw = await downloadToBuffer(att.url)
      const jpeg = await sharp(raw)
        .resize(1200, 1500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
      uris.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    } catch (err) {
      console.error('[Batch] Attachment download failed:', err)
    }
  }
  return uris
}

// Load all approved hero assets, shuffled, as base64 data URIs.
// Shuffling on every call ensures different photos appear across coverage check runs.
interface HeroAssetEntry { uri: string; id: string }

function deprioritizeRecentHeroes(assets: StoredAsset[]): StoredAsset[] {
  const recentIds = new Set(getRecentHeroIds(10))
  const fresh = assets.filter(a => !recentIds.has(a.id))
  const recent = assets.filter(a => recentIds.has(a.id))
  return [...shuffle(fresh), ...shuffle(recent)]
}

async function loadShuffledHeroUris(): Promise<HeroAssetEntry[]> {
  const heroTypes: AssetType[] = ['photo', 'background', 'illustration', 'other']
  const sourceFolderId = process.env.GOOGLE_SOURCE_FOLDER_ID

  // Drive-first: list images currently in the source folder, keep only approved library assets
  if (sourceFolderId && (process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_ACCESS_TOKEN)) {
    try {
      const driveImages = await listFolderImages(sourceFolderId)
      if (driveImages.length > 0) {
        const approved = listAssets('approved').filter(a => heroTypes.includes(a.assetType as AssetType))
        const matched = driveImages
          .map(img => approved.find(a => a.driveUrl?.includes(img.id)))
          .filter((a): a is StoredAsset => !!a)
        const candidates = deprioritizeRecentHeroes(matched)
        const entries: HeroAssetEntry[] = []
        for (const asset of candidates) {
          try {
            const raw = await downloadImage(assetDownloadUrl(asset))
            const jpeg = await sharp(raw)
              .resize(1200, 1500, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer()
            entries.push({ uri: `data:image/jpeg;base64,${jpeg.toString('base64')}`, id: asset.id })
          } catch (err: any) { console.warn(`[Assets] Skipping Drive image download: ${err.message}`) }
        }
        if (entries.length > 0) return entries
      }
    } catch (err: any) { console.warn(`[Assets] Drive folder listing failed, falling back to asset library: ${err.message}`) }
  }

  // Fallback: asset library only
  const assets = deprioritizeRecentHeroes(
    listAssets('approved').filter(a => heroTypes.includes(a.assetType as AssetType))
  )
  const entries: HeroAssetEntry[] = []
  for (const asset of assets) {
    try {
      const raw = await downloadImage(assetDownloadUrl(asset))
      const jpeg = await sharp(raw)
        .resize(1200, 1500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
      entries.push({ uri: `data:image/jpeg;base64,${jpeg.toString('base64')}`, id: asset.id })
    } catch (err: any) { console.warn(`[Assets] Skipping library image download: ${err.message}`) }
  }
  return entries
}

async function runTemplatePreview(ch: SendableChannel, templateKey: string | null, heroDataUri: string | null) {
  const s = loadSettings()
  const brief: AdBrief = {
    product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
    concept: 'Peaceful family memorial park with flexible lot plans and full interment services in South Cotabato',
    location: 'Tantangan, South Cotabato',
  }

  const heroMediaAsset: MediaAsset | null = heroDataUri ? {
    id: 'preview_hero', name: 'hero.jpg', mimeType: 'image/jpeg',
    url: heroDataUri, webViewLink: heroDataUri, score: 90,
  } : null

  const list = templateKey
    ? TEMPLATE_PREVIEW_LIST.filter(t => t.key === templateKey)
    : TEMPLATE_PREVIEW_LIST

  for (const t of list) {
    if (t.needsPhoto && !heroMediaAsset) {
      await ch.send(`⏭️ **${t.label}** — skipped (no hero photo)`)
      continue
    }
    try {
      const assets = t.needsPhoto && heroMediaAsset ? [heroMediaAsset] : []
      const result = await generateImageAd(brief, assets, t.key)
      const attachment = new AttachmentBuilder(result.buffer, { name: `preview_${t.key.toLowerCase()}.png` })
      await ch.send({ content: `**${t.label}** · \`${t.key}\``, files: [attachment] })
    } catch (err: any) {
      console.error(`[Preview] ${t.key} failed:`, err)
      await ch.send(`❌ **${t.label}** failed: ${err?.message ?? 'unknown error'}`)
    }
  }

  if (!templateKey) await ch.send('✅ All template previews done.')
}

// ─── Brand knowledge Q&A ─────────────────────────────────────────────────────
async function sendRepromptList(ch: SendableChannel) {
  await ch.send(
    `**📋 Reprompt Reference** — use \`reprompt: [notes]\` after an image ad is generated.\n\n` +
    `**🖼️ Layout — Centered**\n` +
    `\`reprompt: Centered layout, large headline dominates, minimal elements\`\n` +
    `\`reprompt: Centered layout, headline only — no body line, no eyebrow, single CTA button at bottom\`\n` +
    `\`reprompt: Centered layout, full-bleed hero, text anchored to bottom third, dark gradient at bottom\`\n` +
    `\`reprompt: Centered layout, headline + pricing grid (3 cards), no body line, CTA button\`\n` +
    `\`reprompt: Centered layout, oversized single price (₱240/buwan) as hero element below headline\``
  )
  await ch.send(
    `**🖼️ Layout — Split (Left Panel)**\n` +
    `\`reprompt: Left-aligned split layout, dark gradient panel on left fading to transparent on right so photo bleeds through, logo top-left, headline left-aligned with one key emotional word on its own line in large italic gold (72px+), remaining headline words white 50px, short gold rule below headline, italic body line, CTA button with phone icon gold outline, footer with address bottom-left, no phone number in design, no secondary brand name text below logo\`\n` +
    `\`reprompt: Split layout — left dark panel 55% width, right side shows photo; headline left-aligned 3 lines max, body line italic, pricing grid 2 cards stacked vertically on left, no footer\`\n` +
    `\`reprompt: Split layout — right dark panel, photo on left, all text right-aligned, gold accent word in headline, CTA bottom-right\``
  )
  await ch.send(
    `**🖼️ Layout — Other Styles**\n` +
    `\`reprompt: Bottom-anchored layout — full photo top 60%, dark frosted glass panel bottom 40% with all text inside, headline large, CTA button\`\n` +
    `\`reprompt: Top-anchored layout — dark frosted glass panel top 45% with logo, eyebrow, headline; photo fills bottom half\`\n` +
    `\`reprompt: Magazine editorial — large left number or word in gold as graphic element, small headline beside it, minimal copy, no CTA button\`\n` +
    `\`reprompt: Minimal card layout — solid dark green background (no photo), centered text only, gold serif headline, thin border, small logo top\`\n` +
    `\`reprompt: Cinematic widescreen feel — headline spans full width in large thin serif, photo takes 70% of canvas, very minimal text\``
  )
  await ch.send(
    `**✍️ Headline Style**\n` +
    `\`reprompt: Headline in Filipino, body line in English\`\n` +
    `\`reprompt: Full ad copy in Filipino\`\n` +
    `\`reprompt: Shorter headline — 4 words max, punchy\`\n` +
    `\`reprompt: Loss framing headline — what families risk by not acting now\`\n` +
    `\`reprompt: Question headline — names the reader's exact fear\`\n` +
    `\`reprompt: Headline as a direct promise, not a question\`\n` +
    `\`reprompt: Headline formula: Problem → Solution\`\n` +
    `\`reprompt: Headline formula: Social proof — families who chose Renaissance Park\`\n` +
    `\`reprompt: One key emotional word in italic gold, rest of headline in white\`\n` +
    `\`reprompt: Two-line headline — first line in white, second line in large italic gold\``
  )
  await ch.send(
    `**💰 Pricing & Offers**\n` +
    `\`reprompt: 3 offer cards, 20-year term monthly prices from knowledge base, label "/ month"\`\n` +
    `\`reprompt: 3 offer cards, 10-year term monthly prices from knowledge base, label "/ month"\`\n` +
    `\`reprompt: 3 offer cards, 7-year term monthly prices from knowledge base, label "/ month"\`\n` +
    `\`reprompt: 3 offer cards, 5-year term monthly prices from knowledge base, label "/ month"\`\n` +
    `\`reprompt: Show spot cash prices only, label "Spot Cash"\`\n` +
    `\`reprompt: 2 offer cards — Regular Lawn and Premium Lawn, 20-year term\`\n` +
    `\`reprompt: Single large price — ₱240/buwan, 20-year Regular Lawn, centered below headline\`\n` +
    `\`reprompt: Price + features list — show 3 bullet inclusions (no downpayment, no annual fee, perpetual care) beside the price\`\n` +
    `\`reprompt: Eyebrow: "Flexible Payment Plans", 3 offer cards 20-year term, label "/ month", centered layout\`\n` +
    `\`reprompt: Replace offer cards with single body line, remove pricing grid entirely\``
  )
  await ch.send(
    `**🎨 Mood & Visual Tone**\n` +
    `\`reprompt: Warmer tone — lighter overlay, brighter gold, more breathing room\`\n` +
    `\`reprompt: More dramatic — darker overlay, deeper shadows, high contrast headline\`\n` +
    `\`reprompt: Elegant and restrained — thinner fonts, more whitespace, smaller CTA\`\n` +
    `\`reprompt: Uplifting — softer overlay, headline focused on peace and celebration of life\`\n` +
    `\`reprompt: Gentle grief tone — empathetic copy, no hard sell, no price\`\n` +
    `\`reprompt: Urgency — darker mood, bolder CTA, loss framing headline\`\n` +
    `\`reprompt: Cinematic and moody — heavy vignette, desaturated photo, bold white headline\``
  )
  await ch.send(
    `**📅 Concept-Specific**\n` +
    `\`reprompt: Undas angle — visiting loved one at the park during All Saints Day\`\n` +
    `\`reprompt: OFW angle — providing peace of mind for family from abroad\`\n` +
    `\`reprompt: Transfer angle — move loved one from public cemetery to Renaissance Park\`\n` +
    `\`reprompt: No hidden fees — transparency as the key message\`\n` +
    `\`reprompt: No annual maintenance fee — perpetual care fund headline\`\n` +
    `\`reprompt: Installment plan — affordable monthly payments, no downpayment headline\`\n` +
    `\`reprompt: Park-for-the-living angle — picnic, wellness, family visits\`\n` +
    `\`reprompt: Urgency — prices increase, lock in current rate now\`\n` +
    `\`reprompt: Chapel angle — full-service wake and burial in one place\`\n` +
    `\`reprompt: Pre-need angle — plan now so your family won't have to decide under grief\``
  )
  await ch.send(
    `**🔁 Combined (copy-paste ready)**\n` +
    `\`reprompt: Centered layout, large headline dominates — affordability angle, loss framing. Eyebrow: "Flexible Payment Plans". 3 offer cards 20-year term from knowledge base, label "/ month". Minimal elements.\`\n` +
    `\`reprompt: Left-split layout, dark left panel, photo bleeds right. Logo top-left, diamond rule. Headline left-aligned, one key word in large italic gold. Body line italic. Single price ₱240/buwan below rule. CTA button gold outline. No phone number, no secondary brand text.\`\n` +
    `\`reprompt: Bottom-anchored layout, frosted glass panel bottom 40%. Headline 3 lines, centered, large. Body line italic. 3 pricing cards inside panel, 20-year term. CTA button.\`\n` +
    `\`reprompt: Filipino headline, English body line. Loss framing — what families miss by waiting. Centered, minimal.\`\n` +
    `\`reprompt: Undas concept. Centered layout. Headline: visiting loved one in a peaceful well-kept park. Warm tone, uplifting, no pricing grid.\`\n` +
    `\`reprompt: OFW concept. Split layout. Filipino headline — providing peace of mind from abroad. Gentle, no hard sell, no price.\`\n` +
    `\`reprompt: Pre-need angle. Centered. Headline: don't leave this decision to your grieving family. Loss framing. Single price ₱240/buwan. CTA: I-message kami.\``
  )
}

async function handleBrandQuestion(message: Message, question: string) {
  const ch = message.channel as SendableChannel
  await ch.sendTyping()

  const kbPath = path.join(process.cwd(), '.claude', 'skills', 'brand', 'docs', 'knowledge_base.txt')
  let knowledgeBase = ''
  try {
    knowledgeBase = fs.readFileSync(kbPath, 'utf8')
  } catch {
    // no knowledge base file — proceed without it
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  try {
    const systemPrompt =
      `You are a senior marketing strategist for Renaissance Park & Chapels — a luxury memorial park and chapel brand in South Cotabato, Philippines.\n\n` +
      `Brand positioning: full-service, dignified, family-oriented; solves the hassle, indignity, and emotional burden of public cemetery alternatives.\n` +
      `ICP: Adults 35–60, Mindanao; recently bereaved (urgent), planning ahead (pre-need), or OFW families protecting parents.\n` +
      `Core differentiators: full-service (lot + chapel + transfer in one place), 24/7 support, park-style grounds, flexible payment plans.\n\n` +
      `The user will give you a customer pain point or problem.\n\n` +
      `STEP 1 — Classify audience awareness level:\n` +
      `- problem-aware: they know the problem but don't know solutions exist → use Problem→Solution frame\n` +
      `- solution-aware: they know solutions exist but haven't chosen → use Your approach vs. others frame\n` +
      `- unaware: they don't know they have a problem → use Story or aspiration hook first\n` +
      `- most-aware: they know the brand and are ready to buy → Offer-led, no setup needed\n\n` +
      `STEP 2 — Frame your entire response using that awareness level:\n` +
      `1. State the awareness level and why you chose it (1 line)\n` +
      `2. Explain why this pain point matters to that specific audience\n` +
      `3. Show how Renaissance Park directly solves it (use exact services, policies, and prices from the knowledge base)\n` +
      `4. Suggest 2-3 Facebook ad hooks framed for that awareness level — use ad-creative headline formulas (Promise, Problem→Solution, or Social Proof)\n` +
      `5. Give 1 objection handler using loss framing (what the family risks by not acting)\n` +
      `6. Name the content pillar for a Facebook post on this topic: Inspire / Educate / Connect / Convert\n\n` +
      `Marketing psychology to apply:\n` +
      `- Loss framing: "Families who wait often pay more / face more stress" is stronger than gain framing\n` +
      `- Social proof: cite a real scenario, not vague "many families"\n` +
      `- For grief/bereaved audience: meet them where they are — acknowledge the emotion before the solution\n` +
      `- Re-engagement angle: if the audience may have inquired before without converting, give them a low-friction reason to re-engage now\n\n` +
      `Be specific and grounded in the brand. Never invent prices or policies.\n` +
      (knowledgeBase ? `\n--- KNOWLEDGE BASE ---\n${knowledgeBase}\n--- END ---` : '')

    // Run awareness classification + response in one call
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    })

    const answer = (msg.content[0] as { text: string }).text

    // Extract awareness level from response for downstream use
    const awarenessMatch = answer.match(/\b(problem-aware|solution-aware|unaware|most-aware)\b/i)
    const awareness = (awarenessMatch?.[1]?.toLowerCase() ?? 'problem-aware') as PendingEntry['brandAwareness']

    const chunks = answer.match(/[\s\S]{1,1900}/g) ?? [answer]
    for (const chunk of chunks) await ch.send(chunk)

    // Store pain point + awareness so both flow into ad generation
    const userId = message.author.id
    const entry = g.__pendingBriefs!.get(userId)
    g.__pendingBriefs!.set(userId, {
      ...(entry ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      brandConcept: question,
      brandAwareness: awareness,
    })
    await ch.send(`**Audience awareness: ${awareness}** — Reply **generate ad** to create a post using this frame.`)
  } catch (err: any) {
    await ch.send(`⚠️ Couldn't answer: ${err.message}`)
  }
}

// ─── Scan Drive folder ────────────────────────────────────────────────────────
async function handleScanDrive(message: Message) {
  const ch = message.channel as SendableChannel
  const sourceFolderId = process.env.GOOGLE_SOURCE_FOLDER_ID

  if (!sourceFolderId) {
    await message.reply('`GOOGLE_SOURCE_FOLDER_ID` is not set in .env.local.')
    return
  }
  if (!process.env.GOOGLE_REFRESH_TOKEN && !process.env.GOOGLE_ACCESS_TOKEN) {
    await message.reply('Google Drive not connected. Visit `/api/auth/google/login` to authenticate.')
    return
  }

  await ch.send('Scanning Drive folder for unscored photos...')

  let driveImages: Awaited<ReturnType<typeof listFolderImages>>
  try {
    driveImages = await listFolderImages(sourceFolderId)
  } catch (err: any) {
    await ch.send(`⚠️ Couldn't list Drive folder: ${err.message}`)
    return
  }

  if (driveImages.length === 0) {
    await ch.send('No images found in the Drive folder.')
    return
  }

  const allLibrary = listAssets('approved').concat(listAssets('rejected'))
  const unscored = driveImages.filter(img => !allLibrary.some(a => a.driveUrl?.includes(img.id)))

  if (unscored.length === 0) {
    await ch.send(`All ${driveImages.length} images in the folder are already scored. Nothing to do.`)
    return
  }

  await ch.send(`Found **${unscored.length}** unscored image${unscored.length > 1 ? 's' : ''} — scoring now... (this may take a moment)`)

  const results: string[] = []
  let approved = 0, rejected = 0

  for (const img of unscored) {
    try {
      const raw = await downloadImage(img.directUrl)
      const imgBuffer = await sharp(raw)
        .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
      const result = await scoreAssetFromBuffer(imgBuffer, '', 'Drive scan')
      const stored: StoredAsset = {
        id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fileName: img.name,
        discordUrl: img.directUrl,
        driveUrl: img.webViewLink,
        submittedBy: message.author.id,
        submittedByName: 'Drive scan',
        caption: result.imageDescription,
        assetType: result.assetType,
        qualityScore: result.qualityScore,
        relevanceScore: result.relevanceScore,
        brandScore: result.brandScore,
        overallScore: result.overallScore,
        status: result.passed ? 'approved' : 'rejected',
        rejectionReason: result.rejectionReason,
        qualityNotes: result.qualityNotes,
        relevanceNotes: result.relevanceNotes,
        brandNotes: result.brandNotes,
        tags: result.tags,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      addAsset(stored)

      if (result.passed) {
        approved++
        const scoreEmoji: Record<string, string> = { featured: '⭐', high: '✅', medium: '🟡', low: '🔵' }
        results.push(`${scoreEmoji[result.overallScore!] ?? '✅'} **${img.name}** — **${result.overallScore!.toUpperCase()}**\n> _${result.imageDescription.slice(0, 100)}_`)
      } else {
        rejected++
        results.push(`❌ **${img.name}** — rejected\n> ${result.rejectionReason ?? 'Does not meet standards'}`)
      }
    } catch (err: any) {
      results.push(`⚠️ **${img.name}** — scoring failed: ${err.message}`)
    }
  }

  // Send results in chunks to avoid Discord 2000 char limit
  const chunks: string[] = []
  let current = `Drive scan complete — **${approved} approved**, **${rejected} rejected**:\n\n`
  for (const r of results) {
    if (current.length + r.length + 2 > 1900) {
      chunks.push(current)
      current = ''
    }
    current += r + '\n\n'
  }
  if (current.trim()) chunks.push(current)
  for (const chunk of chunks) await ch.send(chunk)
}

// ─── Manual photo brief assignment ────────────────────────────────────────────
async function handleAssignBrief(message: Message) {
  const ch = message.channel as SendableChannel
  const raw = message.content

  // Extract draft ID from first line: "assign brief: draft_xxx"
  const firstLine = raw.split('\n')[0]
  const draftId = firstLine.slice(firstLine.toLowerCase().indexOf('assign brief:') + 'assign brief:'.length).trim()

  if (!draftId) {
    await message.reply(
      'Specify the draft ID. Example:\n```\nassign brief: draft_1234567890\nto: @name\nsubject: Chapel interior with candles\nlocation: Main chapel hall\nmood: Warm candlelight\ndeadline: May 5\n```'
    )
    return
  }

  const draft = getDraft(draftId)
  if (!draft) {
    await message.reply(`Couldn't find draft \`${draftId}\`. Check the ID and try again.`)
    return
  }

  // Parse optional override fields from remaining lines
  const parse = (key: string): string | undefined => {
    const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'))
    return match?.[1]?.trim() || undefined
  }

  // Parse "to:" for mention or name
  const toRaw = parse('to')
  let assignedTo = draft.assetBrief?.assignedTo ?? 'Unassigned'
  let pingText = ''

  if (toRaw) {
    const mentionMatch = toRaw.match(/<@!?(\d+)>/)
    if (mentionMatch) {
      const memberId = mentionMatch[1]
      const member = message.guild?.members.cache.get(memberId)
      assignedTo = member?.nickname ?? member?.user.globalName ?? member?.user.username ?? `<@${memberId}>`
      pingText = `<@${memberId}> `
    } else {
      assignedTo = toRaw
    }
  }

  const updatedBrief = {
    ...draft.assetBrief,
    subject:      parse('subject')  ?? draft.assetBrief?.subject  ?? '',
    location:     parse('location') ?? draft.assetBrief?.location ?? '',
    moodLighting: parse('mood')     ?? draft.assetBrief?.moodLighting ?? '',
    deadline:     parse('deadline') ?? draft.assetBrief?.deadline ?? '',
    assignedTo,
  }

  updateDraft(draftId, { assetBrief: updatedBrief })

  await ch.send(
    `${pingText}📋 **PHOTO BRIEF** _(ID: \`${draftId}\`)_\n` +
    `> **Subject:** ${updatedBrief.subject}\n` +
    `> **Location:** ${updatedBrief.location}\n` +
    `> **Mood / Lighting:** ${updatedBrief.moodLighting}\n` +
    `> **Deadline:** ${updatedBrief.deadline}\n` +
    `> **Assigned to:** ${assignedTo}\n\n` +
    `📸 Submit with: \`brief: ${draftId}:\` + attach image`
  )
}

// ─── Gap 1a: Audience level (Q1) ──────────────────────────────────────────────

const AUDIENCE_LEVEL_ALIASES: Record<string, PendingEntry['brandAwareness']> = {
  '1': 'unaware',
  '2': 'problem-aware',
  '3': 'solution-aware',
  '4': 'product-aware',
  '5': 'most-aware',
  'unaware': 'unaware',
  'problem aware': 'problem-aware', 'problem-aware': 'problem-aware',
  'solution aware': 'solution-aware', 'solution-aware': 'solution-aware',
  'product aware': 'product-aware', 'product-aware': 'product-aware',
  'most aware': 'most-aware', 'most-aware': 'most-aware', 'offer': 'most-aware',
}

async function askAudienceLevel(message: Message, concept: string, presetAwareness?: string) {
  if (presetAwareness) {
    await askProblems(message, concept, presetAwareness as PendingEntry['brandAwareness'])
    return
  }
  const userId = message.author.id
  const entry = g.__pendingBriefs!.get(userId)
  g.__pendingBriefs!.set(userId, {
    ...(entry ?? { job: null as any, assets: [] }),
    awaitingReply: true,
    audiencePick: { concept },
  })
  await message.reply(
    `Got it. Ano ang audience level ng target audience?\n\n` +
    `**1 · Unaware** — Hindi pa nila alam na may ganitong pangangailangan\n` +
    `**2 · Problem Aware** — Alam na nila ang problema, naghahanap ng solusyon\n` +
    `**3 · Solution Aware** — Inihahambing na nila ang mga opsyon\n` +
    `**4 · Product Aware** — Pamilyar na sa brand, naghahanap ng detalye o presyo\n` +
    `**5 · Most Aware** — Handang kumilos, kailangan lang ng tamang alok\n\n` +
    `I-reply ang numero.`
  )
}

async function handleAudiencePick(message: Message, pick: { concept: string }) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()
  const awareness = AUDIENCE_LEVEL_ALIASES[reply]
  if (!awareness) {
    await ch.send('I-reply ang **1**, **2**, **3**, **4**, o **5** para piliin ang audience level.')
    return
  }
  g.__pendingBriefs!.set(userId, {
    ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
    awaitingReply: false,
    audiencePick: undefined,
  })
  await askProblems(message, pick.concept, awareness)
}

// ─── Gap 1b: Problem selection (Q2) ───────────────────────────────────────────

const PROBLEMS_BY_LEVEL: Record<string, Array<{ text: string; objective: string }>> = {
  'unaware': [
    { text: 'Biglaang gasto, walang preparasyon',                           objective: 'awareness' },
    { text: 'Magkakaaway ang pamilya dahil sa gastos',                       objective: 'grief'     },
    { text: 'Mahal pa rin ang loved one sa public cemetery',                 objective: 'awareness' },
    { text: 'Hassle sa paglipat mula sa public cemetery',                    objective: 'awareness' },
    { text: 'Hindi maabot ang memorial park sa emergency',                   objective: 'awareness' },
    { text: 'Abala/sobrang busy sa pag-aayos ng interment',                  objective: 'inquiry'   },
    { text: 'Pamilyang nasa abroad, gusto makasaksi sa event',               objective: 'inquiry'   },
    { text: 'Too busy to go to the office para bumili ng lot',               objective: 'inquiry'   },
    { text: 'Walang ipon pero gusto mag-lubong sa private memorial park',    objective: 'promo'     },
    { text: 'May bayad pa rin annually para sa lawn maintenance (Undas)',    objective: 'awareness' },
    { text: 'Late response sa inquiries, busy ang tao',                      objective: 'inquiry'   },
    { text: 'Hindi na kayang ituloy ang installment, nai-forfeit',           objective: 'promo'     },
    { text: 'Nahihirapan ang mga anak kasi hindi nakapaghanda ang magulang', objective: 'awareness' },
  ],
  'problem-aware': [
    { text: 'Hassle sa paglipat mula sa public cemetery',         objective: 'awareness' },
    { text: 'Hindi maabot ang memorial park sa emergency',         objective: 'awareness' },
    { text: 'Abala/sobrang busy sa pag-aayos ng interment',        objective: 'inquiry'   },
    { text: 'May bayad pa rin annually para sa lawn maintenance',  objective: 'awareness' },
    { text: 'Late response sa inquiries, busy ang tao',            objective: 'inquiry'   },
  ],
  'solution-aware': [
    { text: 'Pamilyang nasa abroad, gusto makasaksi sa event',    objective: 'inquiry'   },
    { text: 'Too busy to go to the office para bumili ng lot',    objective: 'inquiry'   },
    { text: 'Gusto mag-lubong sa private park pero walang ipon',  objective: 'inquiry'   },
    { text: 'Hindi na kayang ituloy ang installment, nai-forfeit', objective: 'inquiry'  },
  ],
  'product-aware': [
    { text: 'Gusto malaman ang presyo bago kumilos',               objective: 'promo'     },
    { text: 'Naghahambing ng Renaissance Park sa ibang memorial',  objective: 'promo'     },
    { text: 'Naghahanap ng pinakamababang monthly plan',           objective: 'promo'     },
    { text: 'May tanong tungkol sa lot types o chapel services',   objective: 'inquiry'   },
    { text: 'Nag-inquire na dati pero hindi pa nagpuputok',        objective: 'promo'     },
  ],
  'most-aware': [
    { text: 'Gusto mag-lubong sa private park pero walang ipon',  objective: 'promo'     },
    { text: 'Hindi na kayang ituloy ang installment, nai-forfeit', objective: 'promo'    },
    { text: 'Naghahanap ng pinakamababang monthly plan',           objective: 'promo'     },
    { text: 'Gusto bumili online, ayaw pumunta sa opisina',        objective: 'promo'     },
  ],
}

interface AdCategory {
  id: string
  label: string
  desc: string
  objective: string
  designDirective: string
}

const AD_CATEGORIES_BY_LEVEL: Record<string, AdCategory[]> = {
  'unaware': [
    {
      id: 'visual-metaphor',
      label: 'Visual Metaphor / Witty Filipino',
      desc: 'Clever visual comparison OR bold Filipino punchline — stops the scroll, no hard sell',
      objective: 'awareness',
      designDirective: 'VISUAL_METAPHOR_TEMPLATE',
    },
    {
      id: 'lifestyle',
      label: 'Lifestyle / Positioning',
      desc: 'Aspirational park experience — beautiful grounds, family visits, peace',
      objective: 'awareness',
      designDirective: 'LIFESTYLE_TEMPLATE',
    },
    {
      id: 'light-emotional',
      label: 'Light Emotional',
      desc: 'Warm family moments, gentle hook — celebrates life not loss',
      objective: 'grief',
      designDirective: 'LIGHT_EMOTIONAL_TEMPLATE',
    },
  ],
  'problem-aware': [
    {
      id: 'emotional',
      label: 'Emotional',
      desc: 'Deep empathy, acknowledges the pain directly — meets families where they are',
      objective: 'grief',
      designDirective: 'EMOTIONAL_TEMPLATE',
    },
    {
      id: 'problem-solution',
      label: 'Problem → Solution',
      desc: 'Names the pain in the top half, offers the answer in the bottom half',
      objective: 'inquiry',
      designDirective: 'PROBLEM_SOLUTION_TEMPLATE',
    },
    {
      id: 'story',
      label: 'Story',
      desc: 'Narrative personal tone — opens a story the reader recognizes',
      objective: 'awareness',
      designDirective: 'STORY_TEMPLATE',
    },
    {
      id: 'educational-basic',
      label: 'Educational',
      desc: 'Surprising fact or clear explanation — 3 key points, clean infographic style',
      objective: 'awareness',
      designDirective: 'EDUCATIONAL_TEMPLATE',
    },
  ],
  'solution-aware': [
    {
      id: 'educational-adv',
      label: 'Educational',
      desc: 'Feature highlights, differentiators — why this park vs others',
      objective: 'inquiry',
      designDirective: 'EDUCATIONAL_TEMPLATE',
    },
    {
      id: 'lifestyle-pos',
      label: 'Lifestyle / Positioning',
      desc: 'Premium feel, positions the brand as the obvious superior choice',
      objective: 'awareness',
      designDirective: 'LIFESTYLE_TEMPLATE',
    },
    {
      id: 'authority',
      label: 'Authority',
      desc: 'Credentials, established trust — "trusted by families since 2001"',
      objective: 'inquiry',
      designDirective: 'AUTHORITY_TEMPLATE',
    },
    {
      id: 'soft-dr',
      label: 'Soft Direct Response',
      desc: 'Clear CTA but low pressure — invite to inquire, no hard sell',
      objective: 'inquiry',
      designDirective: 'SOFT_DR_TEMPLATE',
    },
  ],
  'product-aware': [
    {
      id: 'comparison',
      label: 'Comparison',
      desc: 'Shows clear advantage over public cemetery or competitors — side by side',
      objective: 'inquiry',
      designDirective: 'COMPARISON_TEMPLATE',
    },
    {
      id: 'social-proof',
      label: 'Social Proof',
      desc: 'Family testimonial over park photo — builds trust quickly',
      objective: 'inquiry',
      designDirective: 'SOCIAL_PROOF_TEMPLATE',
    },
    {
      id: 'product-feature',
      label: 'Product / Feature + Pricing',
      desc: 'Pricing grid, lot types, payment plans — buyers want the numbers',
      objective: 'promo',
      designDirective: 'Centered layout, pricing focus, eyebrow: "FLEXIBLE PAYMENT PLANS", short headline max 5 words, 3 pricing offer cards from knowledge base 20-year term monthly prices, label "/ month", CTA button below cards',
    },
    {
      id: 'authority-prod',
      label: 'Authority',
      desc: 'Reinforces reliability — number of families served, years operating',
      objective: 'inquiry',
      designDirective: 'AUTHORITY_TEMPLATE',
    },
    {
      id: 'retargeting-prod',
      label: 'Retargeting',
      desc: 'Brings warm audience back — they know us, just need a nudge',
      objective: 'promo',
      designDirective: 'RETARGETING_TEMPLATE',
    },
  ],
  'most-aware': [
    {
      id: 'direct-response',
      label: 'Direct Response',
      desc: 'Urgency, strong CTA — ready to act, just needs the push',
      objective: 'promo',
      designDirective: 'DIRECT_RESPONSE_TEMPLATE',
    },
    {
      id: 'offer-promo',
      label: 'Offer / Promo',
      desc: 'Price front-and-center — specific deal or flexible plan as the hook',
      objective: 'promo',
      designDirective: 'OFFER_PROMO_TEMPLATE',
    },
    {
      id: 'retargeting',
      label: 'Retargeting',
      desc: 'Final reminder to act — for people who engaged but did not convert',
      objective: 'promo',
      designDirective: 'RETARGETING_TEMPLATE',
    },
    {
      id: 'conversational',
      label: 'Conversational',
      desc: 'Starts a 1-on-1 conversation — question-based, Messenger-ready',
      objective: 'inquiry',
      designDirective: 'CONVERSATIONAL_TEMPLATE',
    },
  ],
}

async function askProblems(message: Message, concept: string, awareness: PendingEntry['brandAwareness']) {
  const userId = message.author.id
  const entry = g.__pendingBriefs!.get(userId)
  const problems = PROBLEMS_BY_LEVEL[awareness!] ?? PROBLEMS_BY_LEVEL['problem-aware']
  const list = problems.map((p, i) => `**${i + 1} ·** ${p.text}`).join('\n')
  g.__pendingBriefs!.set(userId, {
    ...(entry ?? { job: null as any, assets: [] }),
    awaitingReply: true,
    objectivePick: { concept, awareness },
  })
  await (message.channel as SendableChannel).send(
    `Anong problema ng target audience ang gusto mong i-address?\n\n${list}\n\nI-reply ang numero.`
  )
}

async function handleObjectivePick(message: Message, pick: { concept: string; awareness?: string; problemText?: string }) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()
  const num = parseInt(reply, 10)

  if (pick.problemText) {
    await proceedWithPlan(message, pick.concept, pick.awareness, pick.problemText)
    return
  }

  const problems = PROBLEMS_BY_LEVEL[pick.awareness!] ?? PROBLEMS_BY_LEVEL['problem-aware']
  if (isNaN(num) || num < 1 || num > problems.length) {
    await ch.send(`I-reply ang numero mula **1** hanggang **${problems.length}**.`)
    return
  }

  const problem = problems[num - 1]
  g.__pendingBriefs!.set(userId, {
    ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
    awaitingReply: false,
    objectivePick: undefined,
  })
  await proceedWithPlan(message, pick.concept, pick.awareness, problem.text, problem.objective)
}

async function proceedWithPlan(
  message: Message,
  concept: string,
  awareness: string | undefined,
  problemText: string,
  objective?: string,
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id

  const resolvedObjective = objective ?? 'awareness'

  await ch.sendTyping()

  // Generate brand frame / pain point analysis before content plan
  const kbPath = path.join(process.cwd(), '.claude', 'skills', 'brand', 'docs', 'knowledge_base.txt')
  let knowledgeBase = ''
  try { knowledgeBase = fs.readFileSync(kbPath, 'utf8') } catch { }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  try {
    const awarenessLabel: Record<string, string> = {
      'unaware': 'Unaware', 'problem-aware': 'Problem Aware',
      'solution-aware': 'Solution Aware', 'product-aware': 'Product Aware', 'most-aware': 'Most Aware',
    }
    const systemPrompt =
      `You are a senior marketing strategist for Renaissance Park & Chapels — a luxury memorial park and chapel brand in South Cotabato, Philippines.\n\n` +
      `Brand positioning: full-service, dignified, family-oriented; solves the hassle, indignity, and emotional burden of public cemetery alternatives.\n` +
      `ICP: Adults 35–60, Mindanao; recently bereaved (urgent), planning ahead (pre-need), or OFW families protecting parents.\n\n` +
      `The user will give you a customer pain point + audience level.\n\n` +
      `Respond with:\n` +
      `1. Why this pain point matters to this specific audience (2-3 sentences)\n` +
      `2. How Renaissance Park directly solves it — use exact services and prices from the knowledge base\n` +
      `3. 2-3 Facebook ad hooks framed for the audience level (Promise, Problem→Solution, or Social Proof formula)\n` +
      `4. 1 objection handler using loss framing\n\n` +
      `Be specific and grounded. Never invent prices or policies.\n` +
      (knowledgeBase ? `\n--- KNOWLEDGE BASE ---\n${knowledgeBase}\n--- END ---` : '')

    const userMsg = `Pain point: ${problemText}\nAudience level: ${awarenessLabel[awareness ?? 'problem-aware'] ?? awareness}\nConcept: ${concept}`

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    })

    const analysis = (msg.content[0] as { text: string }).text
    const chunks = analysis.match(/[\s\S]{1,1900}/g) ?? [analysis]
    for (const chunk of chunks) await ch.send(chunk)

    await ch.send(`Reply **ok** to choose an ad category, or **adjust: [notes]** to skip straight to the content plan.`)

    g.__pendingBriefs!.set(userId, {
      ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      brandFrameReview: { concept, awareness, problemText, objective: resolvedObjective, analysis },
    })
  } catch (err: any) {
    await ch.send(`⚠️ Couldn't generate frame: ${err.message}`)
  }
}

async function handleBrandFrameReview(
  message: Message,
  state: { concept: string; awareness?: string; problemText: string; objective: string; analysis: string; adCategoryDirective?: string }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  const adjustMatch = message.content.match(/^adjust:\s*(.+)/i)

  g.__pendingBriefs!.set(userId, {
    ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
    awaitingReply: false,
    brandFrameReview: undefined,
  })

  if (reply !== 'ok' && !adjustMatch) {
    await ch.send('Reply **ok** to proceed, or **adjust: [notes]** to change direction.')
    g.__pendingBriefs!.set(userId, {
      ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      brandFrameReview: state,
    })
    return
  }

  const adjustNotes = adjustMatch ? adjustMatch[1].trim() : undefined

  if (adjustNotes) {
    // Re-run brand frame with adjusted notes instead of going to category pick
    const fullContext = `${state.problemText}. ${adjustNotes}`
    if (!hasApprovedVisuals()) {
      await ch.send(`Okay! Mag-issue muna ako ng photo brief.\n\nWalang approved visuals pa sa library — kapag may nai-submit na image, gagawin na ang buong post.`)
      await issueAssetBriefOnly(message, state.concept, state.objective)
      return
    }
    await ch.send(`Building your content plan...`)
    try {
      const libraryAssets: LibraryAsset[] = listAssets('approved').map(a => ({
        id: a.id, caption: a.caption, tags: a.tags,
        score: a.overallScore ?? 'low', submittedByName: a.submittedByName, assetType: a.assetType,
      }))
      const plan = await generateContentPlan(state.concept, state.objective, libraryAssets, fullContext, state.awareness)
      await ch.send(
        `Here's the content direction:\n\n` +
        `> **${plan.postType}** — ${plan.theme}\n` +
        `> Tone: ${plan.tone}\n` +
        `> Key message: ${plan.keyMessage}\n` +
        `> Approach: ${plan.approach}\n\n` +
        `Happy with this? Reply **ok** to write the draft, or **adjust: [what to change]** to refine the direction.`
      )
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true,
        contentPlanReview: { concept: state.concept, objective: state.objective, plan, revisionCount: 0, awareness: state.awareness, brandFrameAnalysis: state.analysis, adCategoryDirective: state.adCategoryDirective },
      })
    } catch (err: any) {
      const isCredits = err?.message?.includes('credit balance')
      await ch.send(isCredits ? '⚠️ API credit balance too low.' : `⚠️ Failed to build content plan: ${err.message}`)
    }
    return
  }

  // "ok" — ask for ad category before building the content plan
  await askAdCategory(message, state.concept, state.awareness, state.problemText, state.objective, state.analysis)
}

// ─── Ad category pick (Q3 — after brand frame review) ────────────────────────

async function askAdCategory(
  message: Message,
  concept: string,
  awareness: string | undefined,
  problemText: string,
  objective: string,
  brandFrameAnalysis: string,
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const categories = AD_CATEGORIES_BY_LEVEL[awareness ?? 'problem-aware'] ?? AD_CATEGORIES_BY_LEVEL['problem-aware']
  const list = categories.map((c, i) => `**${i + 1} ·** **${c.label}** — ${c.desc}`).join('\n')
  g.__pendingBriefs!.set(userId, {
    ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
    awaitingReply: true,
    adCategoryPick: { concept, awareness, problemText, objective, brandFrameAnalysis },
  })
  await ch.send(
    `Piliin ang ad category para sa post na ito:\n\n${list}\n\nI-reply ang numero.`
  )
}

async function handleAdCategoryPick(
  message: Message,
  pick: { concept: string; awareness?: string; problemText: string; objective: string; brandFrameAnalysis: string },
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()
  const num = parseInt(reply, 10)
  const categories = AD_CATEGORIES_BY_LEVEL[pick.awareness ?? 'problem-aware'] ?? AD_CATEGORIES_BY_LEVEL['problem-aware']

  if (isNaN(num) || num < 1 || num > categories.length) {
    await ch.send(`I-reply ang numero mula **1** hanggang **${categories.length}**.`)
    return
  }

  const chosen = categories[num - 1]
  g.__pendingBriefs!.set(userId, {
    ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
    awaitingReply: false,
    adCategoryPick: undefined,
  })

  await ch.send(`**${chosen.label}** — building your content plan...`)

  if (!hasApprovedVisuals()) {
    await ch.send(`Walang approved visuals pa sa library — mag-issue muna ako ng photo brief.`)
    await issueAssetBriefOnly(message, pick.concept, pick.objective)
    return
  }

  const fullContext = `${pick.problemText}\n\nBrand frame context:\n${pick.brandFrameAnalysis}\n\nAd category: ${chosen.label} — ${chosen.desc}`
  try {
    const libraryAssets: LibraryAsset[] = listAssets('approved').map(a => ({
      id: a.id, caption: a.caption, tags: a.tags,
      score: a.overallScore ?? 'low', submittedByName: a.submittedByName, assetType: a.assetType,
    }))
    const plan = await generateContentPlan(pick.concept, pick.objective, libraryAssets, fullContext, pick.awareness)
    await ch.send(
      `Here's the content direction:\n\n` +
      `> **${plan.postType}** — ${plan.theme}\n` +
      `> Tone: ${plan.tone}\n` +
      `> Key message: ${plan.keyMessage}\n` +
      `> Approach: ${plan.approach}\n\n` +
      `Happy with this? Reply **ok** to write the draft, or **adjust: [what to change]** to refine.`
    )
    g.__pendingBriefs!.set(userId, {
      ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      contentPlanReview: {
        concept: pick.concept, objective: pick.objective, plan, revisionCount: 0,
        awareness: pick.awareness, brandFrameAnalysis: pick.brandFrameAnalysis,
        adCategoryDirective: chosen.designDirective,
      },
    })
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(isCredits ? '⚠️ API credit balance too low.' : `⚠️ Failed to build content plan: ${err.message}`)
  }
}

// ─── askForObjective kept for backward compat (brand: flow) ───────────────────
async function askForObjective(message: Message, concept: string, awareness?: string) {
  await askAudienceLevel(message, concept, awareness)
}

// Gap 2: Issue brief only — no post copy yet; wait for asset submission
async function issueAssetBriefOnly(message: Message, concept: string, objective: string) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const discordUserName = message.member?.nickname ?? message.author.globalName ?? message.author.username

  try {
    const generated = await generatePost({
      concept, objective, discordUserId: userId, discordUserName, libraryAssets: [],
    })

    const draftId = `draft_${Date.now()}`
    const draft: PostDraft = {
      id: draftId,
      concept,
      objective,
      caption: '',
      hashtags: [],
      ctaText: '',
      assetBrief: generated.assetBrief,
      status: 'pending_asset',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      discordUserId: userId,
      discordChannelId: message.channelId,
    }

    addDraft(draft)
    g.__pendingBriefs!.delete(userId)

    await ch.send(
      `No visuals in the library yet, so here's a photo brief for your team:\n\n` +
      `📋 **PHOTO BRIEF** _(ID: \`${draftId}\`)_\n` +
      `> **Subject:** ${generated.assetBrief.subject}\n` +
      `> **Location:** ${generated.assetBrief.location}\n` +
      `> **Mood / Lighting:** ${generated.assetBrief.moodLighting}\n` +
      `> **Deadline:** ${generated.assetBrief.deadline}\n` +
      `> **Assigned to:** ${generated.assetBrief.assignedTo}\n\n` +
      `Once an approved photo is submitted, I'll write the full post.\n` +
      `📸 Submit with: \`brief: ${draftId}:\` + attach image`
    )
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(
      isCredits
        ? '⚠️ API credit balance too low to generate asset brief.'
        : `⚠️ Failed to generate asset brief: ${err.message}`
    )
  }
}

// Gap 3: Human steers the content plan before copy is generated
async function handleContentPlanReview(
  message: Message,
  state: { concept: string; objective: string; plan: ContentPlan; revisionCount: number; revisionNotes?: string; awareness?: string; brandFrameAnalysis?: string; adCategoryDirective?: string },
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  if (reply === 'ok' || reply === 'go' || reply === 'proceed' || reply === 'yes') {
    g.__pendingBriefs!.delete(userId)
    await handlePostGeneration(message, state.concept, state.revisionNotes, state.revisionCount, state.objective, state.plan, state.awareness, state.brandFrameAnalysis, state.adCategoryDirective)
    return
  }

  if (reply.startsWith('adjust:')) {
    const notes = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!notes) {
      await ch.send('Add your adjustment notes after the colon. Example: *adjust: more emotional, less formal*')
      return
    }
    await ch.send('Adjusting the content plan...')
    try {
      const libraryAssets: LibraryAsset[] = listAssets('approved').map(a => ({
        id: a.id, caption: a.caption, tags: a.tags,
        score: a.overallScore ?? 'low', submittedByName: a.submittedByName, assetType: a.assetType,
      }))
      const newPlan = await generateContentPlan(state.concept, state.objective, libraryAssets, notes)
      const obj = OBJECTIVES[state.objective]

      await ch.send(
        `Here's the revised direction:\n\n` +
        `> **${newPlan.postType}** — ${newPlan.theme}\n` +
        `> Tone: ${newPlan.tone}\n` +
        `> Key message: ${newPlan.keyMessage}\n` +
        `> Approach: ${newPlan.approach}\n\n` +
        `Happy with this? Reply **ok** to write the draft, or **adjust: [what to change]** to keep refining.`
      )
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true,
        contentPlanReview: { ...state, plan: newPlan },
      })
    } catch (err: any) {
      const isCredits = err?.message?.includes('credit balance')
      await ch.send(isCredits ? '⚠️ API credit balance too low.' : `⚠️ Failed to adjust plan: ${err.message}`)
    }
    return
  }

  await ch.send('Reply **ok** to write the draft, or **adjust: [what to change]** to keep refining.')
}

// ─── Semantic image ranking via Claude Haiku ─────────────────────────────────
async function rankRelevantAssets(
  concept: string,
  objective: string | undefined,
  plan: ContentPlan | undefined,
  candidates: Array<{ id: string; caption: string; tags: string[]; quality: number }>,
): Promise<string[]> {
  if (candidates.length === 0) return []
  if (candidates.length === 1) return [candidates[0].id]

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const top = [...candidates].sort((a, b) => b.quality - a.quality).slice(0, 10)

  const candidateList = top
    .map(c => `ID:${c.id} | "${c.caption.slice(0, 120)}" | tags: ${c.tags.slice(0, 6).join(', ')}`)
    .join('\n')

  const context = [
    `Post concept: "${concept}"`,
    objective ? `Objective: ${objective}` : null,
    plan?.theme      ? `Theme: ${plan.theme}`            : null,
    plan?.keyMessage ? `Key message: ${plan.keyMessage}` : null,
    plan?.tone       ? `Tone: ${plan.tone}`              : null,
  ].filter(Boolean).join('\n')

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content:
          `Rank the top 3 most relevant photos for this Facebook post.\n\n` +
          `${context}\n\n` +
          `Photos:\n${candidateList}\n\n` +
          `Rules:\n` +
          `- Subject matter relevance to the concept is PRIMARY — the right subject beats a beautiful but unrelated photo\n` +
          `- Rank best-to-worst for this specific concept\n` +
          `- Reply with up to 3 photo IDs in order (best first), comma-separated\n` +
          `- If fewer than 3 photos are relevant, return only the relevant ones\n` +
          `- If no photo matches the concept at all, reply exactly: NONE\n` +
          `Reply ONLY with comma-separated IDs or the word NONE — nothing else.`,
      }],
    })

    const reply = (msg.content[0] as { text: string }).text.trim()
    if (/^none$/i.test(reply)) {
      console.log('[ImageRank] Haiku: no relevant photos → quality fallback')
      return []
    }
    const ids = reply.split(',').map(s => s.trim()).filter(Boolean)
    const validated = ids.filter(id => top.some(c => c.id === id)).slice(0, 3)
    console.log(`[ImageRank] Haiku ranked: ${validated.join(', ')}`)
    return validated
  } catch (err) {
    console.log('[ImageRank] Haiku ranking failed, falling back to quality sort:', err)
    return []
  }
}

function buildRunwayImagePrompt(draft: PostDraft): string {
  return (
    `Cinematic memorial park photograph, Philippines. ` +
    `Concept: ${draft.concept}. ` +
    `Mood: dignified, warm, peaceful, golden hour light. ` +
    `Lush green lawns, white neoclassical chapel, Filipino family. ` +
    `No text, no logos. Professional photography style, shallow depth of field.`
  )
}

function buildRunwayVideoPrompt(draft: PostDraft): string {
  return (
    `Short cinematic Facebook video ad for a Philippine memorial park. ` +
    `Concept: ${draft.concept}. ` +
    `Scene: Filipino family visiting a loved one at a beautiful, peaceful memorial park with manicured lawns and a white chapel. ` +
    `Golden hour light, gentle camera movement, warm and hopeful tone. ` +
    `No text overlays. Cinematic, 5 seconds, landscape.`
  )
}

async function handlePhotoPick(
  message: Message,
  state: {
    draft: PostDraft
    revisionCount: number
    adCategoryDirective?: string
    candidates: Array<{ rank: number; assetId: string; driveUrl: string; discordUrl?: string; caption: string; score: string }>
  },
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()

  // User attached their own photo — use it directly
  const attachment = message.attachments.first()
  if (attachment && attachment.contentType?.startsWith('image/')) {
    await ch.send('📸 Using your uploaded photo...')
    updateDraft(state.draft.id, { fulfilledAssetUrl: attachment.url })
    const updatedDraft: PostDraft = { ...state.draft, fulfilledAssetUrl: attachment.url }
    const entry = g.__pendingBriefs!.get(userId)
    g.__pendingBriefs!.set(userId, {
      ...(entry ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      photoPick: undefined,
      postReview: { draft: updatedDraft, revisionCount: state.revisionCount, adCategoryDirective: state.adCategoryDirective },
    })
    await ch.send(formatDraftForDiscord(updatedDraft, state.revisionCount))
    return
  }

  // Runway: generate concept image
  if (reply === 'concept image') {
    if (!process.env.RUNWAY_API_KEY) {
      await ch.send('⚠️ RUNWAY_API_KEY not set in .env.local. Add it to use Runway generation.')
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true, photoPick: state,
      })
      return
    }
    await ch.send('🎨 Generating concept image with Runway... _(30–60 seconds)_')
    try {
      const prompt = buildRunwayImagePrompt(state.draft)
      const imgBuf = await generateConceptImage(prompt)
      const dataUri = `data:image/jpeg;base64,${imgBuf.toString('base64')}`
      updateDraft(state.draft.id, { fulfilledAssetUrl: dataUri })
      const updatedDraft: PostDraft = { ...state.draft, fulfilledAssetUrl: dataUri }
      const entry = g.__pendingBriefs!.get(userId)
      g.__pendingBriefs!.set(userId, {
        ...(entry ?? { job: null as any, assets: [] }),
        awaitingReply: true, photoPick: undefined,
        postReview: { draft: updatedDraft, revisionCount: state.revisionCount, adCategoryDirective: state.adCategoryDirective },
      })
      const attachment = new AttachmentBuilder(imgBuf, { name: 'concept.jpg' })
      await ch.send({ content: formatDraftForDiscord(updatedDraft, state.revisionCount), files: [attachment] })
    } catch (err: any) {
      await ch.send(`⚠️ Runway concept image failed: ${err.message}`)
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true, photoPick: state,
      })
    }
    return
  }

  // Runway: generate video ad
  if (reply === 'video') {
    if (!process.env.RUNWAY_API_KEY) {
      await ch.send('⚠️ RUNWAY_API_KEY not set in .env.local. Add it to use Runway generation.')
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true, photoPick: state,
      })
      return
    }
    await ch.send('🎬 Generating video ad with Runway... _(1–3 minutes)_')
    try {
      const prompt = buildRunwayVideoPrompt(state.draft)
      const videoBuf = await generateVideoAd(prompt)
      const s = loadSettings()
      const safeName = (state.draft.concept ?? 'ad').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
      const fileName = `${safeName}_runway.mp4`
      const localPath = path.join(process.cwd(), 'public', 'outputs', fileName)
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, videoBuf)

      // Upload to Drive + offer to schedule
      let driveLink = ''
      try { driveLink = await uploadImage(localPath, fileName) } catch (err: any) { console.warn(`[Drive] Upload failed: ${err.message}`) }
      const nextSlot = getNextBestPostTime()
      const attachment = new AttachmentBuilder(videoBuf, { name: fileName })
      await ch.send({
        content:
          `🎬 Here's your video ad!\n\n` +
          (driveLink ? `**Drive:** ${driveLink}\n\n` : '') +
          `Reply **yes** to post now, **schedule** to queue for ${formatPHT(nextSlot)}, or **no** to cancel.`,
        files: [attachment],
      })
      const adBrief: AdBrief = {
        product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
        concept: state.draft.concept,
        caption: state.draft.caption,
        ctaText: state.draft.ctaText,
      }
      const job = createJob({ status: 'rendering', brief: adBrief, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })
      const fullCaption = buildFacebookCaption(state.draft)
      g.__pendingBriefs!.set(userId, {
        job, awaitingReply: true, assets: [],
        facebookConfirm: { localPath, fileName, caption: fullCaption, approvedDraftId: state.draft.id, scheduledTime: nextSlot, adBrief },
      })
    } catch (err: any) {
      await ch.send(`⚠️ Runway video generation failed: ${err.message}`)
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true, photoPick: state,
      })
    }
    return
  }

  const pick = parseInt(reply, 10)

  if (isNaN(pick) || pick < 1 || pick > state.candidates.length) {
    const opts = state.candidates.map(c => `**${c.rank}**`).join(', ')
    await ch.send(`Reply ${opts} to pick a photo, **concept image** to generate one, **video** to generate a video ad, or attach your own image.`)
    return
  }

  const chosen = state.candidates.find(c => c.rank === pick) ?? state.candidates[0]

  updateDraft(state.draft.id, { fulfilledAssetUrl: chosen.driveUrl })
  const updatedDraft: PostDraft = { ...state.draft, fulfilledAssetUrl: chosen.driveUrl }

  const entry = g.__pendingBriefs!.get(userId)
  g.__pendingBriefs!.set(userId, {
    ...(entry ?? { job: null as any, assets: [] }),
    awaitingReply: true,
    photoPick: undefined,
    postReview: { draft: updatedDraft, revisionCount: state.revisionCount, adCategoryDirective: state.adCategoryDirective },
  })

  const msg = formatDraftForDiscord(updatedDraft, state.revisionCount)

  // Try discordUrl first (Drive direct URLs require auth)
  const urls = [chosen.discordUrl, chosen.driveUrl].filter(Boolean) as string[]
  let sent = false
  for (const url of urls) {
    try {
      const raw = await downloadImage(url)
      const imgBuf = await sharp(raw).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
      const attachment = new AttachmentBuilder(imgBuf, { name: 'selected-photo.jpg' })
      await ch.send({ content: msg, files: [attachment] })
      sent = true
      break
    } catch (err) {
      console.log(`[Discord] Selected photo download failed for ${url}:`, (err as Error).message)
    }
  }
  if (!sent) await ch.send(msg)
}

async function handlePostGeneration(
  message: Message,
  concept: string,
  revisionNotes?: string,
  revisionCount = 0,
  objective?: string,
  plan?: ContentPlan,
  awareness?: string,
  brandFrameAnalysis?: string,
  adCategoryDirective?: string,
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel

  await ch.send(revisionNotes ? 'On it — revising...' : 'Writing your draft...')

  try {
    const discordUserName = message.member?.nickname ?? message.author.globalName ?? message.author.username

    // Pick image — Drive source folder first, fall back to asset library
    let fulfilledAssetUrl: string | undefined
    let libraryAssets: LibraryAsset[] = []
    let selectedAssetNote = ''

    // These templates render without a hero photo — skip photo pick entirely
    const NO_PHOTO_TEMPLATES = new Set(['VISUAL_METAPHOR_TEMPLATE', 'WITTY_FILIPINO_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])
    if (NO_PHOTO_TEMPLATES.has(adCategoryDirective ?? '')) {
      const generated = await generatePost({ concept, objective, awareness, plan, revisionNotes, brandFrameAnalysis, discordUserId: userId, discordUserName, libraryAssets: [] })
      const draft: PostDraft = {
        id: `draft_${Date.now()}`,
        concept, objective,
        caption: generated.caption,
        hashtags: generated.hashtags,
        ctaText: generated.ctaText,
        engagementHook: generated.engagementHook,
        assetBrief: generated.assetBrief,
        status: 'pending_review',
        revisionNotes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        discordUserId: userId,
        discordChannelId: message.channelId,
      }
      addDraft(draft)
      const entry = g.__pendingBriefs!.get(userId)
      g.__pendingBriefs!.set(userId, {
        ...(entry ?? { job: null as any, assets: [] }),
        awaitingReply: true,
        postReview: { draft, revisionCount, adCategoryDirective },
      })
      await ch.send(formatDraftForDiscord(draft, revisionCount))
      return
    }

    // ─── Gather photo candidates (Drive → library fallback) ──────────────────
    interface PhotoCandidate {
      assetId: string; driveUrl: string; discordUrl?: string
      caption: string; score: string; quality: number; tags: string[]
    }
    const scoreRank: Record<string, number> = { featured: 4, high: 3, medium: 2, low: 1 }
    let photoCandidates: PhotoCandidate[] = []

    const sourceFolderId = process.env.GOOGLE_SOURCE_FOLDER_ID
    if (sourceFolderId && (process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_ACCESS_TOKEN)) {
      try {
        const driveImages = await listFolderImages(sourceFolderId)
        if (driveImages.length > 0) {
          const allLibrary = listAssets('approved')
          const heroTypes = new Set(['photo', 'background', 'illustration'])
          photoCandidates = driveImages
            .map(img => {
              const match = allLibrary.find(a => a.driveUrl?.includes(img.id))
              if (!match || !heroTypes.has(match.assetType ?? 'photo')) return null
              return {
                assetId: match.id, driveUrl: img.directUrl, discordUrl: match.discordUrl,
                caption: match.caption, score: match.overallScore ?? 'low',
                quality: scoreRank[match.overallScore ?? 'low'] ?? 0, tags: match.tags,
              }
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
        }
      } catch (err) {
        console.log('[Discord] Drive folder listing failed, falling back to asset library:', err)
      }
    }

    if (photoCandidates.length === 0) {
      const visualTypes: AssetType[] = ['photo', 'background', 'illustration', 'other']
      photoCandidates = listAssets('approved')
        .filter(a => visualTypes.includes(a.assetType as AssetType))
        .map(a => ({
          assetId: a.id,
          driveUrl: a.driveUrl ? driveToDirectUrl(a.driveUrl) : (a.discordUrl ?? ''),
          discordUrl: a.discordUrl,
          caption: a.caption, score: a.overallScore ?? 'low',
          quality: scoreRank[a.overallScore ?? 'low'] ?? 0, tags: a.tags,
        }))
        .filter(c => c.driveUrl)
    }

    // ─── Rank candidates via Haiku ─────────────────────────────────────────────
    if (photoCandidates.length > 0) {
      let rankedIds = await rankRelevantAssets(
        concept, objective, plan,
        photoCandidates.map(c => ({ id: c.assetId, caption: c.caption, tags: c.tags, quality: c.quality })),
      )
      // Haiku said NONE or failed — fall back to top N by quality
      if (rankedIds.length === 0) {
        rankedIds = [...photoCandidates]
          .sort((a, b) => b.quality - a.quality)
          .slice(0, 3)
          .map(c => c.assetId)
      }

      const topPicks = rankedIds
        .slice(0, 3)
        .map(id => photoCandidates.find(c => c.assetId === id))
        .filter((x): x is NonNullable<typeof x> => x !== null)

      if (topPicks.length >= 2) {
        // Multiple candidates — generate draft then let user pick photo
        const topAsset = topPicks[0]
        const topLibrary = listAssets('approved').find(a => a.id === topAsset.assetId)
        libraryAssets = [{
          id: topAsset.assetId, caption: topAsset.caption, tags: topAsset.tags,
          score: topAsset.score, submittedByName: topLibrary?.submittedByName ?? '',
          assetType: topLibrary?.assetType,
        }]

        const generated = await generatePost({ concept, objective, awareness, plan, revisionNotes, brandFrameAnalysis, discordUserId: userId, discordUserName, libraryAssets })

        const draft: PostDraft = {
          id: `draft_${Date.now()}`,
          concept, objective,
          caption: generated.caption,
          hashtags: generated.hashtags,
          ctaText: generated.ctaText,
          engagementHook: generated.engagementHook,
          assetBrief: generated.assetBrief,
          status: 'pending_review',
          revisionNotes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          discordUserId: userId,
          discordChannelId: message.channelId,
        }
        addDraft(draft)

        // Show draft text only — no photo brief, no approve footer yet
        const hashtags = draft.hashtags.map(h => `#${h}`).join(' ')
        const hookLine = draft.engagementHook ? `**Hook:** ${draft.engagementHook}\n` : ''
        const revNote = revisionCount > 0 ? ` _(revision ${revisionCount})_` : ''
        const draftPreview =
          `Here's your draft${revNote}:\n` +
          `\`\`\`\n${draft.caption}\n\n${hashtags}\n\`\`\`\n` +
          `**CTA:** ${draft.ctaText}\n` +
          hookLine +
          `\n**Pick a photo for this post:**`
        await ch.send(draftPreview)

        // Send each candidate photo labeled
        const pickCandidates = topPicks.map((c, i) => ({ rank: i + 1, ...c }))
        for (const pick of pickCandidates) {
          // Try discordUrl first — Drive direct URLs require auth
          const urls = [pick.discordUrl, pick.driveUrl].filter(Boolean) as string[]
          let sent = false
          for (const url of urls) {
            try {
              const raw = await downloadImage(url)
              const imgBuf = await sharp(raw).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
              const attachment = new AttachmentBuilder(imgBuf, { name: `photo-${pick.rank}.jpg` })
              await ch.send({
                content: `**${pick.rank}.** _"${pick.caption.slice(0, 100)}"_ (${pick.score})`,
                files: [attachment],
              })
              sent = true
              break
            } catch (err) {
              console.log(`[Discord] Photo ${pick.rank} preview failed for ${url}:`, (err as Error).message)
            }
          }
          if (!sent) await ch.send(`**${pick.rank}.** _"${pick.caption.slice(0, 100)}"_ (${pick.score}) — ⚠️ preview unavailable`)
        }

        await ch.send(
          `Reply **1**, **2**, or **3** to pick a photo — or **attach your own image** to use it instead.\n\n` +
          `No photo? Generate one:\n` +
          `> **concept image** — Runway generates a still image from the ad concept\n` +
          `> **video** — Runway generates a short video ad from the concept`
        )

        const entry = g.__pendingBriefs!.get(userId)
        g.__pendingBriefs!.set(userId, {
          ...(entry ?? { job: null as any, assets: [] }),
          awaitingReply: true,
          photoPick: {
            draft,
            revisionCount,
            adCategoryDirective,
            candidates: pickCandidates.map(p => ({
              rank: p.rank, assetId: p.assetId,
              driveUrl: p.driveUrl, discordUrl: p.discordUrl,
              caption: p.caption, score: p.score,
            })),
          },
        })
        return
      } else if (topPicks.length === 1) {
        // Single candidate — auto-select
        const best = topPicks[0]
        const bestLibrary = listAssets('approved').find(a => a.id === best.assetId)
        fulfilledAssetUrl = best.driveUrl
        libraryAssets = [{
          id: best.assetId, caption: best.caption, tags: best.tags, score: best.score,
          submittedByName: bestLibrary?.submittedByName ?? '', assetType: bestLibrary?.assetType,
        }]
        selectedAssetNote = `\n📸 Using **${best.score}**-rated photo: _"${best.caption.slice(0, 100)}"_`
      }
    }

    const generated = await generatePost({ concept, objective, awareness, plan, revisionNotes, brandFrameAnalysis, discordUserId: userId, discordUserName, libraryAssets })

    const draft: PostDraft = {
      id: `draft_${Date.now()}`,
      concept,
      objective,
      caption: generated.caption,
      hashtags: generated.hashtags,
      ctaText: generated.ctaText,
      engagementHook: generated.engagementHook,
      assetBrief: generated.assetBrief,
      status: 'pending_review',
      revisionNotes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      discordUserId: userId,
      discordChannelId: message.channelId,
      fulfilledAssetUrl,
    }

    addDraft(draft)

    const entry = g.__pendingBriefs!.get(userId)
    g.__pendingBriefs!.set(userId, {
      ...(entry ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      postReview: { draft, revisionCount, adCategoryDirective },
    })

    const msg = formatDraftForDiscord(draft, revisionCount) + selectedAssetNote

    if (fulfilledAssetUrl) {
      // Try Drive URL first, fall back to the Discord CDN URL for the same asset
      const previewUrls: string[] = [fulfilledAssetUrl]
      if (libraryAssets[0]) {
        const stored = listAssets('approved').find(a => a.id === libraryAssets[0].id)
        if (stored?.discordUrl && stored.discordUrl !== fulfilledAssetUrl) previewUrls.push(stored.discordUrl)
      }

      let sent = false
      for (const url of previewUrls) {
        try {
          const imgBuf = await downloadImage(url)
          const attachment = new AttachmentBuilder(imgBuf, { name: 'selected-photo.jpg' })
          await ch.send({ content: msg, files: [attachment] })
          sent = true
          break
        } catch (err) {
          console.log(`[Discord] Preview download failed for ${url}:`, (err as Error).message)
        }
      }
      if (!sent) await ch.send(msg)
    } else {
      await ch.send(msg)
    }
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(
      isCredits
        ? '⚠️ Anthropic API credit balance too low. Please top up at console.anthropic.com.'
        : `⚠️ Failed to generate post: ${err.message}`
    )
  }
}

async function handlePostReview(message: Message, draft: PostDraft, revisionCount: number, adCategoryDirective?: string) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  const isApprove = reply === 'approve' || reply.startsWith('approve:')
  if (isApprove) {
    const afterColon = reply.startsWith('approve:')
      ? message.content.slice(message.content.toLowerCase().indexOf('approve:') + 'approve:'.length).trim()
      : ''

    // Extract Discord @mention if present (e.g. approve: @Juan → <@123456789>)
    const mentionMatch = afterColon.match(/<@!?(\d+)>/)
    let assignedTo = 'Unassigned'
    let pingText = ''

    if (mentionMatch) {
      const memberId = mentionMatch[1]
      const member = message.guild?.members.cache.get(memberId)
      assignedTo = member?.nickname ?? member?.user.globalName ?? member?.user.username ?? `<@${memberId}>`
      pingText = `<@${memberId}> `
    } else if (afterColon) {
      assignedTo = afterColon
    }

    const updatedBrief = { ...draft.assetBrief, assignedTo }
    const approvedDraft = { ...draft, status: 'approved' as const, assetBrief: updatedBrief }
    updateDraft(draft.id, { status: 'approved', assetBrief: updatedBrief })

    // Combined brief (only if no photo yet, and not a no-photo template) + Meta copy
    const NO_PHOTO_TEMPLATES = new Set(['VISUAL_METAPHOR_TEMPLATE', 'WITTY_FILIPINO_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])
    const formatted = formatDraftForMetaBusiness(approvedDraft)
    const nextSlot = getNextBestPostTime()
    const briefSection = !draft.fulfilledAssetUrl && !NO_PHOTO_TEMPLATES.has(adCategoryDirective ?? '')
      ? `${pingText}📋 **PHOTO BRIEF** _(ID: \`${draft.id}\`)_\n` +
        `> **Subject:** ${updatedBrief.subject}\n` +
        `> **Location:** ${updatedBrief.location}\n` +
        `> **Mood / Lighting:** ${updatedBrief.moodLighting}\n` +
        `> **Deadline:** ${updatedBrief.deadline}\n` +
        `> **Assigned to:** ${assignedTo}\n` +
        `📸 Submit with: \`brief: ${draft.id}:\` + attach image\n\n`
      : ''
    const copyBlock = `**Copy for Meta Business Suite:**\n\`\`\`\n${formatted}\n\`\`\``
    const fullMsg = `Approved!\n\n${briefSection}${copyBlock}`
    if (fullMsg.length <= 2000) {
      await ch.send(fullMsg)
    } else {
      // Brief and copy each sent separately to stay under Discord's 2000-char limit
      if (briefSection) await ch.send(`Approved!\n\n${briefSection}`)
      else await ch.send('Approved!')
      // Chunk the copy block if it's still too long
      const LIMIT = 1990
      if (copyBlock.length <= LIMIT) {
        await ch.send(copyBlock)
      } else {
        const lines = formatted.split('\n')
        let chunk = '**Copy for Meta Business Suite:**\n```\n'
        for (const line of lines) {
          if ((chunk + line + '\n').length > LIMIT - 4) {
            await ch.send(chunk + '```')
            chunk = '```\n'
          }
          chunk += line + '\n'
        }
        if (chunk.replace(/```\n?/g, '').trim()) await ch.send(chunk + '```')
      }
    }

    // Render image ad — reuse concept image if already generated, otherwise render now
    const heroUrl = draft.fulfilledAssetUrl
      ? driveToDirectUrl(draft.fulfilledAssetUrl)
      : (() => { const lib = pickBestHeroAsset(); return lib ? assetDownloadUrl(lib) : null })()

    if (heroUrl) {
      await ch.send('Rendering your image ad...')
      try {
        const s = loadSettings()
        const adBrief: AdBrief = {
          product: `${s.footerRight1} ${s.footerRight2}`.trim() || 'Renaissance Park & Chapels',
          concept: draft.concept,
          ctaText: draft.ctaText,
          caption: draft.caption,
        }
        const heroAsset: MediaAsset = {
          id: 'fulfilled_hero', name: 'hero.jpg',
          mimeType: 'image/jpeg', url: heroUrl, webViewLink: heroUrl, score: 100,
        }
        const imageResult = await generateImageAd(adBrief, [heroAsset], adCategoryDirective)
        const job = createJob({
          status: 'rendering', brief: adBrief, assets: [heroAsset],
          discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready',
        })
        updateJob(job.id, { imageUrl: `/outputs/${imageResult.jobId}.png` })

        const safeName = draft.concept.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
        const fileName = `${safeName}_${imageResult.jobId}.png`
        const fullCaption = buildFacebookCaption(draft)
        const categoryLabel = adCategoryDirective
          ? ` _(${Object.values(AD_CATEGORIES_BY_LEVEL).flat().find(c => c.designDirective === adCategoryDirective)?.label ?? 'custom'} layout)_`
          : ''

        const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
        await ch.send({
          content:
            `Here's your image ad!${categoryLabel}\n\n` +
            `Reply **yes** to post now, **schedule** to queue for ${formatPHT(nextSlot)}, ` +
            `**reprompt: [notes]** to redesign, or **no** to cancel.`,
          files: [attachment],
        })

        g.__pendingBriefs!.set(userId, {
          job, awaitingReply: true, assets: [heroAsset],
          approvedPostDraft: approvedDraft,
          facebookConfirm: {
            localPath: imageResult.localPath, fileName, caption: fullCaption,
            approvedDraftId: draft.id, adBrief, heroAsset, adCategoryDirective,
          },
        })
      } catch (err: any) {
        await ch.send(
          `⚠️ Couldn't render image ad: ${err.message}\n\n` +
          `Reply **post now** to publish text-only, or **schedule** to schedule at ${formatPHT(nextSlot)}.`
        )
        g.__pendingBriefs!.set(userId, {
          ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
          awaitingReply: true, postPublish: { draft: approvedDraft },
        })
      }
    } else {
      // No asset yet — keep postPublish state for when brief is fulfilled
      g.__pendingBriefs!.set(userId, {
        ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
        awaitingReply: true, postPublish: { draft: approvedDraft },
      })
    }
    return
  }

  if (reply === 'reject') {
    updateDraft(draft.id, { status: 'rejected' })
    g.__pendingBriefs!.delete(userId)
    await ch.send('Scrapped. Start fresh any time with a new post request.')
    return
  }

  if (reply.startsWith('revise:')) {
    const notes = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!notes) {
      await ch.send('Please add your revision notes after the colon. Example: *revise: make it shorter and more emotional*')
      return
    }
    updateDraft(draft.id, { status: 'rejected' })
    g.__pendingBriefs!.delete(userId)
    await handlePostGeneration(message, draft.concept, notes, revisionCount + 1, draft.objective, undefined, undefined, undefined, adCategoryDirective)
    return
  }

  await ch.send('Reply **approve** (or **approve: @name** to assign the photo brief), **revise: [your notes]** to refine, or **reject** to start over.')
}

async function handlePostPublish(message: Message, draft: PostDraft) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  if (reply === 'schedule') {
    if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) {
      await ch.send('⚠️ Facebook not configured. Set FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in .env.local.')
      return
    }

    const nextSlot = getNextBestPostTime()
    const timeDisplay = formatPHT(nextSlot)

    const schedHeroUrl = draft.fulfilledAssetUrl
      ? driveToDirectUrl(draft.fulfilledAssetUrl)
      : (() => { const lib = pickBestHeroAsset(); return lib ? assetDownloadUrl(lib) : null })()

    if (schedHeroUrl) {
      g.__pendingBriefs!.delete(userId)
      await ch.send(`Rendering image ad... _(scheduling for ${timeDisplay})_`)
      try {
        const s = loadSettings()
        const brief: AdBrief = {
          product: `${s.footerRight1} ${s.footerRight2}`.trim() || 'Renaissance Park & Chapels',
          concept: draft.concept,
          ctaText: draft.ctaText,
          caption: draft.caption,
        }
        const heroAsset: MediaAsset = {
          id: 'fulfilled_hero',
          name: 'hero.jpg',
          mimeType: 'image/jpeg',
          url: schedHeroUrl,
          webViewLink: schedHeroUrl,
          score: 100,
        }

        const imageResult = await generateImageAd(brief, [heroAsset])
        const job = createJob({
          status: 'rendering',
          brief,
          assets: [heroAsset],
          discordChannelId: message.channelId,
          discordUserId: userId,
          conversationStep: 'ready',
        })
        updateJob(job.id, { imageUrl: `/outputs/${imageResult.jobId}.png` })

        const safeName = draft.concept.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
        const fileName = `${safeName}_${imageResult.jobId}.png`
        const fullCaption = buildFacebookCaption(draft)

        const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
        await ch.send({
          content:
            `Here's your image ad!\n\n📅 **Scheduled for: ${timeDisplay}**\n\n` +
            `Reply **yes** to save to Google Drive and schedule, **reprompt: [notes]** to redesign, or **no** to cancel.`,
          files: [attachment],
        })

        g.__pendingBriefs!.set(userId, {
          job,
          awaitingReply: true,
          assets: [heroAsset],
          approvedPostDraft: draft,
          facebookConfirm: {
            localPath: imageResult.localPath,
            fileName,
            caption: fullCaption,
            approvedDraftId: draft.id,
            scheduledTime: nextSlot,
            adBrief: brief,
            heroAsset,
          },
        })
      } catch (err: any) {
        const isCredits = err?.message?.includes('credit balance')
        await ch.send(
          isCredits
            ? '⚠️ API credit balance too low to render the image ad.'
            : `⚠️ Failed to render image ad: ${err.message}`
        )
      }
      return
    }

    // Text-only scheduled post
    const fullCaption = buildFacebookCaption(draft)
    await ch.send(
      `📅 **Schedule text post**\n\n` +
      `\`\`\`\n${draft.caption}\n\n${draft.hashtags.map(h => `#${h}`).join(' ')}\n\n${draft.ctaText}\n\`\`\`\n\n` +
      `**Scheduled for: ${timeDisplay}**\n\n` +
      `Reply **yes** to confirm or **no** to cancel.`
    )
    g.__pendingBriefs!.set(userId, {
      ...(g.__pendingBriefs!.get(userId) ?? { job: null as any, assets: [] }),
      awaitingReply: true,
      postPublish: undefined,
      scheduleTextConfirm: { caption: fullCaption, scheduledTime: nextSlot, approvedDraftId: draft.id },
    })
    return
  }

  if (reply === 'post now') {
    if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) {
      await ch.send('⚠️ Facebook not configured. Set FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in .env.local.')
      return
    }

    const nowHeroUrl = draft.fulfilledAssetUrl
      ? driveToDirectUrl(draft.fulfilledAssetUrl)
      : (() => { const lib = pickBestHeroAsset(); return lib ? assetDownloadUrl(lib) : null })()

    if (nowHeroUrl) {
      g.__pendingBriefs!.delete(userId)
      await ch.send('Rendering image ad...')
      try {
        const s = loadSettings()
        const brief: AdBrief = {
          product: `${s.footerRight1} ${s.footerRight2}`.trim() || 'Renaissance Park & Chapels',
          concept: draft.concept,
          ctaText: draft.ctaText,
          caption: draft.caption,
        }
        const heroAsset: MediaAsset = {
          id: 'fulfilled_hero',
          name: 'hero.jpg',
          mimeType: 'image/jpeg',
          url: nowHeroUrl,
          webViewLink: nowHeroUrl,
          score: 100,
        }

        const imageResult = await generateImageAd(brief, [heroAsset])

        const job = createJob({
          status: 'rendering',
          brief,
          assets: [heroAsset],
          discordChannelId: message.channelId,
          discordUserId: userId,
          conversationStep: 'ready',
        })
        updateJob(job.id, { imageUrl: `/outputs/${imageResult.jobId}.png` })

        const safeName = draft.concept.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
        const fileName = `${safeName}_${imageResult.jobId}.png`
        const fullCaption = buildFacebookCaption(draft)

        const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
        await ch.send({
          content:
            `Here's your image ad!\n\n**Post caption:**\n\`\`\`\n${draft.caption}\n\n` +
            `${draft.hashtags.map(h => `#${h}`).join(' ')}\n\n${draft.ctaText}\n\`\`\`\n\n` +
            `Reply **yes** to save to Google Drive and post, **reprompt: [notes]** to redesign, or **no** to cancel.`,
          files: [attachment],
        })

        g.__pendingBriefs!.set(userId, {
          job,
          awaitingReply: true,
          assets: [heroAsset],
          approvedPostDraft: draft,
          facebookConfirm: {
            localPath: imageResult.localPath,
            fileName,
            caption: fullCaption,
            approvedDraftId: draft.id,
            adBrief: brief,
            heroAsset,
          },
        })
      } catch (err: any) {
        const isCredits = err?.message?.includes('credit balance')
        await ch.send(
          isCredits
            ? '⚠️ API credit balance too low to render the image ad. Please top up at console.anthropic.com.'
            : `⚠️ Failed to render image ad: ${err.message}`
        )
      }
      return
    }

    // No image available — text-only post
    g.__pendingBriefs!.delete(userId)
    await ch.send('Posting to Facebook...')
    try {
      const fullCaption = buildFacebookCaption(draft)
      const fbUrl = await postTextToFacebook(fullCaption)
      updateDraft(draft.id, { status: 'published' })
      await ch.send(`✅ Posted to Facebook!\n${fbUrl}`)
    } catch (err: any) {
      await ch.send(`⚠️ Couldn't post to Facebook: ${err.message}`)
    }
    return
  }

  // Unrecognized reply — keep state alive, remind valid options
  await ch.send(
    draft.fulfilledAssetUrl
      ? 'Reply **post now** to publish immediately, **schedule** to pick the next best slot, or close this and use Meta Business Suite.'
      : 'Reply **post now** for a text post, **schedule** to queue it up, or close this and use Meta Business Suite.'
  )
}

async function handleScheduleTextConfirm(
  message: Message,
  confirm: { caption: string; scheduledTime: Date; approvedDraftId?: string }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  g.__pendingBriefs!.delete(userId)

  if (reply !== 'yes' && reply !== 'y') {
    await ch.send('Scheduling cancelled.')
    return
  }

  await ch.send('Scheduling post...')
  try {
    await scheduleTextToFacebook(confirm.caption, confirm.scheduledTime)
    if (confirm.approvedDraftId) updateDraft(confirm.approvedDraftId, { status: 'published' })
    await ch.send(`✅ Scheduled for **${formatPHT(confirm.scheduledTime)}**!`)
  } catch (err: any) {
    await ch.send(`⚠️ Couldn't schedule post: ${err.message}`)
  }
}

async function postTextToFacebook(message: string): Promise<string> {
  const https = await import('https')
  const pageId = process.env.FACEBOOK_PAGE_ID!
  const token  = process.env.FACEBOOK_ACCESS_TOKEN!

  console.log(`[FB Debug] Page ID: ${pageId}`)
  console.log(`[FB Debug] Token prefix: ${token?.slice(0, 20)}... (length: ${token?.length})`)
  console.log(`[FB Debug] Token type guess: ${token?.startsWith('EAAW') ? 'likely User Token' : token?.startsWith('EAAM') ? 'likely Page Token' : 'unknown'}`)

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message, access_token: token })
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v20.0/${pageId}/feed`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        console.log(`[FB Debug] Response status: ${res.statusCode}`)
        console.log(`[FB Debug] Response body: ${raw}`)
        const result = JSON.parse(raw)
        if (result.error) return reject(new Error(result.error.message))
        resolve(`https://www.facebook.com/${result.id}`)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function regexParseClarifyingAnswers(reply: string): Partial<AdBrief> {
  // Strip leading "1." "2." etc and split into numbered lines
  const lines = reply
    .split('\n')
    .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)

  const result: Partial<AdBrief> = {}

  // Line 1 — features: "Label — Value | Label — Value"
  if (lines[0]) {
    const parts = lines[0].split('|').map(p => p.trim())
    const features = parts.map(p => {
      const dash = p.search(/\s*[—–-]\s*/)
      if (dash === -1) return { label: p.toUpperCase(), value: '' }
      return {
        label: p.slice(0, dash).trim().toUpperCase(),
        value: p.slice(p.indexOf(p[dash]) + 1).replace(/^[—–-]\s*/, '').trim(),
      }
    }).filter(f => f.label)
    if (features.length) result.features = features
  }

  // Line 2 — staff: "Full Name, Job Title" or "skip"
  if (lines[1] && !/^skip$/i.test(lines[1])) {
    const commaIdx = lines[1].lastIndexOf(',')
    if (commaIdx !== -1) {
      result.staffName = lines[1].slice(0, commaIdx).trim()
      result.staffRole = lines[1].slice(commaIdx + 1).trim()
    } else {
      result.staffName = lines[1].trim()
    }
  }

  // Line 3 — tagline + year: "Tagline, 2001" or "Tagline since 2001"
  if (lines[2]) {
    const yearMatch = lines[2].match(/\b(19|20)\d{2}\b/)
    if (yearMatch) {
      result.yearFounded = yearMatch[0]
      result.tagline = lines[2]
        .replace(/,?\s*(since\s*)?\b(19|20)\d{2}\b/, '')
        .trim()
        .replace(/,\s*$/, '')
        .trim()
    } else {
      result.tagline = lines[2].trim()
    }
  }

  // Line 4 — location
  if (lines[3]) result.location = lines[3].trim()

  // Line 5 — CTA
  if (lines[4]) result.ctaText = lines[4].trim().toUpperCase()

  return result
}

async function handleClarification(message: Message, job: Job, collectedAssets: MediaAsset[]) {
  const userId = message.author.id
  const content = message.content.trim()

  const newAssets = collectAttachments(message)
  const allAssets = mergeAssets(collectedAssets, newAssets)

  // Image-only message — collect assets and acknowledge, don't call Claude
  if (!content && newAssets.length > 0) {
    const existing = g.__pendingBriefs!.get(userId)
    g.__pendingBriefs!.set(userId, { ...existing, job, awaitingReply: true, assets: allAssets })
    await message.reply(
      `Got your ${newAssets.length} image${newAssets.length > 1 ? 's' : ''}! ` +
      `${allAssets.length} total so far. Answer the questions above, then type **ready** to generate your ad.`
    )
    return
  }

  if (content.toLowerCase() === 'ready') {
    g.__pendingBriefs!.delete(userId)
    await runPipeline(message, job, allAssets)
    return
  }

  // Parse the user's answers — try Claude first, fall back to regex so credits aren't needed here
  let parsed: Partial<AdBrief> = {}
  try {
    parsed = await parseClarifyingAnswers(job.brief, content)
  } catch {
    parsed = regexParseClarifyingAnswers(content)
  }

  const updatedBrief: AdBrief = { ...job.brief, ...parsed }

  const updatedJob = updateJob(job.id, {
    brief: updatedBrief,
    assets: allAssets,
    conversationStep: 'ready',
  })!
  const existingEntry = g.__pendingBriefs!.get(userId)
  g.__pendingBriefs!.set(userId, { ...existingEntry, job: updatedJob, awaitingReply: true, assets: allAssets })

  const f1 = updatedBrief.features?.[0]
  const f2 = updatedBrief.features?.[1]
  const assetNote =
    newAssets.length > 0
      ? `\n• **Images:** ${allAssets.length} file(s) received`
      : allAssets.length > 0
        ? `\n• **Images:** ${allAssets.length} file(s) so far`
        : '\n• **Images:** none yet — attach images before typing **ready**'

  await message.reply(
    `Here's what I have so far:\n` +
    `• **Business:** ${updatedBrief.product}\n` +
    `• **Feature 1:** ${f1 ? `${f1.label} — ${f1.value}` : 'not set'}\n` +
    `• **Feature 2:** ${f2 ? `${f2.label} — ${f2.value}` : 'not set'}\n` +
    `• **Staff:** ${updatedBrief.staffName ? `${updatedBrief.staffName} (${updatedBrief.staffRole ?? 'no role'})` : 'none'}\n` +
    `• **Tagline:** ${updatedBrief.tagline ?? 'not set'}${updatedBrief.yearFounded ? ` (since ${updatedBrief.yearFounded})` : ''}\n` +
    `• **Location:** ${updatedBrief.location ?? 'not set'}\n` +
    `• **CTA:** ${updatedBrief.ctaText ?? 'not set'}` +
    `${assetNote}\n\n` +
    `Type **ready** when you're done, or give me more details to refine.`
  )
}

async function handleFacebookConfirm(
  message: Message,
  job: Job,
  confirm: { localPath: string; fileName: string; caption: string; approvedDraftId?: string; scheduledTime?: Date; adBrief?: AdBrief; heroAsset?: MediaAsset; adCategoryDirective?: string }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  // Reprompt — regenerate the image ad with revision notes (tolerates typos: repromt, repromot, reprompt with space)
  if (/^re\s*pro\s*m[po]t\s*:/i.test(message.content.trim())) {
    const notes = message.content.slice(message.content.indexOf(':') + 1).trim()
    if (!notes) {
      await ch.send('Add your notes after the colon. Example: *reprompt: shorter headline, warmer tone*')
      return
    }
    if (!confirm.adBrief || !confirm.heroAsset) {
      await ch.send("Can't regenerate — missing brief info.")
      return
    }
    await ch.send('Regenerating the ad...')
    try {
      const imageResult = await generateImageAd(confirm.adBrief, [confirm.heroAsset], notes)
      const safeName = (confirm.adBrief.concept ?? 'ad').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
      const fileName = `${safeName}_${imageResult.jobId}.png`
      const nextSlot = getNextBestPostTime()
      const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
      await ch.send({
        content:
          `Here's the revised ad!\n\n` +
          `Reply **yes** to post now, **schedule** to queue for ${formatPHT(nextSlot)}, ` +
          `**reprompt: [notes]** to revise again, or **no** to cancel.`,
        files: [attachment],
      })
      g.__pendingBriefs!.set(userId, {
        job,
        awaitingReply: true,
        assets: [confirm.heroAsset],
        facebookConfirm: { ...confirm, localPath: imageResult.localPath, fileName, scheduledTime: undefined },
      })
    } catch (err: any) {
      await ch.send(`⚠️ Failed to regenerate: ${err.message}`)
    }
    return
  }

  const wantsSchedule = reply === 'schedule'
  const wantsPost = reply === 'yes' || reply === 'y' || reply === 'post now'

  if (reply === 'reprompts') {
    await sendRepromptList(ch)
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: confirm.heroAsset ? [confirm.heroAsset] : [], facebookConfirm: confirm })
    return
  }

  const wantsCancel = reply === 'no' || reply === 'cancel'
  if (!wantsPost && !wantsSchedule) {
    if (wantsCancel) {
      updateJob(job.id, { status: 'done' })
      g.__pendingBriefs!.delete(userId)
      await ch.send('Got it — ad was not saved.')
    } else {
      // Unrecognized reply — keep state alive, re-prompt
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: confirm.heroAsset ? [confirm.heroAsset] : [], facebookConfirm: confirm })
      await ch.send(`Reply **yes** to post, **schedule** to queue for ${formatPHT(getNextBestPostTime())}, **reprompt: [notes]** to redesign, or **no** to cancel.`)
    }
    return
  }

  // Schedule — compute the next best slot now
  if (wantsSchedule) confirm = { ...confirm, scheduledTime: getNextBestPostTime() }

  g.__pendingBriefs!.delete(userId)

  // Step 1 — upload to Drive
  await ch.send('Saving to Google Drive...')
  let driveLink: string
  try {
    driveLink = await uploadImage(confirm.localPath, confirm.fileName, process.env.GOOGLE_DRIVE_ADS_FOLDER_ID)
    updateJob(job.id, { driveLink })
    await ch.send(`Saved! **Google Drive:** ${driveLink}`)
  } catch (err: any) {
    await ch.send(`Couldn't save to Google Drive: ${err.message}`)
    updateJob(job.id, { status: 'done' })
    return
  }

  // Step 2 — post or schedule to Facebook
  const isScheduled = !!confirm.scheduledTime
  await ch.send(isScheduled ? `Scheduling on Facebook...` : 'Posting to Facebook...')
  try {
    if (isScheduled) {
      const fbResult = await scheduleImageToFacebook(confirm.localPath, confirm.caption, confirm.scheduledTime!)
      updateJob(job.id, { status: 'done' })
      if (confirm.approvedDraftId) updateDraft(confirm.approvedDraftId, { status: 'published' })
      if (confirm.adCategoryDirective?.endsWith('_TEMPLATE')) {
        const catLabel = Object.values(AD_CATEGORIES_BY_LEVEL).flat().find(c => c.designDirective === confirm.adCategoryDirective)?.label ?? confirm.adCategoryDirective
        recordPost(confirm.adCategoryDirective, catLabel, confirm.scheduledTime!, fbResult.photoId, fbResult.postId ?? undefined)
      }
      await ch.send(`✅ Scheduled for **${formatPHT(confirm.scheduledTime!)}**\n${fbResult.url}`)
    } else {
      const { url: fbUrl, postId } = await postToFacebook(confirm.localPath, confirm.caption)
      if (confirm.approvedDraftId) updateDraft(confirm.approvedDraftId, { status: 'published' })
      if (confirm.adCategoryDirective?.endsWith('_TEMPLATE')) {
        const catLabel = Object.values(AD_CATEGORIES_BY_LEVEL).flat().find(c => c.designDirective === confirm.adCategoryDirective)?.label ?? confirm.adCategoryDirective
        const fbPhotoId = fbUrl.match(/fbid=(\d+)/)?.[1]
        recordPost(confirm.adCategoryDirective, catLabel, new Date(), fbPhotoId, postId ?? undefined)
      }

      const adAccountId = process.env.FB_AD_ACCOUNT_ID
      if (adAccountId && postId) {
        const s = loadSettings()
        await ch.send(
          `✅ Posted! **[View on Facebook](${fbUrl})**\n\n` +
          `Boost this post?\n` +
          `> ₱${s.boostBudgetPHP}/day · ${s.boostCountry} · ages ${s.boostAgeMin}–${s.boostAgeMax}\n\n` +
          `Reply **boost** to confirm or **skip**.`
        )
        g.__pendingBriefs!.set(userId, {
          job, awaitingReply: true, assets: [],
          boostConfirm: { postId, fbUrl, approvedDraftId: confirm.approvedDraftId },
        })
      } else {
        updateJob(job.id, { status: 'done' })
        await ch.send(`✅ Posted! **Facebook:** ${fbUrl}`)
      }
    }
  } catch (err: any) {
    updateJob(job.id, { status: 'done' })
    await ch.send(
      isScheduled
        ? `⚠️ Couldn't schedule on Facebook: ${err.message}\n\nYour ad is still on Drive: ${driveLink}`
        : `⚠️ Couldn't post to Facebook: ${err.message}\n\nYour ad is still on Drive: ${driveLink}`
    )
  }
}

async function batchConcurrent<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(tasks.slice(i, i + concurrency).map(t => t()))
    results.push(...batch)
  }
  return results
}

async function runCoverageFillAndPreview(ch: SendableChannel, missing: CoverageMissingItem[], channelId: string) {
  const s = loadSettings()
  const NO_PHOTO = new Set(['VISUAL_METAPHOR_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])

  const [fillInsights, scheduledFill, heroDataUris] = await Promise.all([
    fetchCategoryInsights().catch(() => []),
    fetchScheduledPosts().catch(() => []),
    loadShuffledHeroUris(),
  ])
  const fillPerfContext = formatInsightsForClaude(fillInsights) || undefined
  const slots = getWeekSlots(missing.length, bookedDaysSet(scheduledFill))
  const qualifiedSignals = getQualifiedSignals(5)
  const fillSignalContext = qualifiedSignals.length > 0
    ? { signals: qualifiedSignals.map(s => s.text) }
    : undefined

  type RenderPayload = { item: CoverageMissingItem; slot: Date; heroAsset: MediaAsset | null; heroImageId: string | null; targetGeneration: string }
  const renderPayloads: RenderPayload[] = []
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i]
    const needsPhoto = !NO_PHOTO.has(item.templateKey)
    const heroEntry = heroDataUris.length > 0 ? heroDataUris[i % heroDataUris.length] : null
    if (needsPhoto && !heroEntry) {
      await ch.send(`⏭️ **${item.label}** — skipped (no library photo).`)
      continue
    }
    const heroAsset: MediaAsset | null = (needsPhoto && heroEntry)
      ? { id: heroEntry.id, name: 'hero.jpg', mimeType: 'image/jpeg', url: heroEntry.uri, webViewLink: heroEntry.uri }
      : null
    const targetGeneration = GENERATION_ROTATION[renderPayloads.length % GENERATION_ROTATION.length]
    renderPayloads.push({ item, slot: slots[renderPayloads.length] ?? getNextBestPostTime(), heroAsset, heroImageId: heroEntry?.id ?? null, targetGeneration })
  }

  if (renderPayloads.length === 0) {
    await ch.send('No ads rendered. Check your asset library has approved photos.')
    return
  }

  await ch.send(`Generating **${renderPayloads.length} ad${renderPayloads.length > 1 ? 's' : ''}** in parallel...`)

  const renderResults = await batchConcurrent(
    renderPayloads.map(({ item, slot, heroAsset, heroImageId, targetGeneration }) => async () => {
      try {
        const recentConcepts = { [item.templateKey]: getRecentConcepts(item.templateKey) }
        const sigCtx = fillSignalContext ? { ...fillSignalContext, targetGeneration } : { signals: [], targetGeneration }
        const [draft] = await generateBatchDrafts(item.awareness, [item.problem], [item.category], fillPerfContext, recentConcepts, sigCtx)
        const adBrief: AdBrief = {
          product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
          concept: draft.concept, caption: draft.caption, ctaText: draft.ctaText,
        }
        let finalHeroAsset = heroAsset
        if (draft.conceptImagePrompt) {
          try {
            const imgBuf = await generateConceptImage(draft.conceptImagePrompt)
            finalHeroAsset = { id: 'runway', name: 'hero_background.jpg', mimeType: 'image/jpeg', url: `data:image/jpeg;base64,${imgBuf.toString('base64')}`, webViewLink: '' }
          } catch (err: any) {
            console.warn(`[Coverage] Runway concept image failed for ${item.label} — falling back to library hero: ${err.message}`)
          }
        }
        const result = await generateImageAd(adBrief, finalHeroAsset ? [finalHeroAsset] : [], item.templateKey)
        return { ok: true as const, draft, result, item, slot, heroImageId, targetGeneration }
      } catch (err: any) {
        return { ok: false as const, item, error: err.message as string }
      }
    }),
    1
  )

  const batchItems: BatchPlanItem[] = []
  for (const res of renderResults) {
    if (!res.ok) {
      await ch.send(`❌ **${res.item.label}** failed: ${res.error}`)
      continue
    }
    const { draft, result, item, slot, heroImageId, targetGeneration } = res
    const safeName = item.label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    const fullCaption = buildFacebookCaption({ caption: draft.caption, hashtags: draft.hashtags ?? [], ctaText: draft.ctaText ?? '', engagementHook: draft.engagementHook ?? '' })
    batchItems.push({
      templateKey: item.templateKey, label: item.label,
      localPath: result.localPath, fileName: `${safeName}_${result.jobId}.png`,
      caption: draft.caption, hashtags: draft.hashtags ?? [],
      ctaText: draft.ctaText ?? '', engagementHook: draft.engagementHook ?? '',
      fullCaption, scheduledTime: slot, concept: draft.concept,
      heroImageId: heroImageId ?? undefined,
    })
    const attachment = new AttachmentBuilder(result.buffer, { name: `${safeName}.png` })
    const genLabel = GENERATION_LABEL[targetGeneration] ?? ''
    await ch.send({ content: `**${batchItems.length}. ${item.label}** · ${genLabel} — ${draft.concept}\n📅 ${formatPHT(slot)}\n\n${fullCaption}`, files: [attachment] })
  }

  if (batchItems.length === 0) {
    await ch.send('No ads rendered. Check your asset library has approved photos.')
    return
  }

  const summary = batchItems.map((item, i) => `${i + 1}. **${item.label}** → ${formatPHT(item.scheduledTime)}`).join('\n')
  await ch.send(
    `✅ **${batchItems.length} ad${batchItems.length > 1 ? 's' : ''} ready:**\n${summary}\n\n` +
    `Reply **schedule all** to queue all to Facebook, **schedule 1,3** for specific ones, or **no** to cancel.`
  )
  g.__channelBatchConfirm!.set(channelId, { items: batchItems })
}

async function runScheduledCoverageCheck(ch: SendableChannel) {
  const LOOK_AHEAD_DAYS = 14
  const now = Date.now()
  const coverageMap = buildCoverageMap()

  // Prune deleted posts and collect last-posted time per category
  type EntryWithAge = (typeof coverageMap)[number] & { lastPostedMs: number }
  const withAge: EntryWithAge[] = []
  for (const entry of coverageMap) {
    let last = getLastPosted(entry.templateKey)
    if (last?.fbPhotoId && new Date(last.postedAt).getTime() < now) {
      const stillExists = await checkPhotoExists(last.fbPhotoId)
      if (!stillExists) { removeEntry(entry.templateKey, last.postedAt); last = getLastPosted(entry.templateKey) }
    }
    withAge.push({ ...entry, lastPostedMs: last ? new Date(last.postedAt).getTime() : 0 })
  }

  // Status display — show days since last post (negative = scheduled in future)
  const rows = withAge.map(e => {
    if (e.lastPostedMs === 0) return `❌ **${e.label}** — never posted`
    const daysAgo = Math.floor((now - e.lastPostedMs) / 86_400_000)
    if (daysAgo < 0) return `📅 **${e.label}** — scheduled in ${Math.abs(daysAgo)}d (${formatPHT(new Date(e.lastPostedMs))})`
    return `✅ **${e.label}** — posted ${daysAgo}d ago`
  })
  await ch.send(`**⏰ Scheduled Coverage Check**\n\n${rows.join('\n')}`)

  // Find free days in the next LOOK_AHEAD_DAYS window
  const scheduledPosts = await fetchScheduledPosts().catch(() => [])
  const booked = bookedDaysSet(scheduledPosts)
  const freeSlots = getWeekSlots(LOOK_AHEAD_DAYS, booked, LOOK_AHEAD_DAYS)

  if (freeSlots.length === 0) {
    await ch.send(`Schedule is full for the next ${LOOK_AHEAD_DAYS} days — nothing to fill. 🎉`)
    return
  }

  // Sort by staleness (never-posted first, then oldest last-posted first)
  // and take only as many as there are free slots
  const sorted = [...withAge].sort((a, b) => a.lastPostedMs - b.lastPostedMs)
  const toFill = sorted.slice(0, freeSlots.length)

  await ch.send(`📅 **${freeSlots.length} free day${freeSlots.length > 1 ? 's' : ''}** in the next ${LOOK_AHEAD_DAYS} days — filling with the ${toFill.length} most stale categor${toFill.length > 1 ? 'ies' : 'y'}.`)

  const usedProblemTexts = new Set<string>()
  const fillList = toFill.map(entry => {
    const pool = shuffle(PROBLEMS_BY_LEVEL[entry.awareness] ?? PROBLEMS_BY_LEVEL['problem-aware'])
    const byObjective = pool.filter(p => p.objective === entry.category.objective)
    // Prefer an unused problem matching the objective; fall back to any unused problem;
    // last resort, reuse (only happens when batch size exceeds total distinct problems).
    const problem =
      byObjective.find(p => !usedProblemTexts.has(p.text)) ??
      pool.find(p => !usedProblemTexts.has(p.text)) ??
      byObjective[0] ?? pool[0]
    usedProblemTexts.add(problem.text)
    return { templateKey: entry.templateKey, label: entry.label, awareness: entry.awareness, problem, category: entry.category }
  })

  const channelId = (ch as any).id as string
  await runCoverageFillAndPreview(ch, fillList, channelId)
}

// ─── Coverage scan ────────────────────────────────────────────────────────────

async function handleCoverageScan(message: Message) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id

  const limitMatch = message.content.match(/coverage scan\s+(\d+)/i)
  const limit = limitMatch ? Math.min(parseInt(limitMatch[1], 10), 50) : 20

  if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) {
    await ch.send('⚠️ Facebook not configured. Set FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in .env.local.')
    return
  }

  await ch.send(`Fetching last **${limit} posts** from your Facebook page...`)

  let posts: FBPost[]
  try {
    posts = await fetchPagePosts(limit)
  } catch (err: any) {
    await ch.send(`⚠️ Couldn't fetch posts: ${err.message}`)
    return
  }

  if (posts.length === 0) {
    await ch.send('No posts found on this Facebook page.')
    return
  }

  // Build post list — send in chunks of 10 to stay under 2000 chars
  const postLines = posts.map((p, i) => {
    const date = new Date(p.createdTime).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' })
    const preview = (p.message ?? '(no caption)').replace(/\n/g, ' ').slice(0, 80)
    const hasPhoto = p.photoId ? '🖼' : '📝'
    return `**${i + 1}.** ${hasPhoto} ${date} — ${preview}${preview.length >= 80 ? '…' : ''}`
  })

  await ch.send(`**Posts (${posts.length})** — tag image ads only, skip funeral live streams and text posts:`)
  for (let i = 0; i < postLines.length; i += 10) {
    await ch.send(postLines.slice(i, i + 10).join('\n'))
  }

  // Category list — numbered, one per line
  const coverageMap = buildCoverageMap()
  const catLines = coverageMap.map((c, i) => `**${i + 1}.** ${c.label}`).join('\n')
  await ch.send(`**Ad Categories:**\n${catLines}`)

  await ch.send(
    `Tag posts using **\`tag 1=emotional, 3=lifestyle\`** (name or number).\n` +
    `Reply **\`done\`** when finished · **\`cancel\`** to quit without saving.`
  )

  const job = createJob({ status: 'pending', brief: { product: 'Renaissance Park & Chapels', concept: 'Coverage scan' }, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })
  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    coverageScan: { posts, tagged: new Map() },
  })
}

async function handleCoverageScanReply(
  message: Message,
  job: Job,
  state: { posts: FBPost[]; tagged: Map<number, { templateKey: string; label: string }> }
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const raw = message.content.trim()
  const lower = raw.toLowerCase()

  if (lower === 'cancel') {
    g.__pendingBriefs!.delete(userId)
    await ch.send('Scan cancelled — nothing was saved.')
    return
  }

  if (lower.startsWith('untag ')) {
    const nums = lower.slice(6).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    const removed: number[] = []
    for (const n of nums) {
      if (state.tagged.has(n - 1)) { state.tagged.delete(n - 1); removed.push(n) }
    }
    if (removed.length === 0) {
      await ch.send('None of those post numbers were tagged.')
    } else {
      await ch.send(`Removed **${removed.join(', ')}** from tags. **${state.tagged.size}** post${state.tagged.size !== 1 ? 's' : ''} still tagged — reply **\`done\`** to save.`)
    }
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageScan: state })
    return
  }

  if (lower === 'auto tag' || lower === 'auto tag please') {
    await ch.send('Classifying your image posts with Claude...')
    const coverageMap = buildCoverageMap()
    const imagePosts = state.posts
      .map((p, i) => ({ i, p }))
      .filter(({ p }) => p.photoId) // only image posts
    if (imagePosts.length === 0) {
      await ch.send('No image posts found to classify.')
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageScan: state })
      return
    }
    const postBlock = imagePosts.map(({ i, p }) => {
      const preview = (p.message ?? '').replace(/\n/g, ' ').slice(0, 200)
      return `Post ${i + 1}: "${preview}"`
    }).join('\n')
    const catBlock = coverageMap.map((c, i) => `${i + 1}. ${c.label} — ${c.category.desc}`).join('\n')
    const prompt =
      `You are classifying Facebook image ad posts for a memorial park (Renaissance Park & Chapels in South Cotabato) into ad template categories.\n\n` +
      `Image posts to classify:\n${postBlock}\n\n` +
      `Ad categories:\n${catBlock}\n\n` +
      `Rules:\n` +
      `- Skip posts that are memorial tributes ("In loving memory of...") or funeral live streams\n` +
      `- Assign the single best-matching category per post\n` +
      `- Return ONLY a JSON object, no other text: { "1": 4, "2": 15 } mapping post number (string) to category number (integer)\n` +
      `- Only include posts you can confidently classify`
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      })
      const raw = (resp.content[0] as any).text as string
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in response')
      const assignments: Record<string, number> = JSON.parse(jsonMatch[0])

      const results: string[] = []
      for (const [postNumStr, catNum] of Object.entries(assignments)) {
        const postIdx = parseInt(postNumStr, 10) - 1
        const cat = coverageMap[catNum - 1]
        if (!cat || postIdx < 0 || postIdx >= state.posts.length) continue
        state.tagged.set(postIdx, { templateKey: cat.templateKey, label: cat.label })
        results.push(`**${postIdx + 1}** → ${cat.label}`)
      }

      if (results.length === 0) {
        await ch.send('Claude couldn\'t confidently classify any posts. Try tagging manually.')
      } else {
        await ch.send(
          `Auto-tagged **${results.length}** post${results.length !== 1 ? 's' : ''}:\n${results.join('\n')}\n\n` +
          `Review and adjust with \`tag N=category\` if needed, then reply **\`done\`** to save.`
        )
      }
    } catch (err: any) {
      await ch.send(`⚠️ Auto-tag failed: ${err.message}`)
    }
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageScan: state })
    return
  }

  if (lower === 'done') {
    if (state.tagged.size === 0) {
      g.__pendingBriefs!.delete(userId)
      await ch.send('No posts were tagged — nothing saved.')
      return
    }
    // Seed coverage store
    const coverageMap = buildCoverageMap()
    const saved: string[] = []
    for (const [postIdx, cat] of state.tagged.entries()) {
      const post = state.posts[postIdx]
      if (!post) continue
      recordPost(cat.templateKey, cat.label, new Date(post.createdTime), post.photoId, post.id)
      const date = new Date(post.createdTime).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })
      saved.push(`**${cat.label}** ← post ${postIdx + 1} (${date})`)
    }
    g.__pendingBriefs!.delete(userId)
    await ch.send(`✅ Saved **${saved.length}** coverage record${saved.length !== 1 ? 's' : ''}:\n${saved.join('\n')}\n\nRun \`coverage check\` to see your updated status.`)
    return
  }

  // Parse tag assignments: "tag 1=emotional, 3=lifestyle" or "1=emotional, 3=2"
  const tagContent = lower.startsWith('tag ') ? raw.slice(4) : raw
  const assignments = tagContent.split(',').map(s => s.trim()).filter(Boolean)
  const coverageMap = buildCoverageMap()
  const results: string[] = []
  const errors: string[] = []

  for (const assignment of assignments) {
    const match = assignment.match(/^(\d+)\s*[=:]\s*(.+)$/i)
    if (!match) { errors.push(`"${assignment}" — use format \`1=emotional\``); continue }

    const postNum = parseInt(match[1], 10)
    const catQuery = match[2].trim()

    if (postNum < 1 || postNum > state.posts.length) {
      errors.push(`Post **${postNum}** doesn't exist (1–${state.posts.length})`)
      continue
    }

    // Match category by number or fuzzy name
    const catNum = parseInt(catQuery, 10)
    let cat = isNaN(catNum)
      ? coverageMap.find(c => c.label.toLowerCase().includes(catQuery.toLowerCase()))
      : coverageMap[catNum - 1]

    if (!cat) { errors.push(`Category "${catQuery}" not found`); continue }

    state.tagged.set(postNum - 1, { templateKey: cat.templateKey, label: cat.label })
    results.push(`**${postNum}** → ${cat.label}`)
  }

  if (errors.length > 0) {
    await ch.send(`⚠️ Couldn't parse:\n${errors.map(e => `• ${e}`).join('\n')}`)
  }
  if (results.length > 0) {
    const taggedCount = state.tagged.size
    await ch.send(
      `Tagged ${results.join(', ')}.\n` +
      `**${taggedCount} post${taggedCount !== 1 ? 's' : ''}** tagged so far — reply **\`tag N=category\`** to add more, or **\`done\`** to save.`
    )
  } else if (errors.length === 0) {
    await ch.send('Nothing recognized. Use format `tag 1=emotional, 3=lifestyle` or reply `done` to save.')
  }

  g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageScan: state })
}

// ─── Coverage check ───────────────────────────────────────────────────────────

// Build a flat deduplicated list: templateKey → first matching awareness + category
function buildCoverageMap(): Array<{ templateKey: string; label: string; awareness: string; category: AdCategory }> {
  const seen = new Set<string>()
  const result: Array<{ templateKey: string; label: string; awareness: string; category: AdCategory }> = []
  for (const [awareness, cats] of Object.entries(AD_CATEGORIES_BY_LEVEL)) {
    for (const cat of cats) {
      if (!cat.designDirective.endsWith('_TEMPLATE')) continue
      if (seen.has(cat.designDirective)) continue
      seen.add(cat.designDirective)
      result.push({ templateKey: cat.designDirective, label: cat.label, awareness, category: cat })
    }
  }
  return result
}

async function handleCoverageFix(message: Message) {
  const ch = message.channel as SendableChannel
  await ch.send('Fetching page posts to patch coverage entries...')
  try {
    // Fetch a generous limit to cover all stored entries
    const posts = await fetchPagePosts(50)

    // Build photoId → feedPostId map from the live page
    const photoToPost = new Map<string, string>()
    for (const post of posts) {
      if (post.photoId) photoToPost.set(post.photoId, post.id)
    }

    const patched = patchPostIds(photoToPost)
    const dupes   = deduplicateEntries()

    if (patched === 0 && dupes === 0) {
      await ch.send('Nothing to fix — all entries already have post IDs (or no matching posts found in the last 50 page posts).')
    } else {
      const parts: string[] = []
      if (patched > 0) parts.push(`✅ Patched **${patched}** entr${patched !== 1 ? 'ies' : 'y'}** with feed post IDs`)
      if (dupes   > 0) parts.push(`🗑️ Removed **${dupes}** duplicate entr${dupes !== 1 ? 'ies' : 'y'}`)
      await ch.send(parts.join('\n') + '\n\nRun `ad insights` to see engagement data.')
    }
  } catch (err: any) {
    await ch.send(`❌ coverage fix failed: ${err.message}`)
  }
}

async function handleInsights(message: Message) {
  const ch = message.channel as SendableChannel
  await ch.send('Fetching Facebook engagement data for all ad categories...')
  try {
    const insights = await fetchCategoryInsights()
    const table = formatInsightsTable(insights)
    // Discord 2000-char limit — split if needed
    if (table.length <= 1900) {
      await ch.send(table)
    } else {
      const lines = table.split('\n\n')
      let chunk = ''
      for (const line of lines) {
        if (chunk.length + line.length + 2 > 1900) {
          await ch.send(chunk.trim())
          chunk = ''
        }
        chunk += line + '\n\n'
      }
      if (chunk.trim()) await ch.send(chunk.trim())
    }
  } catch (err: any) {
    await ch.send(`❌ Could not fetch insights: ${err.message}`)
  }
}

function formatScheduledList(posts: ScheduledPost[]): string {
  if (posts.length === 0) return '📭 No scheduled posts on Facebook right now.'
  const rows = posts.map((p, i) => {
    const pht = formatPHT(p.scheduledTime)
    const preview = p.message ? p.message.slice(0, 80).replace(/\n/g, ' ') + (p.message.length > 80 ? '…' : '') : '_(no caption)_'
    return `**${i + 1}.** 📅 ${pht}\n   ${preview}`
  })
  return `**Scheduled Facebook Posts** (${posts.length})\n\n${rows.join('\n\n')}\n\nTo cancel one: \`cancel post 2\``
}

async function getCachedScheduledPosts(userId: string): Promise<ScheduledPost[]> {
  const cached = g.__scheduledPostsCache!.get(userId)
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached.posts
  const posts = await fetchScheduledPosts()
  g.__scheduledPostsCache!.set(userId, { posts, fetchedAt: Date.now() })
  return posts
}

function postMsgPreview(msg: string | undefined, maxLen = 120): string {
  if (!msg) return '_(no caption)_'
  return msg.slice(0, maxLen).replace(/\n/g, ' ') + (msg.length > maxLen ? '…' : '')
}

async function handleScheduledPosts(message: Message) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  await ch.send('Fetching scheduled posts from Facebook...')
  try {
    const posts = await getCachedScheduledPosts(userId)
    const text = formatScheduledList(posts)
    if (text.length <= 1900) {
      await ch.send(text)
    } else {
      const lines = text.split('\n\n')
      let chunk = ''
      for (const line of lines) {
        if (chunk.length + line.length + 2 > 1900) { await ch.send(chunk.trim()); chunk = '' }
        chunk += line + '\n\n'
      }
      if (chunk.trim()) await ch.send(chunk.trim())
    }
  } catch (err: any) {
    await ch.send(`❌ Could not fetch scheduled posts: ${err.message}`)
  }
}

async function handleCancelPost(message: Message, num: number) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id

  let posts: ScheduledPost[]
  try {
    posts = await getCachedScheduledPosts(userId)
  } catch (err: any) {
    await ch.send(`❌ Could not fetch scheduled posts: ${err.message}`)
    return
  }

  if (num < 1 || num > posts.length) {
    await ch.send(`Post **${num}** doesn't exist. Run \`scheduled posts\` to see the current list (1–${posts.length}).`)
    return
  }

  const post = posts[num - 1]
  const pht = formatPHT(post.scheduledTime)
  const preview = postMsgPreview(post.message)

  await ch.send(
    `Are you sure you want to **cancel and delete** this scheduled post?\n\n` +
    `📅 **${pht}**\n${preview}\n\n` +
    `Reply **yes** to delete it or **no** to keep it.`
  )

  const job = createJob({ status: 'pending', brief: { product: '', concept: '' }, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })
  g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], cancelPostConfirm: { post, num } })
}

async function handleCancelPostConfirm(
  message: Message,
  job: Job,
  state: { post: ScheduledPost; num: number }
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const reply = message.content.trim().toLowerCase()

  if (reply === 'no' || reply === 'cancel') {
    g.__pendingBriefs!.delete(userId)
    await ch.send('Kept — post is still scheduled.')
    return
  }

  if (reply !== 'yes') {
    await ch.send('Reply **yes** to delete this post or **no** to keep it.')
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], cancelPostConfirm: state })
    return
  }

  g.__pendingBriefs!.delete(userId)
  await ch.send(`Deleting post ${state.num}...`)
  try {
    await deletePost(state.post.id)
    g.__scheduledPostsCache!.clear()
    const pht = formatPHT(state.post.scheduledTime)
    await ch.send(`✅ Deleted — the post scheduled for **${pht}** has been removed from Facebook.\n\nReply \`shift posts\` to move remaining scheduled posts up to fill the gap.`)
  } catch (err: any) {
    await ch.send(`❌ Delete failed: ${err.message}`)
  }
}

async function handleShiftPosts(message: Message) {
  const ch = message.channel as SendableChannel
  await ch.send('Fetching scheduled posts...')

  let posts: ScheduledPost[]
  try {
    posts = await fetchScheduledPosts()
  } catch (err: any) {
    await ch.send(`❌ Could not fetch scheduled posts: ${err.message}`)
    return
  }

  // Only future posts can be rescheduled
  const future = posts.filter(p => p.scheduledTime.getTime() > Date.now())
  if (future.length === 0) {
    await ch.send('No future scheduled posts to shift.')
    return
  }
  future.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime())

  // Generate the earliest N consecutive slots starting from now (30-day window to be safe)
  const newSlots = getWeekSlots(future.length, undefined, 30)
  if (newSlots.length < future.length) {
    await ch.send(`⚠️ Could only generate ${newSlots.length} slots for ${future.length} posts. Aborting.`)
    return
  }

  // Identify posts whose time would actually change
  const moves: Array<{ post: ScheduledPost; oldTime: Date; newTime: Date }> = []
  for (let i = 0; i < future.length; i++) {
    const oldTime = future[i].scheduledTime
    const newTime = newSlots[i]
    if (Math.abs(oldTime.getTime() - newTime.getTime()) > 60 * 1000) {
      moves.push({ post: future[i], oldTime, newTime })
    }
  }

  if (moves.length === 0) {
    await ch.send('✅ Schedule is already compact — no gaps to fill.')
    return
  }

  await ch.send(`Shifting **${moves.length} post${moves.length > 1 ? 's' : ''}** to fill gaps...`)

  const shifted: string[] = []
  const failed: string[] = []
  for (const { post, oldTime, newTime } of moves) {
    const preview = postMsgPreview(post.message, 50)
    try {
      await updateScheduledPostTime(post.id, newTime)
      shifted.push(`📅 ${formatPHT(oldTime)} → **${formatPHT(newTime)}**\n   ${preview}`)
    } catch (err: any) {
      failed.push(`${preview}: ${err.message}`)
    }
  }

  g.__scheduledPostsCache!.clear()

  if (shifted.length > 0) {
    await ch.send(`✅ Shifted **${shifted.length} post${shifted.length > 1 ? 's' : ''}**:\n${shifted.join('\n\n')}`)
  }
  if (failed.length > 0) {
    await ch.send(`⚠️ Failed:\n${failed.map(f => `• ${f}`).join('\n')}`)
  }
}

// Move one scheduled post to a new date/time. Supports absolute (YYYY-MM-DD [HH:MM])
// and relative (+N days) formats. Times are always interpreted as Asia/Manila.
async function handleReschedulePost(message: Message) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id

  const m = message.content.match(/^reschedule\s+post\s+(\d+)\s*:\s*(.+)$/i)
  if (!m) {
    await ch.send('Usage: `reschedule post 1: 2026-05-23` · `reschedule post 1: 2026-05-23 9:00` · `reschedule post 1: +10`')
    return
  }
  const num = parseInt(m[1], 10)
  const target = m[2].trim()

  let posts: ScheduledPost[]
  try {
    posts = await getCachedScheduledPosts(userId)
  } catch (err: any) {
    await ch.send(`❌ Could not fetch scheduled posts: ${err.message}`)
    return
  }

  if (num < 1 || num > posts.length) {
    await ch.send(`Post **${num}** doesn't exist. Run \`scheduled posts\` to see the list (1–${posts.length}).`)
    return
  }
  const post = posts[num - 1]

  // Parse target into a Date
  let newTime: Date | null = null
  const relMatch = target.match(/^([+-]?\d+)d?$/)
  if (relMatch) {
    const days = parseInt(relMatch[1], 10)
    newTime = new Date(post.scheduledTime.getTime() + days * 24 * 60 * 60 * 1000)
  } else {
    const absMatch = target.match(/^(\d{4}-\d{2}-\d{2})(?:[\sT]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i)
    if (absMatch) {
      const date = absMatch[1]
      let hour = parseInt(absMatch[2] ?? '8', 10)
      const min = absMatch[3] ?? '00'
      const period = absMatch[4]?.toLowerCase()
      if (period === 'pm' && hour < 12) hour += 12
      if (period === 'am' && hour === 12) hour = 0
      newTime = new Date(`${date}T${String(hour).padStart(2, '0')}:${min}:00+08:00`)
    }
  }

  if (!newTime || isNaN(newTime.getTime())) {
    await ch.send('Could not parse the date. Use `YYYY-MM-DD [HH:MM]` or `+N` for relative days.')
    return
  }

  if (newTime.getTime() <= Date.now() + 11 * 60 * 1000) {
    await ch.send(`⚠️ Facebook requires the new time to be at least 10 minutes in the future. Got: ${formatPHT(newTime)}`)
    return
  }

  await ch.send(`Rescheduling post ${num} from **${formatPHT(post.scheduledTime)}** → **${formatPHT(newTime)}**...`)
  try {
    await updateScheduledPostTime(post.id, newTime)
    g.__scheduledPostsCache!.clear()
    await ch.send(`✅ Post ${num} moved to **${formatPHT(newTime)}**.`)
  } catch (err: any) {
    await ch.send(`❌ Reschedule failed: ${err.message}`)
  }
}

async function handleCoverageCheck(message: Message) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const LOOK_AHEAD_DAYS = 14
  const now = Date.now()

  await ch.send('Checking ad category coverage...')

  const coverageMap = buildCoverageMap()

  // Prune deleted posts and collect last-posted time per category
  type EntryWithAge = (typeof coverageMap)[number] & { lastPostedMs: number }
  const withAge: EntryWithAge[] = []
  for (const entry of coverageMap) {
    let last = getLastPosted(entry.templateKey)
    if (last?.fbPhotoId && new Date(last.postedAt).getTime() < now) {
      const stillExists = await checkPhotoExists(last.fbPhotoId)
      if (!stillExists) {
        console.log(`[Coverage] Post deleted on FB — removing entry for ${entry.templateKey} (fbid: ${last.fbPhotoId})`)
        removeEntry(entry.templateKey, last.postedAt)
        last = getLastPosted(entry.templateKey)
      }
    }
    withAge.push({ ...entry, lastPostedMs: last ? new Date(last.postedAt).getTime() : 0 })
  }

  const rows = withAge.map(e => {
    if (e.lastPostedMs === 0) return `❌ **${e.label}** — never posted`
    const daysAgo = Math.floor((now - e.lastPostedMs) / 86_400_000)
    if (daysAgo < 0) return `📅 **${e.label}** — scheduled in ${Math.abs(daysAgo)}d (${formatPHT(new Date(e.lastPostedMs))})`
    return `✅ **${e.label}** — posted ${daysAgo}d ago`
  })
  await ch.send(`**Ad Category Coverage**\n\n${rows.join('\n')}`)

  // Find free days in the look-ahead window
  const scheduledPosts = await getCachedScheduledPosts(userId).catch(() => [])
  const booked = bookedDaysSet(scheduledPosts)
  const freeSlots = getWeekSlots(LOOK_AHEAD_DAYS, booked, LOOK_AHEAD_DAYS)

  if (freeSlots.length === 0) {
    await ch.send(`Schedule is full for the next ${LOOK_AHEAD_DAYS} days — nothing to fill. 🎉`)
    return
  }

  // Sort by staleness, take only as many as there are free days
  const sorted = [...withAge].sort((a, b) => a.lastPostedMs - b.lastPostedMs)
  const toFill = sorted.slice(0, freeSlots.length)

  const usedProblemTexts = new Set<string>()
  const fillList = toFill.map(entry => {
    const pool = shuffle(PROBLEMS_BY_LEVEL[entry.awareness] ?? PROBLEMS_BY_LEVEL['problem-aware'])
    const byObjective = pool.filter(p => p.objective === entry.category.objective)
    const problem =
      byObjective.find(p => !usedProblemTexts.has(p.text)) ??
      pool.find(p => !usedProblemTexts.has(p.text)) ??
      byObjective[0] ?? pool[0]
    usedProblemTexts.add(problem.text)
    return { templateKey: entry.templateKey, label: entry.label, awareness: entry.awareness, problem, category: entry.category }
  })

  const fillLines = fillList.map((f, i) => `${i + 1}. **${f.label}** _(${f.awareness.replace('-', ' ')})_`).join('\n')
  await ch.send(
    `**${freeSlots.length} free day${freeSlots.length > 1 ? 's' : ''} in the next ${LOOK_AHEAD_DAYS} days** — will fill with the ${toFill.length} most stale categor${toFill.length > 1 ? 'ies' : 'y'}:\n${fillLines}\n\n` +
    `Reply **auto-fill** to generate + schedule, or **no** to skip.`
  )

  const job = createJob({ status: 'pending', brief: { product: 'Renaissance Park & Chapels', concept: 'Coverage fill' }, assets: [], discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready' })
  g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillConfirm: { missing: fillList } })
}

// Phase 1: generate all drafts (text only), show them, wait for approval
async function runCoverageDraftPhase(ch: SendableChannel, missing: CoverageMissingItem[], channelId: string, userId: string) {
  const s = loadSettings()
  const NO_PHOTO = new Set(['VISUAL_METAPHOR_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])

  const [heroDataUris, draftInsights, scheduledPosts] = await Promise.all([
    loadShuffledHeroUris(),
    fetchCategoryInsights().catch(() => []),
    getCachedScheduledPosts(userId).catch(() => []),
  ])
  const draftPerfContext = formatInsightsForClaude(draftInsights) || undefined
  const slots = getWeekSlots(missing.length, bookedDaysSet(scheduledPosts))
  const draftQualifiedSignals = getQualifiedSignals(5)
  const draftSignalContext = draftQualifiedSignals.length > 0
    ? { signals: draftQualifiedSignals.map(s => s.text) }
    : undefined

  type GenItem = { item: CoverageMissingItem; idx: number; targetGeneration: string }
  const genItems: GenItem[] = []
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i]
    const needsPhoto = !NO_PHOTO.has(item.templateKey)
    const heroDataUri = heroDataUris.length > 0 ? (heroDataUris[i % heroDataUris.length]?.uri ?? null) : null
    if (needsPhoto && !heroDataUri) {
      await ch.send(`⏭️ **${item.label}** — skipped (no library photo).`)
      continue
    }
    const targetGeneration = GENERATION_ROTATION[genItems.length % GENERATION_ROTATION.length]
    genItems.push({ item, idx: i, targetGeneration })
  }

  if (genItems.length === 0) {
    await ch.send('No drafts generated. Check asset library and try again.')
    return
  }

  await ch.send(`Generating **${genItems.length} draft${genItems.length > 1 ? 's' : ''}**...`)

  const rawResults = await batchConcurrent(
    genItems.map(({ item, targetGeneration }) => async () => {
      const recentConcepts = { [item.templateKey]: getRecentConcepts(item.templateKey) }
      try {
        const sigCtx = draftSignalContext ? { ...draftSignalContext, targetGeneration } : { signals: [], targetGeneration }
        const [draft] = await generateBatchDrafts(item.awareness, [item.problem], [item.category], draftPerfContext, recentConcepts, sigCtx)
        return { ok: true as const, draft }
      } catch (err: any) {
        return { ok: false as const, error: err.message as string }
      }
    }),
    2
  )

  const drafts: WeeklyBrief[] = []
  for (let i = 0; i < genItems.length; i++) {
    const { item, targetGeneration } = genItems[i]
    const res = rawResults[i]
    if (!res.ok) {
      await ch.send(`⚠️ Draft for **${item.label}** failed: ${res.error}`)
      continue
    }
    const { draft } = res
    drafts.push({ ...draft, templateKey: item.templateKey })
    const hashtags = (draft.hashtags ?? []).map(h => `#${h}`).join(' ')
    const slot = slots[drafts.length - 1] ?? getNextBestPostTime()
    const genLabel = GENERATION_LABEL[targetGeneration] ?? ''
    await ch.send(
      `**${drafts.length}. ${item.label}** · ${genLabel}\n` +
      `> _${draft.concept}_\n\n` +
      `\`\`\`\n${draft.caption}\n\n${hashtags}\n\`\`\`\n` +
      `**CTA:** ${draft.ctaText} · **Hook:** ${draft.engagementHook}\n` +
      `📅 Slot: ${formatPHT(slot)}`
    )
  }

  if (drafts.length === 0) {
    await ch.send('No drafts generated. Check asset library and try again.')
    return
  }

  await ch.send(
    `Reply **approve all** to render all ${drafts.length} ads, ` +
    `**revise ${drafts.length > 1 ? 'N' : '1'}: [notes]** to rewrite one, or **no** to cancel.`
  )

  const job = createJob({ status: 'pending', brief: { product: 'Renaissance Park & Chapels', concept: 'Coverage fill' }, assets: [], discordChannelId: channelId, discordUserId: userId, conversationStep: 'ready' })
  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    coverageFillDraftReview: { drafts, heroDataUris: heroDataUris.map(h => h.uri), slots, missing },
  })
}

// Phase 2 handler: approve/revise/cancel after draft review
async function handleCoverageFillDraftReview(
  message: Message,
  job: Job,
  state: { drafts: WeeklyBrief[]; heroDataUris: string[]; slots: Date[]; missing: CoverageMissingItem[] }
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const reply = message.content.trim().toLowerCase()
  const rawReply = message.content.trim()

  if (reply === 'no' || reply === 'cancel') {
    g.__pendingBriefs!.delete(userId)
    await ch.send('Cancelled.')
    return
  }

  // Revise a specific draft
  const reviseMatch = rawReply.match(/^revise\s+(\d+):\s*(.+)/i)
  if (reviseMatch) {
    const idx = parseInt(reviseMatch[1], 10) - 1
    const notes = reviseMatch[2].trim()
    if (idx < 0 || idx >= state.drafts.length) {
      await ch.send(`Number must be between 1 and ${state.drafts.length}.`)
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillDraftReview: state })
      return
    }
    const item = state.missing[idx]
    if (!item) {
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillDraftReview: state })
      return
    }
    await ch.send(`Revising **${state.drafts[idx].label}**...`)
    try {
      const revisedProblem = { text: `${item.problem.text}. Revision notes: ${notes}`, objective: item.problem.objective }
      const [revised] = await generateBatchDrafts(item.awareness, [revisedProblem], [item.category])
      const updatedDrafts = [...state.drafts]
      updatedDrafts[idx] = { ...revised, templateKey: item.templateKey }
      const hashtags = (revised.hashtags ?? []).map(h => `#${h}`).join(' ')
      const slot = state.slots[idx] ?? getNextBestPostTime()
      await ch.send(
        `**${idx + 1}. ${item.label}** _(revised)_\n` +
        `> _${revised.concept}_\n\n` +
        `\`\`\`\n${revised.caption}\n\n${hashtags}\n\`\`\`\n` +
        `**CTA:** ${revised.ctaText} · **Hook:** ${revised.engagementHook}\n` +
        `📅 Slot: ${formatPHT(slot)}`
      )
      await ch.send(`Reply **approve all** to render, **revise N: [notes]** to change another, or **no** to cancel.`)
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillDraftReview: { ...state, drafts: updatedDrafts } })
    } catch (err: any) {
      await ch.send(`⚠️ Revision failed: ${err.message}`)
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillDraftReview: state })
    }
    return
  }

  if (reply !== 'approve all') {
    await ch.send(`Reply **approve all** to render, **revise N: [notes]** to change one, or **no** to cancel.`)
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillDraftReview: state })
    return
  }

  // Approved — render all
  g.__pendingBriefs!.delete(userId)
  await runCoverageRenderPhase(ch, state.drafts, state.heroDataUris, state.slots, state.missing, message.channelId)
}

// Phase 2 render: takes approved drafts + heroes, renders images, sets channel confirm
async function runCoverageRenderPhase(
  ch: SendableChannel,
  drafts: WeeklyBrief[],
  heroDataUris: string[],
  slots: Date[],
  missing: CoverageMissingItem[],
  channelId: string
) {
  const s = loadSettings()
  const NO_PHOTO = new Set(['VISUAL_METAPHOR_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])

  await ch.send(`Rendering **${drafts.length} ad${drafts.length > 1 ? 's' : ''}** in parallel...`)

  type RenderPayload = { draft: WeeklyBrief; item: CoverageMissingItem; slot: Date; adBrief: AdBrief; heroAsset: MediaAsset | null }
  const renderPayloads: RenderPayload[] = []
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]
    const item = missing.find(m => m.templateKey === draft.templateKey) ?? missing[i]
    if (!item) continue
    const slot = slots[i] ?? getNextBestPostTime()
    const needsPhoto = !NO_PHOTO.has(item.templateKey)
    const heroDataUri = heroDataUris.length > 0 ? heroDataUris[i % heroDataUris.length] : null
    const hasRunwayPrompt = !!draft.conceptImagePrompt
    if (needsPhoto && !heroDataUri && !hasRunwayPrompt) {
      await ch.send(`⏭️ **${item.label}** — skipped (no library photo).`)
      continue
    }
    const adBrief: AdBrief = {
      product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
      concept: draft.concept, caption: draft.caption, ctaText: draft.ctaText,
    }
    const heroAsset: MediaAsset | null = (needsPhoto && heroDataUri)
      ? { id: 'coverage_hero', name: 'hero.jpg', mimeType: 'image/jpeg', url: heroDataUri, webViewLink: heroDataUri }
      : null
    renderPayloads.push({ draft, item, slot, adBrief, heroAsset })
  }

  if (renderPayloads.length === 0) {
    await ch.send('No ads rendered. Check your asset library has approved photos.')
    return
  }

  const renderResults = await batchConcurrent(
    renderPayloads.map(({ draft, item, slot, adBrief, heroAsset }) => async () => {
      try {
        let finalHeroAsset = heroAsset
        if (draft.conceptImagePrompt) {
          try {
            const imgBuf = await generateConceptImage(draft.conceptImagePrompt)
            finalHeroAsset = { id: 'runway', name: 'hero_background.jpg', mimeType: 'image/jpeg', url: `data:image/jpeg;base64,${imgBuf.toString('base64')}`, webViewLink: '' }
          } catch (err: any) {
            console.warn(`[Coverage] Runway concept image failed for ${item.label} — falling back to library hero: ${err.message}`)
          }
        }
        const result = await generateImageAd(adBrief, finalHeroAsset ? [finalHeroAsset] : [], item.templateKey)
        return { ok: true as const, result, draft, item, slot }
      } catch (err: any) {
        return { ok: false as const, item, error: err.message as string }
      }
    }),
    1
  )

  const batchItems: BatchPlanItem[] = []
  for (const res of renderResults) {
    if (!res.ok) {
      await ch.send(`❌ **${res.item.label}** failed: ${res.error}`)
      continue
    }
    const { result, draft, item, slot } = res
    const safeName = item.label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    const fullCaption = buildFacebookCaption({ caption: draft.caption, hashtags: draft.hashtags ?? [], ctaText: draft.ctaText ?? '', engagementHook: draft.engagementHook ?? '' })
    batchItems.push({
      templateKey: item.templateKey, label: item.label,
      localPath: result.localPath, fileName: `${safeName}_${result.jobId}.png`,
      caption: draft.caption, hashtags: draft.hashtags ?? [],
      ctaText: draft.ctaText ?? '', engagementHook: draft.engagementHook ?? '',
      fullCaption, scheduledTime: slot, concept: draft.concept,
    })
    const attachment = new AttachmentBuilder(result.buffer, { name: `${safeName}.png` })
    await ch.send({ content: `**${batchItems.length}. ${item.label}** — ${draft.concept}\n📅 ${formatPHT(slot)}\n\n${fullCaption}`, files: [attachment] })
  }

  if (batchItems.length === 0) {
    await ch.send('No ads rendered. Check your asset library has approved photos.')
    return
  }

  const summary = batchItems.map((item, i) => `${i + 1}. **${item.label}** → ${formatPHT(item.scheduledTime)}`).join('\n')
  await ch.send(
    `✅ **${batchItems.length} ad${batchItems.length > 1 ? 's' : ''} ready:**\n${summary}\n\n` +
    `Reply **schedule all** to queue all, **schedule 1,3** for specific ones, or **no** to cancel.`
  )
  g.__channelBatchConfirm!.set(channelId, { items: batchItems })
}

async function handleCoverageFillConfirm(
  message: Message,
  job: Job,
  confirm: {
    missing: Array<{
      templateKey: string
      label: string
      awareness: string
      problem: { text: string; objective: string }
      category: { label: string; designDirective: string; objective: string }
    }>
  }
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const reply = message.content.trim().toLowerCase()

  const isAutoFill = reply === 'auto-fill' || reply === 'auto fill'
  if (!isAutoFill) {
    if (reply === 'no' || reply === 'cancel') {
      g.__pendingBriefs!.delete(userId)
      await ch.send('Skipped — no ads were generated.')
    } else {
      await ch.send('Reply **auto-fill** to generate the missing ads, or **no** to skip.')
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], coverageFillConfirm: confirm })
    }
    return
  }

  g.__pendingBriefs!.delete(userId)
  await ch.send(`Generating draft captions for **${confirm.missing.length}** image ad${confirm.missing.length > 1 ? 's' : ''}...`)
  await runCoverageDraftPhase(ch, confirm.missing, message.channelId, userId)
}

async function handleBatchAudiencePick(
  message: Message,
  job: Job,
  pick: { count: number; heroDataUris: string[] }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()
  const awareness = AUDIENCE_LEVEL_ALIASES[reply]

  if (!awareness) {
    await ch.send('I-reply ang **1**, **2**, **3**, **4**, o **5** para piliin ang audience level.')
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchAudiencePick: pick })
    return
  }

  const problems = PROBLEMS_BY_LEVEL[awareness] ?? PROBLEMS_BY_LEVEL['problem-aware']
  const list = problems.map((p, i) => `**${i + 1} ·** ${p.text}`).join('\n')

  await ch.send(
    `Anong mga pain point ang gusto mong i-address? _(Para sa ${pick.count}-ad plan, pumili ng ${pick.count} numero — comma separated)_\n\n` +
    `${list}\n\n` +
    `Halimbawa: \`1,3,5,7,9\``
  )

  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    batchAudiencePick: undefined,
    batchProblemPick: { count: pick.count, awareness, problems, heroDataUris: pick.heroDataUris },
  })
}

async function handleBatchProblemPick(
  message: Message,
  job: Job,
  pick: { count: number; awareness: string; problems: Array<{ text: string; objective: string }>; heroDataUris: string[] }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()

  const nums = reply.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  const invalid = nums.filter(n => n < 1 || n > pick.problems.length)
  if (nums.length === 0 || invalid.length > 0) {
    await ch.send(`I-reply ang mga numero mula **1** hanggang **${pick.problems.length}**, comma separated. Halimbawa: \`1,3,5\``)
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchProblemPick: pick })
    return
  }

  const selected = nums.map(n => pick.problems[n - 1])
  const allCategories = AD_CATEGORIES_BY_LEVEL[pick.awareness] ?? AD_CATEGORIES_BY_LEVEL['problem-aware']
  const categories = allCategories.filter(c => c.designDirective.endsWith('_TEMPLATE'))

  // Show pain points selected + ask for one ad category per pain point
  const selList = selected.map((p, i) => `**${i + 1}.** ${p.text}`).join('\n')
  const catList = categories.map((c, i) => `**${i + 1} ·** **${c.label}** — ${c.desc}`).join('\n')

  await ch.send(
    `**Selected pain points:**\n${selList}\n\n` +
    `**Available ad categories for ${pick.awareness.replace('-', ' ')} audience:**\n${catList}\n\n` +
    `Piliin ang ad category para sa bawat pain point — i-reply as **comma-separated numbers** ` +
    `(isa bawat ad, in order). Halimbawa para sa ${selected.length} ads: \`${Array.from({ length: selected.length }, (_, i) => (i % categories.length) + 1).join(',')}\``
  )

  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    batchProblemPick: undefined,
    batchCategoryPick: { awareness: pick.awareness, selectedProblems: selected, categories, heroDataUris: pick.heroDataUris },
  })
}

async function handleBatchCategoryPick(
  message: Message,
  job: Job,
  state: {
    awareness: string
    selectedProblems: Array<{ text: string; objective: string }>
    categories: Array<{ label: string; designDirective: string; objective: string }>
    heroDataUris: string[]
  }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()

  const nums = reply.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  const invalid = nums.filter(n => n < 1 || n > state.categories.length)

  if (nums.length !== state.selectedProblems.length || invalid.length > 0) {
    await ch.send(
      `I-reply ang **${state.selectedProblems.length} numero**, isa bawat ad — comma separated. ` +
      `Mula **1** hanggang **${state.categories.length}**. Halimbawa: \`${Array.from({ length: state.selectedProblems.length }, (_, i) => (i % state.categories.length) + 1).join(',')}\``
    )
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchCategoryPick: state })
    return
  }

  const assignedCategories = nums.map(n => state.categories[n - 1])
  const selList = state.selectedProblems.map((p, i) => `${i + 1}. ${p.text} → **${assignedCategories[i].label}**`).join('\n')
  await ch.send(`Generating **${state.selectedProblems.length} ads**:\n${selList}\n\n_(writing captions + building drafts...)_`)

  g.__pendingBriefs!.set(userId, { job, awaitingReply: false, assets: [], batchCategoryPick: undefined })

  // Fetch performance context once, share across all draft calls
  const batchInsights = await fetchCategoryInsights().catch(() => [])
  const perfContext = formatInsightsForClaude(batchInsights)
  const batchQualifiedSignals = getQualifiedSignals(5)
  const batchSignalContext = batchQualifiedSignals.length > 0
    ? { signals: batchQualifiedSignals.map(s => s.text) }
    : undefined

  // Generate one draft per problem with its assigned single-category
  const draftResults: WeeklyBrief[] = []
  for (let i = 0; i < state.selectedProblems.length; i++) {
    try {
      const recentConcepts = { [assignedCategories[i].designDirective]: getRecentConcepts(assignedCategories[i].designDirective) }
      const targetGeneration = GENERATION_ROTATION[i % GENERATION_ROTATION.length]
      const sigCtx = batchSignalContext ? { ...batchSignalContext, targetGeneration } : { signals: [], targetGeneration }
      const result = await generateBatchDrafts(state.awareness, [state.selectedProblems[i]], [assignedCategories[i]], perfContext || undefined, recentConcepts, sigCtx)
      draftResults.push(result[0])
    } catch (err: any) {
      await ch.send(`⚠️ Ad ${i + 1} draft failed: ${err.message}`)
      draftResults.push({
        templateKey: assignedCategories[i].designDirective,
        label: assignedCategories[i].label,
        concept: state.selectedProblems[i].text,
        objective: state.selectedProblems[i].objective,
        caption: '(generation failed — revise to regenerate)',
        hashtags: [],
        ctaText: '',
        engagementHook: '',
      })
    }
  }

  for (let i = 0; i < draftResults.length; i++) {
    const d = draftResults[i]
    const hashtags = (d.hashtags ?? []).map(h => `#${h}`).join(' ')
    await ch.send(
      `**Ad ${i + 1} — ${d.label}**\n` +
      `> _${d.concept}_\n\n` +
      `\`\`\`\n${d.caption}\n\n${hashtags}\n\`\`\`\n` +
      `**CTA:** ${d.ctaText}\n` +
      `**Hook:** ${d.engagementHook}`
    )
  }

  await ch.send(
    `Reply **approve all** to render all ${draftResults.length} image ads, ` +
    `**revise 2: [notes]** to rewrite a specific draft, or **no** to cancel.`
  )

  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    batchDraftReview: { awareness: state.awareness, drafts: draftResults, heroDataUris: state.heroDataUris },
  })
}

async function handleBatchDraftReview(
  message: Message,
  job: Job,
  state: { awareness: string; drafts: WeeklyBrief[]; heroDataUris: string[] }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()
  const rawReply = message.content.trim()

  if (reply === 'no') {
    g.__pendingBriefs!.delete(userId)
    await ch.send('Cancelled.')
    return
  }

  const reviseMatch = rawReply.match(/^revise\s+(\d+):\s*(.+)/i)
  if (reviseMatch) {
    const idx = parseInt(reviseMatch[1], 10) - 1
    const notes = reviseMatch[2].trim()
    if (idx < 0 || idx >= state.drafts.length) {
      await ch.send(`Ad number must be between 1 and ${state.drafts.length}.`)
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchDraftReview: state })
      return
    }

    const allCategories = AD_CATEGORIES_BY_LEVEL[state.awareness] ?? AD_CATEGORIES_BY_LEVEL['problem-aware']
    const categories = allCategories.filter(c => c.designDirective.endsWith('_TEMPLATE'))
    const targetProblem = { text: `${state.drafts[idx].concept}. Revision: ${notes}`, objective: state.drafts[idx].objective }

    await ch.send(`Revising **Ad ${idx + 1}**...`)
    try {
      const revInsights = await fetchCategoryInsights().catch(() => [])
      const revised = await generateBatchDrafts(state.awareness, [targetProblem], categories, formatInsightsForClaude(revInsights) || undefined)
      const updatedDrafts = [...state.drafts]
      updatedDrafts[idx] = revised[0]

      const d = revised[0]
      const hashtags = (d.hashtags ?? []).map(h => `#${h}`).join(' ')
      await ch.send(
        `**Ad ${idx + 1} revised — ${d.label}**\n\n` +
        `\`\`\`\n${d.caption}\n\n${hashtags}\n\`\`\`\n` +
        `**CTA:** ${d.ctaText}  **Hook:** ${d.engagementHook}\n\n` +
        `Reply **approve all** to proceed, **revise ${idx + 1}: [notes]** to revise again, or **no** to cancel.`
      )
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchDraftReview: { ...state, drafts: updatedDrafts } })
    } catch (err: any) {
      await ch.send(`⚠️ Revision failed: ${err.message}`)
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchDraftReview: state })
    }
    return
  }

  if (reply !== 'approve all') {
    await ch.send(`Reply **approve all** to render all ads, **revise 2: [notes]** to change a specific draft, or **no** to cancel.`)
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchDraftReview: state })
    return
  }

  // Approved — render all image ads
  g.__pendingBriefs!.set(userId, { job, awaitingReply: false, assets: [], batchDraftReview: undefined })
  await runBatchRender(message, job, state.drafts, state.heroDataUris)
}

async function runBatchRender(message: Message, job: Job, drafts: WeeklyBrief[], heroDataUris: string[] = []) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const scheduledBatch = await getCachedScheduledPosts(userId).catch(() => [])
  const slots = getWeekSlots(drafts.length, bookedDaysSet(scheduledBatch))
  // Use provided hero images (one per ad, cycling if fewer than ad count); fall back to library hero
  let resolvedHeroes: string[] = heroDataUris
  if (resolvedHeroes.length === 0) {
    const fallback = await fetchPreviewHero(message)
    if (fallback) resolvedHeroes = [fallback]
  }
  const s = loadSettings()
  const NO_PHOTO = new Set(['VISUAL_METAPHOR_TEMPLATE', 'EDUCATIONAL_TEMPLATE'])
  const batchItems: BatchPlanItem[] = []

  await ch.send(`Rendering **${drafts.length} image ads**... _(results appear one by one)_`)

  for (let i = 0; i < drafts.length; i++) {
    const brief = drafts[i]
    const slot = slots[i] ?? getNextBestPostTime()
    const needsPhoto = !NO_PHOTO.has(brief.templateKey)

    const heroDataUri = resolvedHeroes.length > 0 ? resolvedHeroes[i % resolvedHeroes.length] : null
    if (needsPhoto && !heroDataUri) {
      await ch.send(`⏭️ **${i + 1}. ${brief.label}** — skipped (no hero photo). Attach park photos to the \`weekly plan\` command and try again.`)
      continue
    }

    await ch.send(`Rendering **${i + 1}/${drafts.length}: ${brief.label}**...`)
    try {
      const adBrief: AdBrief = {
        product: `${s.footerRight1 ?? ''} ${s.footerRight2 ?? ''}`.trim() || 'Renaissance Park & Chapels',
        concept: brief.concept,
        caption: brief.caption,
        ctaText: brief.ctaText,
      }
      const heroAsset: MediaAsset | null = (needsPhoto && heroDataUri) ? {
        id: 'batch_hero', name: 'hero.jpg', mimeType: 'image/jpeg',
        url: heroDataUri, webViewLink: heroDataUri,
      } : null
      const result = await generateImageAd(adBrief, heroAsset ? [heroAsset] : [], brief.templateKey)
      const safeName = brief.label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
      const fileName = `${safeName}_${result.jobId}.png`
      const fullCaption = buildFacebookCaption({
        caption: brief.caption, hashtags: brief.hashtags ?? [],
        ctaText: brief.ctaText ?? '', engagementHook: brief.engagementHook ?? '',
      })
      batchItems.push({
        templateKey: brief.templateKey, label: brief.label,
        localPath: result.localPath, fileName,
        caption: brief.caption, hashtags: brief.hashtags ?? [],
        ctaText: brief.ctaText ?? '', engagementHook: brief.engagementHook ?? '',
        fullCaption, scheduledTime: slot,
      })
      const attachment = new AttachmentBuilder(result.buffer, { name: `ad_${i + 1}.png` })
      await ch.send({ content: `**${i + 1}. ${brief.label}** — ${brief.concept}\n📅 ${formatPHT(slot)}`, files: [attachment] })
    } catch (err: any) {
      await ch.send(`❌ **${i + 1}. ${brief.label}** failed: ${err.message}`)
    }
  }

  if (batchItems.length === 0) {
    await ch.send('No ads rendered. Attach a park photo and try again.')
    return
  }

  const summary = batchItems.map((item, i) => `${i + 1}. **${item.label}** → ${formatPHT(item.scheduledTime)}`).join('\n')
  await ch.send(
    `✅ Here are your **${batchItems.length} image ads**:\n${summary}\n\n` +
    `Reply **schedule all** to queue all ${batchItems.length} to Facebook, **schedule 1,3** for specific ones, or **no** to cancel.`
  )
  g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchPlanConfirm: { items: batchItems } })
}

async function handleBatchPlanConfirm(
  message: Message,
  job: Job,
  confirm: { items: BatchPlanItem[] }
) {
  const ch = message.channel as SendableChannel
  const userId = message.author.id
  const reply = message.content.trim().toLowerCase()

  if (reply === 'no') {
    g.__pendingBriefs!.delete(userId)
    await ch.send('Cancelled — no ads were scheduled.')
    return
  }

  const scheduleAllMatch = reply === 'schedule all'
  const schedulePickMatch = reply.match(/^schedule\s+([\d,\s]+)$/)

  if (!scheduleAllMatch && !schedulePickMatch) {
    const summary = confirm.items.map((item, i) => `${i + 1}. ${item.label} → ${formatPHT(item.scheduledTime)}`).join('\n')
    await ch.send(`Reply **schedule all** to queue all ${confirm.items.length} ads, **schedule 1,3** for specific ones, or **no** to cancel.\n${summary}`)
    g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchPlanConfirm: confirm })
    return
  }

  let selectedItems = confirm.items
  if (schedulePickMatch) {
    const indexes = schedulePickMatch[1].split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < confirm.items.length)
    selectedItems = indexes.map(i => confirm.items[i])
    if (selectedItems.length === 0) {
      await ch.send('No valid ad numbers found. Reply **schedule all** or **schedule 1,3** (1-based), or **no** to cancel.')
      g.__pendingBriefs!.set(userId, { job, awaitingReply: true, assets: [], batchPlanConfirm: confirm })
      return
    }
  }

  g.__pendingBriefs!.delete(userId)

  if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) {
    await ch.send('⚠️ Facebook not configured. Set FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in .env.local.')
    return
  }

  await ch.send(`Uploading and scheduling **${selectedItems.length} ad${selectedItems.length > 1 ? 's' : ''}**...`)

  const scheduled: Array<{ label: string; time: Date }> = []
  const failed: string[] = []

  for (const item of selectedItems) {
    try {
      await uploadImage(item.localPath, item.fileName)
      const fbResult = await scheduleImageToFacebook(item.localPath, item.fullCaption, item.scheduledTime)
      if (item.templateKey.endsWith('_TEMPLATE')) {
        recordPost(item.templateKey, item.label, item.scheduledTime, fbResult.photoId, fbResult.postId ?? undefined, item.concept, item.heroImageId)
      }
      scheduled.push({ label: item.label, time: item.scheduledTime })
    } catch (err: any) {
      failed.push(`${item.label}: ${err.message}`)
    }
  }

  if (scheduled.length > 0) {
    const lines = scheduled.map(s => `📅 ${formatPHT(s.time)} — **${s.label}**`).join('\n')
    await ch.send(`✅ Scheduled **${scheduled.length} ad${scheduled.length > 1 ? 's' : ''}**:\n${lines}`)
  }
  if (failed.length > 0) {
    await ch.send(`⚠️ Failed:\n${failed.map(f => `• ${f}`).join('\n')}`)
  }
}

async function handleBoostConfirm(
  message: Message,
  job: Job,
  confirm: { postId: string; fbUrl: string; approvedDraftId?: string }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  if (reply === 'skip') {
    if (job) updateJob(job.id, { status: 'done' })
    g.__pendingBriefs!.delete(userId)
    await ch.send('Skipped boost. Post is live!')
    return
  }

  if (reply === 'boost') {
    g.__pendingBriefs!.delete(userId)
    const s = loadSettings()
    await ch.send('Boosting post...')
    try {
      const adUrl = await boostPost(confirm.postId, s.boostBudgetPHP, s.boostAgeMin, s.boostAgeMax, s.boostCountry)
      if (job) updateJob(job.id, { status: 'done' })
      await ch.send(`✅ Boosted! ₱${s.boostBudgetPHP}/day · runs until you stop it.\n**Ads Manager:** ${adUrl}`)
    } catch (err: any) {
      if (job) updateJob(job.id, { status: 'done' })
      await ch.send(`⚠️ Boost failed: ${err.message}\n\nPost is still live: ${confirm.fbUrl}`)
    }
    return
  }

  // Unrecognized — re-ask
  await ch.send('Reply **boost** to boost this post or **skip** to leave it as-is.')
  g.__pendingBriefs!.set(userId, {
    job, awaitingReply: true, assets: [],
    boostConfirm: confirm,
  })
}

async function runPipeline(message: Message, job: Job, assets: MediaAsset[]) {
  if (!process.env.GOOGLE_ACCESS_TOKEN && !process.env.GOOGLE_REFRESH_TOKEN) {
    await (message.channel as SendableChannel).send(
      '⚠️ Google Drive not connected. Please authenticate at `/api/auth/google/login`.'
    )
    return
  }

  let resolvedAssets = assets
  if (resolvedAssets.length === 0) {
    const lib = pickBestHeroAsset()
    if (lib) {
      resolvedAssets = [{
        id: lib.id,
        name: lib.fileName,
        mimeType: 'image/jpeg',
        url: assetDownloadUrl(lib),
        webViewLink: lib.driveUrl ?? lib.discordUrl,
      }]
      await (message.channel as SendableChannel).send(
        `No images attached — using approved library asset: _"${lib.caption.slice(0, 80)}"_ (${lib.overallScore?.toUpperCase()})`
      )
    } else {
      await (message.channel as SendableChannel).send(
        '⚠️ No images attached and no approved assets in the library yet. Attach images or submit assets first.'
      )
      const existingEntry = g.__pendingBriefs!.get(message.author.id)
      g.__pendingBriefs!.set(message.author.id, { ...existingEntry, job, awaitingReply: true, assets })
      return
    }
  }

  const alreadyWarned = job.status === 'needs_shots'
  const ch = message.channel as SendableChannel

  updateJob(job.id, { status: 'evaluating', assets: resolvedAssets })
  await ch.send(`Evaluating your ${resolvedAssets.length} image(s)...`)

  let scored = resolvedAssets
  try {
    const evaluation = await evaluateMedia(resolvedAssets, job.brief)
    scored = evaluation.scored

    if (!evaluation.ready && !alreadyWarned) {
      updateJob(job.id, { status: 'needs_shots', assets: scored, missingShots: evaluation.missingShots })
      const shotList = evaluation.missingShots.map((s) => `• ${s}`).join('\n')
      await ch.send(
        `Your images could be stronger. Here's what would improve the ad:\n${shotList}\n\nAttach more images and type **ready**, or just type **ready** to proceed with what you have.`
      )
      const existingEntryShots = g.__pendingBriefs!.get(message.author.id)
      g.__pendingBriefs!.set(message.author.id, {
        ...existingEntryShots,
        job: getJob(job.id)!,
        awaitingReply: true,
        assets: scored,
      })
      return
    }
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    if (isCredits) {
      await ch.send('⚠️ Anthropic API credit balance is too low — skipping image evaluation and proceeding with all images.')
    } else {
      await ch.send(`⚠️ Image evaluation failed (${err?.message ?? 'unknown error'}) — proceeding with all images.`)
    }
    // Continue with unscored assets rather than stopping
  }

  updateJob(job.id, { status: 'scripting', assets: scored })
  await ch.send('Generating your Facebook ad image...')

  try {
    const imageResult = await generateImageAd(job.brief, scored)

    updateJob(job.id, {
      status: 'rendering',
      imageUrl: `/outputs/${imageResult.jobId}.png`,
    })

    const safeName = job.brief.product.replace(/[^a-zA-Z0-9]/g, '_')
    const fileName = `${safeName}_ad_${imageResult.jobId}.png`

    // Use approved Stage 2 copy if available, otherwise fall back to brief data
    const approvedDraft = g.__pendingBriefs!.get(message.author.id)?.approvedPostDraft
    const caption = approvedDraft
      ? buildFacebookCaption(approvedDraft)
      : [job.brief.product, job.brief.concept].filter(Boolean).join(' — ')

    const captionPreview = approvedDraft
      ? `\n\n**Post caption:**\n\`\`\`\n${buildFacebookCaption(approvedDraft)}\n\`\`\``
      : ''

    const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
    await ch.send({
      content: `Here's your ad!${captionPreview}\n\nReply **yes** to save to Google Drive and post, **reprompt: [notes]** to redesign, or **no** to cancel.`,
      files: [attachment],
    })

    g.__pendingBriefs!.set(message.author.id, {
      job: getJob(job.id)!,
      awaitingReply: true,
      assets: scored,
      approvedPostDraft: approvedDraft,
      facebookConfirm: {
        localPath: imageResult.localPath,
        fileName,
        caption,
        approvedDraftId: approvedDraft?.id,
        adBrief: { ...job.brief, caption: approvedDraft ? buildFacebookCaption(approvedDraft) : undefined },
        heroAsset: scored[0] ?? undefined,
      },
    })
  } catch (err: any) {
    console.error('[Discord] Pipeline error:', err)
    updateJob(job.id, { status: 'failed', error: err.message })
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(
      isCredits
        ? '⚠️ Anthropic API credit balance is too low to generate the ad. Please top up at console.anthropic.com, then type **ready** to try again.'
        : `Something went wrong generating your ad: ${err.message}`
    )
  }
}
