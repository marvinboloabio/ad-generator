import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface SceneBlock {
  description: string   // shown in Discord for editorial review
  visualPrompt: string  // sent to Runway for this clip
}

export interface VideoScript {
  scenes: [SceneBlock, SceneBlock, SceneBlock]  // exactly 3 × 10s scenes
  narration: string                              // full 30s voiceover (~75 words)
}

export async function generateVideoScript(
  caption: string,
  toneTag?: string,
  targetGeneration?: string,
): Promise<VideoScript> {
  const toneHint  = toneTag         ? `\nEmotional tone: ${toneTag.replace(/_/g, ' ')}` : ''
  const genHint   = targetGeneration ? `\nTarget audience: ${targetGeneration}` : ''

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    system: `You write 30-second video ad scripts for Renaissance Park & Chapels — a Philippine memorial park.

Structure: 3 scenes × 10 seconds each.

Scene roles:
- Scene 1 (0–10s): Emotional hook — a Filipino person or family experiencing the core emotion (grief, longing, love, memory). Intimate, close-up, warm lighting.
- Scene 2 (10–20s): Reflection — a quieter moment. The weight of feeling. A gesture, an object, a gaze. No dialogue.
- Scene 3 (20–30s): Resolution — a serene, beautiful memorial park. Manicured lawn, soft golden light, peaceful atmosphere. Dignified. A family in the distance.

Runway prompt rules (apply to every visualPrompt):
- Cinematic, photorealistic, Filipino setting
- Warm natural lighting, soft bokeh
- Slow camera movement: "slow push in" / "gentle pan" / "static wide shot"
- No text in frame, no logos, no fast movement

Narration rules:
- Calm, warm, empathetic voice
- Filipino-English mix is OK
- 70–80 words total (timed for 30 seconds at a calm pace)
- No hashtags, no hard sell
- Should feel like a quiet, caring voice speaking directly to someone grieving

Respond ONLY with valid JSON — no markdown:
{"scenes":[{"description":"...","visualPrompt":"..."},{"description":"...","visualPrompt":"..."},{"description":"...","visualPrompt":"..."}],"narration":"..."}`,
    messages: [{
      role: 'user',
      content: `Write the video script for this Facebook ad caption:

${caption}${toneHint}${genHint}`,
    }],
  })

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())

  if (!Array.isArray(parsed.scenes) || parsed.scenes.length < 3) {
    throw new Error('Video script generation returned fewer than 3 scenes')
  }

  return {
    scenes: [parsed.scenes[0], parsed.scenes[1], parsed.scenes[2]],
    narration: String(parsed.narration ?? ''),
  }
}
