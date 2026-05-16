import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { analyzeBoostScaler } from '@/lib/fbInsights'

export const dynamic = 'force-dynamic'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '7d'
  try {
    const scaler = await analyzeBoostScaler(range)
    if (scaler.winners.length + scaler.mids.length + scaler.losers.length === 0) {
      return NextResponse.json({ recommendations: ['Not enough boost data yet — boost some posts first.'] })
    }

    const summary = [
      `Total spend: ₱${scaler.totalSpend.toFixed(0)}, ${scaler.totalMessages} messages, avg ₱${scaler.avgCostPerMessage.toFixed(2)}/msg`,
      ``,
      `WINNERS (${scaler.winners.length}):`,
      ...scaler.winners.map(p => `- ${p.label} — ${p.messagingConversations} msgs @ ₱${p.costPerMessage.toFixed(0)}/msg, CTR ${p.ctr.toFixed(2)}%`),
      ``,
      `MIDS (${scaler.mids.length}):`,
      ...scaler.mids.map(p => `- ${p.label} — ${p.messagingConversations} msgs @ ₱${p.costPerMessage.toFixed(0)}/msg, CTR ${p.ctr.toFixed(2)}%`),
      ``,
      `LOSERS (${scaler.losers.length}):`,
      ...scaler.losers.map(p => `- ${p.label} — ${p.messagingConversations} msgs @ ₱${p.costPerMessage.toFixed(0)}/msg, CTR ${p.ctr.toFixed(2)}%`),
    ].join('\n')

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `You are a Facebook Ads analyst for Renaissance Park & Chapels, a Philippine memorial park. Given a boost performance summary, produce 3-5 SHORT, actionable recommendations.

Guidelines:
- Be specific: name the exact category and action (e.g. "Pause Light Emotional", "Scale Educational to ₱500/day")
- Lead with the highest-impact action
- Use emojis: 🎯 scale, ⚠️ caution, ⏸️ pause, 🚀 boost-again, 🔍 investigate
- Each line ≤ 100 chars
- Memorial services have ₱100K+ LTV — ₱150/msg is good, ₱300+ is expensive

Respond ONLY as a JSON array of strings.
Example: ["🎯 Scale Educational — ₱137/msg is your best converter", "⏸️ Pause Light Emotional — 2.28% CTR is below threshold"]`,
      messages: [{ role: 'user', content: summary }],
    })

    const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
    const recommendations = JSON.parse(raw.replace(/```json|```/g, '').trim())
    return NextResponse.json({ recommendations })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
