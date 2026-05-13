'use client'

import { useEffect, useState } from 'react'
import { Job, JobStatus } from '@/types'

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  clarifying: 'Clarifying Brief',
  evaluating: 'Evaluating Media',
  scripting: 'Generating Ad',
  rendering: 'Rendering',
  done: 'Done',
  needs_shots: 'Needs Images',
  failed: 'Failed',
}

const STATUS_COLORS: Record<JobStatus, string> = {
  pending: '#7A7870',
  clarifying: '#C9A84C',
  evaluating: '#C9A84C',
  scripting: '#E8D08A',
  rendering: '#E8D08A',
  done: '#4CAF73',
  needs_shots: '#E87B4C',
  failed: '#E84C4C',
}

function StatusDot({ status }: { status: JobStatus }) {
  const color = STATUS_COLORS[status]
  const pulse = ['clarifying', 'evaluating', 'scripting', 'rendering'].includes(status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          boxShadow: pulse ? `0 0 6px ${color}` : 'none',
          animation: pulse ? 'pulse 2s ease-in-out infinite' : 'none',
        }}
      />
      <span style={{ color, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        {STATUS_LABELS[status]}
      </span>
    </span>
  )
}

function JobCard({ job }: { job: Job }) {
  return (
    <div
      style={{
        background: '#111111',
        border: '1px solid #2A2A2A',
        borderRadius: 12,
        padding: '20px 24px',
        marginBottom: 12,
        transition: 'border-color 0.2s',
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(201,168,76,0.3)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = '#2A2A2A')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 18, color: '#F0EDE6', marginBottom: 4 }}>
            {job.brief.product}
          </p>
          <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: '#7A7870', letterSpacing: '0.1em' }}>
            {job.id}
          </p>
        </div>
        <StatusDot status={job.status} />
      </div>

      <p style={{ fontSize: 13, color: '#7A7870', marginBottom: 12, lineHeight: 1.5 }}>
        {job.brief.concept}
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {job.brief.tone && (
          <span style={{ fontSize: 11, color: '#7A7870', fontFamily: 'DM Mono, monospace' }}>
            Tone: <span style={{ color: '#C9A84C' }}>{job.brief.tone}</span>
          </span>
        )}
        {job.assets.length > 0 && (
          <span style={{ fontSize: 11, color: '#7A7870', fontFamily: 'DM Mono, monospace' }}>
            Assets: <span style={{ color: '#C9A84C' }}>{job.assets.length}</span>
          </span>
        )}
      </div>

      {job.missingShots && job.missingShots.length > 0 && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: '#1A1A1A', borderRadius: 8, border: '1px solid rgba(232,123,76,0.2)' }}>
          <p style={{ fontSize: 11, color: '#E87B4C', fontFamily: 'DM Mono, monospace', marginBottom: 6 }}>MISSING SHOTS</p>
          {job.missingShots.map((s, i) => (
            <p key={i} style={{ fontSize: 12, color: '#7A7870', marginBottom: 2 }}>• {s}</p>
          ))}
        </div>
      )}

      {(job.imageUrl || job.driveLink) && (
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          {job.imageUrl && (
            <a
              href={job.imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                padding: '6px 16px',
                background: 'transparent',
                border: '1px solid rgba(201,168,76,0.4)',
                borderRadius: 6,
                color: '#C9A84C',
                fontSize: 12,
                fontFamily: 'DM Mono, monospace',
                textDecoration: 'none',
                letterSpacing: '0.08em',
              }}
            >
              VIEW AD →
            </a>
          )}
          {job.driveLink && (
            <a
              href={job.driveLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                padding: '6px 16px',
                background: 'transparent',
                border: '1px solid rgba(100,150,255,0.4)',
                borderRadius: 6,
                color: '#6496FF',
                fontSize: 12,
                fontFamily: 'DM Mono, monospace',
                textDecoration: 'none',
                letterSpacing: '0.08em',
              }}
            >
              DRIVE →
            </a>
          )}
        </div>
      )}

      <p style={{ fontSize: 10, color: '#3A3830', fontFamily: 'DM Mono, monospace', marginTop: 12 }}>
        {new Date(job.createdAt).toLocaleString()}
      </p>
    </div>
  )
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [botStatus, setBotStatus] = useState<{ running: boolean; tag: string | null }>({ running: false, tag: null })
  const [loading, setLoading] = useState(true)

  async function fetchData() {
    const [jobsRes, botRes] = await Promise.all([fetch('/api/jobs'), fetch('/api/bot')])
    if (jobsRes.ok) setJobs(await jobsRes.json())
    if (botRes.ok) setBotStatus(await botRes.json())
    setLoading(false)
  }

  async function toggleBot() {
    const action = botStatus.running ? 'stop' : 'start'
    await fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    await fetchData()
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

  const activeJobs = jobs.filter((j) => !['done', 'failed'].includes(j.status))
  const doneJobs = jobs.filter((j) => ['done', 'failed'].includes(j.status))

  return (
    <div style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 800, margin: '0 auto' }}>
      <style>{`
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
      `}</style>

      <div style={{ marginBottom: 48 }}>
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: '#7A7870', letterSpacing: '0.3em', marginBottom: 8 }}>
          AD GENERATOR
        </p>
        <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 36, fontWeight: 300, color: '#F0EDE6', marginBottom: 24 }}>
          Production Pipeline
        </h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <a
            href="/settings"
            style={{
              padding: '8px 20px',
              border: '1px solid #2A2A2A',
              borderRadius: 6,
              background: 'transparent',
              color: '#7A7870',
              fontFamily: 'DM Mono, monospace',
              fontSize: 12,
              letterSpacing: '0.1em',
              textDecoration: 'none',
            }}
          >
            SETTINGS
          </a>
          <a
            href="/boost-stats"
            style={{
              padding: '8px 20px',
              border: '1px solid #2A2A2A',
              borderRadius: 6,
              background: 'transparent',
              color: '#7A7870',
              fontFamily: 'DM Mono, monospace',
              fontSize: 12,
              letterSpacing: '0.1em',
              textDecoration: 'none',
            }}
          >
            BOOST STATS
          </a>
          <button
            onClick={toggleBot}
            style={{
              padding: '8px 20px',
              border: `1px solid ${botStatus.running ? 'rgba(76,175,115,0.4)' : 'rgba(201,168,76,0.4)'}`,
              borderRadius: 6,
              background: 'transparent',
              color: botStatus.running ? '#4CAF73' : '#C9A84C',
              fontFamily: 'DM Mono, monospace',
              fontSize: 12,
              letterSpacing: '0.1em',
              cursor: 'pointer',
            }}
          >
            {botStatus.running ? 'STOP BOT' : 'START BOT'}
          </button>
          {botStatus.running && botStatus.tag && (
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: '#4CAF73' }}>
              {botStatus.tag} — online
            </span>
          )}
          {!botStatus.running && (
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: '#7A7870' }}>
              Bot offline
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: '#7A7870' }}>Loading...</p>
      ) : (
        <>
          {activeJobs.length > 0 && (
            <section style={{ marginBottom: 40 }}>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: '#7A7870', letterSpacing: '0.2em', marginBottom: 16 }}>
                ACTIVE — {activeJobs.length}
              </p>
              {activeJobs.map((job) => <JobCard key={job.id} job={job} />)}
            </section>
          )}

          {doneJobs.length > 0 && (
            <section>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: '#7A7870', letterSpacing: '0.2em', marginBottom: 16 }}>
                COMPLETED — {doneJobs.length}
              </p>
              {doneJobs.map((job) => <JobCard key={job.id} job={job} />)}
            </section>
          )}

          {jobs.length === 0 && (
            <div style={{ textAlign: 'center', padding: '80px 0' }}>
              <p style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 22, color: '#3A3830', marginBottom: 12 }}>
                No jobs yet
              </p>
              <p style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: '#3A3830' }}>
                Start the bot and type &quot;generate ad for...&quot; in Discord
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
