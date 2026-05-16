import { NextRequest, NextResponse } from 'next/server'
import { pauseBoostCampaign, resumeBoostCampaign, deleteCampaign } from '@/lib/facebook'

export const dynamic = 'force-dynamic'

type Body = { action: 'pause' | 'resume' | 'delete'; campaignIds: string[] }

export async function POST(req: NextRequest) {
  let body: Body
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (!Array.isArray(body.campaignIds) || body.campaignIds.length === 0) {
    return NextResponse.json({ error: 'campaignIds must be a non-empty array' }, { status: 400 })
  }

  const fn = body.action === 'pause' ? pauseBoostCampaign
    : body.action === 'resume' ? resumeBoostCampaign
    : body.action === 'delete' ? deleteCampaign
    : null
  if (!fn) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  const ok: string[] = []
  const failed: Array<{ id: string; err: string }> = []
  for (const id of body.campaignIds) {
    try { await fn(id); ok.push(id) }
    catch (err: any) { failed.push({ id, err: err.message }) }
  }
  return NextResponse.json({ ok: ok.length, failed })
}
