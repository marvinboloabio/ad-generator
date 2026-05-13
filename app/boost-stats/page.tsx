'use client'

import { useEffect, useState } from 'react'
import type { BoostCampaignInsights, BoostScaler } from '@/lib/fbInsights'

type Data = { campaigns: BoostCampaignInsights[]; scaler: BoostScaler; pageId: string; adAccountId: string }

const COLORS = {
  bg: '#0A0A0A',
  card: '#111111',
  cardHover: '#1A1A1A',
  border: '#2A2A2A',
  borderHi: 'rgba(201,168,76,0.3)',
  cream: '#F0EDE6',
  muted: '#7A7870',
  dim: '#3A3830',
  gold: '#C9A84C',
  green: '#4CAF73',
  yellow: '#E8D08A',
  red: '#E84C4C',
  orange: '#E87B4C',
  blue: '#6496FF',
}

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
  return (
    <span style={{
      fontSize: 10, color, fontFamily: 'DM Mono, monospace',
      letterSpacing: '0.12em', padding: '3px 8px',
      border: `1px solid ${color}40`, borderRadius: 4, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function TierBadge({ tier }: { tier: 'winner' | 'mid' | 'loser' }) {
  const map = {
    winner: { label: '🏆 WINNER', color: COLORS.green },
    mid:    { label: '🟡 MID', color: COLORS.yellow },
    loser:  { label: '🔴 LOSER', color: COLORS.red },
  }
  const { label, color } = map[tier]
  return (
    <span style={{
      fontSize: 10, color, fontFamily: 'DM Mono, monospace',
      letterSpacing: '0.12em', padding: '3px 8px',
      border: `1px solid ${color}40`, borderRadius: 4,
    }}>{label}</span>
  )
}

function Metric({ label, value, color = COLORS.cream }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 70 }}>
      <span style={{ fontSize: 9, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>{label}</span>
      <span style={{ fontSize: 14, color, fontFamily: 'DM Mono, monospace' }}>{value}</span>
    </div>
  )
}

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

function ActionButton({
  label, color, onClick, disabled,
}: { label: string; color: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '5px 12px',
        background: 'transparent',
        border: `1px solid ${color}50`,
        borderRadius: 6,
        color: disabled ? COLORS.dim : color,
        fontFamily: 'DM Mono, monospace',
        fontSize: 10,
        letterSpacing: '0.12em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >{label}</button>
  )
}

function LinkButton({ label, color, href }: { label: string; color: string; href: string }) {
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        padding: '5px 12px',
        background: 'transparent',
        border: `1px solid ${color}50`,
        borderRadius: 6,
        color,
        fontFamily: 'DM Mono, monospace',
        fontSize: 10,
        letterSpacing: '0.12em',
        textDecoration: 'none',
      }}
    >{label}</a>
  )
}

function CampaignRow({
  c, pageId, adAccountId, onAction, busy,
}: {
  c: BoostCampaignInsights
  pageId: string
  adAccountId: string
  onAction: (action: 'pause' | 'resume' | 'delete' | 'boost-again', payload: Record<string, string>) => Promise<void>
  busy: string | null
}) {
  const isShell = c.adStatus === 'NO_AD'
  const isActive = c.adStatus === 'ACTIVE'
  const isPaused = c.campaignStatus === 'PAUSED' || c.adStatus === 'CAMPAIGN_PAUSED' || c.adStatus === 'ADSET_PAUSED'
  const thisBusy = busy === c.campaignId
  return (
    <div style={{
      background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: '14px 18px',
      marginBottom: 8,
      opacity: isShell ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>
            {formatPHT(c.createdTime)} {c.postPhotoId && `· post ${c.postPhotoId}`}
          </p>
          <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 14, color: COLORS.cream }}>
            {c.campaignName}
          </p>
        </div>
        <StatusBadge campaign={c} />
      </div>

      {isShell ? (
        <p style={{ fontSize: 11, color: COLORS.red, fontFamily: 'DM Mono, monospace' }}>
          🚫 Empty shell — boost creation failed, no spending
        </p>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <Metric
            label="Messages"
            value={c.messagingConversations > 0 ? String(c.messagingConversations) : '—'}
            color={c.messagingConversations > 0 ? COLORS.green : COLORS.cream}
          />
          <Metric
            label="₱/Msg"
            value={c.costPerMessage > 0 ? `₱${c.costPerMessage.toFixed(2)}` : '—'}
            color={c.costPerMessage > 0 && c.costPerMessage < 30 ? COLORS.green : c.costPerMessage > 80 ? COLORS.orange : COLORS.cream}
          />
          <Metric label="Spent" value={`₱${c.spend.toFixed(2)}`} color={c.spend > 0 ? COLORS.cream : COLORS.muted} />
          <Metric label="Reach" value={c.reach > 0 ? c.reach.toLocaleString() : '—'} />
          <Metric label="CTR" value={c.ctr > 0 ? `${c.ctr.toFixed(2)}%` : '—'} color={c.ctr > 3 ? COLORS.green : c.ctr > 0 && c.ctr < 1 ? COLORS.orange : COLORS.cream} />
          <Metric label="CPM" value={c.cpm > 0 ? `₱${c.cpm.toFixed(0)}` : '—'} color={c.cpm > 0 && c.cpm < 50 ? COLORS.green : c.cpm > 80 ? COLORS.orange : COLORS.cream} />
        </div>
      )}

      {/* Action row — view links + pause/resume/delete/boost-again */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <LinkButton label="VIEW POST →" color={COLORS.blue} href={postUrl(pageId, c.postPhotoId)} />
        <LinkButton label="ADS MANAGER →" color={COLORS.gold} href={adsManagerUrl(adAccountId, c.campaignId)} />
        {!isShell && isActive && (
          <ActionButton
            label={thisBusy ? '...' : 'PAUSE'}
            color={COLORS.orange}
            disabled={thisBusy}
            onClick={() => onAction('pause', { campaignId: c.campaignId })}
          />
        )}
        {!isShell && isPaused && (
          <ActionButton
            label={thisBusy ? '...' : 'RESUME'}
            color={COLORS.green}
            disabled={thisBusy}
            onClick={() => onAction('resume', { campaignId: c.campaignId })}
          />
        )}
        {!isShell && c.postPhotoId && (
          <ActionButton
            label={thisBusy ? '...' : 'BOOST AGAIN'}
            color={COLORS.yellow}
            disabled={thisBusy}
            onClick={() => onAction('boost-again', { postId: c.postPhotoId })}
          />
        )}
        {(isShell || isPaused) && (
          <ActionButton
            label={thisBusy ? '...' : 'DELETE'}
            color={COLORS.red}
            disabled={thisBusy}
            onClick={() => onAction('delete', { campaignId: c.campaignId })}
          />
        )}
      </div>
    </div>
  )
}

function PerformanceRow({
  p, pageId, adAccountId, onAction, busy,
}: {
  p: BoostScaler['winners'][number]
  pageId: string
  adAccountId: string
  onAction: (action: 'pause' | 'resume' | 'delete' | 'boost-again', payload: Record<string, string>) => Promise<void>
  busy: string | null
}) {
  const thisBusy = busy === p.campaignId
  return (
    <div style={{
      background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: '14px 18px',
      marginBottom: 8,
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
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Metric
          label="Messages"
          value={p.messagingConversations > 0 ? String(p.messagingConversations) : (p.spend < 100 ? 'ramping' : '0')}
          color={p.messagingConversations > 0 ? COLORS.green : (p.spend < 100 ? COLORS.muted : COLORS.orange)}
        />
        <Metric
          label="₱/Msg"
          value={p.costPerMessage > 0 ? `₱${p.costPerMessage.toFixed(2)}` : '—'}
          color={p.costPerMessage > 0 && p.costPerMessage < 30 ? COLORS.green : p.costPerMessage > 80 ? COLORS.orange : COLORS.cream}
        />
        <Metric label="Spent" value={`₱${p.spend.toFixed(0)}`} />
        <Metric label="CTR" value={`${p.ctr.toFixed(2)}%`} color={p.ctr > 3 ? COLORS.green : p.ctr < 1.5 ? COLORS.orange : COLORS.cream} />
        <Metric label="CPM" value={`₱${p.cpm.toFixed(0)}`} color={p.cpm < 50 ? COLORS.green : p.cpm > 80 ? COLORS.orange : COLORS.cream} />
        <Metric label="Reach" value={p.reach.toLocaleString()} />
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <LinkButton label="VIEW POST →" color={COLORS.blue} href={postUrl(pageId, p.postPhotoId)} />
        <LinkButton label="ADS MANAGER →" color={COLORS.gold} href={adsManagerUrl(adAccountId, p.campaignId)} />
        <ActionButton
          label={thisBusy ? '...' : 'PAUSE'}
          color={COLORS.orange}
          disabled={thisBusy}
          onClick={() => onAction('pause', { campaignId: p.campaignId })}
        />
        <ActionButton
          label={thisBusy ? '...' : 'BOOST AGAIN'}
          color={COLORS.yellow}
          disabled={thisBusy}
          onClick={() => onAction('boost-again', { postId: p.postPhotoId })}
        />
      </div>
    </div>
  )
}

export default function BoostStatsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'scaler' | 'all'>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  async function load() {
    setError(null)
    try {
      const res = await fetch('/api/boost-stats')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as Data
      setData(json)
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function onAction(action: 'pause' | 'resume' | 'delete' | 'boost-again', payload: Record<string, string>) {
    const confirmMsg: Record<string, string> = {
      delete: 'Delete this campaign permanently? This cannot be undone.',
      'boost-again': 'Create a NEW boost campaign for this post? It will start spending at the configured daily budget immediately.',
    }
    if (confirmMsg[action] && !window.confirm(confirmMsg[action])) return

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

  useEffect(() => {
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1000, margin: '0 auto' }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: COLORS.muted }}>Loading boost stats from Facebook...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1000, margin: '0 auto' }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: COLORS.red }}>⚠️ {error}</p>
        <button onClick={load} style={{ marginTop: 16, padding: '6px 14px', background: 'transparent', border: `1px solid ${COLORS.borderHi}`, borderRadius: 6, color: COLORS.gold, fontFamily: 'DM Mono, monospace', fontSize: 12, cursor: 'pointer' }}>RETRY</button>
      </div>
    )
  }

  if (!data) return null

  const { campaigns, scaler } = data
  const active = campaigns.filter(c => c.adStatus === 'ACTIVE')
  const shells = campaigns.filter(c => c.adStatus === 'NO_AD')

  return (
    <div style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 1000, margin: '0 auto', color: COLORS.cream }}>
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.3em', marginBottom: 8 }}>
          AD GENERATOR
        </p>
        <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 36, fontWeight: 300, color: COLORS.cream, marginBottom: 24 }}>
          Boost Stats
        </h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href="/" style={{ padding: '8px 20px', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.muted, fontFamily: 'DM Mono, monospace', fontSize: 12, letterSpacing: '0.1em', textDecoration: 'none' }}>← DASHBOARD</a>
          <button onClick={load} style={{ padding: '8px 20px', border: `1px solid ${COLORS.borderHi}`, borderRadius: 6, background: 'transparent', color: COLORS.gold, fontFamily: 'DM Mono, monospace', fontSize: 12, letterSpacing: '0.1em', cursor: 'pointer' }}>REFRESH</button>
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.dim }}>auto-refresh every 60s</span>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 50,
          background: COLORS.card,
          border: `1px solid ${toast.kind === 'ok' ? COLORS.green : COLORS.red}80`,
          borderRadius: 8,
          padding: '12px 20px',
          fontFamily: 'DM Mono, monospace',
          fontSize: 12,
          color: toast.kind === 'ok' ? COLORS.green : COLORS.red,
          letterSpacing: '0.08em',
          maxWidth: 360,
        }}>
          {toast.kind === 'ok' ? '✓ ' : '⚠️ '}{toast.msg}
        </div>
      )}

      {/* Top-line metrics — messages first, since that's the actual win condition */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div style={{ background: COLORS.card, border: `1px solid ${scaler.totalMessages > 0 ? COLORS.green + '60' : COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>MESSAGES</p>
          <p style={{ fontSize: 22, color: scaler.totalMessages > 0 ? COLORS.green : COLORS.cream, fontFamily: 'DM Mono, monospace' }}>{scaler.totalMessages.toLocaleString()}</p>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>COST / MSG</p>
          <p style={{ fontSize: 22, color: scaler.avgCostPerMessage > 0 && scaler.avgCostPerMessage < 30 ? COLORS.green : scaler.avgCostPerMessage > 80 ? COLORS.orange : COLORS.cream, fontFamily: 'DM Mono, monospace' }}>{scaler.avgCostPerMessage > 0 ? `₱${scaler.avgCostPerMessage.toFixed(2)}` : '—'}</p>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>TOTAL SPEND</p>
          <p style={{ fontSize: 22, color: COLORS.cream, fontFamily: 'DM Mono, monospace' }}>₱{scaler.totalSpend.toFixed(0)}</p>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>AVG CTR</p>
          <p style={{ fontSize: 22, color: scaler.avgCTR > 3 ? COLORS.green : COLORS.cream, fontFamily: 'DM Mono, monospace' }}>{scaler.avgCTR.toFixed(2)}%</p>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, color: COLORS.dim, fontFamily: 'DM Mono, monospace', letterSpacing: '0.1em', marginBottom: 4 }}>TOTAL REACH</p>
          <p style={{ fontSize: 22, color: COLORS.cream, fontFamily: 'DM Mono, monospace' }}>{scaler.totalReach.toLocaleString()}</p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `1px solid ${COLORS.border}` }}>
        {([['overview', 'OVERVIEW'], ['scaler', 'SCALER'], ['all', 'ALL CAMPAIGNS']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${tab === key ? COLORS.gold : 'transparent'}`,
              color: tab === key ? COLORS.gold : COLORS.muted,
              fontFamily: 'DM Mono, monospace',
              fontSize: 12,
              letterSpacing: '0.15em',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em', marginBottom: 12 }}>
            ACTIVE CAMPAIGNS — {active.length}
          </p>
          {active.length === 0 ? (
            <p style={{ color: COLORS.muted, fontSize: 13, padding: '20px 0' }}>No active boost campaigns right now.</p>
          ) : active.map(c => <CampaignRow key={c.campaignId} c={c} pageId={data.pageId} adAccountId={data.adAccountId} onAction={onAction} busy={busy} />)}

          {shells.length > 0 && (
            <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.orange, marginTop: 24 }}>
              ⚠️ {shells.length} empty shell{shells.length === 1 ? '' : 's'} — run <code style={{ color: COLORS.gold }}>cleanup shells</code> in Discord to remove.
            </p>
          )}
        </div>
      )}

      {tab === 'scaler' && (
        <div>
          {scaler.winners.length > 0 && (
            <>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.green, letterSpacing: '0.2em', marginBottom: 12 }}>
                🏆 WINNERS — {scaler.winners.length} (replicate these)
              </p>
              {scaler.winners.map(p => <PerformanceRow key={p.campaignId} p={p} pageId={data.pageId} adAccountId={data.adAccountId} onAction={onAction} busy={busy} />)}
            </>
          )}
          {scaler.mids.length > 0 && (
            <>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.yellow, letterSpacing: '0.2em', marginTop: 24, marginBottom: 12 }}>
                🟡 MID — {scaler.mids.length}
              </p>
              {scaler.mids.map(p => <PerformanceRow key={p.campaignId} p={p} pageId={data.pageId} adAccountId={data.adAccountId} onAction={onAction} busy={busy} />)}
            </>
          )}
          {scaler.losers.length > 0 && (
            <>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.red, letterSpacing: '0.2em', marginTop: 24, marginBottom: 12 }}>
                🔴 LOSERS — {scaler.losers.length} (avoid this pattern)
              </p>
              {scaler.losers.map(p => <PerformanceRow key={p.campaignId} p={p} pageId={data.pageId} adAccountId={data.adAccountId} onAction={onAction} busy={busy} />)}
            </>
          )}
          {scaler.winners.length === 0 && scaler.mids.length === 0 && scaler.losers.length === 0 && (
            <p style={{ color: COLORS.muted, fontSize: 13, padding: '20px 0' }}>
              No measurable boost data yet — boosts need spend &gt; ₱0 to be scored.
            </p>
          )}

          {(scaler.topTemplates.length > 0 || scaler.worstTemplates.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 32 }}>
              {scaler.topTemplates.length > 0 && (
                <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '16px 20px' }}>
                  <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.green, letterSpacing: '0.15em', marginBottom: 12 }}>🎯 BEST CATEGORIES</p>
                  {scaler.topTemplates.filter(t => t.count > 0).map((t, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 14, color: COLORS.cream }}>{t.label}</p>
                      <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.muted }}>
                        score {t.avgScore.toFixed(1)}/9
                        {t.avgCostPerMessage > 0 && ` · avg ₱${t.avgCostPerMessage.toFixed(2)}/msg`}
                        {` · ${t.count} boost${t.count === 1 ? '' : 's'}`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {scaler.worstTemplates.length > 0 && scaler.worstTemplates[0].label !== scaler.topTemplates[0]?.label && (
                <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '16px 20px' }}>
                  <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.red, letterSpacing: '0.15em', marginBottom: 12 }}>⚠️ WEAKEST CATEGORIES</p>
                  {scaler.worstTemplates.filter(t => t.count > 0).map((t, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 14, color: COLORS.cream }}>{t.label}</p>
                      <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: COLORS.muted }}>
                        score {t.avgScore.toFixed(1)}/9
                        {t.avgCostPerMessage > 0 && ` · avg ₱${t.avgCostPerMessage.toFixed(2)}/msg`}
                        {` · ${t.count} boost${t.count === 1 ? '' : 's'}`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'all' && (
        <div>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: COLORS.muted, letterSpacing: '0.2em', marginBottom: 12 }}>
            ALL CAMPAIGNS — {campaigns.length}
          </p>
          {campaigns.map(c => <CampaignRow key={c.campaignId} c={c} pageId={data.pageId} adAccountId={data.adAccountId} onAction={onAction} busy={busy} />)}
        </div>
      )}
    </div>
  )
}
