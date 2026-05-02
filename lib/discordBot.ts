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
import { postToFacebook, scheduleImageToFacebook, scheduleTextToFacebook, boostPost } from './facebook'
import { loadSettings, saveSettings } from './brandSettings'
import { generatePost, generateContentPlan, formatDraftForDiscord, formatDraftForMetaBusiness, buildFacebookCaption, LibraryAsset, ContentPlan } from './contentGenerator'
import { addDraft, updateDraft, getDraft, PostDraft } from './draftStore'
import { scoreAsset, scoreAssetFromBuffer } from './assetScorer'
import { addAsset, updateAsset, getAsset, listAssets, StoredAsset, AssetType } from './assetStore'
import { AdBrief, Job, MediaAsset } from '@/types'

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
  }
  scheduleTextConfirm?: {
    caption: string
    scheduledTime: Date
    approvedDraftId?: string
  }
  postReview?: {
    draft: PostDraft
    revisionCount: number
  }
  postPublish?: {
    draft: PostDraft
  }
  // Gap 1: objective selection
  objectivePick?: {
    concept: string
    awareness?: string
  }
  // Gap 3: content plan review
  contentPlanReview?: {
    concept: string
    objective: string
    plan: ContentPlan
    revisionCount: number
    revisionNotes?: string
    awareness?: string
  }
  approvedPostDraft?: PostDraft
  boostConfirm?: {
    postId: string
    fbUrl: string
    approvedDraftId?: string
  }
  brandConcept?: string
  brandAwareness?: 'problem-aware' | 'solution-aware' | 'unaware' | 'most-aware'
  photoPick?: {
    draft: PostDraft
    revisionCount: number
    candidates: Array<{
      rank: number
      assetId: string
      driveUrl: string
      discordUrl?: string
      caption: string
      score: string
    }>
  }
}

// Persist state across Next.js hot reloads using globalThis
const g = globalThis as typeof globalThis & {
  __discordClient?: Client | null
  __pendingBriefs?: Map<string, PendingEntry>
  __processedIds?: Set<string>
}
if (!g.__discordClient) g.__discordClient = null
if (!g.__pendingBriefs) g.__pendingBriefs = new Map()
if (!g.__processedIds) g.__processedIds = new Set()

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

// Pick the highest-scored approved photo from the asset library
function pickBestHeroAsset(): StoredAsset | null {
  const rank: Record<string, number> = { featured: 4, high: 3, medium: 2, low: 1 }
  const heroTypes: AssetType[] = ['photo', 'background', 'illustration', 'other']
  return listAssets('approved')
    .filter(a => heroTypes.includes(a.assetType as AssetType))
    .sort((a, b) => (rank[b.overallScore ?? 'low'] ?? 0) - (rank[a.overallScore ?? 'low'] ?? 0))[0] ?? null
}

const OBJECTIVES: Record<string, { label: string; desc: string }> = {
  awareness: { label: 'Awareness',     desc: 'Brand recognition & community presence' },
  inquiry:   { label: 'Inquiry',       desc: 'Drive service inquiries & lead generation' },
  grief:     { label: 'Grief Support', desc: 'Compassionate content for bereaved families' },
  promo:     { label: 'Promo',         desc: 'Promotional offers & specific services' },
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
    0: [9, 20],      // Sunday
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

  // Boost confirmation takes priority over everything
  if (pending?.awaitingReply && pending.boostConfirm) {
    await handleBoostConfirm(message, pending.job, pending.boostConfirm)
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
    await handlePostReview(message, pending.postReview.draft, pending.postReview.revisionCount)
    return
  }

  // Content plan review (ok / adjust:)
  if (pending?.awaitingReply && pending.contentPlanReview) {
    await handleContentPlanReview(message, pending.contentPlanReview)
    return
  }

  // Objective pick (1–4 / keyword)
  if (pending?.awaitingReply && pending.objectivePick) {
    await handleObjectivePick(message, pending.objectivePick)
    return
  }

  // Generate ad from brand: pain point
  if (pending?.awaitingReply && pending.brandConcept) {
    if (content === 'generate ad') {
      const concept = pending.brandConcept
      const awareness = pending.brandAwareness
      g.__pendingBriefs!.set(userId, { ...pending, brandConcept: undefined, brandAwareness: undefined, awaitingReply: false })
      await askForObjective(message, concept, awareness)
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
  if (content === 'show boost settings') {
    const s = loadSettings()
    const accountId = process.env.FB_AD_ACCOUNT_ID
    await message.reply(
      `**Boost settings:**\n` +
      `Budget: ₱${s.boostBudgetPHP}/day · Ages: ${s.boostAgeMin}–${s.boostAgeMax} · Country: ${s.boostCountry}\n` +
      `Ad Account: ${accountId ? `\`${accountId}\`` : '⚠️ not set — add FB_AD_ACCOUNT_ID to .env.local'}\n\n` +
      `Commands: \`set boost budget: 200\` · \`set boost age: 25-60\` · \`set boost country: PH\``
    )
    return
  }

  if (content === 'reprompts') {
    const ch = message.channel as SendableChannel
    await ch.send(
      `**📋 Reprompt Reference** — use \`reprompt: [notes]\` after an image ad is generated.\n\n` +
      `**🖼️ Layout & Composition**\n` +
      `\`reprompt: Centered layout, large headline dominates, minimal elements\`\n` +
      `\`reprompt: Full-bleed hero photo, text anchored to bottom third\`\n` +
      `\`reprompt: Reduce text density, more breathing room around headline\`\n` +
      `\`reprompt: Remove eyebrow text entirely\`\n` +
      `\`reprompt: Remove body line, headline only\`\n\n` +
      `**✍️ Headline Style**\n` +
      `\`reprompt: Headline in Filipino, body line in English\`\n` +
      `\`reprompt: Full caption in Filipino\`\n` +
      `\`reprompt: Shorter headline — 4 words max, punchy\`\n` +
      `\`reprompt: Loss framing headline — what families risk by waiting\`\n` +
      `\`reprompt: Question headline that names the reader's exact fear\`\n` +
      `\`reprompt: Headline as a direct promise, not a question\`\n` +
      `\`reprompt: Headline formula: Problem → Solution\`\n` +
      `\`reprompt: Headline formula: Social proof — families who chose RP\``
    )
    await ch.send(
      `**💰 Offers & Pricing Grid**\n` +
      `\`reprompt: 3 offer cards, 20-year term monthly prices from knowledge base, label "/ month"\`\n` +
      `\`reprompt: 3 offer cards, 7-year term monthly prices from knowledge base, label "/ month"\`\n` +
      `\`reprompt: 3 offer cards, 5-year term monthly prices from knowledge base, label "/ month"\`\n` +
      `\`reprompt: Show spot cash prices, label "Spot Cash"\`\n` +
      `\`reprompt: 2 offer cards only — Regular Lawn and Premium Lawn, 20-year term\`\n` +
      `\`reprompt: Replace offer cards with single body line, remove pricing grid\`\n` +
      `\`reprompt: Eyebrow: "Flexible Payment Plans", 3 offer cards, 20-year term, label "/ month", centered layout\`\n\n` +
      `**🎨 Mood & Tone**\n` +
      `\`reprompt: Warmer tone — less formal, more family-feeling\`\n` +
      `\`reprompt: More dignified, reduce urgency\`\n` +
      `\`reprompt: Eyebrow in Filipino, headline in English\`\n` +
      `\`reprompt: Uplifting tone — focus on peace and celebration of life\`\n` +
      `\`reprompt: Gentle grief tone — empathetic, no hard sell\``
    )
    await ch.send(
      `**📅 Concept-Specific**\n` +
      `\`reprompt: Undas angle — visiting the park during All Saints Day\`\n` +
      `\`reprompt: OFW angle — providing for family from abroad\`\n` +
      `\`reprompt: No hidden fees angle — transparency as the key message\`\n` +
      `\`reprompt: No annual maintenance fee — perpetual care fund\`\n` +
      `\`reprompt: Installment plan angle — affordable monthly payments headline\`\n` +
      `\`reprompt: Park-for-the-living angle — picnic, wellness, family visits\`\n` +
      `\`reprompt: Urgency angle — prices increase, lock in now\`\n` +
      `\`reprompt: Location angle — along the highway, easy to visit\`\n\n` +
      `**🔁 Combined (copy-paste ready)**\n` +
      `\`reprompt: Centered layout, large headline dominates — affordability angle, loss framing. Eyebrow: "Flexible Payment Plans". 3 offer cards, 20-year term from knowledge base, label "/ month". Minimal elements.\`\n` +
      `\`reprompt: Filipino headline, English body line. Loss framing — what families miss by waiting. Minimal elements, centered.\`\n` +
      `\`reprompt: Undas concept. Headline: visiting loved one in a well-kept peaceful park. Warm tone, no pricing grid.\`\n` +
      `\`reprompt: OFW concept. Headline in Filipino — providing peace of mind from abroad. Gentle, no hard sell.\``
    )
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
    await askForObjective(message, concept)
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

// ─── Brand knowledge Q&A ─────────────────────────────────────────────────────
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

// ─── Gap 1: Objective selection ───────────────────────────────────────────────

async function askForObjective(message: Message, concept: string, awareness?: string) {
  const userId = message.author.id
  const entry = g.__pendingBriefs!.get(userId)
  g.__pendingBriefs!.set(userId, {
    ...(entry ?? { job: null as any, assets: [] }),
    awaitingReply: true,
    objectivePick: { concept, awareness },
  })
  await message.reply(
    `Got it. What's the goal for this post?\n\n` +
    `**1 · Awareness** — building brand recognition & community presence\n` +
    `**2 · Inquiry** — driving service inquiries & leads\n` +
    `**3 · Grief Support** — compassionate content for bereaved families\n` +
    `**4 · Promo** — promotional offers & specific services\n\n` +
    `Reply with a number or keyword.`
  )
}

async function handleObjectivePick(message: Message, pick: { concept: string; awareness?: string }) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  const objective = OBJECTIVE_ALIASES[reply]
  if (!objective) {
    await ch.send('Please reply **1**, **2**, **3**, or **4** to select an objective.')
    return
  }

  const obj = OBJECTIVES[objective]

  // Gap 2: Asset sufficient? check
  if (!hasApprovedVisuals()) {
    await ch.send(
      `Going with **${obj.label}**.\n\n` +
      `There aren't any approved visuals in the library yet — I'll issue a photo brief alongside the draft.\n` +
      `Once an image is submitted and approved, the full post will be ready.`
    )
    await issueAssetBriefOnly(message, pick.concept, objective)
    return
  }

  // Assets available — build content plan first
  await ch.send(`**${obj.label}** — building your content plan...`)
  try {
    const libraryAssets: LibraryAsset[] = listAssets('approved').map(a => ({
      id: a.id, caption: a.caption, tags: a.tags,
      score: a.overallScore ?? 'low', submittedByName: a.submittedByName, assetType: a.assetType,
    }))
    const plan = await generateContentPlan(pick.concept, objective, libraryAssets, undefined, pick.awareness)

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
      contentPlanReview: { concept: pick.concept, objective, plan, revisionCount: 0, awareness: pick.awareness },
    })
  } catch (err: any) {
    const isCredits = err?.message?.includes('credit balance')
    await ch.send(isCredits ? '⚠️ API credit balance too low.' : `⚠️ Failed to build content plan: ${err.message}`)
  }
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
  state: { concept: string; objective: string; plan: ContentPlan; revisionCount: number; revisionNotes?: string; awareness?: string },
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  if (reply === 'ok' || reply === 'go' || reply === 'proceed' || reply === 'yes') {
    g.__pendingBriefs!.delete(userId)
    await handlePostGeneration(message, state.concept, state.revisionNotes, state.revisionCount, state.objective, state.plan, state.awareness)
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

async function handlePhotoPick(
  message: Message,
  state: {
    draft: PostDraft
    revisionCount: number
    candidates: Array<{ rank: number; assetId: string; driveUrl: string; discordUrl?: string; caption: string; score: string }>
  },
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim()
  const pick = parseInt(reply, 10)

  if (isNaN(pick) || pick < 1 || pick > state.candidates.length) {
    const opts = state.candidates.map(c => `**${c.rank}**`).join(', ')
    await ch.send(`Reply ${opts} to pick a photo.`)
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
    postReview: { draft: updatedDraft, revisionCount: state.revisionCount },
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

        const generated = await generatePost({ concept, objective, awareness, plan, revisionNotes, discordUserId: userId, discordUserName, libraryAssets })

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

        await ch.send('Reply **1**, **2**, or **3** to pick a photo.')

        const entry = g.__pendingBriefs!.get(userId)
        g.__pendingBriefs!.set(userId, {
          ...(entry ?? { job: null as any, assets: [] }),
          awaitingReply: true,
          photoPick: {
            draft,
            revisionCount,
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

    const generated = await generatePost({ concept, objective, awareness, plan, revisionNotes, discordUserId: userId, discordUserName, libraryAssets })

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
      postReview: { draft, revisionCount },
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

async function handlePostReview(message: Message, draft: PostDraft, revisionCount: number) {
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

    // Combined brief (only if no photo yet) + Meta copy
    const formatted = formatDraftForMetaBusiness(approvedDraft)
    const nextSlot = getNextBestPostTime()
    const briefSection = !draft.fulfilledAssetUrl
      ? `${pingText}📋 **PHOTO BRIEF** _(ID: \`${draft.id}\`)_\n` +
        `> **Subject:** ${updatedBrief.subject}\n` +
        `> **Location:** ${updatedBrief.location}\n` +
        `> **Mood / Lighting:** ${updatedBrief.moodLighting}\n` +
        `> **Deadline:** ${updatedBrief.deadline}\n` +
        `> **Assigned to:** ${assignedTo}\n` +
        `📸 Submit with: \`brief: ${draft.id}:\` + attach image\n\n`
      : ''
    await ch.send(
      `Approved!\n\n` +
      briefSection +
      `**Copy for Meta Business Suite:**\n\`\`\`\n${formatted}\n\`\`\``
    )

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
        const imageResult = await generateImageAd(adBrief, [heroAsset])
        const job = createJob({
          status: 'rendering', brief: adBrief, assets: [heroAsset],
          discordChannelId: message.channelId, discordUserId: userId, conversationStep: 'ready',
        })
        updateJob(job.id, { imageUrl: `/outputs/${imageResult.jobId}.png` })

        const safeName = draft.concept.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
        const fileName = `${safeName}_${imageResult.jobId}.png`
        const fullCaption = buildFacebookCaption(draft)

        const attachment = new AttachmentBuilder(imageResult.localPath, { name: 'ad-preview.png' })
        await ch.send({
          content:
            `Here's your image ad!\n\n` +
            `Reply **yes** to post now, **schedule** to queue for ${formatPHT(nextSlot)}, ` +
            `**reprompt: [notes]** to redesign, or **no** to cancel.`,
          files: [attachment],
        })

        g.__pendingBriefs!.set(userId, {
          job, awaitingReply: true, assets: [heroAsset],
          approvedPostDraft: approvedDraft,
          facebookConfirm: {
            localPath: imageResult.localPath, fileName, caption: fullCaption,
            approvedDraftId: draft.id, adBrief, heroAsset,
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
    await handlePostGeneration(message, draft.concept, notes, revisionCount + 1, draft.objective)
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
  confirm: { localPath: string; fileName: string; caption: string; approvedDraftId?: string; scheduledTime?: Date; adBrief?: AdBrief; heroAsset?: MediaAsset }
) {
  const userId = message.author.id
  const ch = message.channel as SendableChannel
  const reply = message.content.trim().toLowerCase()

  // Reprompt — regenerate the image ad with revision notes
  if (reply.startsWith('reprompt:')) {
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

  if (!wantsPost && !wantsSchedule) {
    updateJob(job.id, { status: 'done' })
    g.__pendingBriefs!.delete(userId)
    await ch.send('Got it — ad was not saved.')
    return
  }

  // Schedule — compute the next best slot now
  if (wantsSchedule) confirm = { ...confirm, scheduledTime: getNextBestPostTime() }

  g.__pendingBriefs!.delete(userId)

  // Step 1 — upload to Drive
  await ch.send('Saving to Google Drive...')
  let driveLink: string
  try {
    driveLink = await uploadImage(confirm.localPath, confirm.fileName)
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
      const fbUrl = await scheduleImageToFacebook(confirm.localPath, confirm.caption, confirm.scheduledTime!)
      updateJob(job.id, { status: 'done' })
      if (confirm.approvedDraftId) updateDraft(confirm.approvedDraftId, { status: 'published' })
      await ch.send(`✅ Scheduled for **${formatPHT(confirm.scheduledTime!)}**\n${fbUrl}`)
    } else {
      const { url: fbUrl, postId } = await postToFacebook(confirm.localPath, confirm.caption)
      if (confirm.approvedDraftId) updateDraft(confirm.approvedDraftId, { status: 'published' })

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
