import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, loadKnowledgeBase } from './brandSettings'
import { PostDraft, AssetBrief } from './draftStore'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface LibraryAsset {
  id: string
  caption: string
  tags: string[]
  score: string
  submittedByName: string
  assetType?: string
}

export interface ContentPlan {
  postType: string
  theme: string
  tone: string
  keyMessage: string
  approach: string
}

const OBJECTIVE_GUIDANCE: Record<string, string> = {
  awareness: 'Build brand recognition, community presence, and trust. Focus on brand story and park atmosphere.',
  inquiry:   'Drive service inquiries and lead generation. Highlight value, availability, and ease of inquiry.',
  grief:     'Compassionate support for bereaved families. Tone must be gentle, empathetic, never promotional.',
  promo:     'Highlight specific service offers, packages, or promotions. Clear value proposition with urgency.',
}

interface GeneratePostOptions {
  concept: string
  objective?: string          // awareness | inquiry | grief | promo
  awareness?: string          // problem-aware | solution-aware | unaware | most-aware
  plan?: ContentPlan          // content plan approved by human
  revisionNotes?: string
  discordUserId: string
  discordUserName?: string
  imageUrl?: string
  libraryAssets?: LibraryAsset[]
}

interface GeneratedPost {
  caption: string
  hashtags: string[]
  ctaText: string
  engagementHook: string
  assetBrief: AssetBrief
  selectedAssetId?: string
}

function deadlineDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 3)
  return d.toISOString().split('T')[0]
}

export async function generateContentPlan(
  concept: string,
  objective: string,
  libraryAssets: LibraryAsset[],
  adjustNotes?: string,
  awareness?: string,
): Promise<ContentPlan> {
  const s = loadSettings()

  const assetContext = libraryAssets.length > 0
    ? `Available assets:\n${libraryAssets.slice(0, 5).map(a => `- ${(a.assetType ?? 'photo').toUpperCase()} "${a.caption}" (${a.score})`).join('\n')}`
    : 'No assets in library yet.'

  const adjustBlock = adjustNotes ? `\nAdjustment notes: ${adjustNotes}\n` : ''

  const awarenessFrames: Record<string, string> = {
    'problem-aware':   'Audience knows the problem but not the solution. Frame: Problem → Solution. Open with the pain, then reveal how RP solves it.',
    'solution-aware':  'Audience knows solutions exist but hasn\'t chosen. Frame: Your approach vs. others. Highlight what makes RP different.',
    'unaware':         'Audience doesn\'t know they have a problem. Frame: Story or aspiration hook first. Lead with emotion or aspiration before any mention of services.',
    'most-aware':      'Audience is ready to buy. Frame: Offer-led, no setup needed. Lead directly with the offer, price, or next step.',
  }
  const awarenessBlock = awareness && awarenessFrames[awareness]
    ? `\nAudience awareness level: ${awareness.toUpperCase()}\n${awarenessFrames[awareness]}\nThe plan MUST follow this frame.\n`
    : ''

  const kb = loadKnowledgeBase()
  const kbBlock = kb ? `\nBrand knowledge base:\n${kb}\n` : ''

  // content-strategy principles: buyer stage awareness, lead with recommendation, searchable vs shareable balance
  const prompt =
    `You are a content strategist. Build a focused Facebook content plan.\n\n` +
    `Business: ${s.footerRight1} ${s.footerRight2} — Philippine memorial park and chapel services.\n` +
    kbBlock +
    `Post concept: "${concept}"\n` +
    `Objective: ${objective.toUpperCase()} — ${OBJECTIVE_GUIDANCE[objective] ?? 'General post'}\n` +
    awarenessBlock +
    adjustBlock +
    `${assetContext}\n\n` +
    `Strategy rules:\n` +
    `- Lead with your recommendation first, then the rationale\n` +
    `- Match the buyer stage: awareness (top), inquiry (mid), grief/promo (bottom)\n` +
    `- Shareable content = emotional resonance; searchable content = specific answers. Pick one.\n` +
    `- The key message must be ONE specific claim, not a generic statement\n` +
    `- The approach must directly serve the objective — no vague "tell a story"\n` +
    `- Content pillar: classify this post as Inspire (emotion/story), Educate (inform/explain), Connect (community/shared experience), or Convert (offer/CTA) — one pillar only; name it in the approach field\n` +
    `- social-content hook: the approach must specify what the opening hook is (scenario, bold claim, question, or stat)\n\n` +
    `Respond ONLY with valid JSON, no markdown:\n` +
    `{\n` +
    `  "postType": "type of post (e.g. Informational, Promotional, Story, Engagement)",\n` +
    `  "theme": "specific theme for this post — one concise line",\n` +
    `  "tone": "tone descriptors (e.g. Warm, professional, hopeful)",\n` +
    `  "keyMessage": "the single core message this post must communicate",\n` +
    `  "approach": "how to structure the caption — 1 sentence"\n` +
    `}`

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (msg.content[0] as { text: string }).text
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return JSON.parse(stripped) as ContentPlan
}

// content-humanizer: strip AI tells from a caption and make it sound like a real person wrote it
async function humanizeCaption(caption: string): Promise<string> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system:
      `You are an expert content humanizer. Rewrite the caption to sound like a real person wrote it — warm, direct, specific.\n\n` +
      `Rules:\n` +
      `- Remove AI filler words: "delve", "leverage", "robust", "landscape", "facilitate", "testament", "realm", "embark"\n` +
      `- Remove hedging chains: "It's important to note", "In many cases", "It's worth mentioning"\n` +
      `- Vary sentence rhythm — mix short punchy lines with longer ones. Real writing isn't uniform.\n` +
      `- Replace vague claims with specific ones. No "many families" — say what actually happens.\n` +
      `- Keep the same meaning, length, and language (Filipino-English mix is fine).\n` +
      `- Do NOT add hashtags, CTAs, or emojis — only rewrite the caption text.\n` +
      `- Return ONLY the rewritten caption, nothing else.`,
    messages: [{ role: 'user', content: caption }],
  })
  return (msg.content[0] as { text: string }).text.trim()
}

export async function generatePost(opts: GeneratePostOptions): Promise<GeneratedPost> {
  const s = loadSettings()
  const kb = loadKnowledgeBase()
  const kbBlock = kb ? `\n\nBrand knowledge base — use for accurate prices, services, and brand facts:\n${kb}\n` : ''

  const revisionBlock = opts.revisionNotes
    ? `\nRevision requested: ${opts.revisionNotes}\nPlease apply the revision notes to improve the draft.`
    : ''

  const planBlock = opts.plan
    ? `\n\nApproved content plan:\n` +
      `- Post type: ${opts.plan.postType}\n` +
      `- Theme: ${opts.plan.theme}\n` +
      `- Tone: ${opts.plan.tone}\n` +
      `- Key message: ${opts.plan.keyMessage}\n` +
      `- Approach: ${opts.plan.approach}\n` +
      `Follow this plan closely when writing the caption.`
    : ''

  const jsonSchema = `{
  "caption": "2-4 sentence Facebook post caption. Warm and professional. No hashtags here.",
  "hashtags": ["up to 8 relevant hashtags without the # symbol"],
  "ctaText": "short call to action phrase (e.g. Inquire Now, Learn More, Book a Visit)",
  "engagementHook": "a short warm invite to comment or tag someone — e.g. 'Tag someone you want to honor.' or 'Who do you carry in your heart? Tag them.' Max 12 words.",
  "selectedAssetId": "asset ID from the library list if one suits this post, otherwise null",
  "assetBrief": {
    "subject": "what to photograph or film — be specific",
    "location": "exact spot within the park or chapel",
    "moodLighting": "lighting style and mood direction",
    "deadline": "${deadlineDate()}",
    "assignedTo": "${opts.discordUserName ?? 'You'}"
  }
}`

  const objectiveBlock = opts.objective
    ? `\nObjective: ${opts.objective.toUpperCase()} — ${OBJECTIVE_GUIDANCE[opts.objective] ?? ''}\n`
    : ''

  const awarenessInstructions: Record<string, string> = {
    'problem-aware':  'Open with the pain point directly. Name it plainly. Then reveal how Renaissance Park solves it. Don\'t lead with the brand.',
    'solution-aware': 'Skip the problem setup — they already know it. Lead with what makes Renaissance Park different from other options.',
    'unaware':        'Don\'t mention the product or service first. Start with a story, an emotion, or an aspiration. Let the reader arrive at the solution naturally.',
    'most-aware':     'No warm-up needed. Lead directly with the offer, the price, or the next step. Keep it short and action-focused.',
  }
  const awarenessBlock = opts.awareness && awarenessInstructions[opts.awareness]
    ? `\nAudience awareness: ${opts.awareness.toUpperCase()}\nCaption writing rule: ${awarenessInstructions[opts.awareness]}\n`
    : ''

  // content-production: specificity, bottom-line-first, no clichés
  // page-cro: benefit-driven CTA, one clear action, address objections
  const systemPrompt =
    `You are a social media content writer for ${s.footerRight1} ${s.footerRight2}, a Philippine memorial park and chapel services brand.\n\n` +
    `Brand tone: dignified, warm, professional, family-oriented. ${s.claudeInstructions ?? ''}\n\n` +
    `Content production rules:\n` +
    `- Lead with the point — don't bury the message under 2 sentences of context\n` +
    `- Be specific: name the real feeling, the real situation, the real service — never vague\n` +
    `- Never open with: "In today's world", "In the Philippines", "Losing a loved one is never easy"\n` +
    `- Every sentence must earn its place — no filler, no hedging\n` +
    `- Write like a warm human, not a press release\n\n` +
    `CTA rules (page-cro):\n` +
    `- CTA must state a benefit, not just an action — not "Click here" but "Reserve your lot today"\n` +
    `- One clear primary action only — don't ask them to do two things\n` +
    `- Handle the silent objection in the caption before the CTA lands\n\n` +
    `Social-content rules (Facebook-native):\n` +
    `- First sentence is the thumb-stop hook — open with a specific scenario, a bold claim, or a question that names the reader's exact feeling. Never open with a platitude.\n` +
    `- Engagement hook must invite real responses, not just likes — "Tag someone..." or a genuine question they want to answer\n\n` +
    `Marketing psychology rules:\n` +
    `- Loss framing beats gain framing: "Families who wait often pay more" is stronger than "Save money now"\n` +
    `- Social proof must be situational, not statistical — paint a real scenario they can picture, not "many families"\n` +
    `- Natural scarcity only: if lots are limited or prices increase, say it; never manufacture urgency\n` +
    `- For grief and awareness posts: acknowledge the reader's emotional stage — don't push for action before they're ready\n` +
    `- For inquiry and promo posts: surface the hidden objection and defuse it before the CTA; re-engagement angle works when addressing people who've inquired before\n` +
    awarenessBlock +
    objectiveBlock +
    planBlock +
    kbBlock +
    `\n\nRespond ONLY with valid JSON, no markdown:\n${jsonSchema}`

  let messageContent: Anthropic.MessageParam['content']

  if (opts.imageUrl) {
    // Re-run after photographer uploads — use vision to write caption about the actual photo
    messageContent = [
      { type: 'image', source: { type: 'url', url: opts.imageUrl } },
      {
        type: 'text',
        text:
          `Generate a Facebook post for this concept: "${opts.concept}"${revisionBlock}\n\n` +
          `A photographer has submitted the image above to fulfil the asset brief. ` +
          `Write the caption to describe and complement what is actually shown in this photo. ` +
          `Set "selectedAssetId" to null (the image is already attached, no library lookup needed).`,
      },
    ]
  } else if (opts.libraryAssets && opts.libraryAssets.length > 0) {
    // Initial generation — give Claude the library to draw from
    const assetList = opts.libraryAssets
      .map((a, i) =>
        `[${i + 1}] ID: ${a.id} — Type: ${(a.assetType ?? 'photo').toUpperCase()} — Score: ${a.score.toUpperCase()} — "${a.caption}" — Tags: ${a.tags.join(', ')}`
      )
      .join('\n')

    messageContent =
      `ASSET LIBRARY — available approved photos/videos:\n${assetList}\n\n` +
      `Generate a Facebook post for this concept: "${opts.concept}"${revisionBlock}\n\n` +
      `If one of the listed assets suits this post well, set "selectedAssetId" to its ID and write the caption to complement that asset. ` +
      `If none are suitable, set "selectedAssetId" to null — a photographer brief will be issued.`
  } else {
    // No library assets — just generate with a brief
    messageContent =
      `Generate a Facebook post for this concept: "${opts.concept}"${revisionBlock}\n\n` +
      `No assets are available in the library yet. Set "selectedAssetId" to null and issue a brief for what needs to be photographed.`
  }

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }],
  })

  const raw = (msg.content[0] as { text: string }).text
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const parsed = JSON.parse(stripped) as GeneratedPost & { selectedAssetId: string | null }

  // content-humanizer: strip AI tells before returning
  const humanizedCaption = await humanizeCaption(parsed.caption)

  return {
    ...parsed,
    caption: humanizedCaption,
    selectedAssetId: parsed.selectedAssetId ?? undefined,
  }
}

export function buildFacebookCaption(draft: Pick<PostDraft, 'caption' | 'engagementHook' | 'ctaText' | 'hashtags'>): string {
  const hook = draft.engagementHook ? `\n\n${draft.engagementHook}` : ''
  return `${draft.caption}${hook}\n\n${draft.ctaText}\n\n${draft.hashtags.map(h => `#${h}`).join(' ')}`
}

export function formatDraftForDiscord(draft: PostDraft, revisionCount: number): string {
  const hashtags = draft.hashtags.map(h => `#${h}`).join(' ')
  const revNote = revisionCount > 0 ? ` _(revision ${revisionCount})_` : ''

  const imageSection = draft.fulfilledAssetUrl
    ? `\n📸 _Photo selected — ready to post_\n`
    : ''

  const hookLine = draft.engagementHook ? `**Hook:** ${draft.engagementHook}\n` : ''

  return (
    `Here's your draft${revNote}:\n` +
    `\`\`\`\n${draft.caption}\n\n${hashtags}\n\`\`\`\n` +
    `**CTA:** ${draft.ctaText}\n` +
    hookLine +
    imageSection +
    `\nLooking good? Reply **approve** (or **approve: @name** to assign the photo brief). Need changes? **revise: [your notes]**. Start over? **reject**.`
  )
}

export function formatDraftForMetaBusiness(draft: PostDraft): string {
  const hashtags = draft.hashtags.map(h => `#${h}`).join(' ')
  const imageLine = draft.fulfilledAssetUrl
    ? `\n— APPROVED IMAGE —\n${draft.fulfilledAssetUrl}\n`
    : ''
  const hookLine = draft.engagementHook ? `${draft.engagementHook}\n\n` : ''

  return (
    `— CAPTION —\n${draft.caption}\n\n${hookLine}${hashtags}\n\n${draft.ctaText}\n` +
    `${imageLine}\n` +
    `— BEST POSTING TIMES —\n` +
    `Weekdays: 7–9 AM, 12 PM, 6–8 PM\n` +
    `Weekend: 8–10 AM, 7–9 PM\n\n` +
    `— SUGGESTED AUDIENCE —\n` +
    `Location: 20km around Koronadal (roundball)\nAge: 30–65\nInterests: none`
  )
}
