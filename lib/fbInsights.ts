import https from 'https'
import { listAll, removeEntry } from './coverageStore'

export interface PostInsights {
  postId: string
  reach: number
  impressions: number
  reactions: number
  shares: number
  clicks: number
  score: number
}

export interface CategoryInsights {
  templateKey: string
  label: string
  postCount: number
  measuredCount: number  // entries that had a photoId and API returned data
  noPhotoId: number      // entries without a stored photo ID
  apiFailed: number      // entries with a photo ID but API returned null
  avgReach: number
  avgReactions: number
  avgShares: number
  avgClicks: number
  avgScore: number
  lastPosted: string
  trend: 'top' | 'mid' | 'low'
}

function graphGet(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path: urlPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch { reject(new Error('Facebook API non-JSON response')) }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

export interface BoostCampaignInsights {
  campaignId: string
  campaignName: string
  campaignStatus: string
  adStatus: string      // effective_status of the actual ad inside — may differ from campaign
  dailyBudgetPHP: number
  lifetimeBudgetPHP: number
  spend: number
  reach: number
  impressions: number
  cpm: number
  ctr: number
  clicks: number
  // Messenger objective metrics — the real win condition for OUTCOME_ENGAGEMENT
  // boosts. messagingConversations = total people who started a chat from the ad.
  messagingConversations: number
  costPerMessage: number  // spend / messagingConversations (0 if no messages)
  createdTime: string
  postPhotoId: string
  // Joined from coverage store — the ad category label and concept summary
  // (so the OVERVIEW tab can show "Light Emotional" instead of just a post ID).
  templateKey?: string
  label?: string
  concept?: string
}

export type DateRange = '1d' | '7d' | '30d' | 'all'

function dateRangeToParam(range: DateRange | string): { useTimeRange: boolean; since?: string; until?: string } {
  if (range === 'all') return { useTimeRange: false }
  const days = range === '1d' ? 1 : range === '30d' ? 30 : 7
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const until = new Date().toISOString().slice(0, 10)
  return { useTimeRange: true, since, until }
}

export async function fetchBoostCampaignInsights(range: DateRange | string = '7d'): Promise<BoostCampaignInsights[]> {
  const adAccountId = process.env.FB_AD_ACCOUNT_ID
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
  if (!adAccountId || !accessToken) throw new Error('FB_AD_ACCOUNT_ID or FACEBOOK_ACCESS_TOKEN not set')

  const tok = encodeURIComponent(accessToken)

  // 1. All campaigns in the ad account
  const campaignRes = await graphGet(
    `/v21.0/${adAccountId}/campaigns?fields=id,name,effective_status,created_time,daily_budget,lifetime_budget&limit=50&access_token=${tok}`
  )
  if (campaignRes.error) throw new Error(`FB Campaigns: ${campaignRes.error.message}`)

  const campaigns: any[] = campaignRes.data ?? []
  if (campaigns.length === 0) return []

  const campaignIds = campaigns.map((c: any) => c.id as string)
  const campaignMap = new Map(campaigns.map((c: any) => [c.id as string, c]))

  // 2. Fetch all ads for these campaigns in one account-level call
  const adFilter = encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]))
  const adsRes = await graphGet(
    `/v21.0/${adAccountId}/ads?fields=campaign_id,effective_status,creative{object_story_id}&filtering=${adFilter}&limit=100&access_token=${tok}`
  )
  // Map campaignId → first ad found
  const adsByCampaign = new Map<string, { status: string; photoId: string }>()
  if (!adsRes.error) {
    for (const ad of (adsRes.data ?? []) as any[]) {
      const cid: string = ad.campaign_id
      if (!adsByCampaign.has(cid)) {
        const storyId: string = ad.creative?.object_story_id ?? ''
        adsByCampaign.set(cid, {
          status: ad.effective_status ?? 'UNKNOWN',
          photoId: storyId.includes('_') ? storyId.split('_')[1] : storyId,
        })
      }
    }
  }

  // 3. Adsets for budget — one account-level call. Boosted posts usually use
  // lifetime_budget (you pick total spend × duration), not daily_budget. Fetch
  // both and prefer adset-level over campaign-level (CBO) values.
  const adsetFilter = encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]))
  const adsetsRes = await graphGet(
    `/v21.0/${adAccountId}/adsets?fields=campaign_id,daily_budget,lifetime_budget&filtering=${adsetFilter}&limit=100&access_token=${tok}`
  )
  const dailyByCampaign = new Map<string, number>()
  const lifetimeByCampaign = new Map<string, number>()
  if (!adsetsRes.error) {
    for (const adset of (adsetsRes.data ?? []) as any[]) {
      if (adset.daily_budget) dailyByCampaign.set(adset.campaign_id, parseInt(adset.daily_budget, 10) / 100)
      if (adset.lifetime_budget) lifetimeByCampaign.set(adset.campaign_id, parseInt(adset.lifetime_budget, 10) / 100)
    }
  }
  // Fall back to campaign-level CBO budgets when adsets don't carry them
  for (const c of campaigns) {
    if (c.daily_budget && !dailyByCampaign.has(c.id)) {
      dailyByCampaign.set(c.id, parseInt(c.daily_budget, 10) / 100)
    }
    if (c.lifetime_budget && !lifetimeByCampaign.has(c.id)) {
      lifetimeByCampaign.set(c.id, parseInt(c.lifetime_budget, 10) / 100)
    }
  }

  // 4. Insights — one account-level call with campaign breakdown.
  // Request `actions` + `cost_per_action_type` to capture Messenger conversation
  // metrics, which are the real KPI for OUTCOME_ENGAGEMENT ads with MESSAGE_PAGE CTA.
  const rangeParam = dateRangeToParam(range)
  const insightFilter = encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]))
  const timeOrPreset = rangeParam.useTimeRange
    ? `time_range=${encodeURIComponent(JSON.stringify({ since: rangeParam.since, until: rangeParam.until }))}`
    : `date_preset=maximum`
  const insightsRes = await graphGet(
    `/v21.0/${adAccountId}/insights?fields=campaign_id,spend,reach,impressions,cpm,ctr,clicks,actions,cost_per_action_type&${timeOrPreset}&level=campaign&filtering=${insightFilter}&limit=50&access_token=${tok}`
  )
  const insightsByCampaign = new Map<string, any>()
  if (!insightsRes.error) {
    for (const row of (insightsRes.data ?? []) as any[]) {
      insightsByCampaign.set(row.campaign_id, row)
    }
  }

  // Facebook action_type for Messenger conversations. The primary metric is
  // `messaging_user_depth_3_message_send` — counts users who sent 3+ messages
  // (real conversation depth, not just one tap that opened Messenger). We fall
  // back to weaker signals only if the primary isn't reported.
  const PRIMARY_MESSAGING_ACTION = 'onsite_conversion.messaging_user_depth_3_message_send'
  const FALLBACK_MESSAGING_ACTIONS = new Set([
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_first_reply',
    'onsite_conversion.total_messaging_connection',
  ])

  function extractMessages(ins: any): { count: number; cpa: number } {
    if (!ins) return { count: 0, cpa: 0 }
    const actions: Array<{ action_type: string; value: string }> = ins.actions ?? []
    const costs:   Array<{ action_type: string; value: string }> = ins.cost_per_action_type ?? []
    const primary = actions.find(a => a.action_type === PRIMARY_MESSAGING_ACTION)
    let count = primary ? parseFloat(primary.value) : 0
    if (count === 0) {
      for (const a of actions) {
        if (FALLBACK_MESSAGING_ACTIONS.has(a.action_type)) { count = parseFloat(a.value); break }
      }
    }
    const primaryCost = costs.find(c => c.action_type === PRIMARY_MESSAGING_ACTION)
    let cpa = primaryCost ? parseFloat(primaryCost.value) : 0
    if (cpa === 0) {
      for (const c of costs) {
        if (FALLBACK_MESSAGING_ACTIONS.has(c.action_type)) { cpa = parseFloat(c.value); break }
      }
    }
    return { count, cpa }
  }

  // Build photoId → coverage entry lookup so we can tag campaigns with their
  // ad category for display. Match on either fbPhotoId or the post-id portion
  // of fbPostId (covers entries patched after publish).
  const coverageByPhoto = new Map<string, { templateKey: string; label: string; concept?: string }>()
  for (const e of listAll()) {
    const tag = { templateKey: e.templateKey, label: e.label, concept: e.concept }
    if (e.fbPhotoId) coverageByPhoto.set(e.fbPhotoId, tag)
    if (e.fbPostId) {
      const suffix = e.fbPostId.includes('_') ? e.fbPostId.split('_')[1] : e.fbPostId
      if (suffix && !coverageByPhoto.has(suffix)) coverageByPhoto.set(suffix, tag)
    }
  }

  const results: BoostCampaignInsights[] = campaigns.map((c: any) => {
    const cid: string = c.id
    const ad = adsByCampaign.get(cid)
    const ins = insightsByCampaign.get(cid)
    const { count: messagingConversations, cpa: costPerMessage } = extractMessages(ins)
    const photoId = ad?.photoId ?? ''
    const cov = photoId ? coverageByPhoto.get(photoId) : undefined

    return {
      campaignId: cid,
      campaignName: c.name,
      campaignStatus: c.effective_status ?? 'UNKNOWN',
      adStatus: ad?.status ?? 'NO_AD',
      dailyBudgetPHP: dailyByCampaign.get(cid) ?? 0,
      lifetimeBudgetPHP: lifetimeByCampaign.get(cid) ?? 0,
      spend:       parseFloat(ins?.spend ?? '0'),
      reach:       parseInt(ins?.reach ?? '0', 10),
      impressions: parseInt(ins?.impressions ?? '0', 10),
      cpm:         parseFloat(ins?.cpm ?? '0'),
      ctr:         parseFloat(ins?.ctr ?? '0'),
      clicks:      parseInt(ins?.clicks ?? '0', 10),
      messagingConversations,
      costPerMessage,
      createdTime: c.created_time ?? '',
      postPhotoId: photoId,
      templateKey: cov?.templateKey,
      label: cov?.label,
      concept: cov?.concept,
    }
  })

  results.sort((a, b) => b.createdTime.localeCompare(a.createdTime))
  return results
}

export function formatBoostInsightsTable(items: BoostCampaignInsights[]): string {
  if (items.length === 0) return '📊 No boosted campaigns found in this ad account.'

  const adStatusIcon = (s: string) => {
    if (s === 'ACTIVE') return '🟢'
    if (s === 'PAUSED' || s === 'CAMPAIGN_PAUSED' || s === 'ADSET_PAUSED') return '⏸️'
    if (s === 'PENDING_REVIEW') return '🕐'
    if (s === 'DISAPPROVED') return '❌'
    if (s === 'WITH_ISSUES') return '⚠️'
    if (s === 'DELETED') return '🗑️'
    return '⚪'
  }

  const rows = items.map((item, i) => {
    const hasData = item.impressions > 0
    const budgetStr = item.dailyBudgetPHP > 0
      ? `₱${item.dailyBudgetPHP.toFixed(0)}/day`
      : item.lifetimeBudgetPHP > 0
        ? `₱${item.lifetimeBudgetPHP.toFixed(0)} total`
        : '—'
    const spendStr = `₱${item.spend.toFixed(2)}`
    const postRef = item.postPhotoId ? ` · post \`${item.postPhotoId}\`` : ''
    const date = item.createdTime ? item.createdTime.slice(0, 10) : item.campaignName

    // Show ad status — this is what actually matters for delivery
    const adSt = item.adStatus
    const statusLine = adSt !== item.campaignStatus
      ? `campaign: ${item.campaignStatus} · ad: ${adStatusIcon(adSt)} **${adSt}**`
      : `${adStatusIcon(adSt)} ${adSt}`

    let metricsLine: string
    if (hasData) {
      const msgPart = item.messagingConversations > 0
        ? `**${item.messagingConversations} msg** @ ₱${item.costPerMessage.toFixed(2)}/msg · `
        : ''
      metricsLine = `   ${msgPart}reach: ${item.reach.toLocaleString()} · CPM: ₱${item.cpm.toFixed(2)} · CTR: ${item.ctr.toFixed(2)}% · clicks: ${item.clicks.toLocaleString()}`
    } else if (adSt === 'UNKNOWN' || adSt === 'NO_AD') {
      metricsLine = `   🚫 No ad found — boost creation failed (empty campaign shell, not spending)`
    } else if (adSt === 'PENDING_REVIEW') {
      metricsLine = `   🕐 Ad is under review — no spend until approved`
    } else if (adSt === 'DISAPPROVED') {
      metricsLine = `   ❌ Ad was disapproved — check Ads Manager for reason`
    } else if (adSt === 'WITH_ISSUES') {
      metricsLine = `   ⚠️ Ad has issues — check Ads Manager`
    } else if (adSt === 'ACTIVE') {
      metricsLine = `   ⏳ No spend yet — check payment method or ad account billing`
    } else {
      metricsLine = `   ⏸️ Not delivering`
    }

    return (
      `**${i + 1}. ${date}**${postRef} — ${statusLine}\n` +
      `   budget: ${budgetStr} · spent: ${spendStr}\n` +
      metricsLine
    )
  })

  // Summarise delivery issues
  const disapproved   = items.filter(i => i.adStatus === 'DISAPPROVED').length
  const withIssues    = items.filter(i => i.adStatus === 'WITH_ISSUES').length
  const inReview      = items.filter(i => i.adStatus === 'PENDING_REVIEW').length
  const emptyShells   = items.filter(i => i.adStatus === 'UNKNOWN' || i.adStatus === 'NO_AD').length
  const activeNoSpend = items.filter(i => i.adStatus === 'ACTIVE' && i.spend === 0).length

  const warnings: string[] = []
  if (emptyShells > 0)   warnings.push(`${emptyShells} empty shells — boost creation failed before the token was fixed, not spending anything`)
  if (disapproved > 0)   warnings.push(`${disapproved} disapproved — open Ads Manager to see why`)
  if (withIssues > 0)    warnings.push(`${withIssues} have issues — check Ads Manager`)
  if (inReview > 0)      warnings.push(`${inReview} under review`)
  if (activeNoSpend > 0) warnings.push(`${activeNoSpend} ACTIVE with ₱0 spend — verify payment method at facebook.com/ads/manager`)

  const footer = warnings.length > 0
    ? `\n\n⚠️ **Delivery issues:**\n` + warnings.map(w => `- ${w}`).join('\n')
    : ''

  return (
    `**📈 Ad Campaign Analytics** — ${items.length} campaign${items.length !== 1 ? 's' : ''}\n\n` +
    rows.join('\n\n') +
    footer
  )
}

const DELETED_SENTINEL = 'DELETED' as const
type InsightsResult = PostInsights | typeof DELETED_SENTINEL | null

function isDeletedError(err: { message?: string; code?: number }): boolean {
  return err.code === 100 && (err.message ?? '').toLowerCase().includes('does not exist')
}

// Fetch engagement metrics for a feed post using its actual post ID (e.g. "527444473995015_1371009688382567").
// Returns 'DELETED' when FB confirms the post no longer exists — caller should remove the store entry.
export async function fetchPostInsights(feedPostId: string): Promise<InsightsResult> {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
  if (!accessToken) return null

  const tok = encodeURIComponent(accessToken)

  // Always fetch reactions via the reactions edge — reliable across all API versions
  let reactions = 0
  let shares = 0
  let isDeleted = false
  try {
    const rr = await graphGet(`/v20.0/${feedPostId}/reactions?limit=0&summary=true&access_token=${tok}`)
    if (rr.error) {
      if (isDeletedError(rr.error)) { isDeleted = true }
    } else {
      reactions = (rr.summary?.total_count as number) ?? 0
    }
  } catch { /* network error — continue */ }

  if (isDeleted) {
    console.log(`[Insights] ${feedPostId} — post deleted, removing`)
    return DELETED_SENTINEL
  }

  try {
    const sr = await graphGet(`/v20.0/${feedPostId}?fields=shares&access_token=${tok}`)
    if (!sr.error) shares = (sr.shares?.count as number) ?? 0
  } catch { /* shares optional */ }

  // Attempt reach + impressions + clicks from /insights (v20 deprecated post_reactions_by_type_total,
  // so we request only the metrics that are still valid)
  let reach = 0, impressions = 0, clicks = 0
  try {
    const metrics = 'post_impressions_unique,post_impressions,post_clicks'
    const result = await graphGet(`/v20.0/${feedPostId}/insights?metric=${metrics}&access_token=${tok}`)
    if (!result.error && result.data) {
      const data: any[] = result.data
      const get = (name: string): number => {
        const entry = data.find((d: any) => d.name === name)
        const val = entry?.values?.[0]?.value
        if (val == null) return 0
        return typeof val === 'object'
          ? Object.values(val as Record<string, number>).reduce((s, n) => s + n, 0)
          : (val as number)
      }
      reach       = get('post_impressions_unique')
      impressions = get('post_impressions')
      clicks      = get('post_clicks')
    }
  } catch { /* insights unavailable — score from reactions/shares only */ }

  const score = reach + reactions * 5 + clicks * 3 + shares * 10 + (reach > 0 ? (reactions / reach) * 500 : 0)
  console.log(`[Insights] ${feedPostId} — reach:${reach} reactions:${reactions} shares:${shares} clicks:${clicks} score:${score.toFixed(0)}`)
  return { postId: feedPostId, reach, impressions, reactions, shares, clicks, score }
}

export async function fetchCategoryInsights(): Promise<CategoryInsights[]> {
  const entries = listAll()
  if (entries.length === 0) return []

  type Group = {
    label: string
    insights: PostInsights[]
    noPhotoId: number
    apiFailed: number
    lastPosted: string
    totalPosts: number
  }
  const grouped = new Map<string, Group>()

  for (const entry of entries) {
    if (!grouped.has(entry.templateKey)) {
      grouped.set(entry.templateKey, { label: entry.label, insights: [], noPhotoId: 0, apiFailed: 0, lastPosted: entry.postedAt, totalPosts: 0 })
    }
    const g = grouped.get(entry.templateKey)!
    g.totalPosts++
    if (entry.postedAt > g.lastPosted) g.lastPosted = entry.postedAt
    if (!entry.fbPostId) g.noPhotoId++
  }

  const toFetch = entries.filter(e => e.fbPostId)
  const results_raw = await Promise.all(toFetch.map(e => fetchPostInsights(e.fbPostId!)))

  const toRemove: Array<{ templateKey: string; postedAt: string }> = []
  for (let i = 0; i < toFetch.length; i++) {
    const entry = toFetch[i]
    const ins = results_raw[i]
    const g = grouped.get(entry.templateKey)!
    if (ins === DELETED_SENTINEL) {
      toRemove.push({ templateKey: entry.templateKey, postedAt: entry.postedAt })
      console.log(`[Insights] Removed deleted entry: ${entry.templateKey} posted ${entry.postedAt}`)
    } else if (ins) {
      g.insights.push(ins)
    } else {
      g.apiFailed++
    }
  }
  for (const { templateKey, postedAt } of toRemove) removeEntry(templateKey, postedAt)

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, n) => s + n, 0) / arr.length : 0

  const results: CategoryInsights[] = []
  for (const [templateKey, g] of grouped) {
    const measuredCount = g.insights.length
    results.push({
      templateKey,
      label: g.label,
      postCount: g.totalPosts,
      measuredCount,
      noPhotoId: g.noPhotoId,
      apiFailed: g.apiFailed,
      avgReach:     avg(g.insights.map(i => i.reach)),
      avgReactions: avg(g.insights.map(i => i.reactions)),
      avgShares:    avg(g.insights.map(i => i.shares)),
      avgClicks:    avg(g.insights.map(i => i.clicks)),
      avgScore:     avg(g.insights.map(i => i.score)),
      lastPosted: g.lastPosted,
      trend: 'mid',
    })
  }

  results.sort((a, b) => {
    if (a.measuredCount === 0 && b.measuredCount === 0) return 0
    if (a.measuredCount === 0) return 1
    if (b.measuredCount === 0) return -1
    return b.avgScore - a.avgScore
  })

  const measured = results.filter(r => r.measuredCount > 0)
  const topCut = Math.ceil(measured.length * 0.34)
  const botCut = Math.floor(measured.length * 0.67)
  results.forEach((r, i) => {
    if (r.measuredCount === 0) { r.trend = 'mid'; return }
    const rank = measured.indexOf(r)
    r.trend = rank < topCut ? 'top' : rank >= botCut ? 'low' : 'mid'
  })

  return results
}

// Short text block for injecting into Claude generation prompts
export function formatInsightsForClaude(insights: CategoryInsights[]): string {
  const measured = insights.filter(r => r.measuredCount > 0)
  if (measured.length === 0) return ''
  const lines = measured.map(r =>
    `- ${r.label} (${r.templateKey}): avg_score=${r.avgScore.toFixed(0)}, avg_reach=${r.avgReach.toFixed(0)}, avg_reactions=${r.avgReactions.toFixed(1)}, posts=${r.postCount}, trend=${r.trend}`
  )
  return (
    `Recent Facebook performance by ad category (higher score = better audience engagement):\n` +
    lines.join('\n') + '\n' +
    `Use "top" trend categories more often. Avoid repeating "low" trend categories unless coverage demands it.`
  )
}

// Formatted table for Discord display
export function formatInsightsTable(insights: CategoryInsights[]): string {
  if (insights.length === 0) {
    return '📊 No performance data yet — post some ads first.'
  }

  const trendLabel = { top: '🔥 Top', mid: '➡️ Mid', low: '📉 Low' }

  // Helper: show value if measured, '—' if not
  const fmt = (val: number, measuredCount: number, decimals = 0) =>
    measuredCount > 0 ? val.toFixed(decimals) : '—'

  const rows = insights.map((r, i) => {
    const tier  = r.measuredCount > 0 ? trendLabel[r.trend] : '❔ No data'
    const days  = Math.floor((Date.now() - new Date(r.lastPosted).getTime()) / 86_400_000)
    const age   = days === 0 ? 'today' : `${days}d ago`

    let noDataNote = ''
    if (r.measuredCount === 0) {
      if (r.noPhotoId > 0 && r.apiFailed === 0) {
        noDataNote = ` ⚠️ no post IDs — re-run \`coverage scan\` after posts publish to get engagement data`
      } else if (r.apiFailed > 0 && r.noPhotoId === 0) {
        noDataNote = ` ⚠️ FB API error — check server console`
      } else if (r.noPhotoId > 0 && r.apiFailed > 0) {
        noDataNote = ` ⚠️ ${r.noPhotoId} missing IDs · ${r.apiFailed} API errors`
      }
    }

    return (
      `**${i + 1}. ${r.label}** ${tier}\n` +
      `   score: ${fmt(r.avgScore, r.measuredCount)} · reach: ${fmt(r.avgReach, r.measuredCount)} · ` +
      `reactions: ${fmt(r.avgReactions, r.measuredCount, 1)} · shares: ${fmt(r.avgShares, r.measuredCount, 1)} · ` +
      `clicks: ${fmt(r.avgClicks, r.measuredCount)}\n` +
      `   ${r.postCount} post${r.postCount !== 1 ? 's' : ''} · last: ${age}${noDataNote}`
    )
  })

  const unmeasuredTotal = insights.filter(r => r.measuredCount === 0).length
  const footer = unmeasuredTotal > 0
    ? `\n_${unmeasuredTotal} categor${unmeasuredTotal > 1 ? 'ies' : 'y'} have no engagement data — FB photo IDs are needed to pull metrics._`
    : ''

  return (
    `**📊 Ad Category Performance** — sorted by engagement score\n` +
    `_(🔥 top · ➡️ mid · 📉 low · ❔ not measured)_\n\n` +
    rows.join('\n\n') +
    footer
  )
}

// ── Boost scaler ──────────────────────────────────────────────────────────
// Analyzes boosted ad performance to identify winners (replicate) vs losers (avoid).

export interface BoostPerformance {
  campaignId: string
  postPhotoId: string
  spend: number
  reach: number
  clicks: number
  cpm: number
  ctr: number
  costPerClick: number
  messagingConversations: number
  costPerMessage: number    // 0 if no messages yet
  score: number             // 0–9 composite, weighted on cost-per-message
  tier: 'winner' | 'mid' | 'loser' | 'ramping'
  templateKey?: string      // matched from coverage store
  label?: string            // ad category label
  concept?: string          // one-line concept summary
  createdTime: string
}

export interface BoostScaler {
  winners: BoostPerformance[]
  mids: BoostPerformance[]
  losers: BoostPerformance[]
  ramping: BoostPerformance[]  // boosts with < ₱100 spent — too early to score
  totalSpend: number
  totalReach: number
  totalClicks: number
  totalMessages: number
  avgCTR: number
  avgCPM: number
  avgCostPerMessage: number  // weighted by spend across all measured campaigns
  topTemplates: Array<{ label: string; avgScore: number; count: number; avgCostPerMessage: number }>
  worstTemplates: Array<{ label: string; avgScore: number; count: number; avgCostPerMessage: number }>
}

/**
 * Pull every boost campaign with measurable spend, score each one primarily on
 * cost-per-messaging-conversation (since all our boosts use OUTCOME_ENGAGEMENT
 * with MESSAGE_PAGE CTA — messages are the actual win condition), then bucket
 * into winner/mid/loser tiers. Joins against the coverage store so each boost
 * is tagged with its ad category.
 *
 * Scoring (max 9):
 *   Cost-per-message (0–5): ₱100 baseline → 1pt, ₱20 caps at 5pt.
 *                           Campaigns with 0 messages but real spend get 0pt.
 *                           Campaigns still ramping (<₱100 spent) get a neutral 2.5pt.
 *   CTR score        (0–2): ctr / 3 (caps at 6% = 2)
 *   CPM score        (0–2): 50 / cpm (caps at ₱25 = 2)
 *
 * Tiers: ≥6 winner · 3–6 mid · <3 loser
 */
export async function analyzeBoostScaler(range: DateRange | string = '7d'): Promise<BoostScaler> {
  const insights = await fetchBoostCampaignInsights(range)
  const coverage = listAll()

  // Build a photoId → coverage entry lookup
  const coverageByPhoto = new Map<string, { templateKey: string; label: string; concept?: string }>()
  for (const e of coverage) {
    if (e.fbPhotoId) coverageByPhoto.set(e.fbPhotoId, { templateKey: e.templateKey, label: e.label, concept: e.concept })
  }

  // Include every campaign that (a) has an ad attached and (b) can be matched
  // back to a coverage-store entry. We include ₱0-spend (just-boosted) ones so
  // they show up in the RAMPING tier instead of disappearing.
  const measurable = insights.filter(c =>
    c.adStatus !== 'NO_AD' &&
    coverageByPhoto.has(c.postPhotoId)
  )

  const performances: BoostPerformance[] = measurable.map(c => {
    // Recalibrated for PH memorial services — customer lifetime value is high,
    // so ₱150/msg is good, not bad. Old e-commerce benchmarks (₱20/msg) don't
    // apply here.
    //   ₱50/msg  → 5pt (excellent)
    //   ₱100/msg → 4pt
    //   ₱150/msg → 3pt (the typical PH benchmark)
    //   ₱200/msg → 2pt
    //   ₱300/msg → 1pt (expensive)
    //   ₱500+    → 0pt
    let messageScore: number
    const isRamping = c.spend < 100
    if (isRamping) {
      messageScore = 2.5 // ramping — neutral, no real data yet
    } else if (c.messagingConversations === 0 || c.costPerMessage === 0) {
      messageScore = 0   // real spend, zero conversations = not working
    } else {
      // Linear ramp: ₱50 → 5pt, ₱500 → 0pt
      const cpm = c.costPerMessage
      messageScore = Math.max(0, Math.min(5, 5 - (cpm - 50) / 90))
    }
    const ctrScore = Math.min(c.ctr / 3, 2)
    const cpmScore = c.cpm > 0 ? Math.min(50 / c.cpm, 2) : 0
    const score    = messageScore + ctrScore + cpmScore
    const tier: 'winner' | 'mid' | 'loser' | 'ramping' =
      isRamping     ? 'ramping' :
      score >= 6    ? 'winner'  :
      score >= 3    ? 'mid'     :
                      'loser'
    const cov = coverageByPhoto.get(c.postPhotoId)!
    return {
      campaignId: c.campaignId,
      postPhotoId: c.postPhotoId,
      spend: c.spend, reach: c.reach, clicks: c.clicks, cpm: c.cpm, ctr: c.ctr,
      costPerClick: c.clicks > 0 ? c.spend / c.clicks : 0,
      messagingConversations: c.messagingConversations,
      costPerMessage: c.costPerMessage,
      score, tier,
      templateKey: cov.templateKey,
      label: cov.label,
      concept: cov.concept,
      createdTime: c.createdTime,
    }
  })

  performances.sort((a, b) => b.score - a.score)

  // Aggregate by template/category to find best/worst content types
  const byTemplate = new Map<string, { scores: number[]; cpms: number[]; label: string }>()
  for (const p of performances) {
    if (!p.label) continue
    if (!byTemplate.has(p.label)) byTemplate.set(p.label, { scores: [], cpms: [], label: p.label })
    const g = byTemplate.get(p.label)!
    g.scores.push(p.score)
    if (p.costPerMessage > 0) g.cpms.push(p.costPerMessage)
  }
  const templateAgg = Array.from(byTemplate.values()).map(g => ({
    label: g.label,
    avgScore: g.scores.reduce((a, b) => a + b, 0) / g.scores.length,
    count: g.scores.length,
    avgCostPerMessage: g.cpms.length ? g.cpms.reduce((a, b) => a + b, 0) / g.cpms.length : 0,
  })).sort((a, b) => b.avgScore - a.avgScore)

  const totalSpend = performances.reduce((s, p) => s + p.spend, 0)
  const totalMessages = performances.reduce((s, p) => s + p.messagingConversations, 0)

  return {
    winners: performances.filter(p => p.tier === 'winner'),
    mids: performances.filter(p => p.tier === 'mid'),
    losers: performances.filter(p => p.tier === 'loser'),
    ramping: performances.filter(p => p.tier === 'ramping'),
    totalSpend,
    totalReach: performances.reduce((s, p) => s + p.reach, 0),
    totalClicks: performances.reduce((s, p) => s + p.clicks, 0),
    totalMessages,
    avgCTR: performances.length ? performances.reduce((s, p) => s + p.ctr, 0) / performances.length : 0,
    avgCPM: performances.length ? performances.reduce((s, p) => s + p.cpm, 0) / performances.length : 0,
    avgCostPerMessage: totalMessages > 0 ? totalSpend / totalMessages : 0,
    topTemplates: templateAgg.slice(0, 3),
    worstTemplates: templateAgg.slice(-3).reverse(),
  }
}

export function formatBoostScaler(s: BoostScaler): string {
  if (s.winners.length === 0 && s.mids.length === 0 && s.losers.length === 0 && s.ramping.length === 0) {
    return '📊 No boost performance data yet — boosts need spend + reach to be scored.'
  }

  const lines: string[] = []
  lines.push(`**📊 Boost Scaler** — ranked by cost per Messenger conversation`)
  lines.push('')
  lines.push(`**Overall:** ₱${s.totalSpend.toFixed(0)} spent · **${s.totalMessages} messages** · avg ₱${s.avgCostPerMessage > 0 ? s.avgCostPerMessage.toFixed(2) : '—'}/msg · ${s.totalReach.toLocaleString()} reach · CTR ${s.avgCTR.toFixed(2)}%`)

  const renderRow = (p: BoostPerformance) => {
    const cat = p.label ?? '_(uncategorized)_'
    const concept = p.concept ? `\n   _"${p.concept.slice(0, 80)}${p.concept.length > 80 ? '…' : ''}"_` : ''
    const msgLine = p.messagingConversations > 0
      ? `**${p.messagingConversations} msg** @ **₱${p.costPerMessage.toFixed(2)}/msg**`
      : (p.spend < 100 ? '_ramping_' : '**0 msg**')
    return `**[${p.score.toFixed(1)}/9]** ${cat}\n   ${msgLine} · ₱${p.spend.toFixed(0)} spent · CTR ${p.ctr.toFixed(2)}% · CPM ₱${p.cpm.toFixed(0)}${concept}`
  }

  if (s.winners.length > 0) {
    lines.push('')
    lines.push(`🏆 **WINNERS (${s.winners.length})** — replicate these`)
    for (const p of s.winners.slice(0, 5)) lines.push(renderRow(p))
  }

  if (s.losers.length > 0) {
    lines.push('')
    lines.push(`🔴 **LOSERS (${s.losers.length})** — avoid this pattern`)
    for (const p of s.losers.slice(-5).reverse()) lines.push(renderRow(p))
  }

  if (s.mids.length > 0) {
    lines.push('')
    lines.push(`🟡 _Mid performers: ${s.mids.length}_`)
  }

  if (s.ramping.length > 0) {
    lines.push('')
    lines.push(`⏳ **RAMPING (${s.ramping.length})** — too early to judge (<₱100 spent)`)
    for (const p of s.ramping.slice(0, 5)) lines.push(renderRow(p))
  }

  if (s.topTemplates.length > 0) {
    lines.push('')
    lines.push(`**🎯 Best categories overall:**`)
    for (const t of s.topTemplates.filter(t => t.count > 0)) {
      const cpm = t.avgCostPerMessage > 0 ? ` · avg ₱${t.avgCostPerMessage.toFixed(2)}/msg` : ''
      lines.push(`- **${t.label}** — score ${t.avgScore.toFixed(1)}/9${cpm} (${t.count} boost${t.count === 1 ? '' : 's'})`)
    }
  }
  if (s.worstTemplates.length > 0 && s.worstTemplates[0].label !== s.topTemplates[0]?.label) {
    lines.push('')
    lines.push(`**⚠️ Weakest categories:**`)
    for (const t of s.worstTemplates.filter(t => t.count > 0)) {
      const cpm = t.avgCostPerMessage > 0 ? ` · avg ₱${t.avgCostPerMessage.toFixed(2)}/msg` : ''
      lines.push(`- **${t.label}** — score ${t.avgScore.toFixed(1)}/9${cpm} (${t.count} boost${t.count === 1 ? '' : 's'})`)
    }
  }

  return lines.join('\n')
}
