import { NextRequest, NextResponse } from 'next/server'
import { pauseBoostCampaign, resumeBoostCampaign, deleteCampaign, boostPost } from '@/lib/facebook'
import { loadSettings } from '@/lib/brandSettings'

export const dynamic = 'force-dynamic'

type Body =
  | { action: 'pause'; campaignId: string }
  | { action: 'resume'; campaignId: string }
  | { action: 'delete'; campaignId: string }
  | { action: 'boost-again'; postId: string }

export async function POST(req: NextRequest) {
  let body: Body
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  try {
    switch (body.action) {
      case 'pause': {
        await pauseBoostCampaign(body.campaignId)
        return NextResponse.json({ ok: true, message: 'Campaign paused' })
      }
      case 'resume': {
        await resumeBoostCampaign(body.campaignId)
        return NextResponse.json({ ok: true, message: 'Campaign resumed' })
      }
      case 'delete': {
        await deleteCampaign(body.campaignId)
        return NextResponse.json({ ok: true, message: 'Campaign deleted' })
      }
      case 'boost-again': {
        const pageId = process.env.FACEBOOK_PAGE_ID
        if (!pageId) return NextResponse.json({ error: 'FACEBOOK_PAGE_ID not set' }, { status: 500 })
        const s = loadSettings()
        const objectStoryId = `${pageId}_${body.postId}`
        const adsUrl = await boostPost(
          objectStoryId,
          s.boostBudgetPHP ?? 250,
          s.boostAgeMin ?? 25,
          s.boostAgeMax ?? 60,
          s.boostCountry ?? 'PH',
        )
        return NextResponse.json({ ok: true, message: 'New boost created', adsUrl })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
