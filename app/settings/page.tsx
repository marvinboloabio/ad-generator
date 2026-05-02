'use client'

import { useEffect, useState } from 'react'

interface Settings {
  bgColor: string; accentColor: string; accentDark: string
  offWhite: string; bodyText: string
  footerRight1: string; footerRight2: string
  logoUrl: string
  staffName: string; staffRole: string; staffAvatarUrl: string
  claudeInstructions: string
  [key: string]: unknown
}

const mono: React.CSSProperties = { fontFamily: 'DM Mono, Consolas, monospace' }
const gold = '#C9A84C'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <p style={{ ...mono, fontSize: 10, color: '#7A7870', letterSpacing: '0.25em', marginBottom: 16, textTransform: 'uppercase' }}>
        {title}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <span style={{ ...mono, fontSize: 12, color: '#7A7870', minWidth: 180 }}>{label}</span>
      {children}
    </div>
  )
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        flex: 1, minWidth: 200, background: '#111', border: '1px solid #2A2A2A',
        borderRadius: 6, padding: '7px 12px', color: '#F0EDE6',
        fontFamily: 'DM Mono, monospace', fontSize: 13, outline: 'none',
      }}
    />
  )
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: 40, height: 36, border: '1px solid #2A2A2A', borderRadius: 6, cursor: 'pointer', background: 'none', padding: 2 }}
      />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: 100, background: '#111', border: '1px solid #2A2A2A',
          borderRadius: 6, padding: '7px 10px', color: '#F0EDE6',
          fontFamily: 'DM Mono, monospace', fontSize: 12, outline: 'none',
        }}
      />
    </div>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings)
  }, [])

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings(prev => prev ? { ...prev, [key]: value } : prev)
    setSaved(false)
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function uploadLogo(file: File) {
    setLogoUploading(true)
    const form = new FormData()
    form.append('logo', file)
    const res = await fetch('/api/settings/logo', { method: 'POST', body: form })
    const json = await res.json()
    if (json.url) {
      setSettings(prev => prev ? { ...prev, logoUrl: json.url } : prev)
      setLogoPreview(json.url + '?t=' + Date.now())
    }
    setLogoUploading(false)
  }

  async function removeLogo() {
    await fetch('/api/settings/logo', { method: 'DELETE' })
    setSettings(prev => prev ? { ...prev, logoUrl: '' } : prev)
    setLogoPreview(null)
  }

  async function uploadAvatar(file: File) {
    setAvatarUploading(true)
    const form = new FormData()
    form.append('avatar', file)
    const res = await fetch('/api/settings/avatar', { method: 'POST', body: form })
    const json = await res.json()
    if (json.url) {
      setSettings(prev => prev ? { ...prev, staffAvatarUrl: json.url } : prev)
      setAvatarPreview(json.url + '?t=' + Date.now())
    }
    setAvatarUploading(false)
  }

  async function removeAvatar() {
    await fetch('/api/settings/avatar', { method: 'DELETE' })
    setSettings(prev => prev ? { ...prev, staffAvatarUrl: '' } : prev)
    setAvatarPreview(null)
  }

  if (!settings) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ ...mono, color: '#7A7870', fontSize: 13 }}>Loading...</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', padding: '40px 24px', maxWidth: 760, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <a href="/" style={{ ...mono, fontSize: 11, color: '#7A7870', textDecoration: 'none', letterSpacing: '0.1em' }}>
          ← BACK
        </a>
        <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 32, fontWeight: 300, color: '#F0EDE6', marginTop: 16, marginBottom: 6 }}>
          Brand Settings
        </h1>
        <p style={{ ...mono, fontSize: 12, color: '#7A7870' }}>
          These settings apply to every ad generated by the bot.
        </p>
      </div>

      {/* BUSINESS IDENTITY */}
      <Section title="Business Identity">
        <Field label="Brand Name Line 1"><TextInput value={settings.footerRight1} onChange={v => set('footerRight1', v)} /></Field>
        <Field label="Brand Name Line 2"><TextInput value={settings.footerRight2} onChange={v => set('footerRight2', v)} /></Field>
      </Section>

      {/* LOGO */}
      <Section title="Brand Logo">
        <p style={{ ...mono, fontSize: 11, color: '#7A7870', lineHeight: 1.6 }}>
          Preset logo used on every ad. PNG or SVG with transparent background works best.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{
            width: 160, height: 80, background: '#071f17', border: '1px solid #2A2A2A',
            borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {(logoPreview || settings.logoUrl) ? (
              <img src={logoPreview ?? settings.logoUrl} alt="logo preview"
                style={{ maxWidth: 140, maxHeight: 64, objectFit: 'contain' }} />
            ) : (
              <span style={{ ...mono, fontSize: 11, color: '#3A3830' }}>no logo set</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{
              display: 'inline-block', padding: '7px 18px',
              background: logoUploading ? 'transparent' : `linear-gradient(135deg, ${gold}, #f0d060)`,
              border: `1px solid ${gold}`, borderRadius: 6,
              color: logoUploading ? gold : '#0c2a22',
              fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.08em', cursor: logoUploading ? 'default' : 'pointer',
            }}>
              {logoUploading ? 'UPLOADING...' : 'UPLOAD LOGO'}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={logoUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f) }} />
            </label>
            {settings.logoUrl && (
              <button onClick={removeLogo} style={{
                padding: '7px 18px', background: 'transparent',
                border: '1px solid #3A2020', borderRadius: 6, color: '#8A4040',
                fontFamily: 'DM Mono, monospace', fontSize: 12, cursor: 'pointer',
              }}>REMOVE LOGO</button>
            )}
          </div>
        </div>
      </Section>

      {/* STAFF */}
      <Section title="Default Staff Member">
        <p style={{ ...mono, fontSize: 11, color: '#7A7870', lineHeight: 1.6 }}>
          Name shown in photo briefs. Avatar shown as icon on ads. Leave name blank to hide.
        </p>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 88, height: 88, borderRadius: '50%', flexShrink: 0,
              background: '#071f17', border: `2px solid ${gold}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}>
              {(avatarPreview || settings.staffAvatarUrl) ? (
                <img src={avatarPreview ?? settings.staffAvatarUrl} alt="avatar"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ ...mono, fontSize: 10, color: '#3A3830', textAlign: 'center', padding: 4 }}>no photo</span>
              )}
            </div>
            <label style={{
              padding: '5px 14px',
              background: avatarUploading ? 'transparent' : `linear-gradient(135deg, ${gold}, #f0d060)`,
              border: `1px solid ${gold}`, borderRadius: 6,
              color: avatarUploading ? gold : '#0c2a22',
              fontFamily: 'DM Mono, monospace', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.08em', cursor: avatarUploading ? 'default' : 'pointer',
            }}>
              {avatarUploading ? 'UPLOADING...' : 'UPLOAD PHOTO'}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={avatarUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadAvatar(f) }} />
            </label>
            {settings.staffAvatarUrl && (
              <button onClick={removeAvatar} style={{
                padding: '5px 14px', background: 'transparent',
                border: '1px solid #3A2020', borderRadius: 6, color: '#8A4040',
                fontFamily: 'DM Mono, monospace', fontSize: 11, cursor: 'pointer',
              }}>REMOVE</button>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
            <Field label="Full Name"><TextInput value={settings.staffName} onChange={v => set('staffName', v)} /></Field>
            <Field label="Position / Title"><TextInput value={settings.staffRole} onChange={v => set('staffRole', v)} /></Field>
          </div>
        </div>
      </Section>

      {/* COLORS */}
      <Section title="Colors">
        <Field label="Background"><ColorInput value={settings.bgColor} onChange={v => set('bgColor', v)} /></Field>
        <Field label="Gold Accent"><ColorInput value={settings.accentColor} onChange={v => set('accentColor', v)} /></Field>
        <Field label="Gold Dark"><ColorInput value={settings.accentDark} onChange={v => set('accentDark', v)} /></Field>
        <Field label="Heading Text"><ColorInput value={settings.offWhite} onChange={v => set('offWhite', v)} /></Field>
        <Field label="Body Text"><ColorInput value={settings.bodyText} onChange={v => set('bodyText', v)} /></Field>
      </Section>

      {/* EXTRA INSTRUCTIONS */}
      <Section title="Extra Instructions for Claude">
        <p style={{ ...mono, fontSize: 11, color: '#7A7870', lineHeight: 1.6 }}>
          Brand tone, language style, or anything Claude should always follow when writing copy.
        </p>
        <textarea
          value={settings.claudeInstructions}
          onChange={e => set('claudeInstructions', e.target.value)}
          placeholder="Example: Always write in Filipino-English mix. Use formal but warm tone."
          rows={4}
          style={{
            width: '100%', background: '#111', border: '1px solid #2A2A2A',
            borderRadius: 6, padding: '10px 14px', color: '#F0EDE6',
            fontFamily: 'DM Mono, monospace', fontSize: 12, outline: 'none',
            resize: 'vertical', lineHeight: 1.6,
          }}
        />
      </Section>

      {/* SAVE */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: 8 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: '10px 28px',
            background: saving ? 'transparent' : `linear-gradient(135deg, ${gold}, #f0d060)`,
            border: `1px solid ${gold}`,
            borderRadius: 6, color: saving ? gold : '#0c2a22',
            fontFamily: 'DM Mono, monospace', fontSize: 13,
            fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer',
          }}
        >
          {saving ? 'SAVING...' : 'SAVE SETTINGS'}
        </button>
        {saved && (
          <span style={{ ...mono, fontSize: 12, color: '#4CAF73' }}>
            ✓ Saved
          </span>
        )}
      </div>
    </div>
  )
}
