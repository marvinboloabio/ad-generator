import Anthropic from '@anthropic-ai/sdk'
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { processHeroImage, processLogo, processIconSquare } from './imageComposer'
import { loadSettings, loadKnowledgeBase, BrandSettings } from './brandSettings'
import { buildAdHTML, AdContent } from './adTemplates'
import { AdBrief, MediaAsset } from '@/types'

export interface ImageAdResult {
  localPath: string
  buffer: Buffer
  jobId: string
}

// ─── Asset classification via Claude vision ────────────────────────────────────
interface ClassifiedAssets {
  hero: MediaAsset | null
  logo: MediaAsset | null
  icon: MediaAsset | null
  avatar: MediaAsset | null
}

async function classifyAssets(assets: MediaAsset[]): Promise<ClassifiedAssets> {
  if (assets.length === 0) return { hero: null, logo: null, icon: null, avatar: null }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Build a message with all images + ask Claude to classify each by ID
  const contentParts: Anthropic.MessageParam['content'] = []

  const downloadedAssets: Array<{ asset: MediaAsset; buf: Buffer }> = []
  for (const asset of assets) {
    try {
      const raw = await downloadToBuffer(asset.url)
      const buf = await sharp(raw)
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer()
      downloadedAssets.push({ asset, buf })
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
      })
    } catch {
      console.log(`[ImageGen] Classification: skipping ${asset.name}`)
    }
  }

  if (downloadedAssets.length === 0) return { hero: null, logo: null, icon: null, avatar: null }

  const assetList = downloadedAssets
    .map((d, i) => `Image ${i + 1}: filename="${d.asset.name}" id="${d.asset.id}"`)
    .join('\n')

  contentParts.push({
    type: 'text',
    text: `You are classifying uploaded images for a Facebook ad. Look at each image carefully and assign it a role.

Roles:
- hero: main background/venue/product photo (landscape scene, building, park, product shot)
- logo: company logo or wordmark (text/graphic on solid or transparent background)
- icon: small icon, badge, emblem, or symbol (usually square, graphic style)
- avatar: photo of a person (staff, employee, portrait)
- other: anything that doesn't fit above

Images provided (in order):
${assetList}

Respond ONLY with valid JSON — no markdown:
{
  "classifications": [
    { "id": "<asset id>", "role": "hero|logo|icon|avatar|other" }
  ]
}

Rules:
- Each image gets exactly one role
- If multiple images could be the same role, pick the best one for that role and mark others as "other"
- hero takes priority — if unsure between hero and other, pick hero`,
  })

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: contentParts }],
    })

    const raw = (msg.content[0] as { text: string }).text
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    const result = JSON.parse(stripped) as {
      classifications: Array<{ id: string; role: string }>
    }

    const byRole = (role: string) =>
      result.classifications.find(c => c.role === role)?.id ?? null

    const find = (id: string | null) =>
      id ? (assets.find(a => a.id === id) ?? null) : null

    const classified = {
      hero:   find(byRole('hero')),
      logo:   find(byRole('logo')),
      icon:   find(byRole('icon')),
      avatar: find(byRole('avatar')),
    }

    console.log(
      `[ImageGen] Vision classification — ` +
      `hero:${classified.hero?.name ?? 'none'} ` +
      `logo:${classified.logo?.name ?? 'none'} ` +
      `icon:${classified.icon?.name ?? 'none'} ` +
      `avatar:${classified.avatar?.name ?? 'none'}`
    )

    // If no hero found, fall back to highest-scored image that isn't assigned
    if (!classified.hero) {
      const usedIds = new Set([classified.logo?.id, classified.icon?.id, classified.avatar?.id])
      classified.hero = assets
        .filter(a => !usedIds.has(a.id) && a.mimeType?.startsWith('image/'))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null
    }

    return classified
  } catch (err) {
    console.error('[ImageGen] Classification failed, using first image as hero:', err)
    return {
      hero:   assets[0] ?? null,
      logo:   null,
      icon:   null,
      avatar: null,
    }
  }
}

// ─── Download utility ──────────────────────────────────────────────────────────
export function downloadToBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadToBuffer(res.headers.location).then(resolve).catch(reject)
        return
      }
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

// ─── HTML mode: Claude generates the full ad layout ───────────────────────────
async function generateHtmlAd(
  prompt: string,
  heroUri: string,
  wordmarkUri: string | null,
  iconUri: string | null,
  brief: AdBrief,
  revisionNotes?: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const fullPrompt =
    prompt
      .replace(/\{\{BUSINESS\}\}/g, brief.product ?? '')
      .replace(/\{\{CONCEPT\}\}/g,  brief.concept  ?? '')
      .replace(/\{\{LOCATION\}\}/g, brief.location  ?? '') +
    (revisionNotes ? `\n\nRevision notes: ${revisionNotes}` : '') +
    `\n\nOutput ONLY the complete HTML document — no explanation, no markdown fences.`

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: fullPrompt }],
  })

  let html = (msg.content[0] as { text: string }).text
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim()

  // Inject processed asset data URIs
  html = html.replace(/\{\{HERO_URI\}\}/g,     heroUri)
  html = html.replace(/\{\{LOGO_URI\}\}/g,     wordmarkUri ?? '')
  html = html.replace(/\{\{ICON_URI\}\}/g,     iconUri     ?? '')

  return html
}

// ─── Claude content generation ─────────────────────────────────────────────────
async function generateAdContent(brief: AdBrief, assets: MediaAsset[], s: BrandSettings, revisionNotes?: string): Promise<AdContent> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const imageAssets = assets
    .filter(a => a.mimeType?.startsWith('image/') && (a.score ?? 0) >= 40)
    .slice(0, 2)

  const contentParts: Anthropic.MessageParam['content'] = []

  for (const asset of imageAssets) {
    try {
      const raw = await downloadToBuffer(asset.url)
      const buf = await sharp(raw)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
      })
    } catch {
      console.log(`[ImageGen] Skipping image ${asset.name}`)
    }
  }

  const hasPricing = revisionNotes && /₱|\bprice\b|\bpricelist\b|\boffers?\b|\blawn\b|\bspot cash\b|\binstallment\b|\bmonthly\b|\bplan/i.test(revisionNotes)

  const kb = loadKnowledgeBase()
  const kbBlock = kb
    ? `\n\nBrand knowledge base — reference for accurate service names, prices, and brand facts. Use EXACT prices and plan names from here; never invent them:\n${kb}\n`
    : ''

  const customPrompt = s.adPrompt?.trim()
  const isAbsolute = customPrompt?.includes('"eyebrow"') ?? false

  let prompt: string

  if (isAbsolute) {
    prompt = customPrompt! + kbBlock + (revisionNotes ? `\n\nRevision notes: ${revisionNotes}` : '')
  } else {
    const defaultPrompt =
      `You are writing copy for a luxury memorial park ad. David Ogilvy principles: the photo sells, copy deepens.\n` +
      `Business: ${brief.product}\n` +
      `Concept: ${brief.concept}\n` +
      (brief.location ? `Location: ${brief.location}\n` : '') +
      (s.claudeInstructions ? `${s.claudeInstructions}\n` : '') +
      (brief.caption
        ? `\nThe Facebook post caption for this ad is:\n"${brief.caption}"\n\n` +
          `IMPORTANT: Your headline MUST be derived from this caption. ` +
          `Extract the core emotion or key message from it and compress into the headline. ` +
          `Do NOT generate generic memorial park copy — the headline must reflect THIS specific post's theme.\n`
        : '') +
      `\nRules: one headline max 8 words, one body line max 15 words, emotional not functional.\n\n` +
      `Ad-creative principles:\n` +
      `- Headline formula: use ONE of — Promise ("Give your family the peace they deserve"), Problem→Solution ("Still visiting a crowded cemetery?"), or Social Proof ("Families across South Cotabato choose us") — pick the one that fits the concept\n` +
      `- One ad, one job: don't blend brand awareness + inquiry + promo in the same copy\n` +
      `- Thumb-stop: the headline must work even if the body line is never read — make it self-contained\n` +
      `- Loss framing: if the concept has a risk angle, frame what the family stands to lose by not acting (dignity, peace of mind, price lock) — stronger than gain framing\n` +
      `- Visual hierarchy: keep the headline short enough to scan in 3 seconds — no subordinate clauses`

    const basePrompt = customPrompt || defaultPrompt

    const offersSchema = hasPricing
      ? `  "offers": [{"name":"LOT TYPE 1-3 WORDS ALL CAPS","price":"₱X,XXX","label":"/ month"}],\n` +
        `  // Use EXACT prices from the knowledge base. Up to 4 plans. "label" = the price descriptor (e.g. "/ month", "Spot Cash", "/ year"). Match label to what the revision notes ask for.\n`
      : `  "offers": null,\n`

    prompt =
      basePrompt +
      kbBlock +
      (revisionNotes ? `\n\nRevision notes from reviewer: ${revisionNotes}` : '') +
      `\n\nRespond ONLY with valid JSON, no markdown:\n` +
      `{\n` +
      `  "eyebrow": "LOCATION TAG — city/region, max 4 words, all caps",\n` +
      `  "headline": "one bold idea, max 8 words, no end punctuation",\n` +
      `  "bodyLine": "one italic emotional seed sentence, max 15 words — ignored when offers is set",\n` +
      offersSchema +
      `}`
  }

  contentParts.push({ type: 'text', text: prompt })

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: contentParts }],
  })

  const raw = (msg.content[0] as { text: string }).text
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const parsed = JSON.parse(stripped)
  return {
    ...parsed,
    offers: Array.isArray(parsed.offers) && parsed.offers.length > 0 ? parsed.offers : undefined,
  } as AdContent
}


// ─── Design reprompt: base HTML prompt with brand tokens ──────────────────────
function buildDesignPrompt(brief: AdBrief, s: BrandSettings, revisionNotes?: string): string {
  const removeOgilvy = !!revisionNotes && /\b(no|remove|without|drop|skip|ignore)\b.{0,20}\bogilvy\b/i.test(revisionNotes)
  const ogilvyLine = removeOgilvy ? '' : 'David Ogilvy principles: the photo sells, copy deepens. '
  return `You are a senior HTML/CSS designer creating a Facebook ad image.

Canvas: exactly 680px wide by 850px tall. Render as a single self-contained HTML document with inline <style>.

Business: ${brief.product ?? ''}
Concept:  ${brief.concept  ?? ''}
${brief.location ? `Location: ${brief.location}` : ''}

Brand palette:
- Background:   ${s.bgColor      || '#07372f'}
- Accent gold:  ${s.accentColor  || '#c9a84c'}
- Gold dark:    ${s.accentDark   || '#b28648'}
- Off-white:    ${s.offWhite     || '#f7f3ee'}
- Body text:    ${s.bodyText     || '#b9aa94'}

Asset placeholders — copy these strings EXACTLY into your HTML/CSS, they are swapped for real data URIs at render time:
- Hero photo:   {{HERO_URI}}   → use as: background-image:url({{HERO_URI}}) on a full-bleed div
- Logo/wordmark:{{LOGO_URI}}   → use as: <img src="{{LOGO_URI}}"> — omit the element entirely if you choose not to show a logo
- Icon badge:   {{ICON_URI}}   → use as: <img src="{{ICON_URI}}"> — omit if not needed
IMPORTANT: never replace or alter these placeholder strings — leave them verbatim in your output.

Layout rules:
- Hero fills the entire background, with a dark gradient overlay so text is legible
- Logo and icon appear near the top (skip if empty)
- Headline, eyebrow, and body copy appear near the bottom
- Add a decorative gold border or rule to give a luxury feel
- Fonts: load Cormorant Garamond from Google Fonts for headlines; use system serif as fallback
- body { width:680px; height:850px; overflow:hidden; }
- Do NOT use external images other than the three placeholders above

Ad-creative rules for copy:
${ogilvyLine}One headline max 8 words, one body line max 15 words.
- Thumb-stop: the headline must work even if the body line is never read
- Headline formula: Promise, Problem→Solution, or Social Proof — pick the one that fits the concept
- Visual hierarchy: headline is the largest text element; eye travels hero photo → headline → CTA
- One ad, one job: copy must serve a single objective — don't mix awareness with offer

The revision notes (provided separately) describe a DESIGN CHANGE — apply them faithfully while keeping the brand palette and luxury tone.

Output ONLY the complete HTML document — no explanation, no markdown fences.`
}

// ─── No-photo fallback: Claude generates a concept-driven CSS design ──────────

// ─── Main entry point ──────────────────────────────────────────────────────────
export async function generateImageAd(brief: AdBrief, assets: MediaAsset[], revisionNotes?: string): Promise<ImageAdResult> {
  console.log('[ImageGen] Starting image ad generation')

  const { hero, logo, icon } = await classifyAssets(assets)

  const W = 680, H = 850
  const s = loadSettings()

  // Preset logo/icon paths from brand settings
  const presetLogoPath = s.logoUrl
    ? path.join(process.cwd(), 'public', s.logoUrl.replace(/^\//, ''))
    : null
  const presetLogoExists = presetLogoPath ? fs.existsSync(presetLogoPath) : false

  const presetIconPath = s.staffAvatarUrl
    ? path.join(process.cwd(), 'public', s.staffAvatarUrl.replace(/^\//, ''))
    : null
  const presetIconExists = presetIconPath ? fs.existsSync(presetIconPath) : false

  // Download + process assets in parallel
  const [heroUri, wordmarkUri, iconUri] = await Promise.all([
    hero
      ? downloadToBuffer(hero.url)
          .then(buf => processHeroImage(buf, W, H))
          .catch(() => { console.log('[ImageGen] Hero failed'); return null })
      : Promise.resolve(null),

    logo
      ? downloadToBuffer(logo.url)
          .then(buf => processLogo(buf))
          .catch(() => { console.log('[ImageGen] Wordmark failed'); return null })
      : presetLogoExists
        ? fs.promises.readFile(presetLogoPath!)
            .then(buf => processLogo(buf))
            .catch(() => { console.log('[ImageGen] Preset wordmark failed'); return null })
        : Promise.resolve(null),

    icon
      ? downloadToBuffer(icon.url)
          .then(buf => processIconSquare(buf, 64))
          .catch(() => { console.log('[ImageGen] Icon failed'); return null })
      : presetIconExists
        ? fs.promises.readFile(presetIconPath!)
            .then(buf => processIconSquare(buf, 64))
            .catch(() => { console.log('[ImageGen] Preset icon failed'); return null })
        : Promise.resolve(null),
  ])

  console.log('[ImageGen] Generating ad content with Claude...')

  const isHtmlMode = s.adPrompt?.includes('{{HERO_URI}}') ?? false
  const isDesignReprompt = !isHtmlMode && !!revisionNotes &&
    /\b(color|colour|dark|light|bright|layout|font|size|bold|minimal|clean|style|design|background|border|spacing|align|centered|overlay|gradient|shadow|theme|modern|elegant|warm|cool|simple|wide|narrow|compact|bigger|smaller|larger|thinner|thicker|bolder|red|blue|green|yellow|orange|purple|pink|black|white|gray|grey|gold|silver|teal|cyan|magenta|crimson|navy|beige|ivory|cream|maroon|violet|indigo|turquoise|coral|amber|bronze|copper|rose|monochrome|duotone|vibrant|vivid|saturated|desaturated|faded|pastel|neon|muted|washed|earthy|neutral|contrast|hue|tint|shade|tone|palette|italic|underline|uppercase|lowercase|serif|sans|monospace|script|cursive|condensed|extended|regular|medium|semibold|heavy|typeface|weight|tracking|leading|kerning|heading|caption|wordmark|grid|flex|column|row|horizontal|vertical|split|half|full|stack|sidebar|banner|card|panel|section|block|header|footer|margin|padding|gap|indent|corner|inner|outer|edge|middle|blur|glow|shine|shimmer|highlight|sharp|crisp|haze|vignette|bloom|grain|noise|texture|pattern|stripe|curve|wave|diagonal|geometric|organic|abstract|glossy|matte|metallic|sleek|luxury|premium|vintage|retro|classic|timeless|transparent|opaque|translucent|solid|outline|stroke|fill|rounded|radius|circle|square|pill|badge|icon|logo|photo|image|illustration|resize|scale|stretch|shrink|expand|crop|rotate|flip|replace|swap|remove|brighter|darker|lighter|heavier|cinematic|dramatic|moody|airy|crowded|clutter|asymmetric|symmetric|balanced|framed|boxed|contained|bleed)\b/i.test(revisionNotes)

  let html: string
  if (!heroUri) throw new Error('No hero image available — please attach a park/venue photo')

  if (isHtmlMode) {
    console.log('[ImageGen] HTML mode — Claude generates full layout')
    html = await generateHtmlAd(s.adPrompt!, heroUri, wordmarkUri, iconUri, brief, revisionNotes)
  } else if (isDesignReprompt) {
    console.log('[ImageGen] Design reprompt — switching to HTML mode')
    const designPrompt = buildDesignPrompt(brief, s, revisionNotes)
    html = await generateHtmlAd(designPrompt, heroUri, wordmarkUri, iconUri, brief, revisionNotes)
  } else {
    const content = await generateAdContent(brief, assets, s, revisionNotes)
    console.log('[ImageGen] Content:', content.eyebrow, '|', content.headline)
    html = buildAdHTML(content, heroUri, iconUri, wordmarkUri)
  }

  console.log('[ImageGen] Rendering with Puppeteer...')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 680, height: 850, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })

    const jobId = `img_${Date.now()}`
    const outputDir = path.join(process.cwd(), 'public', 'outputs')
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

    const outputPath = path.join(outputDir, `${jobId}.png`)
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 680, height: 850 },
      omitBackground: false,
    }) as Buffer

    fs.writeFileSync(outputPath, buffer)
    console.log(`[ImageGen] Saved → ${outputPath} (${buffer.length} bytes)`)

    return { localPath: outputPath, buffer, jobId }
  } finally {
    await browser.close()
  }
}
