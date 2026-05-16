import { NextRequest, NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@/lib/brandSettings'

export const dynamic = 'force-dynamic'

export async function GET() {
  const s = loadSettings()
  return NextResponse.json({
    autoBoostEnabled: s.autoBoostEnabled,
    autoPauseEnabled: s.autoPauseEnabled,
    autoPauseCpmThreshold: s.autoPauseCpmThreshold,
    autoPauseMinSpend: s.autoPauseMinSpend,
    autoBoostAgainEnabled: s.autoBoostAgainEnabled,
    autoBoostAgainMinScore: s.autoBoostAgainMinScore,
    autoBoostAgainCooldownDays: s.autoBoostAgainCooldownDays,
    boostBudgetPHP: s.boostBudgetPHP,
    boostAgeMin: s.boostAgeMin,
    boostAgeMax: s.boostAgeMax,
    boostCountry: s.boostCountry,
  })
}

export async function POST(req: NextRequest) {
  try {
    const patch = await req.json()
    const allowed = [
      'autoBoostEnabled', 'autoPauseEnabled', 'autoPauseCpmThreshold', 'autoPauseMinSpend',
      'autoBoostAgainEnabled', 'autoBoostAgainMinScore', 'autoBoostAgainCooldownDays',
      'boostBudgetPHP', 'boostAgeMin', 'boostAgeMax', 'boostCountry',
    ] as const
    const clean: Record<string, any> = {}
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k]
    }
    const current = loadSettings()
    saveSettings({ ...current, ...clean })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
