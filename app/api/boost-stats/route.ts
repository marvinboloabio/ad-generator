import { NextResponse } from 'next/server'
import { fetchBoostCampaignInsights, analyzeBoostScaler } from '@/lib/fbInsights'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [campaigns, scaler] = await Promise.all([
      fetchBoostCampaignInsights(),
      analyzeBoostScaler(),
    ])
    return NextResponse.json({
      campaigns,
      scaler,
      pageId: process.env.FACEBOOK_PAGE_ID ?? '',
      adAccountId: process.env.FB_AD_ACCOUNT_ID ?? '',
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
