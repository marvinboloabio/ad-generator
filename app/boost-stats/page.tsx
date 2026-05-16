'use client'

import { useEffect, useMemo, useState } from 'react'
import type { BoostCampaignInsights, BoostScaler } from '@/lib/fbInsights'

type DateRange = '1d' | '7d' | '30d' | 'all'
type Tier = 'winner' | 'mid' | 'loser' | 'ramping'
type Tab = 'overview' | 'scaler' | 'categories' | 'recommendations' | 'all' | 'settings'

type Data = { campaigns: BoostCampaignInsights[]; scaler: BoostScaler; pageId: string; adAccountId: string; range: string }

type AutoSettings = {
  autoBoostEnabled: boolean
  autoPauseEnabled: boolean
  autoPauseCpmThreshold: number
  autoPauseMinSpend: number
  autoBoostAgainEnabled: boolean
  autoBoostAgainMinScore: number
  autoBoostAgainCooldownDays: number
  boostBudgetPHP: number
  boostAgeMin: number
  boostAgeMax: number
  boostCountry: string
}

const COLORS = {
  bg: '#0A0A0A', card: '#111111', cardHover: '#1A1A1A',
  border: '#2A2A2A', borderHi: 'rgba(201,168,76,0.3)',
  cream: '#F0EDE6', muted: '#7A7870', dim: '#3A3830',
  gold: '#C9A84C', green: '#4CAF73', yellow: '#E8D08A',
  red: '#E84C4C', orange: '#E87B4C', blue: '#6496FF',
}

const RESPONSIVE_CSS = `
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
  @media (max-width: 720px) {
    .bs-page { padding: 20px 12px !important; }
    .bs-card { padding: 12px !important; }
    .bs-header h1 { font-size: 28px !important; }
    .bs-metric-grid { grid-template-columns: repeat(2, 1fr) !important; }
    .bs-controls { flex-direction: column !important; align-items: stretch !important; }
    .bs-tabs button { padding: 8px 10px !important; font-size: 10px !important; }
  }
`

function formatPHT(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' })
}

function postUrl(pageId: string, postId: string): string {
  if (!pageId || !postId) return ''
  return `https://www.facebook.com/${pageId}/posts/${postId}`
}
function adsManagerUrl(adAccountId: string, campaignId: string): string {
  if (!adAccountId || !campaignId) return ''
  const acct = adAccountId.replace(/^act_/, '')
  return `https://www.facebook.com/adsmanager/manage/ads?act=${acct}&selected_campaign_ids=${campaignId}`
}

// ── Mini components ──────────────────────────────────────────────────────

function StatusBadge({ campaign }: { campaign: BoostCampaignInsights }) {
  const { campaignStatus, adStatus } = campaign
  let label = '', color = COLORS.muted
  if (adStatus === 'ACTIVE') { label = 'ACTIVE'; color = COLORS.green }
  else if (adStatus === 'NO_AD') { label = 'NO AD'; color = COLORS.red }
  else if (adStatus === 'CAMPAIGN_PAUSED' || campaignStatus === 'PAUSED') { label = 'PAUSED'; color = COLORS.muted }
  else if (adStatus === 'DISAPPROVED') { label = 'DISAPPROVED'; color = COLORS.red }
  else if (adStatus === 'WITH_ISSUES') { label = 'ISSUES'; color = COLORS.orange }
  else if (adStatus === 'PENDING_REVIEW') { label = 'REVIEW'; color = COLORS.yellow }
  else { label = adStatus; color = COLORS.muted }
  return <Pill label={label} color={color} />
}

function TierBadge({ tier }: { tier: Tier }) {
  const map: Record<Tier, { label: string; color: string }> = {
    winner:  { label: '🏆 WINNER', color: COLORS.green },
    mid:     { label: '🟡 MID', color: COLORS.yellow },
    loser:   { label: '🔴 LOSER', color: COLORS.red },
    ramping: { label: '⏳ RAMPING', color: COLORS.blue },
  }
  const { label, color } = map[tier]
  return <Pill label={label} color={color} />
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, color, fontFamily: 'DM Mono, monospace',
      letterSpacing: '0.12em', padding: '3px 8px',
      border: `1px solid ${color}40`, borderRadius: 4, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function Metric({ label, value, color = COLORS.cream, tooltip }: { label: string; value: string; color?: string; tooltip?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 70 }} title={tooltip}>
      <span style={{ fontSize: 9, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2, cursor: tooltip ? 'help' : 'default' }}>{label}</span>
      <span style={{ fontSize: 14, color, fontFamily: 'DM Mono, monospace' }}>{value}</span>
    </div>
  )
}

function Button({ label, color = COLORS.muted, onClick, disabled, active }: { label: string; color?: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 12px', background: active ? `${color}20` : 'transparent',
      border: `1px solid ${active ? color : color + '50'}`, borderRadius: 6,
      color: disabled ? COLORS.dim : color,
      fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.12em',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap',
    }}>{label}</button>
  )
}

function LinkButton({ label, color, href }: { label: string; color: string; href: string }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      padding: '5px 12px', background: 'transparent',
      border: `1px solid ${color}50`, borderRadius: 6, color,
      fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.12em', textDecoration: 'none', whiteSpace: 'nowrap',
    }}>{label}</a>
  )
}

// ── Campaign card ────────────────────────────────────────────────────────

function CampaignRow({
  c, pageId, adAccountId, onAction, busy, selected, onToggleSelect,
}: {
  c: BoostCampaignInsights
  pageId: string
  adAccountId: string
  onAction: (action: 'pause' | 'resume' | 'delete' | 'boost-again', payload: Record<string, string>, opts?: { spend?: number; label?: string }) => Promise<void>
  busy: string | null
  selected: boolean
  onToggleSelect: () => void
}) {
  const isShell = c.adStatus === 'NO_AD'
  const isActive = c.adStatus === 'ACTIVE'
  const isPaused = c.campaignStatus === 'PAUSED' || c.adStatus === 'CAMPAIGN_PAUSED' || c.adStatus === 'ADSET_PAUSED'
  const thisBusy = busy === c.campaignId
  return (
    <div className="bs-card" style={{
      background: COLORS.card, border: `1px solid ${selected ? COLORS.gold : COLORS.border}`,
      borderRadius: 10, padding: '14px 18px', marginBottom: 8, opacity: isShell ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {!isShell && (
            <input
              type="checkbox" checked={selected} onChange={onToggleSelect}
              style={{ marginTop: 4, accentColor: COLORS.gold, cursor: 'pointer' }}
            />
          )}
          <div style={{ flex: 1 }}>
            <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>
              {formatPHT(c.createdTime)} {c.postPhotoId && `· post ${c.postPhotoId}`}
            </p>
            <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 16, color: COLORS.cream, marginBottom: c.label ? 2 : 0 }}>
              {c.label ?? c.campaignName}
            </p>
            {c.label && (
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.dim, letterSpacing: '0.08em' }}>
                {c.campaignName}
              </p>
            )}
            {c.concept && (
              <p style={{ fontSize: 12, color: COLORS.muted, fontStyle: 'italic', marginTop: 6, lineHeight: 1.4 }}>
                &ldquo;{c.concept.slice(0, 100)}{c.concept.length > 100 ? '…' : ''}&rdquo;
              </p>
            )}
          </div>
        </div>
        <StatusBadge campaign={c} />
      </div>

      {isShell ? (
        <p style={{ fontSize: 11, color: COLORS.red, fontFamily: 'DM Mono, monospace' }}>
          🚫 Empty shell — boost creation failed, no spending
        </p>
      ) : (
        <div className="bs-metric-grid" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <Metric label="Messages" value={c.messagingConversations > 0 ? String(c.messagingConversations) : '—'} color={c.messagingConversations > 0 ? COLORS.green : COLORS.cream} tooltip="Users who sent 3+ messages in Messenger (real conversations)" />
          <Metric label="₱/Msg" value={c.costPerMessage > 0 ? `₱${c.costPerMessage.toFixed(2)}` : '—'} color={c.costPerMessage > 0 && c.costPerMessage < 100 ? COLORS.green : c.costPerMessage > 250 ? COLORS.orange : COLORS.cream} tooltip="Cost per qualifying message — primary KPI for engagement boosts" />
          <Metric label="Spent" value={`₱${c.spend.toFixed(2)}`} color={c.spend > 0 ? COLORS.cream : COLORS.muted} tooltip="Lifetime spend within the selected date range" />
          <Metric label="Reach" value={c.reach > 0 ? c.reach.toLocaleString() : '—'} tooltip="Unique people who saw the ad" />
          <Metric label="CTR" value={c.ctr > 0 ? `${c.ctr.toFixed(2)}%` : '—'} color={c.ctr > 3 ? COLORS.green : c.ctr > 0 && c.ctr < 1 ? COLORS.orange : COLORS.cream} tooltip="Click-through rate — % of impressions that resulted in a click" />
          <Metric label="CPM" value={c.cpm > 0 ? `₱${c.cpm.toFixed(0)}` : '—'} color={c.cpm > 0 && c.cpm < 50 ? COLORS.green : c.cpm > 80 ? COLORS.orange : COLORS.cream} tooltip="Cost per 1,000 impressions" />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <LinkButton label="VIEW POST →" color={COLORS.blue} href={postUrl(pageId, c.postPhotoId)} />
        <LinkButton label="ADS MANAGER →" color={COLORS.gold} href={adsManagerUrl(adAccountId, c.campaignId)} />
        {!isShell && isActive && (
          <Button label={thisBusy ? '...' : 'PAUSE'} color={COLORS.orange} disabled={thisBusy}
            onClick={() => onAction('pause', { campaignId: c.campaignId }, { spend: c.spend, label: c.label ?? c.campaignName })} />
        )}
        {!isShell && isPaused && (
          <Button label={thisBusy ? '...' : 'RESUME'} color={COLORS.green} disabled={thisBusy}
            onClick={() => onAction('resume', { campaignId: c.campaignId })} />
        )}
        {!isShell && c.postPhotoId && (
          <Button label={thisBusy ? '...' : 'BOOST AGAIN'} color={COLORS.yellow} disabled={thisBusy}
            onClick={() => onAction('boost-again', { postId: c.postPhotoId })} />
        )}
        {(isShell || isPaused) && (
          <Button label={thisBusy ? '...' : 'DELETE'} color={COLORS.red} disabled={thisBusy}
            onClick={() => onAction('delete', { campaignId: c.campaignId })} />
        )}
      </div>
    </div>
  )
}

// ── Performance row (scaler tab) ─────────────────────────────────────────

function PerformanceRow({
  p, pageId, adAccountId, onAction, busy,
}: {
  p: BoostScaler['winners'][number]
  pageId: string
  adAccountId: string
  onAction: (action: 'pause' | 'resume' | 'delete' | 'boost-again', payload: Record<string, string>, opts?: { spend?: number; label?: string }) => Promise<void>
  busy: string | null
}) {
  const thisBusy = busy === p.campaignId
  return (
    <div className="bs-card" style={{
      background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>
            {formatPHT(p.createdTime)} · score {p.score.toFixed(1)}/9
          </p>
          <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 15, color: COLORS.cream }}>
            {p.label ?? '(uncategorized)'}
          </p>
          {p.concept && (
            <p style={{ fontSize: 12, color: COLORS.muted, fontStyle: 'italic', marginTop: 4, lineHeight: 1.4 }}>
              &ldquo;{p.concept.slice(0, 110)}{p.concept.length > 110 ? '…' : ''}&rdquo;
            </p>
          )}
        </div>
        <TierBadge tier={p.tier} />
      </div>
      <div className="bs-metric-grid" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Metric label="Messages" value={p.messagingConversations > 0 ? String(p.messagingConversations) : (p.spend < 100 ? 'ramping' : '0')} color={p.messagingConversations > 0 ? COLORS.green : (p.spend < 100 ? COLORS.muted : COLORS.orange)} />
        <Metric label="₱/Msg" value={p.costPerMessage > 0 ? `₱${p.costPerMessage.toFixed(2)}` : '—'} color={p.costPerMessage > 0 && p.costPerMessage < 100 ? COLORS.green : p.costPerMessage > 250 ? COLORS.orange : COLORS.cream} />
        <Metric label="Spent" value={`₱${p.spend.toFixed(0)}`} />
        <Metric label="CTR" value={`${p.ctr.toFixed(2)}%`} color={p.ctr > 3 ? COLORS.green : p.ctr < 1.5 ? COLORS.orange : COLORS.cream} />
        <Metric label="CPM" value={`₱${p.cpm.toFixed(0)}`} color={p.cpm < 50 ? COLORS.green : p.cpm > 80 ? COLORS.orange : COLORS.cream} />
        <Metric label="Reach" value={p.reach.toLocaleString()} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <LinkButton label="VIEW POST →" color={COLORS.blue} href={postUrl(pageId, p.postPhotoId)} />
        <LinkButton label="ADS MANAGER →" color={COLORS.gold} href={adsManagerUrl(adAccountId, p.campaignId)} />
        <Button label={thisBusy ? '...' : 'PAUSE'} color={COLORS.orange} disabled={thisBusy}
          onClick={() => onAction('pause', { campaignId: p.campaignId }, { spend: p.spend, label: p.label })} />
        <Button label={thisBusy ? '...' : 'BOOST AGAIN'} color={COLORS.yellow} disabled={thisBusy}
          onClick={() => onAction('boost-again', { postId: p.postPhotoId })} />
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────

export default function BoostStatsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  // Controls
  const [range, setRange] = useState<DateRange>('7d')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'date' | 'score' | 'spend' | 'messages' | 'ctr' | 'cpm'>('date')
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set(['winner', 'mid', 'loser', 'ramping']))
  const [combineByPost, setCombineByPost] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Settings
  const [settings, setSettings] = useState<AutoSettings | null>(null)

  // Recommendations
  const [recs, setRecs] = useState<string[] | null>(null)
  const [recsLoading, setRecsLoading] = useState(false)

  async function load() {
    setError(null)
    try {
      const res = await fetch(`/api/boost-stats?range=${range}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/boost-stats/settings')
      if (res.ok) setSettings(await res.json())
    } catch {}
  }

  async function loadRecommendations() {
    setRecsLoading(true)
    setRecs(null)
    try {
      const res = await fetch(`/api/boost-stats/recommendations?range=${range}`)
      const body = await res.json()
      if (body.error) throw new Error(body.error)
      setRecs(body.recommendations)
    } catch (err: any) {
      setRecs([`⚠️ Could not generate recommendations: ${err.message}`])
    } finally {
      setRecsLoading(false)
    }
  }

  async function saveSettings(patch: Partial<AutoSettings>) {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      await fetch('/api/boost-stats/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      setToast({ kind: 'ok', msg: 'Settings saved' })
      setTimeout(() => setToast(null), 3000)
    } catch (err: any) {
      setToast({ kind: 'err', msg: err.message })
    }
  }

  async function onAction(
    action: 'pause' | 'resume' | 'delete' | 'boost-again',
    payload: Record<string, string>,
    opts?: { spend?: number; label?: string },
  ) {
    const confirmMsg: Record<string, string> = {
      delete: 'Delete this campaign permanently? This cannot be undone.',
      'boost-again': 'Create a NEW boost campaign for this post? It will start spending at the configured daily budget immediately.',
    }
    if (action === 'pause' && opts && (opts.spend ?? 0) > 500) {
      const ok = window.confirm(`Pause "${opts.label}"?\nThis campaign has spent ₱${opts.spend!.toFixed(0)}. Pausing stops delivery; you can resume anytime.`)
      if (!ok) return
    } else if (confirmMsg[action] && !window.confirm(confirmMsg[action])) {
      return
    }

    const busyKey = payload.campaignId ?? payload.postId
    setBusy(busyKey)
    setToast(null)
    try {
      const res = await fetch('/api/boost-stats/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      })
      const body = await res.json()
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setToast({ kind: 'ok', msg: body.message ?? 'Done' })
      await load()
    } catch (err: any) {
      setToast({ kind: 'err', msg: err.message })
    } finally {
      setBusy(null)
      setTimeout(() => setToast(null), 5000)
    }
  }

  async function bulkAction(action: 'pause' | 'resume' | 'delete') {
    if (selected.size === 0) return
    const ok = window.confirm(`${action.toUpperCase()} ${selected.size} campaign${selected.size === 1 ? '' : 's'}?`)
    if (!ok) return
    try {
      const res = await fetch('/api/boost-stats/bulk-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, campaignIds: Array.from(selected) }),
      })
      const body = await res.json()
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`)
      setToast({ kind: 'ok', msg: `${body.ok} ${action}d${body.failed?.length ? `, ${body.failed.length} failed` : ''}` })
      setSelected(new Set())
      await load()
    } catch (err: any) {
      setToast({ kind: 'err', msg: err.message })
    } finally {
      setTimeout(() => setToast(null), 5000)
    }
  }

  useEffect(() => {
    load()
    loadSettings()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  // Derived: filtered + sorted campaigns
  const visibleCampaigns = useMemo(() => {
    if (!data) return []
    let arr = data.campaigns
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(c =>
        (c.label ?? '').toLowerCase().includes(q) ||
        (c.concept ?? '').toLowerCase().includes(q) ||
        c.postPhotoId.includes(q) ||
        c.campaignName.toLowerCase().includes(q),
      )
    }
    // Combine duplicates by postPhotoId
    if (combineByPost) {
      const byPost = new Map<string, BoostCampaignInsights>()
      for (const c of arr) {
        const key = c.postPhotoId || c.campaignId
        const ex = byPost.get(key)
        if (!ex) { byPost.set(key, { ...c }); continue }
        ex.spend += c.spend
        ex.reach = Math.max(ex.reach, c.reach)
        ex.impressions += c.impressions
        ex.clicks += c.clicks
        ex.messagingConversations += c.messagingConversations
        if (ex.messagingConversations > 0) ex.costPerMessage = ex.spend / ex.messagingConversations
      }
      arr = Array.from(byPost.values())
    }
    // Sort
    arr = [...arr].sort((a, b) => {
      if (sort === 'score') return 0
      if (sort === 'spend') return b.spend - a.spend
      if (sort === 'messages') return b.messagingConversations - a.messagingConversations
      if (sort === 'ctr') return b.ctr - a.ctr
      if (sort === 'cpm') return a.cpm - b.cpm
      return b.createdTime.localeCompare(a.createdTime)
    })
    return arr
  }, [data, search, sort, combineByPost])

  const active = visibleCampaigns.filter(c => c.adStatus === 'ACTIVE')
  const shells = visibleCampaigns.filter(c => c.adStatus === 'NO_AD')

  // Burn rate stats
  const burnStats = useMemo(() => {
    if (!data) return null
    const activeCampaigns = data.campaigns.filter(c => c.adStatus === 'ACTIVE')
    const dailyBudgetTotal = activeCampaigns.reduce((s, c) => s + (c.dailyBudgetPHP ?? 0), 0)
    const todaySpend = activeCampaigns.reduce((s, c) => s + c.spend, 0) // approximation — depends on range
    return {
      activeCount: activeCampaigns.length,
      dailyBudgetTotal,
      projectedMonthly: dailyBudgetTotal * 30,
      todaySpend,
    }
  }, [data])

  if (loading) {
    return (
      <div className="bs-page" style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1100, margin: '0 auto' }}>
        <style>{RESPONSIVE_CSS}</style>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: COLORS.muted }}>Loading boost stats from Facebook...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bs-page" style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1100, margin: '0 auto' }}>
        <style>{RESPONSIVE_CSS}</style>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: COLORS.red }}>⚠️ {error}</p>
        <button onClick={load} style={{ marginTop: 16, padding: '6px 14px', background: 'transparent', border: `1px solid ${COLORS.borderHi}`, borderRadius: 6, color: COLORS.gold, fontFamily: 'DM Mono, monospace', fontSize: 12, cursor: 'pointer' }}>RETRY</button>
      </div>
    )
  }

  if (!data) return null

  const { scaler } = data

  return (
    <div className="bs-page" style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1100, margin: '0 auto', color: COLORS.cream }}>
      <style>{RESPONSIVE_CSS}</style>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 50,
          background: COLORS.card,
          border: `1px solid ${toast.kind === 'ok' ? COLORS.green : COLORS.red}80`,
          borderRadius: 8, padding: '12px 20px',
          fontFamily: 'DM Mono, monospace', fontSize: 12,
          color: toast.kind === 'ok' ? COLORS.green : COLORS.red,
          letterSpacing: '0.08em', maxWidth: 360,
        }}>
          {toast.kind === 'ok' ? '✓ ' : '⚠️ '}{toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="bs-header" style={{ marginBottom: 24 }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.3em', marginBottom: 8 }}>
          AD GENERATOR
        </p>
        <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 36, fontWeight: 300, color: COLORS.cream, marginBottom: 16 }}>
          Boost Stats
        </h1>
      </div>

      {/* Controls bar: date range, search, sort, refresh */}
      <div className="bs-controls" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <a href="/" style={{ padding: '8px 16px', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.muted, fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.1em', textDecoration: 'none' }}>← HOME</a>
        <select value={range} onChange={e => setRange(e.target.value as DateRange)} style={{
          padding: '8px 12px', background: COLORS.card, border: `1px solid ${COLORS.border}`,
          borderRadius: 6, color: COLORS.cream, fontFamily: 'DM Mono, monospace', fontSize: 11, cursor: 'pointer',
        }} title="Time range for metrics">
          <option value="1d">LAST 24H</option>
          <option value="7d">LAST 7 DAYS</option>
          <option value="30d">LAST 30 DAYS</option>
          <option value="all">ALL TIME</option>
        </select>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by category, concept, or post ID..."
          style={{
            flex: 1, minWidth: 180, padding: '8px 12px',
            background: COLORS.card, border: `1px solid ${COLORS.border}`,
            borderRadius: 6, color: COLORS.cream, fontFamily: 'DM Mono, monospace', fontSize: 11,
          }}
        />
        <select value={sort} onChange={e => setSort(e.target.value as any)} style={{
          padding: '8px 12px', background: COLORS.card, border: `1px solid ${COLORS.border}`,
          borderRadius: 6, color: COLORS.cream, fontFamily: 'DM Mono, monospace', fontSize: 11, cursor: 'pointer',
        }} title="Sort campaigns">
          <option value="date">SORT: DATE</option>
          <option value="spend">SORT: SPEND</option>
          <option value="messages">SORT: MESSAGES</option>
          <option value="ctr">SORT: CTR</option>
          <option value="cpm">SORT: CPM</option>
        </select>
        <Button label={combineByPost ? 'COMBINED: ON' : 'COMBINE DUPES'} color={COLORS.blue} active={combineByPost} onClick={() => setCombineByPost(v => !v)} />
        <Button label="REFRESH" color={COLORS.gold} onClick={load} />
      </div>

      {/* Top-line metrics */}
      <div className="bs-metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
        <StatTile label="MESSAGES" value={scaler.totalMessages.toLocaleString()} color={scaler.totalMessages > 0 ? COLORS.green : COLORS.cream} highlight={scaler.totalMessages > 0} />
        <StatTile label="COST / MSG" value={scaler.avgCostPerMessage > 0 ? `₱${scaler.avgCostPerMessage.toFixed(2)}` : '—'} color={scaler.avgCostPerMessage > 0 && scaler.avgCostPerMessage < 150 ? COLORS.green : scaler.avgCostPerMessage > 250 ? COLORS.orange : COLORS.cream} />
        <StatTile label="TOTAL SPEND" value={`₱${scaler.totalSpend.toFixed(0)}`} />
        <StatTile label="AVG CTR" value={`${scaler.avgCTR.toFixed(2)}%`} color={scaler.avgCTR > 3 ? COLORS.green : COLORS.cream} />
        <StatTile label="TOTAL REACH" value={scaler.totalReach.toLocaleString()} />
      </div>

      {/* Burn rate row */}
      {burnStats && burnStats.activeCount > 0 && (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 20px', marginBottom: 24, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.dim, letterSpacing: '0.15em' }}>💸 BURN RATE</p>
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: COLORS.cream }}>
            <span style={{ color: COLORS.dim }}>Active: </span>{burnStats.activeCount} boost{burnStats.activeCount === 1 ? '' : 's'}
          </span>
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: COLORS.cream }}>
            <span style={{ color: COLORS.dim }}>Daily budget: </span>₱{burnStats.dailyBudgetTotal}
          </span>
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: burnStats.projectedMonthly > 50000 ? COLORS.orange : COLORS.cream }}>
            <span style={{ color: COLORS.dim }}>Projected monthly: </span>₱{burnStats.projectedMonthly.toLocaleString()}
          </span>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{ background: `${COLORS.gold}15`, border: `1px solid ${COLORS.gold}`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: COLORS.gold }}>
            {selected.size} selected
          </span>
          <Button label="BULK PAUSE" color={COLORS.orange} onClick={() => bulkAction('pause')} />
          <Button label="BULK RESUME" color={COLORS.green} onClick={() => bulkAction('resume')} />
          <Button label="BULK DELETE" color={COLORS.red} onClick={() => bulkAction('delete')} />
          <Button label="CLEAR" color={COLORS.muted} onClick={() => setSelected(new Set())} />
        </div>
      )}

      {/* Tabs */}
      <div className="bs-tabs" style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `1px solid ${COLORS.border}`, overflowX: 'auto' }}>
        {([
          ['overview', 'OVERVIEW'],
          ['scaler', 'SCALER'],
          ['categories', 'BY CATEGORY'],
          ['recommendations', 'RECOMMENDATIONS'],
          ['all', 'ALL'],
          ['settings', 'SETTINGS'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => { setTab(key); if (key === 'recommendations' && !recs && !recsLoading) loadRecommendations() }}
            style={{
              padding: '10px 18px', background: 'transparent', border: 'none',
              borderBottom: `2px solid ${tab === key ? COLORS.gold : 'transparent'}`,
              color: tab === key ? COLORS.gold : COLORS.muted,
              fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.15em', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab
          active={active} shells={shells}
          pageId={data.pageId} adAccountId={data.adAccountId}
          onAction={onAction} busy={busy}
          selected={selected} setSelected={setSelected}
        />
      )}

      {tab === 'scaler' && (
        <ScalerTab
          scaler={scaler} tierFilter={tierFilter} setTierFilter={setTierFilter}
          pageId={data.pageId} adAccountId={data.adAccountId}
          onAction={onAction} busy={busy}
        />
      )}

      {tab === 'categories' && (
        <CategoriesTab data={data} />
      )}

      {tab === 'recommendations' && (
        <RecommendationsTab recs={recs} loading={recsLoading} reload={loadRecommendations} />
      )}

      {tab === 'all' && (
        <div>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em', marginBottom: 12 }}>
            ALL CAMPAIGNS — {visibleCampaigns.length}
          </p>
          {visibleCampaigns.map(c => (
            <CampaignRow key={c.campaignId} c={c} pageId={data.pageId} adAccountId={data.adAccountId}
              onAction={onAction} busy={busy}
              selected={selected.has(c.campaignId)}
              onToggleSelect={() => setSelected(prev => {
                const next = new Set(prev)
                if (next.has(c.campaignId)) next.delete(c.campaignId); else next.add(c.campaignId)
                return next
              })}
            />
          ))}
        </div>
      )}

      {tab === 'settings' && settings && (
        <SettingsTab settings={settings} onSave={saveSettings} />
      )}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────

function StatTile({ label, value, color = COLORS.cream, highlight }: { label: string; value: string; color?: string; highlight?: boolean }) {
  return (
    <div style={{ background: COLORS.card, border: `1px solid ${highlight ? color + '60' : COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 22, color, fontFamily: 'DM Mono, monospace' }}>{value}</p>
    </div>
  )
}

function OverviewTab({
  active, shells, pageId, adAccountId, onAction, busy, selected, setSelected,
}: {
  active: BoostCampaignInsights[]
  shells: BoostCampaignInsights[]
  pageId: string
  adAccountId: string
  onAction: any
  busy: string | null
  selected: Set<string>
  setSelected: (fn: (prev: Set<string>) => Set<string>) => void
}) {
  return (
    <div>
      <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em', marginBottom: 12 }}>
        ACTIVE CAMPAIGNS — {active.length}
      </p>
      {active.length === 0 ? (
        <p style={{ color: COLORS.muted, fontSize: 13, padding: '20px 0' }}>
          No active boost campaigns. Type <code style={{ color: COLORS.gold }}>boost auto on</code> in Discord or boost manually.
        </p>
      ) : active.map(c => (
        <CampaignRow key={c.campaignId} c={c} pageId={pageId} adAccountId={adAccountId}
          onAction={onAction} busy={busy}
          selected={selected.has(c.campaignId)}
          onToggleSelect={() => setSelected(prev => {
            const next = new Set(prev)
            if (next.has(c.campaignId)) next.delete(c.campaignId); else next.add(c.campaignId)
            return next
          })}
        />
      ))}
      {shells.length > 0 && (
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.orange, marginTop: 24 }}>
          ⚠️ {shells.length} empty shell{shells.length === 1 ? '' : 's'} — run <code style={{ color: COLORS.gold }}>cleanup shells</code> in Discord to remove.
        </p>
      )}
    </div>
  )
}

function ScalerTab({
  scaler, tierFilter, setTierFilter, pageId, adAccountId, onAction, busy,
}: {
  scaler: BoostScaler
  tierFilter: Set<Tier>
  setTierFilter: (s: Set<Tier>) => void
  pageId: string
  adAccountId: string
  onAction: any
  busy: string | null
}) {
  const toggleTier = (t: Tier) => {
    const next = new Set(tierFilter)
    if (next.has(t)) next.delete(t); else next.add(t)
    setTierFilter(next)
  }
  const tiers: Array<[Tier, BoostScaler['winners'], string, string]> = [
    ['winner',  scaler.winners,  '🏆 WINNERS',  COLORS.green],
    ['mid',     scaler.mids,     '🟡 MID',      COLORS.yellow],
    ['loser',   scaler.losers,   '🔴 LOSERS',   COLORS.red],
    ['ramping', scaler.ramping,  '⏳ RAMPING',  COLORS.blue],
  ]
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, alignSelf: 'center', letterSpacing: '0.15em' }}>FILTER:</span>
        {tiers.map(([t, , label, color]) => (
          <Button key={t} label={label} color={color} active={tierFilter.has(t)} onClick={() => toggleTier(t)} />
        ))}
      </div>
      {tiers.map(([t, list, label, color]) => {
        if (!tierFilter.has(t) || list.length === 0) return null
        return (
          <div key={t} style={{ marginTop: 16 }}>
            <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color, letterSpacing: '0.2em', marginBottom: 12 }}>
              {label} — {list.length}
            </p>
            {list.map(p => <PerformanceRow key={p.campaignId} p={p} pageId={pageId} adAccountId={adAccountId} onAction={onAction} busy={busy} />)}
          </div>
        )
      })}
      {scaler.winners.length === 0 && scaler.mids.length === 0 && scaler.losers.length === 0 && scaler.ramping.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 8 }}>No boost data yet for this date range.</p>
          <p style={{ color: COLORS.dim, fontSize: 11, fontFamily: 'DM Mono, monospace' }}>
            What makes a 🏆 WINNER: cost/msg under ₱100 + CTR above 3%
          </p>
        </div>
      )}
    </div>
  )
}

function CategoriesTab({ data }: { data: Data }) {
  type Row = {
    label: string
    boosts: number
    totalSpend: number
    totalMessages: number
    avgCostPerMessage: number
    avgCTR: number
    avgCPM: number
    avgScore: number
  }
  const rows: Row[] = useMemo(() => {
    const all = [...data.scaler.winners, ...data.scaler.mids, ...data.scaler.losers, ...data.scaler.ramping]
    const groups = new Map<string, Row & { _msgWeightedSum: number; _msgWeightTotal: number }>()
    for (const p of all) {
      const label = p.label ?? '(uncategorized)'
      const row = groups.get(label) ?? {
        label, boosts: 0, totalSpend: 0, totalMessages: 0, avgCostPerMessage: 0,
        avgCTR: 0, avgCPM: 0, avgScore: 0, _msgWeightedSum: 0, _msgWeightTotal: 0,
      }
      row.boosts++
      row.totalSpend += p.spend
      row.totalMessages += p.messagingConversations
      row.avgCTR += p.ctr
      row.avgCPM += p.cpm
      row.avgScore += p.score
      groups.set(label, row)
    }
    return Array.from(groups.values()).map(r => ({
      label: r.label,
      boosts: r.boosts,
      totalSpend: r.totalSpend,
      totalMessages: r.totalMessages,
      avgCostPerMessage: r.totalMessages > 0 ? r.totalSpend / r.totalMessages : 0,
      avgCTR: r.avgCTR / r.boosts,
      avgCPM: r.avgCPM / r.boosts,
      avgScore: r.avgScore / r.boosts,
    })).sort((a, b) => b.avgScore - a.avgScore)
  }, [data])

  return (
    <div>
      <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em', marginBottom: 12 }}>
        AGGREGATED BY CATEGORY — {rows.length} types
      </p>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted, fontSize: 13, padding: '20px 0' }}>No categorized boosts yet.</p>
      ) : rows.map(r => (
        <div key={r.label} className="bs-card" style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 18, color: COLORS.cream }}>
              {r.label} <span style={{ fontSize: 12, color: COLORS.muted }}>· {r.boosts} boost{r.boosts === 1 ? '' : 's'}</span>
            </p>
            <Pill label={`SCORE ${r.avgScore.toFixed(1)}/9`} color={r.avgScore >= 6 ? COLORS.green : r.avgScore >= 3 ? COLORS.yellow : COLORS.red} />
          </div>
          <div className="bs-metric-grid" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Metric label="Messages" value={r.totalMessages > 0 ? String(r.totalMessages) : '—'} color={r.totalMessages > 0 ? COLORS.green : COLORS.cream} />
            <Metric label="Avg ₱/Msg" value={r.avgCostPerMessage > 0 ? `₱${r.avgCostPerMessage.toFixed(2)}` : '—'} />
            <Metric label="Total Spend" value={`₱${r.totalSpend.toFixed(0)}`} />
            <Metric label="Avg CTR" value={`${r.avgCTR.toFixed(2)}%`} />
            <Metric label="Avg CPM" value={`₱${r.avgCPM.toFixed(0)}`} />
          </div>
        </div>
      ))}
    </div>
  )
}

function RecommendationsTab({ recs, loading, reload }: { recs: string[] | null; loading: boolean; reload: () => void }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em' }}>
          AI RECOMMENDATIONS
        </p>
        <Button label={loading ? '...' : 'REGENERATE'} color={COLORS.gold} onClick={reload} disabled={loading} />
      </div>
      {loading ? (
        <p style={{ color: COLORS.muted, fontSize: 13 }}>Asking Claude to analyze your data...</p>
      ) : recs && recs.length > 0 ? (
        <div>
          {recs.map((r, i) => (
            <div key={i} className="bs-card" style={{
              background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8,
              padding: '14px 18px', marginBottom: 8, fontSize: 14, color: COLORS.cream, lineHeight: 1.5,
            }}>{r}</div>
          ))}
        </div>
      ) : (
        <p style={{ color: COLORS.muted, fontSize: 13 }}>Click REGENERATE to fetch recommendations from Claude.</p>
      )}
    </div>
  )
}

function SettingsTab({ settings, onSave }: { settings: AutoSettings; onSave: (patch: Partial<AutoSettings>) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        title="Auto-Boost (new posts)"
        description="When a scheduled post goes live, automatically create a boost campaign with the configured budget."
        toggle={settings.autoBoostEnabled}
        onToggle={v => onSave({ autoBoostEnabled: v })}
      />

      <SettingCard
        title="Auto-Pause Bad Performers"
        description={`Automatically pause any boost whose cost-per-message exceeds the threshold, once it has spent at least the minimum.`}
        toggle={settings.autoPauseEnabled}
        onToggle={v => onSave({ autoPauseEnabled: v })}
      >
        <NumberInput label="Max cost per message" value={settings.autoPauseCpmThreshold} onChange={v => onSave({ autoPauseCpmThreshold: v })} prefix="₱" />
        <NumberInput label="Min spend before activation" value={settings.autoPauseMinSpend} onChange={v => onSave({ autoPauseMinSpend: v })} prefix="₱" />
      </SettingCard>

      <SettingCard
        title="Auto-Boost-Again Winners"
        description="When a campaign hits 🏆 WINNER status, automatically create a duplicate at 2× budget. Each post can only be duplicated once per cooldown window."
        toggle={settings.autoBoostAgainEnabled}
        onToggle={v => onSave({ autoBoostAgainEnabled: v })}
      >
        <NumberInput label="Minimum score to trigger" value={settings.autoBoostAgainMinScore} onChange={v => onSave({ autoBoostAgainMinScore: v })} suffix="/9" min={3} max={9} />
        <NumberInput label="Cooldown between duplicates" value={settings.autoBoostAgainCooldownDays} onChange={v => onSave({ autoBoostAgainCooldownDays: v })} suffix=" days" />
      </SettingCard>

      <SettingCard title="Default Boost Settings" description="Used when auto-boost or boost-again creates new campaigns.">
        <NumberInput label="Daily budget" value={settings.boostBudgetPHP} onChange={v => onSave({ boostBudgetPHP: v })} prefix="₱" suffix="/day" />
        <NumberInput label="Min age" value={settings.boostAgeMin} onChange={v => onSave({ boostAgeMin: v })} min={13} max={65} />
        <NumberInput label="Max age" value={settings.boostAgeMax} onChange={v => onSave({ boostAgeMax: v })} min={13} max={65} />
      </SettingCard>
    </div>
  )
}

function SettingCard({
  title, description, toggle, onToggle, children,
}: {
  title: string; description: string; toggle?: boolean; onToggle?: (v: boolean) => void; children?: React.ReactNode
}) {
  return (
    <div className="bs-card" style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 18, color: COLORS.cream, marginBottom: 6 }}>{title}</p>
          <p style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.5 }}>{description}</p>
        </div>
        {onToggle && (
          <button onClick={() => onToggle(!toggle)} style={{
            padding: '6px 16px', borderRadius: 6,
            background: toggle ? COLORS.green + '20' : 'transparent',
            border: `1px solid ${toggle ? COLORS.green : COLORS.border}`,
            color: toggle ? COLORS.green : COLORS.muted,
            fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.12em', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{toggle ? 'ENABLED' : 'DISABLED'}</button>
        )}
      </div>
      {children && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>{children}</div>}
    </div>
  )
}

function NumberInput({ label, value, onChange, prefix, suffix, min, max }: {
  label: string; value: number; onChange: (v: number) => void; prefix?: string; suffix?: string; min?: number; max?: number
}) {
  return (
    <div>
      <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.dim, letterSpacing: '0.1em', marginBottom: 4 }}>{label}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {prefix && <span style={{ color: COLORS.muted, fontSize: 13, fontFamily: 'DM Mono, monospace' }}>{prefix}</span>}
        <input
          type="number" value={value} min={min} max={max}
          onChange={e => onChange(Number(e.target.value))}
          onBlur={e => onChange(Number(e.target.value))}
          style={{
            width: 80, padding: '6px 8px', background: COLORS.bg,
            border: `1px solid ${COLORS.border}`, borderRadius: 4,
            color: COLORS.cream, fontFamily: 'DM Mono, monospace', fontSize: 13,
          }}
        />
        {suffix && <span style={{ color: COLORS.muted, fontSize: 13, fontFamily: 'DM Mono, monospace' }}>{suffix}</span>}
      </div>
    </div>
  )
}
