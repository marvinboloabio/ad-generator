import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, loadKnowledgeBase } from './brandSettings'
import { PostDraft, AssetBrief } from './draftStore'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 })

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

const AWARENESS_LABELS: Record<string, string> = {
  'unaware':        'Unaware — hindi pa nila alam na may ganitong pangangailangan',
  'problem-aware':  'Problem Aware — alam na nila ang problema, naghahanap ng solusyon',
  'solution-aware': 'Solution Aware — inihahambing na nila ang mga opsyon',
  'product-aware':  'Product Aware — pamilyar na sa brand, naghahanap ng detalye o presyo',
  'most-aware':     'Most Aware — handang kumilos, kailangan lang ng tamang alok',
}

function parseJsonArray(raw: string): WeeklyBrief[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Claude did not return a JSON array.\n\nRaw response:\n${raw.slice(0, 400)}`)
  }
  const jsonStr = raw.slice(start, end + 1)
  try {
    return JSON.parse(jsonStr) as WeeklyBrief[]
  } catch {
    const repaired = jsonStr.replace(/:(\s*)"((?:[^"\\]|\\.)*)"/g, (_m, colon, val) =>
      `${colon}"${val.replace(/(?<!\\)"/g, '\\"')}"`)
    return JSON.parse(repaired) as WeeklyBrief[]
  }
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
  brandFrameAnalysis?: string // full brand frame + hooks from proceedWithPlan
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

  const kb = await loadKnowledgeBase()
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
  try {
    return JSON.parse(stripped) as ContentPlan
  } catch {
    throw new Error(`Claude returned invalid JSON for content plan.\n\nRaw: ${raw.slice(0, 300)}`)
  }
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
  const kb = await loadKnowledgeBase()
  const kbBlock = kb ? `\n\nBrand knowledge base — use for accurate prices, services, and brand facts:\n${kb}\n` : ''

  const revisionBlock = opts.revisionNotes
    ? `\nRevision requested: ${opts.revisionNotes}\nPlease apply the revision notes to improve the draft.`
    : ''

  const brandFrameBlock = opts.brandFrameAnalysis
    ? `\n\n===BRAND FRAME ANALYSIS (use the hooks below as the basis for the caption)===\n` +
      opts.brandFrameAnalysis +
      `\n===END BRAND FRAME===\n` +
      `IMPORTANT: The caption must be written as a natural Facebook post version of one of the hooks above. ` +
      `Pick the hook that best matches the approved content plan's approach and rewrite it as a flowing, human caption.\n`
    : ''

  const planBlock = opts.plan
    ? `\n\n===APPROVED CONTENT PLAN — MUST FOLLOW EXACTLY===\n` +
      `Post type: ${opts.plan.postType}\n` +
      `Theme: ${opts.plan.theme}\n` +
      `Tone: ${opts.plan.tone}\n` +
      `Key message: ${opts.plan.keyMessage}\n` +
      `Approach: ${opts.plan.approach}\n` +
      `This plan was approved by the human. The caption MUST execute this exact theme, tone, and approach. ` +
      `Do not substitute a different concept or default to generic brand copy. ` +
      `The first sentence of the caption must reflect the opening hook described in the Approach above.\n` +
      `===END PLAN===`
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
    kbBlock +
    brandFrameBlock +
    planBlock +
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
  let parsed: GeneratedPost & { selectedAssetId: string | null }
  try {
    parsed = JSON.parse(stripped) as GeneratedPost & { selectedAssetId: string | null }
  } catch {
    throw new Error(`Claude returned invalid JSON for post.\n\nRaw: ${raw.slice(0, 300)}`)
  }

  // content-humanizer: strip AI tells before returning — fall back to original on failure
  let humanizedCaption = parsed.caption
  try { humanizedCaption = await humanizeCaption(parsed.caption) } catch { /* keep original */ }

  return {
    ...parsed,
    caption: humanizedCaption,
    selectedAssetId: parsed.selectedAssetId ?? undefined,
  }
}

// ─── Weekly batch plan ────────────────────────────────────────────────────────
export interface WeeklyBrief {
  templateKey: string
  label: string
  concept: string
  objective: string
  caption: string
  hashtags: string[]
  ctaText: string
  engagementHook: string
  conceptImagePrompt?: string
  videoAdPrompt?: string
}

export async function generateBatchDrafts(
  awareness: string,
  selectedProblems: Array<{ text: string; objective: string }>,
  categories: Array<{ label: string; designDirective: string; objective: string }>,
  performanceContext?: string,
  recentConceptsByTemplate?: Record<string, string[]>,
  signalContext?: { signals: string[]; toneMap?: string; targetGeneration?: string },
): Promise<WeeklyBrief[]> {
  const s = loadSettings()
  const kb = await loadKnowledgeBase()
  const kbBlock = kb ? `\nKnowledge base (use for accurate prices, services, brand facts):\n${kb}\n` : ''
  const perfBlock = performanceContext ? `\n${performanceContext}\n` : ''

  const GENERATION_GUIDANCE: Record<string, string> = {
    boomer:     'Boomers (60+): Pre-planning their own interment or choosing for a recently deceased spouse. Tone: dignified, reassuring, formal. Values: peace of mind, not burdening children, leaving a proper legacy. Short sentences, no slang.',
    millennial: 'Millennials (30–45): Planning for aging parents, or an OFW sending money home for burial plots. Tone: sacrifice, duty, love, guilt of being far. Values: honoring parents, being prepared, not being caught off-guard. Emotional but practical.',
    genz:       'Gen Z (18–28): Not primary buyers — they share emotional content and influence family decisions. Tone: punchy, raw, short sentences. Values: honoring lolo/lola, being the family member who cared, not letting time run out. Lead with a gut-punch hook.',
    all:        'Broad Filipino family audience spanning multiple generations. Balance dignity, warmth, and practical value.',
  }

  const signalBlock = signalContext && signalContext.signals.length > 0
    ? `\nTimely signals from Filipino social media this week (use naturally if they fit — do NOT force):\n` +
      signalContext.signals.map(s => `- "${s}"`).join('\n') +
      (signalContext.toneMap ? `\n\nDominant emotional tone this month: ${signalContext.toneMap}\nMatch this tone where appropriate.\n` : '') + '\n'
    : ''

  const generationBlock = signalContext?.targetGeneration && GENERATION_GUIDANCE[signalContext.targetGeneration]
    ? `\nTarget generation for this ad:\n${GENERATION_GUIDANCE[signalContext.targetGeneration]}\nAdjust tone, language register, and cultural references accordingly.\n`
    : ''

  const recentBlock = recentConceptsByTemplate && Object.keys(recentConceptsByTemplate).length > 0
    ? `\nRecently used concept angles — DO NOT reuse the same hook, premise, or emotional arc:\n` +
      Object.entries(recentConceptsByTemplate)
        .filter(([, concepts]) => concepts.length > 0)
        .map(([key, concepts]) => `- ${key}: ${concepts.map(c => `"${c}"`).join(' | ')}`)
        .join('\n') + '\n'
    : ''

  const problemList = selectedProblems
    .map((p, i) => `${i + 1}. "${p.text}" (objective: ${p.objective})`)
    .join('\n')
  const categoryList = categories
    .map((c, i) => `${i + 1}. templateKey: ${c.designDirective} | label: ${c.label} | objective: ${c.objective}`)
    .join('\n')

  const prompt =
    `You are a Facebook ad strategist for ${s.footerRight1 ?? 'Renaissance Park'} ${s.footerRight2 ?? '& Chapels'}, a Philippine memorial park.\n` +
    kbBlock +
    perfBlock +
    signalBlock +
    generationBlock +
    recentBlock +
    `\nAudience level: ${AWARENESS_LABELS[awareness] ?? awareness}\n\n` +
    `The user has selected the following specific pain points. Create one Facebook ad brief per pain point — do NOT swap or skip any.\n\n` +
    `Selected pain points (in order — output must match this order):\n${problemList}\n\n` +
    `Available ad templates for this audience level:\n${categoryList}\n\n` +
    `For EACH pain point:\n` +
    `1. Assign the BEST matching template from the list (match template objective to pain point objective; no two ads should use the same templateKey if avoidable)\n` +
    `2. Write full Facebook ad content\n\n` +
    `Per ad, output:\n` +
    `- templateKey: exact designDirective value from the template list\n` +
    `- label: template label\n` +
    `- concept: 1 sentence — pain point + how RP specifically solves it (use KB for exact services/prices)\n` +
    `- objective: "awareness" | "inquiry" | "promo" | "grief"\n` +
    `- caption: 3–4 sentence Facebook caption. Lead with a thumb-stop hook — a specific scenario or bold claim, NOT a platitude. Filipino-English mix OK. No hashtags.\n` +
    `- hashtags: array of 5–8 hashtag strings WITHOUT the # symbol\n` +
    `- ctaText: short benefit-driven CTA e.g. "Mag-inquire Na" or "Reserve Your Lot Today"\n` +
    `- engagementHook: 1 warm invite to tag or comment, max 12 words\n` +
    `- conceptImagePrompt: ONLY fill this when the caption is a storytelling/emotional scene NOT visually tied to the park itself (e.g. a person at home late at night, a family moment, an OFW scenario). Write a short English image generation prompt describing the scene — cinematic, photorealistic, Filipino setting, warm lighting. Leave EMPTY STRING if the caption is park-focused (grounds, facilities, nature, chapel).\n` +
    `- videoAdPrompt: ONLY fill this when conceptImagePrompt is also filled. Write a short English Runway video prompt describing the same scene with motion — cinematic, photorealistic, Filipino setting, use action words (e.g. 'a Filipino man slowly sets down his phone on the bed, dim room, warm glow'). Leave EMPTY STRING otherwise.\n\n` +
    `Caption rules:\n` +
    `- For promo objective: use real prices from the knowledge base\n` +
    `- For grief objective: compassionate tone, no hard sell\n` +
    `- Never open with: "In today\'s world", "Losing a loved one is never easy", generic platitudes\n` +
    `- CRITICAL for valid JSON: do NOT use double-quote characters inside any string value. Use single quotes or rephrase instead.\n\n` +
    `Respond ONLY with a valid JSON array (${selectedProblems.length} items), no markdown:\n` +
    `[{"templateKey":"...","label":"...","concept":"...","objective":"...","caption":"...","hashtags":[...],"ctaText":"...","engagementHook":"...","conceptImagePrompt":"...","videoAdPrompt":"..."}, ...]`

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3500,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJsonArray((msg.content[0] as { text: string }).text)
}

export async function generateWeeklyBriefs(
  count: number,
  awareness: string,
  problems: Array<{ text: string; objective: string }>,
  categories: Array<{ label: string; designDirective: string; objective: string }>,
  performanceContext?: string,
  recentConceptsByTemplate?: Record<string, string[]>,
): Promise<WeeklyBrief[]> {
  const s = loadSettings()
  const kb = await loadKnowledgeBase()
  const kbBlock = kb ? `\nKnowledge base (use for accurate prices, services, brand facts):\n${kb}\n` : ''
  const perfBlock = performanceContext ? `\n${performanceContext}\n` : ''

  const recentBlock = recentConceptsByTemplate && Object.keys(recentConceptsByTemplate).length > 0
    ? `\nRecently used concept angles — DO NOT reuse the same hook, premise, or emotional arc:\n` +
      Object.entries(recentConceptsByTemplate)
        .filter(([, concepts]) => concepts.length > 0)
        .map(([key, concepts]) => `- ${key}: ${concepts.map(c => `"${c}"`).join(' | ')}`)
        .join('\n') + '\n'
    : ''

  const problemList = problems.map((p, i) => `${i + 1}. "${p.text}" (objective: ${p.objective})`).join('\n')
  const categoryList = categories.map((c, i) => `${i + 1}. templateKey: ${c.designDirective} | label: ${c.label} | objective: ${c.objective}`).join('\n')

  const prompt =
    `You are a Facebook ad strategist for ${s.footerRight1 ?? 'Renaissance Park'} ${s.footerRight2 ?? '& Chapels'}, a Philippine memorial park.\n` +
    kbBlock +
    perfBlock +
    recentBlock +
    `\nAudience level: ${AWARENESS_LABELS[awareness] ?? awareness}\n\n` +
    `Create exactly ${count} Facebook ad briefs for a weekly content plan. No repeated pain points or templates.\n\n` +
    `Available pain points for this audience level:\n${problemList}\n\n` +
    `Available ad templates for this audience level:\n${categoryList}\n\n` +
    `For each of the ${count} ads:\n` +
    `1. Pick a DIFFERENT pain point from the list above (no repeats)\n` +
    `2. Pick a DIFFERENT template — choose one whose objective matches or complements the pain point\n` +
    `3. Write full Facebook ad content at the same quality as a brand frame analysis\n\n` +
    `Per ad, output:\n` +
    `- templateKey: exact designDirective value from the template list\n` +
    `- label: template label\n` +
    `- concept: 1-sentence concept — pain point + how RP specifically solves it (use KB for exact services/prices)\n` +
    `- objective: "awareness" | "inquiry" | "promo" | "grief"\n` +
    `- caption: 3–4 sentence Facebook caption. Lead with a thumb-stop hook (specific scenario or bold claim, NOT a platitude). Filipino-English mix OK. No hashtags.\n` +
    `- hashtags: array of 5–8 hashtag strings WITHOUT the # symbol\n` +
    `- ctaText: short benefit-driven CTA, e.g. "Mag-inquire Na" or "Reserve Your Lot Today"\n` +
    `- engagementHook: 1 warm invite to tag or comment, max 12 words\n\n` +
    `Caption rules:\n` +
    `- For promo objective: use real prices from the knowledge base\n` +
    `- For grief objective: compassionate tone, no hard sell\n` +
    `- Never open with: "In today's world", "Losing a loved one is never easy", generic platitudes\n` +
    `- Every sentence must earn its place\n` +
    `- CRITICAL for valid JSON: do NOT use double-quote characters inside any string value. Use single quotes or rephrase instead.\n\n` +
    `Respond ONLY with a valid JSON array, no markdown fences, no commentary:\n` +
    `[{"templateKey":"...","label":"...","concept":"...","objective":"...","caption":"...","hashtags":[...],"ctaText":"...","engagementHook":"..."}, ...]`

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3500,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJsonArray((msg.content[0] as { text: string }).text)
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
