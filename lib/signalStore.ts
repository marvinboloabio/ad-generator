import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { listAll } from './coverageStore'
import {
  fetchGoogleTrendsPH,
  fetchNewsRSS,
  fetchRedditSurface,
  fetchRedditDeep,
  fetchYouTubeTitles,
  fetchYouTubeComments,
} from './signalSources'
import { getUpcomingHolidays, daysUntil } from './phCalendar'

// ── Paths ─────────────────────────────────────────────────────────────────
const SIGNALS_PATH  = path.join(process.cwd(), 'signals.json')
const TONE_MAP_PATH = path.join(process.cwd(), 'toneMap.json')

// ── Types ─────────────────────────────────────────────────────────────────
export type SignalSource = 'google_trends' | 'news_rss' | 'reddit_surface' | 'reddit_deep' | 'youtube' | 'ph_calendar'
export type SignalCadence = 'surface' | 'deep'
export type SignalStatus = 'pending' | 'approved' | 'held' | 'discarded'

export type GenerationTag = 'boomer' | 'millennial' | 'genz' | 'all'

export type ToneTag =
  | 'quiet_grief'
  | 'generational_pride'
  | 'aging_softness'
  | 'ofw_longing'
  | 'parental_sacrifice'
  | 'hopeful_legacy'

export type TopicTag =
  | 'aging_mortality'
  | 'ofw_distance'
  | 'family_sacrifice'
  | 'grief_loss'
  | 'legacy_planning'
  | 'celebrity_death'
  | 'current_news'
  | 'holiday_occasion'
  | 'other'

export interface Signal {
  id: string           // MD5(source + text) — dedup key
  text: string
  source: SignalSource
  cadence: SignalCadence
  fetchedAt: string    // ISO
  fitScore?: number    // 3–9 (sum of 3 dimensions)
  toneTag?: ToneTag
  topicTag?: TopicTag
  generationTag?: GenerationTag
  fitReason?: string
  status: SignalStatus
  heldUntil?: string   // ISO — re-score time for held signals
  discardReason?: string
}

export interface ToneMapEntry {
  tag: ToneTag
  description: string  // Claude's one-line summary of why this tone dominates
  weight: number       // 1–3
}

export interface ToneMap {
  month: string        // YYYY-MM
  entries: ToneMapEntry[]
  rawSummary: string   // full Claude analysis
  generatedAt: string
}

// ── Cooldown windows (days) ───────────────────────────────────────────────
const COOLDOWN_DAYS: Record<TopicTag, number> = {
  aging_mortality:   30,
  ofw_distance:      30,
  family_sacrifice:  30,
  grief_loss:        21,
  legacy_planning:   21,
  celebrity_death:   14,
  current_news:      14,
  holiday_occasion: 365,
  other:              7,
}

// ── Storage ───────────────────────────────────────────────────────────────
function loadSignals(): Signal[] {
  try {
    if (fs.existsSync(SIGNALS_PATH)) return JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf8'))
  } catch {}
  return []
}

function saveSignals(signals: Signal[]): void {
  fs.writeFileSync(SIGNALS_PATH, JSON.stringify(signals, null, 2), 'utf8')
}

export function loadToneMap(): ToneMap | null {
  try {
    if (fs.existsSync(TONE_MAP_PATH)) return JSON.parse(fs.readFileSync(TONE_MAP_PATH, 'utf8'))
  } catch {}
  return null
}

function saveToneMap(tm: ToneMap): void {
  fs.writeFileSync(TONE_MAP_PATH, JSON.stringify(tm, null, 2), 'utf8')
}

// ── MD5 dedup ─────────────────────────────────────────────────────────────
function md5Id(source: string, text: string): string {
  return crypto.createHash('md5').update(source + '::' + text.trim().toLowerCase()).digest('hex')
}

function isDuplicate(signals: Signal[], id: string): boolean {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  return signals.some(s => s.id === id && s.fetchedAt >= cutoff)
}

// ── Hard stop check ───────────────────────────────────────────────────────
const HARD_STOP_PATTERNS: RegExp[] = [
  /\b(election|halalan|partido|kandidato|senator|congressman|mayor|presidente|VP|vice president|Marcos|Duterte|Robredo|partisan|laban|campaign|botohan)\b/i,
  /\b(murder|murder|patay na|pinatay|aksidente|tragedy|disaster|baha|lindol|bagyo|suicide|nagpakamatay|drug war|tokhang)\b/i,
  /\b(chismis|intriga|scandal|breakup|nagbreak|celebrity|artista|showbiz|love team|teleserye|gossip)\b/i,
  /\b(meme|viral challenge|trend challenge|hugot lang|joke lang|funniest|nakakatawa|LOL|HAHA)\b/i,
  /\b(K-12|college entrance|UPCAT|ACET|graduation stress|grade|uni life|dorm|iskolar)\b/i,
]

function isHardStop(text: string): string | null {
  const patterns = [
    { re: HARD_STOP_PATTERNS[0], reason: 'political/partisan content' },
    { re: HARD_STOP_PATTERNS[1], reason: 'violent/traumatic death or disaster' },
    { re: HARD_STOP_PATTERNS[2], reason: 'celebrity gossip or lifestyle trend' },
    { re: HARD_STOP_PATTERNS[3], reason: 'humor-only trend' },
    { re: HARD_STOP_PATTERNS[4], reason: 'youth/student audience trend' },
  ]
  for (const { re, reason } of patterns) {
    if (re.test(text)) return reason
  }
  return null
}

// ── Claude fit scoring ────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 })

const TONE_TAGS: ToneTag[] = ['quiet_grief', 'generational_pride', 'aging_softness', 'ofw_longing', 'parental_sacrifice', 'hopeful_legacy']
const TOPIC_TAGS: TopicTag[] = ['aging_mortality', 'ofw_distance', 'family_sacrifice', 'grief_loss', 'legacy_planning', 'celebrity_death', 'current_news', 'holiday_occasion', 'other']
const GENERATION_TAGS: GenerationTag[] = ['boomer', 'millennial', 'genz', 'all']

interface ScoreResult {
  id: string
  fitScore: number
  toneTag: ToneTag
  topicTag: TopicTag
  generationTag: GenerationTag
  fitReason: string
  hardStop?: string
}

async function scoreSignalsBatch(signals: Signal[]): Promise<ScoreResult[]> {
  if (signals.length === 0) return []

  const numbered = signals.map((s, i) => `${i + 1}. "${s.text}"`).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You score trending topics for Renaissance Park & Chapels — a Philippine memorial park. Their audience: Filipino families dealing with grief, legacy planning, or caring for aging parents. Their values: Dignity, Family, Legacy, Peace, Remembrance.

Score each topic on THREE dimensions (1–3 each), then sum for total (3–9):
1. Audience resonance: 1=general public only, 2=families broadly, 3=core RP audience directly
2. Earned right to speak: 1=opportunistic, 2=adjacent/stretched, 3=natural authority
3. Emotional timing: 1=too raw or exhausted, 2=peak noise, 3=reflective stage (quiet after)

Tone tags (pick one): quiet_grief, generational_pride, aging_softness, ofw_longing, parental_sacrifice, hopeful_legacy
Topic tags (pick one): aging_mortality, ofw_distance, family_sacrifice, grief_loss, legacy_planning, celebrity_death, current_news, holiday_occasion, other
Generation tags (pick one): boomer (60+ pre-planning own interment), millennial (30-45 planning for parents / OFW), genz (18-28 emotional sharer / lolo-lola connection), all (resonates broadly)

Respond ONLY with a JSON array:
[{"n":1,"score":7,"tone":"quiet_grief","topic":"grief_loss","generation":"millennial","reason":"one sentence why"},...]`,
    messages: [{ role: 'user', content: `Score these ${signals.length} trending topics:\n${numbered}` }],
  })

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
  const stripped = raw.replace(/```json|```/g, '').trim()
  let parsed: any[] = []
  try { parsed = JSON.parse(stripped) } catch { return [] }

  return parsed.map((r: any) => ({
    id: signals[r.n - 1]?.id ?? '',
    fitScore: Math.max(3, Math.min(9, Number(r.score) || 3)),
    toneTag: TONE_TAGS.includes(r.tone) ? r.tone : 'quiet_grief',
    topicTag: TOPIC_TAGS.includes(r.topic) ? r.topic : 'other',
    generationTag: GENERATION_TAGS.includes(r.generation) ? r.generation as GenerationTag : 'all',
    fitReason: String(r.reason ?? ''),
  }))
}

// ── Checker 2 — topic cooldown ────────────────────────────────────────────
function isTopicOnCooldown(topicTag: TopicTag): boolean {
  const cooldownMs = COOLDOWN_DAYS[topicTag] * 24 * 3600 * 1000
  const cutoff = new Date(Date.now() - cooldownMs).toISOString()
  const entries = listAll()
  return entries.some(e => (e as any).topicTag === topicTag && e.postedAt >= cutoff)
}

// ── Checker 3 — tone frequency ────────────────────────────────────────────
function getToneFrequencyLast30Days(): Record<string, number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const entries = listAll()
  const counts: Record<string, number> = {}
  for (const e of entries) {
    if (e.postedAt >= cutoff && (e as any).toneTag) {
      const t = (e as any).toneTag
      counts[t] = (counts[t] ?? 0) + 1
    }
  }
  return counts
}

// ── Surface pull (every 4 hours) ──────────────────────────────────────────
export async function runSurfacePull(): Promise<{ added: number; discarded: number; held: number }> {
  const signals = loadSignals()
  let added = 0, discarded = 0, held = 0

  // Collect from all surface sources
  const texts: Array<{ text: string; source: SignalSource }> = []
  const now = new Date().toISOString()

  try {
    const trends = await fetchGoogleTrendsPH()
    trends.forEach(t => texts.push({ text: t, source: 'google_trends' }))
  } catch (e: any) { console.warn('[Signals] Google Trends fetch failed:', e.message) }

  try {
    const news = await fetchNewsRSS()
    news.forEach(t => texts.push({ text: t, source: 'news_rss' }))
  } catch (e: any) { console.warn('[Signals] News RSS fetch failed:', e.message) }

  const ytKey = process.env.YOUTUBE_API_KEY
  if (ytKey) {
    try {
      const ytTitles = await fetchYouTubeTitles()
      ytTitles.forEach(t => texts.push({ text: t, source: 'youtube' }))
    } catch (e: any) { console.warn('[Signals] YouTube titles fetch failed:', e.message) }
  }

  const redditCreds = process.env.REDDIT_CLIENT_ID
  if (redditCreds) {
    try {
      const reddit = await fetchRedditSurface()
      reddit.forEach(t => texts.push({ text: t, source: 'reddit_surface' }))
    } catch (e: any) { console.warn('[Signals] Reddit surface fetch failed:', e.message) }
  }

  // ── Backfill generationTag on existing signals that predate the field ────
  const needsGenTag = signals.filter(s =>
    s.source !== 'ph_calendar' &&
    (s.status === 'approved' || s.status === 'held') &&
    !s.generationTag
  )
  if (needsGenTag.length > 0) {
    try {
      const results = await scoreSignalsBatch(needsGenTag)
      for (const r of results) {
        const sig = signals.find(s => s.id === r.id)
        if (sig) sig.generationTag = r.generationTag
      }
      console.log(`[Signals] Backfilled generationTag on ${needsGenTag.length} signal(s)`)
    } catch { /* non-fatal — tag will be filled next pull */ }
  }

  // ── Inject upcoming PH holidays as pre-approved signals ─────────────────
  const upcomingHolidays = getUpcomingHolidays()
  const upcomingKeys = new Set(upcomingHolidays.map(h => h.key))

  // Remove ph_calendar signals no longer in the upcoming window
  for (let i = signals.length - 1; i >= 0; i--) {
    if (signals[i].source === 'ph_calendar' && !upcomingKeys.has(signals[i].id)) {
      signals.splice(i, 1)
    }
  }

  // Add new upcoming holidays not yet in store
  for (const h of upcomingHolidays) {
    if (signals.some(s => s.id === h.key)) continue
    const days = daysUntil(h)
    signals.push({
      id: h.key,
      text: `[PH Holiday in ${days}d] ${h.name}: ${h.copyHint}`,
      source: 'ph_calendar',
      cadence: 'surface',
      fetchedAt: now,
      fitScore: 9,
      toneTag: h.toneTag as ToneTag,
      topicTag: h.topicTag as TopicTag,
      generationTag: h.generationTag as GenerationTag,
      fitReason: `PH holiday in ${days} day${days === 1 ? '' : 's'} — ${h.signal}`,
      status: 'approved',
    })
    added++
    console.log(`[Signals] Calendar: added "${h.name}" (${days}d away)`)
  }

  // ── Dedup + hard stop filter ──────────────────────────────────────────
  const toScore: Signal[] = []
  for (const { text, source } of texts) {
    if (!text.trim()) continue
    const id = md5Id(source, text)
    if (isDuplicate(signals, id)) continue

    const hardStop = isHardStop(text)
    if (hardStop) {
      signals.push({ id, text, source, cadence: 'surface', fetchedAt: now, status: 'discarded', discardReason: hardStop })
      discarded++
      continue
    }

    const sig: Signal = { id, text, source, cadence: 'surface', fetchedAt: now, status: 'pending' }
    signals.push(sig)
    toScore.push(sig)
  }

  // Batch score new signals
  if (toScore.length > 0) {
    const BATCH = 20
    for (let i = 0; i < toScore.length; i += BATCH) {
      const batch = toScore.slice(i, i + BATCH)
      try {
        const results = await scoreSignalsBatch(batch)
        for (const r of results) {
          const sig = signals.find(s => s.id === r.id)
          if (!sig) continue
          sig.fitScore = r.fitScore
          sig.toneTag = r.toneTag
          sig.topicTag = r.topicTag
          sig.generationTag = r.generationTag
          sig.fitReason = r.fitReason
          if (sig.topicTag === 'current_news' && r.fitScore < 6) {
            sig.status = 'discarded'
            sig.discardReason = `trending noise: current_news, score ${r.fitScore} < 6`
            discarded++
          } else if (r.fitScore >= 7) {
            sig.status = 'approved'; added++
          } else if (r.fitScore >= 4) {
            sig.status = 'held'
            sig.heldUntil = new Date(Date.now() + 48 * 3600 * 1000).toISOString()
            held++
          } else {
            sig.status = 'discarded'
            sig.discardReason = `low fit score: ${r.fitScore} — ${r.fitReason}`
            discarded++
          }
        }
      } catch (e: any) { console.warn('[Signals] Batch score failed:', e.message) }
    }
  }

  // Re-score held signals whose hold period has expired
  const expiredHeld = signals.filter(s => s.status === 'held' && s.heldUntil && s.heldUntil <= new Date().toISOString())
  if (expiredHeld.length > 0) {
    try {
      const results = await scoreSignalsBatch(expiredHeld)
      for (const r of results) {
        const sig = signals.find(s => s.id === r.id)
        if (!sig) continue
        sig.fitScore = r.fitScore
        sig.toneTag = r.toneTag
        sig.topicTag = r.topicTag
        sig.generationTag = r.generationTag
        sig.fitReason = r.fitReason
        sig.heldUntil = undefined
        if (r.fitScore >= 7) { sig.status = 'approved'; added++ }
        else { sig.status = 'discarded'; sig.discardReason = `still low after re-score: ${r.fitScore}` }
      }
    } catch { /* re-score failed — leave held */ }
  }

  // Prune signals older than 7 days (keep discarded for 48h dedup, approved forever)
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const cutoff48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const pruned = signals.filter(s => {
    if (s.status === 'approved' || s.status === 'held') return true
    if (s.status === 'discarded') return s.fetchedAt >= cutoff48h
    return s.fetchedAt >= cutoff7d
  })

  saveSignals(pruned)
  console.log(`[Signals] Surface pull — +${added} approved, ${held} held, ${discarded} discarded`)
  return { added, discarded, held }
}

// ── Deep pull (monthly) ───────────────────────────────────────────────────
export async function runDeepPull(): Promise<ToneMap> {
  const texts: string[] = []

  const redditCreds = process.env.REDDIT_CLIENT_ID
  if (redditCreds) {
    try { texts.push(...await fetchRedditDeep()) }
    catch (e: any) { console.warn('[Signals] Reddit deep fetch failed:', e.message) }
  }

  const ytKey = process.env.YOUTUBE_API_KEY
  if (ytKey) {
    try { texts.push(...await fetchYouTubeComments()) }
    catch (e: any) { console.warn('[Signals] YouTube fetch failed:', e.message) }
  }

  if (texts.length === 0) throw new Error('No deep signal texts collected — check Reddit and YouTube credentials')

  // Sample up to 200 texts to keep prompt manageable
  const sample = texts.sort(() => Math.random() - 0.5).slice(0, 200)
  const month = new Date().toISOString().slice(0, 7)

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You analyze Filipino social media texts for Renaissance Park & Chapels to identify dominant emotional tones.

Tone tags available: quiet_grief, generational_pride, aging_softness, ofw_longing, parental_sacrifice, hopeful_legacy

Analyze recurring emotional language patterns across ALL texts. Identify which tones dominate this month's content.
Weight: 1=minor presence, 2=moderate, 3=strongly dominant.

Respond ONLY with JSON:
{
  "summary": "2-3 sentence overview of this month's dominant Filipino emotional landscape",
  "tones": [
    {"tag":"quiet_grief","weight":3,"description":"one sentence why this tone dominates"},
    ...
  ]
}`,
    messages: [{
      role: 'user',
      content: `Analyze these ${sample.length} texts from Filipino social media this month:\n\n${sample.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    }],
  })

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
  const stripped = raw.replace(/```json|```/g, '').trim()
  let parsed: any = {}
  try { parsed = JSON.parse(stripped) } catch { parsed = { summary: raw, tones: [] } }

  const toneMap: ToneMap = {
    month,
    entries: (parsed.tones ?? []).map((t: any) => ({
      tag: TONE_TAGS.includes(t.tag) ? t.tag : 'quiet_grief',
      description: t.description ?? '',
      weight: Math.max(1, Math.min(3, Number(t.weight) || 1)),
    })),
    rawSummary: parsed.summary ?? '',
    generatedAt: new Date().toISOString(),
  }

  saveToneMap(toneMap)
  console.log(`[Signals] Deep pull complete — tone map for ${month} with ${toneMap.entries.length} tones`)
  return toneMap
}

// ── Get qualified signals for content generation ──────────────────────────
// Returns approved signals, filtered by Checkers 2 & 3, sorted by score desc
export function getQualifiedSignals(limit = 5): Signal[] {
  const signals = loadSignals()
  const toneFreq = getToneFrequencyLast30Days()

  return signals
    .filter(s => s.status === 'approved' && s.fitScore && s.fitScore >= 7)
    .filter(s => s.source === 'ph_calendar' || !s.topicTag || !isTopicOnCooldown(s.topicTag))
    .filter(s => s.source === 'ph_calendar' || !s.toneTag || (toneFreq[s.toneTag] ?? 0) < 2)
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, limit)
}

// ── Discord display helpers ───────────────────────────────────────────────
const GENERATION_EMOJI: Record<GenerationTag, string> = {
  boomer:     '🧓 Boomer',
  millennial: '👨‍👩‍👧 Millennial',
  genz:       '⚡ Gen Z',
  all:        '👥 All',
}

const SOURCE_LABEL: Record<SignalSource, string> = {
  google_trends:  '📈 Google Trends',
  news_rss:       '📰 News RSS',
  reddit_surface: '🤙 Reddit',
  reddit_deep:    '🔍 Reddit Deep',
  youtube:        '▶️ YouTube',
  ph_calendar:    '📅 PH Calendar',
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3600000)
  const diffM = Math.floor(diffMs / 60000)
  if (diffH >= 24) return `${Math.floor(diffH / 24)}d ago`
  if (diffH >= 1) return `${diffH}h ago`
  return `${diffM}m ago`
}

export function formatSignalsForDiscord(): string {
  const signals = loadSignals()
  const toneMap = loadToneMap()
  const toneFreq = getToneFrequencyLast30Days()

  const approved = signals.filter(s => s.status === 'approved').sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
  const held     = signals.filter(s => s.status === 'held').sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
  const discarded = signals.filter(s => s.status === 'discarded' && s.fetchedAt >= new Date(Date.now() - 24 * 3600 * 1000).toISOString())

  const scoreBar = (n: number) => n >= 7 ? '🟢' : n >= 4 ? '🟡' : '🔴'

  const rows: string[] = []

  if (approved.length === 0 && held.length === 0) {
    rows.push('_No signals yet — run `signals refresh` to pull from sources._')
  }

  if (approved.length > 0) {
    rows.push('**✅ Approved signals** _(score ≥ 7, cleared all checkers)_')
    for (const s of approved.slice(0, 8)) {
      const cooldown = s.topicTag && isTopicOnCooldown(s.topicTag) ? ' ⏸️ topic cooling' : ''
      const toneBlock = s.toneTag && (toneFreq[s.toneTag] ?? 0) >= 2 ? ' ⚠️ tone at limit' : ''
      const src = SOURCE_LABEL[s.source] ?? s.source
      const age = relativeTime(s.fetchedAt)
      const gen = s.generationTag ? GENERATION_EMOJI[s.generationTag] : ''
      rows.push(
        `${scoreBar(s.fitScore ?? 0)} **[${s.fitScore}/9]** ${s.text.slice(0, 90)}${s.text.length > 90 ? '…' : ''}` +
        `\n  ↳ ${src} · _${age}_ · ${gen} · tone: **${s.toneTag?.replace(/_/g, ' ')}** · topic: **${s.topicTag?.replace(/_/g, ' ')}**${cooldown}${toneBlock}` +
        (s.fitReason ? `\n  ↳ _"${s.fitReason.slice(0, 120)}"_` : '')
      )
    }
  }

  if (held.length > 0) {
    rows.push(`\n**🕐 Held (${held.length})** _(score 4–6, re-scoring in 48h)_`)
    for (const s of held.slice(0, 8)) {
      const eta = s.heldUntil ? `re-score ${new Date(s.heldUntil).toLocaleDateString()}` : ''
      const src = SOURCE_LABEL[s.source] ?? s.source
      const age = relativeTime(s.fetchedAt)
      const gen = s.generationTag ? GENERATION_EMOJI[s.generationTag] : ''
      rows.push(
        `🟡 **[${s.fitScore}/9]** ${s.text.slice(0, 80)}${s.text.length > 80 ? '…' : ''}` +
        `\n  ↳ ${src} · _${age}_ · ${gen} · ${eta}` +
        (s.fitReason ? `\n  ↳ _"${s.fitReason.slice(0, 100)}"_` : '')
      )
    }
  }

  if (discarded.length > 0) {
    rows.push(`\n**❌ Discarded today (${discarded.length})** _(hard stops + low fit)_`)
    for (const s of discarded.slice(0, 6)) {
      const src = SOURCE_LABEL[s.source] ?? s.source
      rows.push(
        `🔴 ${s.text.slice(0, 70)}${s.text.length > 70 ? '…' : ''}` +
        `\n  ↳ ${src} · _${s.discardReason?.slice(0, 100)}_`
      )
    }
  }

  if (toneMap) {
    const month = toneMap.month
    const dominant = [...toneMap.entries].sort((a, b) => b.weight - a.weight).slice(0, 3)
    rows.push(`\n**🎭 Active tone map** _(${month})_\n${toneMap.rawSummary}`)
    for (const t of dominant) {
      const bar = '█'.repeat(t.weight) + '░'.repeat(3 - t.weight)
      rows.push(`${bar} **${t.tag.replace(/_/g, ' ')}** — ${t.description}`)
    }
  }

  return rows.join('\n')
}
