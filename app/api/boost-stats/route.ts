import { NextRequest, NextResponse } from 'next/server'
import { fetchBoostCampaignInsights, analyzeBoostScaler } from '@/lib/fbInsights'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '7d'
  try {
    const [campaigns, scaler] = await Promise.all([
      fetchBoostCampaignInsights(range),
      analyzeBoostScaler(range),
    ])
    return NextResponse.json({
      campaigns,
      scaler,
      pageId: process.env.FACEBOOK_PAGE_ID ?? '',
      adAccountId: process.env.FB_AD_ACCOUNT_ID ?? '',
      range,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
