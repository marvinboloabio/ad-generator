import Anthropic from '@anthropic-ai/sdk'
import { loadSettings } from './brandSettings'
import { AssetScore, AssetType } from './assetStore'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ScoringResult {
  passed: boolean
  overallScore: AssetScore | null
  assetType: AssetType
  imageDescription: string    // Claude's own description of what's in the image
  qualityScore: number
  relevanceScore: number
  brandScore: number
  qualityNotes: string
  relevanceNotes: string
  brandNotes: string
  rejectionReason?: string
  tags: string[]
}

async function scoreImageSource(
  imageSource: Anthropic.ImageBlockParam['source'],
  submitterContext: string,
  submitterName: string
): Promise<ScoringResult> {
  const s = loadSettings()

  const contextLine = submitterContext
    ? `Submitter's context: "${submitterContext}"`
    : 'No caption provided — describe the image yourself.'

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: imageSource },
        {
          type: 'text',
          text: `You are a content quality evaluator for ${s.footerRight1} ${s.footerRight2}, a Philippine memorial park and chapel services brand.

Submitted by: "${submitterName}"
${contextLine}

Evaluate this image. Respond ONLY with valid JSON, no markdown:
{
  "imageDescription": "one sentence describing exactly what is in this image (ignore the submitter's caption — describe what you actually see)",
  "assetType": "one of: photo | logo | avatar | background | illustration | other",
  "quality": {
    "score": <1-10>,
    "notes": "clarity, composition, lighting, resolution"
  },
  "relevance": {
    "score": <1-10>,
    "relevant": <true|false>,
    "notes": "is this suitable content for a professional Philippine memorial park brand?"
  },
  "brand": {
    "score": <1-10>,
    "notes": "does this match a dignified, warm, professional memorial park aesthetic?"
  },
  "tags": ["up to 6 descriptive lowercase tags"],
  "rejectionReason": "one sentence reason if any score below 5 or not relevant, otherwise null"
}`,
        },
      ],
    }],
  })

  const raw = (msg.content[0] as { text: string }).text
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const data = JSON.parse(stripped)

  const qualityScore: number = data.quality.score
  const relevanceScore: number = data.relevance.score
  const brandScore: number = data.brand.score
  const isRelevant: boolean = data.relevance.relevant

  const passed = isRelevant && qualityScore >= 5 && brandScore >= 5

  let overallScore: AssetScore | null = null
  if (passed) {
    const avg = (qualityScore + brandScore) / 2
    if (avg >= 8.5) overallScore = 'featured'
    else if (avg >= 7) overallScore = 'high'
    else if (avg >= 6) overallScore = 'medium'
    else overallScore = 'low'
  }

  const validTypes: AssetType[] = ['photo', 'logo', 'avatar', 'background', 'illustration', 'other']
  const assetType: AssetType = validTypes.includes(data.assetType) ? data.assetType : 'other'

  return {
    passed,
    overallScore,
    assetType,
    imageDescription: data.imageDescription ?? submitterContext ?? 'Unclassified asset',
    qualityScore,
    relevanceScore,
    brandScore,
    qualityNotes: data.quality.notes,
    relevanceNotes: data.relevance.notes,
    brandNotes: data.brand.notes,
    rejectionReason: data.rejectionReason ?? undefined,
    tags: Array.isArray(data.tags) ? data.tags : [],
  }
}

export async function scoreAsset(
  imageUrl: string,
  submitterContext: string,
  submitterName: string
): Promise<ScoringResult> {
  return scoreImageSource({ type: 'url', url: imageUrl }, submitterContext, submitterName)
}

export async function scoreAssetFromBuffer(
  buffer: Buffer,
  submitterContext: string,
  submitterName: string
): Promise<ScoringResult> {
  const base64 = buffer.toString('base64')
  return scoreImageSource({ type: 'base64', media_type: 'image/jpeg', data: base64 }, submitterContext, submitterName)
}
