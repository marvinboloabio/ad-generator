import Anthropic from '@anthropic-ai/sdk'
import { AdBrief, MediaAsset } from '@/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function parseJSON(text: string) {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return JSON.parse(stripped)
}

export async function generateClarifyingQuestions(brief: AdBrief): Promise<string> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system:
      `You are a creative director for Facebook photo ads (1200×628px). Ask the user exactly 5 short, friendly questions to fill in the ad template. Number them 1–5. Keep it conversational and concise.

The ad template has these slots you need to fill:
1. Two feature boxes (e.g. "PARK LOTS / Available Now" and "CHAPEL SERVICES / 24/7 Support") — ask what 2 key services or selling points to highlight, with a short status/value under each
2. A featured staff member — ask for the name and job title of one person to feature (or say "skip" to leave it out)
3. Tagline + years in business — ask for a short tagline and the year the business started (for "Serving families with grace since YEAR")
4. Location — ask what city/region to show in the footer
5. Call-to-action — ask what the CTA button should say (e.g. "INQUIRE NOW", "BOOK NOW", "CALL US TODAY")`,
    messages: [
      {
        role: 'user',
        content: `Ad brief — Business: ${brief.product}. Concept: ${brief.concept}.`,
      },
    ],
  })

  return (msg.content[0] as { text: string }).text
}

export async function parseClarifyingAnswers(
  brief: AdBrief,
  userReply: string
): Promise<Partial<AdBrief>> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system:
      `Extract structured data from the user's answers to 5 Facebook ad clarifying questions.
Respond ONLY with valid JSON — no markdown fences:
{
  "features": [
    { "label": "SERVICE NAME", "value": "short status" },
    { "label": "SERVICE NAME", "value": "short status" }
  ],
  "staffName": "full name or null",
  "staffRole": "job title or null",
  "tagline": "short tagline or null",
  "yearFounded": "4-digit year or null",
  "location": "city/region or null",
  "ctaText": "CTA button text or null"
}
Rules: feature labels should be UPPERCASE. If user says skip/none for staff, set staffName and staffRole to null.`,
    messages: [
      {
        role: 'user',
        content: `Business: ${brief.product}. Concept: ${brief.concept}.\n\nUser answers:\n${userReply}`,
      },
    ],
  })

  try {
    const raw = (msg.content[0] as { text: string }).text
    return parseJSON(raw) as Partial<AdBrief>
  } catch {
    return {}
  }
}

export async function evaluateMedia(
  assets: MediaAsset[],
  brief: AdBrief
): Promise<{ scored: MediaAsset[]; missingShots: string[]; ready: boolean }> {
  const assetList = assets
    .map((a) => `- ${a.name} (${a.mimeType}) — ID: ${a.id}`)
    .join('\n')

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system:
      'You are a video production supervisor. Evaluate the provided media assets against the ad brief. Score each asset 0–100 for relevance and quality. List what shots are missing. Respond ONLY with valid JSON matching this schema: {"scores": [{"id": string, "score": number, "feedback": string}], "missingShots": string[], "ready": boolean}',
    messages: [
      {
        role: 'user',
        content: `Brief: ${JSON.stringify(brief)}\n\nAvailable assets:\n${assetList}`,
      },
    ],
  })

  const raw = (msg.content[0] as { text: string }).text
  const parsed = parseJSON(raw)

  const scored = assets.map((a) => {
    const match = parsed.scores.find((s: { id: string }) => s.id === a.id)
    return match ? { ...a, score: match.score, feedback: match.feedback } : a
  })

  return { scored, missingShots: parsed.missingShots ?? [], ready: parsed.ready ?? false }
}

