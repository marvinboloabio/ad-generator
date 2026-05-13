import Anthropic from '@anthropic-ai/sdk'
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { processHeroImage, processLogo, processIconSquare } from './imageComposer'
import { loadSettings, loadKnowledgeBase, loadKnowledgeBaseSync, BrandSettings } from './brandSettings'
import { fetchPageReviews, getRandomReview, type PageReview } from './facebook'
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

  // Runway-generated concept images are always hero — skip Claude classification
  const runwayHero = assets.find(a => a.id === 'runway')
  if (runwayHero) return { hero: runwayHero, logo: null, icon: null, avatar: null }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 })

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
    let result: { classifications: Array<{ id: string; role: string }> }
    try {
      result = JSON.parse(stripped) as typeof result
    } catch {
      console.warn('[ImageGen] Classification JSON parse failed, using first image as hero')
      return { hero: assets[0] ?? null, logo: null, icon: null, avatar: null }
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
  if (url.startsWith('data:')) {
    const base64 = url.split(',')[1] ?? ''
    return Promise.resolve(Buffer.from(base64, 'base64'))
  }
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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 })

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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 })

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

  const kb = await loadKnowledgeBase()
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
  let parsed: any
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error(`Claude returned invalid JSON for ad content.\n\nRaw: ${raw.slice(0, 300)}`)
  }
  return {
    ...parsed,
    offers: Array.isArray(parsed.offers) && parsed.offers.length > 0 ? parsed.offers : undefined,
  } as AdContent
}


// ─── Visual Metaphor template: white-bg split comparison layout ───────────────
function buildVisualMetaphorPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'
  const green = s.bgColor || '#07372f'

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
/* ── BASE — DO NOT OVERRIDE THESE IN CUSTOM CSS ── */
html,body{width:543px!important;height:466px!important;margin:0!important;padding:0!important;overflow:hidden!important;box-sizing:border-box;background:#ffffff;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#1a1a1a;}
.headline{height:160px!important;max-height:160px!important;display:flex;align-items:center;justify-content:center;padding:0 36px;text-align:center;border-bottom:1px solid #e8e0d5;background:#ffffff;overflow:hidden!important;flex-shrink:0!important;}
.headline h1{margin:0;font-size:/*FONT_SIZE*/px!important;font-weight:900;line-height:1.15;color:#1a1a1a;text-transform:uppercase;letter-spacing:-0.02em;hyphens:auto;overflow-wrap:break-word;word-break:break-word;}
.headline h1 .gold{color:${gold};}
.panels{height:196px!important;max-height:196px!important;display:flex;flex-direction:row;background:#f7f5f2;overflow:hidden!important;flex-shrink:0!important;}
.panel{flex:1;position:relative;display:flex;align-items:center;justify-content:center;background:#f7f5f2;overflow:hidden!important;padding-bottom:22px;}
.divider{width:1px;background:#e0d8cc;flex-shrink:0;margin:12px 0;}
.art{display:flex;align-items:center;justify-content:center;overflow:hidden;}
.art svg{display:block;width:130px!important;height:130px!important;max-width:130px!important;max-height:130px!important;}
.panel-label{position:absolute;bottom:8px;left:0;right:0;font-size:8px;letter-spacing:0.26em;color:#aaa;font-weight:700;text-transform:uppercase;text-align:center;z-index:10;}
.logo-area{height:110px!important;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden!important;}
.logo-text{font-size:18px;font-weight:800;letter-spacing:0.18em;color:${gold};text-transform:uppercase;}
.logo-img{position:absolute;max-width:130px;height:auto;filter:sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78);display:none;}
/* ── YOUR CUSTOM STYLES BELOW ── */
/*CUSTOM_CSS*/
</style>
</head>
<body>
<div class="headline"><h1>/*HEADLINE*/</h1></div>
<div class="panels">
  <div class="panel left">
    <div class="art">/*LEFT_ART*/</div>
    <div class="panel-label">/*LEFT_LABEL*/</div>
  </div>
  <div class="divider"></div>
  <div class="panel right">
    <div class="art">/*RIGHT_ART*/</div>
    <div class="panel-label">/*RIGHT_LABEL*/</div>
  </div>
</div>
<div class="logo-area">
  <span id="ltx" class="logo-text">RENAISSANCE</span>
  <img src="{{LOGO_URI}}" class="logo-img" onload="this.style.display='block';document.getElementById('ltx').style.display='none'" onerror="this.style.display='none'">
</div>
</body>
</html>`

  return `You are creating a scroll-stopping Facebook ad for a Filipino memorial park brand using the VISUAL METAPHOR layout.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Fill EVERY /*SLOT*/ in the scaffold below. Output ONLY the complete filled-in HTML — no explanation, no markdown fences.

━━━ SLOTS TO FILL ━━━

/*FONT_SIZE*/ — COUNT the total characters in your headline text (including spaces), then pick:
  ≤18 chars → 44 · 19–28 → 36 · 29–38 → 30 · 39–50 → 26 · 51+ → 22
  IMPORTANT: do NOT use a larger font-size in /*CUSTOM_CSS*/ — these sizes are enforced with !important

/*HEADLINE*/ — ALL CAPS witty juxtaposition, 5–8 words across 2 clean lines. Wrap the punchline word(s) in <span class="gold">WORD</span>.
  Example: HINDI LANG DINNER ANG <span class="gold">NIRE-RESERVE.</span>

/*CUSTOM_CSS*/ — any extra CSS overrides needed, otherwise leave empty.

/*LEFT_ART*/ — ONE inline SVG of the "everyday" object (the relatable comparison item).
/*RIGHT_ART*/ — ONE inline SVG of the Renaissance Park equivalent object.

  SVG rules for BOTH objects:
  - Canvas: width="300" height="300" viewBox="0 0 300 300"
  - LARGE: main shape must occupy at least 200×200px of the 300×300 viewBox — fill the space
  - Use radialGradient for 3D depth (light source top-left)
  - Use feDropShadow filter for a subtle ground shadow
  - Muted realistic colors: whites #f0eeeb, grays #c8c4be #9a9590, dark #2a2a2a
  - Right panel object uses gold (${gold}) or deep green (${green}) as accent color
  - Text ON an object (e.g. "RESERVED" on a sign) must be SVG <text> INSIDE the SVG — the ONLY text allowed in the panel
  - No emoji, no external images

  SVG starter template:
  <svg width="300" height="300" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g1" cx="38%" cy="30%" r="65%">
        <stop offset="0%" stop-color="#f5f2ee"/><stop offset="100%" stop-color="#c8c4bc"/>
      </radialGradient>
      <filter id="s1"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="rgba(0,0,0,0.18)"/></filter>
    </defs>
    <ellipse cx="150" cy="278" rx="95" ry="12" fill="rgba(0,0,0,0.09)"/>
    <rect x="50" y="30" width="200" height="230" rx="12" fill="url(#g1)" filter="url(#s1)"/>
    <text x="150" y="155" font-family="Inter,sans-serif" font-size="22" font-weight="700" fill="#2a2a2a" text-anchor="middle" letter-spacing="2">RESERVED</text>
  </svg>

/*LEFT_LABEL*/ — ALL CAPS, max 4 words. Name the SPECIFIC PROBLEM shown in the left SVG — the stressful thing the family has to source or handle themselves (e.g. "HANAPIN PA ANG UPUAN", "IKAW PA ANG EMCEE", "DIY NA LIBING", "WALA PANG PHOTOGRAPHER"). Must match the left object exactly.

/*RIGHT_LABEL*/ — ALL CAPS, max 4 words. Name the SPECIFIC RENAISSANCE PARK ADVANTAGE that solves the left-panel problem. Draw from RP's full range of offerings:
  Interment: Emcee · 6 Marshalls · 250 Plastic Chairs · Three 4×4 Tents · Green Carpet · Sound System · Singer · Photographer · AV Presentation · Flowers · Snacks · Grand Chapel Program · Concrete Vault · Engraved Lapida
  Lot plans: No Downpayment · Flexible Installment · ₱240/mo · 20-Year Term · Spot Cash Option · No Annual Fee · Perpetual Care
  Park experience: Family Park · Open Daily · Picnic Area · Peaceful Grounds · Along the Highway
  Admin: No Collectors · GCash Payment · Transfer of Rights · Transfer of Site · No Sales Agents
  e.g. "MAY EMCEE NA KAMI", "WALANG DOWNPAYMENT", "₱240 LANG SA BUWAN", "OPEN ARAW-ARAW", "WALANG ANNUAL FEE", "TENTS KASAMA NA"
  Must directly answer the exact left-panel problem using a real RP advantage.

━━━ SCAFFOLD ━━━
${scaffold}`
}

// ─── Witty / Filipino Ads template ────────────────────────────────────────────
function buildWittyFilipinoPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;background:#ffffff;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#1a1a1a;}
.wrap{width:680px;height:850px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#ffffff;position:relative;box-sizing:border-box;}
.top-bar{position:absolute;top:0;left:0;right:0;height:7px;background:${gold};}
.bottom-bar{position:absolute;bottom:0;left:0;right:0;height:7px;background:${gold};}
.eyebrow{font-size:10px;letter-spacing:0.35em;color:#aaa;font-weight:700;text-transform:uppercase;margin-bottom:28px;text-align:center;}
.setup{font-size:22px;font-weight:600;color:#444;text-align:center;line-height:1.35;padding:0 60px;margin-bottom:12px;}
.punchline{font-size:/*FONT_SIZE*/px;font-weight:900;color:#1a1a1a;text-align:center;line-height:1.0;text-transform:uppercase;padding:0 44px;hyphens:none;word-break:keep-all;margin-bottom:32px;}
.punchline .gold{color:${gold};}
.divider{width:44px;height:3px;background:${gold};margin:0 auto 28px;}
.logo-wrap{display:flex;flex-direction:column;align-items:center;gap:7px;}
.logo-img{max-width:136px;height:auto;}
.tagline{font-size:8px;letter-spacing:0.4em;color:#ccc;font-weight:600;text-transform:uppercase;}
/*CUSTOM_CSS*/
</style>
</head>
<body>
<div class="wrap">
  <div class="top-bar"></div>
  <div class="eyebrow">RENAISSANCE PARK & CHAPELS</div>
  <div class="setup">/*SETUP_TEXT*/</div>
  <div class="punchline">/*PUNCHLINE*/</div>
  <div class="divider"></div>
  <div class="logo-wrap">
    <img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'">
    <div class="tagline">Where Every Life is Celebrated</div>
  </div>
  <div class="bottom-bar"></div>
</div>
</body>
</html>`

  return `You are filling in a Witty / Filipino Ad template for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

This is a text-only Facebook ad — no photo, just bold words. Think of it like a relatable Filipino observation or meme-style post that makes someone pause and think. Tone: warm, clever, never disrespectful. Tagalog, Taglish, or pure English fine.

━━━ YOUR JOB ━━━

/*FONT_SIZE*/ — number based on punchline character count:
  ≤10 chars → 120 | 11–16 chars → 100 | 17–22 chars → 82 | 23+ chars → 64

/*SETUP_TEXT*/ — 1 sentence setup/observation, max 14 words, Filipino or Taglish.
  Example: "Nagrereserba ka ng mesa sa restaurant, pero paano ang para sa mahal mo sa buhay?"
  If no good setup fits, write: <span style="display:none"></span>

/*PUNCHLINE*/ — 2–6 words ALL CAPS, the witty payoff. Wrap the KEY WORD in <span class="gold">WORD</span>.
  Examples: "BAKIT HINDI <span class="gold">LUPA?</span>" · "I-RESERVE NA <span class="gold">NGAYON.</span>" · "MAHAL MO <span class="gold">BA SIYA?</span>"
  Must land as a complete thought even without the setup.

/*CUSTOM_CSS*/ — leave empty unless you need extra classes.

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
}

// ─── Educational template ──────────────────────────────────────────────────────
function buildEducationalPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'
  const green = s.bgColor || '#0c2a22'
  const kb = loadKnowledgeBaseSync()
  const kbBlock = kb ? `\nKnowledge base (use EXACT prices and service names):\n${kb}\n` : ''

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;background:#f7f3ee;font-family:'Inter','Helvetica Neue',Arial,sans-serif;color:#1a1a1a;}
body{display:flex;flex-direction:column;}
.header{background:${green};padding:28px 44px 24px;border-bottom:3px solid ${gold};flex-shrink:0;}
.eyebrow{font-size:10px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;margin-bottom:10px;}
.headline{font-size:/*HEADLINE_SIZE*/px;font-weight:900;color:#f7f3ee;line-height:1.1;text-transform:uppercase;hyphens:none;word-break:keep-all;}
.headline .gold{color:${gold};}
.boxes{padding:24px 32px;display:flex;flex-direction:column;gap:14px;flex:1;}
.box{background:#ffffff;border-radius:6px;padding:18px 20px;display:flex;align-items:flex-start;gap:16px;border-left:4px solid ${gold};}
.box-num{font-size:28px;font-weight:900;color:${gold};line-height:1;flex-shrink:0;min-width:30px;}
.box-title{font-size:13px;font-weight:800;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;}
.box-detail{font-size:12.5px;color:#555;line-height:1.45;}
.footer{background:${green};border-top:2px solid ${gold};height:130px;display:flex;align-items:center;justify-content:space-between;padding:0 36px;flex-shrink:0;}
.footer-cta{font-size:11px;font-weight:700;letter-spacing:0.12em;color:${gold};text-transform:uppercase;}
.footer-sub{font-size:9px;color:rgba(247,243,238,0.45);letter-spacing:0.2em;text-transform:uppercase;margin-top:3px;}
.logo-img{max-height:44px;width:auto;filter:brightness(0) invert(1) sepia(1) saturate(1.5) hue-rotate(2deg);}
</style>
</head>
<body>
<div class="header">
  <div class="eyebrow">/*EYEBROW*/</div>
  <div class="headline">/*HEADLINE*/</div>
</div>
<div class="boxes">
  <div class="box">
    <div class="box-num">01</div>
    <div class="box-content">
      <div class="box-title">/*BOX1_TITLE*/</div>
      <div class="box-detail">/*BOX1_DETAIL*/</div>
    </div>
  </div>
  <div class="box">
    <div class="box-num">02</div>
    <div class="box-content">
      <div class="box-title">/*BOX2_TITLE*/</div>
      <div class="box-detail">/*BOX2_DETAIL*/</div>
    </div>
  </div>
  <div class="box">
    <div class="box-num">03</div>
    <div class="box-content">
      <div class="box-title">/*BOX3_TITLE*/</div>
      <div class="box-detail">/*BOX3_DETAIL*/</div>
    </div>
  </div>
</div>
<div class="footer">
  <div>
    <div class="footer-cta">/*CTA*/</div>
    <div class="footer-sub">Koronadal City</div>
  </div>
  <img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'">
</div>
</body>
</html>`

  return `You are filling in an Educational Ad template for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}
${kbBlock}
This is a clean, informative ad that teaches the audience something — a surprising fact, a key differentiator, or a clear explanation of a service. Three numbered boxes, each with a short title and one detail sentence.

━━━ YOUR JOB ━━━

/*EYEBROW*/ — "ALAM MO BA?" or "BAKIT PILIIN ANG RENAISSANCE?" or "3 DAHILAN" — ALL CAPS, max 5 words.

/*HEADLINE_SIZE*/ — 48 for ≤20 chars · 40 for 21–30 chars · 34 for 31+ chars

/*HEADLINE*/ — clear informational headline, ALL CAPS, max 8 words. One <span class="gold">KEY</span> allowed.

/*BOX1_TITLE*/ to /*BOX3_TITLE*/ — 2–4 words, ALL CAPS, each a distinct point.

/*BOX1_DETAIL*/ to /*BOX3_DETAIL*/ — 1 sentence max 18 words each. Specific fact or benefit. Use EXACT prices/service names from knowledge base if relevant.

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
}

// ─── Social Proof / Testimonial template ──────────────────────────────────────
function buildSocialProofPrompt(brief: AdBrief, s: BrandSettings, review?: PageReview): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,700;1,400;1,700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;font-family:'Inter',sans-serif;}
.bg{width:680px;height:850px;position:relative;}
.hero{position:absolute;inset:0;background-image:url({{HERO_URI}});background-size:cover;background-position:center;}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,4,2,0.52) 0%,rgba(12,4,2,0.20) 32%,rgba(12,4,2,0.86) 65%,rgba(12,4,2,0.97) 100%);}
.content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;padding:36px 60px 26px;box-sizing:border-box;text-align:center;}
.logo-top{flex-shrink:0;margin-bottom:4px;}
.logo-img{max-width:130px;height:auto;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78);}
.quote-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.stars{font-size:22px;color:${gold};letter-spacing:5px;margin-bottom:12px;}
.quote-mark{font-family:'Cormorant Garamond',Georgia,serif;font-size:110px;line-height:0.6;color:${gold};opacity:0.88;margin-bottom:8px;}
.quote-text{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*QUOTE_SIZE*/px;font-style:italic;color:#f7f3ee;line-height:1.5;margin-bottom:20px;text-shadow:0 2px 12px rgba(0,0,0,0.7);}
.divider{width:36px;height:2px;background:${gold};margin:0 auto 12px;}
.attribution{font-size:11px;letter-spacing:0.2em;color:${gold};font-weight:600;text-transform:uppercase;}
.eyebrow-bottom{flex-shrink:0;font-size:9px;letter-spacing:0.35em;color:rgba(247,243,238,0.45);font-weight:600;text-transform:uppercase;padding-top:10px;}
</style>
</head>
<body>
<div class="bg">
  <div class="hero"></div>
  <div class="overlay"></div>
  <div class="content">
    <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
    <div class="quote-center">
      <div class="stars">/*STARS*/</div>
      <div class="quote-mark">"</div>
      <div class="quote-text">/*QUOTE*/</div>
      <div class="divider"></div>
      <div class="attribution">— /*ATTRIBUTION*/</div>
    </div>
    <div class="eyebrow-bottom">/*EYEBROW_BOTTOM*/</div>
  </div>
</div>
</body>
</html>`

  if (review) {
    const quoteSize = review.text.length <= 40 ? 30 : review.text.length <= 60 ? 26 : 22
    const filledScaffold = scaffold
      .replace('/*QUOTE_SIZE*/', String(quoteSize))
      .replace('/*STARS*/', '★'.repeat(review.rating))
      .replace('/*QUOTE*/', review.text)
      .replace('/*ATTRIBUTION*/', review.reviewerName)

    return `You are completing a Social Proof / Testimonial Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}

The quote, stars, and attribution are ALREADY FILLED from a real Facebook review — do NOT change them.

Fill in ONLY:
/*EYEBROW_BOTTOM*/ — short trust line. e.g. "PINAGKAKATIWALAANG PANGKOMUNIDAD" or "TRUSTED BY FAMILIES ACROSS SOUTH COTABATO"

━━━ SCAFFOLD ━━━
${filledScaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
  }

  return `You are filling in a Social Proof / Testimonial Ad template for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

This is a testimonial-style Facebook ad. The quote is the hero. It should feel like something a real Filipino family would genuinely say — warm, grateful, specific. Not corporate, not salesy.

━━━ YOUR JOB ━━━

/*QUOTE_SIZE*/ — number: 30 for ≤40 chars · 26 for 41–60 chars · 22 for 61+ chars

/*STARS*/ — ★★★★★ (almost always 5 stars)

/*QUOTE*/ — 1–2 sentences as a genuine family testimonial, Filipino or Taglish. Max 35 words. Specific and emotional — mentions a real feeling, a real moment, or a real relief.
  Example: "Hindi namin inakala na ganito kaganda ang lugar. Ngayon pakiramdam namin ay nasa mabuting kamay si Nanay."

/*ATTRIBUTION*/ — plausible Filipino name + town. e.g. "Maria Santos, Koronadal City" or "Ang Pamilya Reyes, General Santos"

/*EYEBROW_BOTTOM*/ — short trust line. e.g. "PINAGKAKATIWALAANG PANGKOMUNIDAD" or "TRUSTED BY FAMILIES ACROSS SOUTH COTABATO"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
}

// ─── Offer / Promo template ────────────────────────────────────────────────────
function buildOfferPromoPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'
  const green = s.bgColor || '#0c2a22'
  const kb = loadKnowledgeBaseSync()
  const kbBlock = kb ? `\nKnowledge base (use EXACT prices and plan names):\n${kb}\n` : ''

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,400;1,600&family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;font-family:'Inter','Helvetica Neue',Arial,sans-serif;}
.bg{width:680px;height:850px;position:relative;background:${green};}
.hero{position:absolute;inset:0;background-image:url({{HERO_URI}});background-size:cover;background-position:center;}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,4,2,0.78) 0%,rgba(8,4,2,0.60) 35%,rgba(8,4,2,0.70) 65%,rgba(8,4,2,0.88) 100%);}
.wrap{position:relative;width:680px;height:850px;display:flex;flex-direction:column;align-items:center;padding:0;box-sizing:border-box;}
/* corner brackets */
.c-tl,.c-tr,.c-bl,.c-br{position:absolute;width:34px;height:34px;pointer-events:none;}
.c-tl{top:16px;left:16px;border-top:1.5px solid rgba(201,168,76,0.55);border-left:1.5px solid rgba(201,168,76,0.55);}
.c-tr{top:16px;right:16px;border-top:1.5px solid rgba(201,168,76,0.55);border-right:1.5px solid rgba(201,168,76,0.55);}
.c-bl{bottom:16px;left:16px;border-bottom:1.5px solid rgba(201,168,76,0.55);border-left:1.5px solid rgba(201,168,76,0.55);}
.c-br{bottom:16px;right:16px;border-bottom:1.5px solid rgba(201,168,76,0.55);border-right:1.5px solid rgba(201,168,76,0.55);}
/* header */
.header-area{display:flex;flex-direction:column;align-items:center;padding:32px 60px 16px;width:100%;box-sizing:border-box;}
.logo-img{max-height:46px;width:auto;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78);margin-bottom:18px;}
.eyebrow-row{display:flex;align-items:center;gap:12px;margin-bottom:16px;width:100%;}
.eyebrow-line{flex:1;height:1px;background:rgba(201,168,76,0.35);}
.eyebrow-text{font-size:8.5px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;white-space:nowrap;}
.headline{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-weight:700;color:#f7f3ee;text-align:center;line-height:1.08;padding:0 20px;}
.headline .ig{font-style:italic;color:${gold};}
/* pricing cards */
.cards{display:flex;gap:10px;padding:18px 22px 12px;width:100%;box-sizing:border-box;}
.card{flex:1;background:rgba(0,0,0,0.35);border:1px solid rgba(201,168,76,0.22);padding:20px 10px 14px;display:flex;flex-direction:column;align-items:center;position:relative;}
.card.featured{background:rgba(201,168,76,0.12);border-color:rgba(201,168,76,0.7);}
.card-tag{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:${gold};color:#1a1a1a;font-size:7px;font-weight:900;letter-spacing:0.2em;text-transform:uppercase;padding:3px 10px;white-space:nowrap;}
.card-plan{font-size:8.5px;letter-spacing:0.32em;color:rgba(247,243,238,0.45);text-transform:uppercase;margin-bottom:10px;font-weight:700;}
.card-price{font-size:36px;font-weight:900;color:${gold};line-height:1;margin-bottom:2px;letter-spacing:-0.02em;}
.card-period{font-size:8px;color:rgba(247,243,238,0.42);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px;}
.card-div{width:22px;height:1px;background:rgba(201,168,76,0.28);margin-bottom:10px;}
.card-detail{font-size:10px;color:rgba(247,243,238,0.65);text-align:center;line-height:1.45;}
/* footer */
.footer-bar{margin-top:auto;width:100%;background:rgba(0,0,0,0.35);border-top:1px solid rgba(201,168,76,0.2);display:flex;align-items:center;padding:0 24px;height:72px;box-sizing:border-box;gap:12px;}
.footer-loc{font-size:8px;letter-spacing:0.14em;color:rgba(247,243,238,0.3);text-transform:uppercase;flex:1;}
.footer-cta{background:${gold};color:#1a1a1a;font-size:9.5px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;padding:9px 18px;white-space:nowrap;flex-shrink:0;}
.footer-brand{font-size:8.5px;letter-spacing:0.22em;color:rgba(247,243,238,0.35);text-transform:uppercase;text-align:right;flex:1;}
</style>
</head>
<body>
<div class="bg">
  <div class="hero"></div>
  <div class="overlay"></div>
  <div class="wrap">
  <div class="c-tl"></div><div class="c-tr"></div>
  <div class="c-bl"></div><div class="c-br"></div>
  <div class="header-area">
    <img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'">
    <div class="eyebrow-row">
      <div class="eyebrow-line"></div>
      <div class="eyebrow-text">/*EYEBROW*/</div>
      <div class="eyebrow-line"></div>
    </div>
    <div class="headline">/*HEADLINE*/</div>
  </div>
  <div class="cards">
    <div class="card">
      <div class="card-plan">/*PLAN1_NAME*/</div>
      <div class="card-price">/*PLAN1_PRICE*/</div>
      <div class="card-period">/*PLAN1_PERIOD*/</div>
      <div class="card-div"></div>
      <div class="card-detail">/*PLAN1_DETAIL*/</div>
    </div>
    <div class="card featured">
      <div class="card-tag">POPULAR</div>
      <div class="card-plan">/*PLAN2_NAME*/</div>
      <div class="card-price">/*PLAN2_PRICE*/</div>
      <div class="card-period">/*PLAN2_PERIOD*/</div>
      <div class="card-div"></div>
      <div class="card-detail">/*PLAN2_DETAIL*/</div>
    </div>
    <div class="card">
      <div class="card-plan">/*PLAN3_NAME*/</div>
      <div class="card-price">/*PLAN3_PRICE*/</div>
      <div class="card-period">/*PLAN3_PERIOD*/</div>
      <div class="card-div"></div>
      <div class="card-detail">/*PLAN3_DETAIL*/</div>
    </div>
  </div>
  <div class="footer-bar">
    <div class="footer-loc">Brgy. San Felipe · Tantangan, South Cotabato</div>
    <div class="footer-cta">/*CTA*/</div>
    <div class="footer-brand">RENAISSANCE</div>
  </div>
  </div>
</div>
</body>
</html>`

  return `You are filling in an Offer / Promo Ad template for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}
${kbBlock}
Layout: Dark green background, gold corner brackets. Logo top-center with decorative eyebrow band (lines on both sides). Large serif headline with one italic gold key word. THREE pricing cards side by side. Footer bar: location | CTA button | "RENAISSANCE" text.

Use EXACT prices from the knowledge base — never invent prices. Pull 3 real lot/plan tiers.

━━━ SLOTS ━━━

/*EYEBROW*/ — ALL CAPS, max 5 words. e.g. "LOT PLANS · MEMORIAL PARK" or "PAUNANG HALAGA · KORONADAL CITY"

/*HL_SIZE*/ — 52 for ≤22 chars · 44 for 23–32 chars · 36 for 33+ chars

/*HEADLINE*/ — Cormorant Garamond serif, max 8 words. Wrap 1 key word in <span class="ig">word</span> for italic gold.
  e.g. "Mag-invest Sa <span class="ig">Pinaka-</span>Magandang Pahingahan" · "Para Sa Pamilyang <span class="ig">Nagmamahal.</span>"

/*PLAN1_NAME*/ — tier 1 label ALL CAPS e.g. "ENTRY" or "LAWN LOT"
/*PLAN1_PRICE*/ — exact price e.g. "₱240" (the monthly amount or spot cash — just the number)
/*PLAN1_PERIOD*/ — descriptor e.g. "/ month · 20 yrs" or "spot cash"
/*PLAN1_DETAIL*/ — 1–2 lines describing what this plan includes, max 12 words total

/*PLAN2_NAME*/ — featured middle tier ALL CAPS e.g. "GARDEN" or "POPULAR"
/*PLAN2_PRICE*/ — exact price
/*PLAN2_PERIOD*/ — descriptor
/*PLAN2_DETAIL*/ — same format as PLAN1

/*PLAN3_NAME*/ — premium tier ALL CAPS e.g. "PRESTIGE" or "FAMILY ESTATE"
/*PLAN3_PRICE*/ — exact price
/*PLAN3_PERIOD*/ — descriptor
/*PLAN3_DETAIL*/ — same format as PLAN1

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
}

// ─── Problem → Solution template ──────────────────────────────────────────────
function buildProblemSolutionPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'
  const green = s.bgColor || '#0c2a22'

  const scaffold = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800;900&family=Cormorant+Garamond:ital,wght@1,400;1,600&display=swap" rel="stylesheet">
<style>
html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;font-family:'Inter',sans-serif;}
.bg{width:680px;height:850px;position:relative;}
.hero{position:absolute;inset:0;background-image:url({{HERO_URI}});background-size:cover;background-position:center;}
.overlay-top{position:absolute;top:0;left:0;right:0;height:50%;background:linear-gradient(180deg,rgba(55,15,5,0.78) 0%,rgba(40,12,3,0.60) 100%);}
.overlay-bottom{position:absolute;bottom:0;left:0;right:0;height:50%;background:linear-gradient(180deg,rgba(7,55,47,0.72) 0%,rgba(7,55,47,0.96) 100%);}
.problem-panel{position:absolute;top:0;left:0;right:0;height:46%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;text-align:center;}
.problem-eye{font-size:9px;letter-spacing:0.38em;color:rgba(247,210,160,0.75);font-weight:700;text-transform:uppercase;margin-bottom:10px;}
.problem-hl{font-size:/*PROB_SIZE*/px;font-weight:900;color:#f7f3ee;line-height:1.1;text-transform:uppercase;text-shadow:0 2px 14px rgba(0,0,0,0.7);hyphens:none;word-break:keep-all;}
.bridge{position:absolute;top:46%;left:0;right:0;height:8%;background:${green};display:flex;align-items:center;justify-content:center;z-index:10;}
.bridge-text{font-size:12px;font-weight:800;letter-spacing:0.25em;color:${gold};text-transform:uppercase;}
.solution-panel{position:absolute;bottom:0;left:0;right:0;height:46%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;text-align:center;}
.solution-eye{font-size:9px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;margin-bottom:8px;}
.solution-hl{font-size:/*SOL_SIZE*/px;font-weight:900;color:#f7f3ee;line-height:1.1;text-transform:uppercase;text-shadow:0 2px 14px rgba(0,0,0,0.7);hyphens:none;word-break:keep-all;}
.solution-body{font-family:'Cormorant Garamond',Georgia,serif;font-size:17px;font-style:italic;color:rgba(247,243,238,0.82);margin-top:10px;text-shadow:0 1px 8px rgba(0,0,0,0.5);}
.logo-strip{position:absolute;bottom:3%;left:0;right:0;display:flex;justify-content:center;}
.logo-img{max-width:86px;height:auto;filter:brightness(0) invert(1) sepia(1) saturate(1.8) hue-rotate(2deg) brightness(0.88);}
</style>
</head>
<body>
<div class="bg">
  <div class="hero"></div>
  <div class="overlay-top"></div>
  <div class="overlay-bottom"></div>
  <div class="problem-panel">
    <div class="problem-eye">ANG PROBLEMA</div>
    <div class="problem-hl">/*PROBLEM_HL*/</div>
  </div>
  <div class="bridge">
    <div class="bridge-text">/*BRIDGE*/</div>
  </div>
  <div class="solution-panel">
    <div class="solution-eye">ANG SOLUSYON</div>
    <div class="solution-hl">/*SOLUTION_HL*/</div>
    <div class="solution-body">/*SOLUTION_BODY*/</div>
  </div>
  <div class="logo-strip"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
</div>
</body>
</html>`

  return `You are filling in a Problem→Solution Ad template for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

This ad names a real pain point in the top half, then offers Renaissance Park as the clear answer in the bottom half. The hero photo shows through both halves with different color overlays (warm brown = problem, deep green = solution).

━━━ YOUR JOB ━━━

/*PROB_SIZE*/ — font size for problem headline: 52 for ≤20 chars · 44 for 21–32 chars · 36 for 33+ chars

/*PROBLEM_HL*/ — the pain point, ALL CAPS, max 7 words. Immediately relatable.
  Examples: "MALAYO NA, MAHIRAP PA BISITAHIN" · "PALAGING BAHA SA LUMANG SEMENTERYO"

/*BRIDGE*/ — the pivot phrase between panels, ALL CAPS, max 5 words.
  e.g. "KAYA NAMAN" · "MAY SOLUSYON NA" · "HANGGANG DITO NA LANG BA?"

/*SOL_SIZE*/ — font size for solution headline: 52 for ≤20 chars · 44 for 21–32 chars · 36 for 33+

/*SOLUTION_HL*/ — the answer/benefit, ALL CAPS, max 7 words. Promise or benefit formula.

/*SOLUTION_BODY*/ — 1 short italic line, max 12 words. Warm and reassuring.

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML — no explanation, no markdown fences.`
}

// ─── Shared photo-overlay base CSS ────────────────────────────────────────────
function photoBase(gold: string): string {
  return `html,body{width:680px;height:850px;margin:0;padding:0;overflow:hidden;font-family:'Inter',sans-serif;}
.bg{width:680px;height:850px;position:relative;}
.hero{position:absolute;inset:0;background-image:url({{HERO_URI}});background-size:cover;background-position:center;}
.content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;padding:30px 56px 28px;box-sizing:border-box;}
.logo-img{max-width:86px;height:auto;filter:brightness(0) invert(1) sepia(1) saturate(1.8) hue-rotate(2deg) brightness(0.9);}
.eyebrow{font-size:9.5px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;text-shadow:0 1px 8px rgba(0,0,0,0.8);}
.headline{hyphens:none;word-break:keep-all;text-shadow:0 2px 18px rgba(0,0,0,0.75);}
.body-line{text-shadow:0 1px 10px rgba(0,0,0,0.75);}
.footer{font-size:8.5px;letter-spacing:0.22em;color:rgba(247,243,238,0.42);text-transform:uppercase;text-align:center;}`
}

// ─── Lifestyle / Positioning template ─────────────────────────────────────────
function buildLifestylePrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,400;1,600&family=Inter:wght@600;700&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,8,4,0.72) 0%,rgba(12,8,4,0.06) 30%,rgba(12,8,4,0.06) 60%,rgba(12,8,4,0.84) 100%);}
.frame{position:absolute;inset:18px;border:1px solid rgba(201,168,76,0.35);pointer-events:none;}
.logo-top{margin-bottom:auto;}
.copy{text-align:center;margin-bottom:32px;}
.eyebrow{background:rgba(0,0,0,0.38);padding:4px 14px;border-radius:2px;display:inline-block;margin-bottom:18px;}
.headline{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-weight:700;color:#f7f3ee;line-height:1.12;margin-bottom:16px;text-align:center;text-shadow:0 2px 24px rgba(0,0,0,0.95),0 1px 6px rgba(0,0,0,0.9);}
.headline .gold{color:${gold};}
.rule{width:40px;height:1.5px;background:${gold};margin:0 auto 16px;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-style:italic;color:#f7f3ee;line-height:1.45;text-align:center;background:rgba(0,0,0,0.38);padding:7px 20px;border-radius:2px;text-shadow:0 1px 8px rgba(0,0,0,0.95);}
.cta{background:${gold};color:#1a1a1a;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;padding:13px 36px;margin-top:auto;margin-bottom:24px;}
.logo-img{max-width:150px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div><div class="frame"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="rule"></div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta">/*CTA*/</div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in a Lifestyle / Positioning Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

The overlay is a warm dark vignette — heavy at top and bottom, barely touching the middle — so the photo's golden hour warmth and the people in it shine through. Aspirational, serene, premium. NOT grief-focused, NOT a service list.

━━━ SLOTS ━━━

/*EYEBROW*/ — ALL CAPS brand tag, max 5 words. e.g. "WHERE EVERY LIFE IS CELEBRATED" or "TANTANGAN, SOUTH COTABATO"

/*HL_SIZE*/ — count characters in headline then pick: ≤22 chars → 64 · 23–34 chars → 54 · 35+ chars → 46

/*HEADLINE*/ — max 8 words, title-case. Emotionally resonant promise about beauty, peace, family, or legacy. Must feel like something a family would want — not a product pitch.
  You may wrap 1–2 key words in <span class="gold">Word</span> for a gold accent.
  Examples: "The Place Your Family Will <span class="gold">Always Return To</span>" · "Where Every Visit Still Feels Like <span class="gold">Home</span>"

/*BODY*/ — 1 italic sentence, MAX 10 words. The feeling of being at the park — warm, specific, sensory.
  Examples: "Every visit still feels like coming home." · "Beauty that honors the ones you love most."

/*CTA*/ — 3–4 words ALL CAPS. Warm invite.
  e.g. "DISCOVER YOUR SANCTUARY" · "VISIT US TODAY" · "INQUIRE NOW"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Light Emotional template ──────────────────────────────────────────────────
function buildLightEmotionalPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,400;1,600&family=Inter:wght@500;600&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(18,8,1,0.55) 0%,rgba(18,8,1,0.04) 18%,rgba(18,8,1,0.04) 42%,rgba(30,14,3,0.74) 72%,rgba(18,8,1,0.95) 100%);}
.content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:flex-start;padding:30px 52px 32px;box-sizing:border-box;}
.logo-top{align-self:center;margin-bottom:auto;}
.logo-img{max-width:150px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:left;margin-bottom:26px;border-left:2px solid ${gold};padding-left:18px;}
.eyebrow{font-size:9.5px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;margin-bottom:14px;text-shadow:0 1px 8px rgba(0,0,0,0.9);}
.headline{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-weight:700;color:#f7f3ee;line-height:1.1;text-align:left;margin-bottom:14px;text-shadow:0 2px 20px rgba(0,0,0,0.95);}
.ornament{color:${gold};font-size:11px;letter-spacing:0.55em;margin-bottom:14px;text-shadow:none;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:17px;font-style:italic;color:rgba(247,243,238,0.88);line-height:1.5;text-align:left;text-shadow:0 1px 8px rgba(0,0,0,0.9);}
.cta{border:1.5px solid rgba(201,168,76,0.75);color:${gold};font-size:10px;font-weight:600;letter-spacing:0.3em;text-transform:uppercase;padding:10px 26px;margin-bottom:22px;}
.footer{font-size:8.5px;letter-spacing:0.22em;color:rgba(247,243,238,0.38);text-transform:uppercase;align-self:center;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="ornament">✦ · ✦</div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta">/*CTA*/</div>
  <div class="footer">Where Every Life is Celebrated</div>
</div></div></body></html>`

  return `You are filling in a Light Emotional Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Layout: The photo dominates the top 40%. Text is left-aligned at the bottom, anchored by a gold left-border bar on the copy block. Warm amber fade rises from the bottom. Intimate and editorial — not premium gallery like Lifestyle. NOT grief-heavy, NOT a sales pitch.

━━━ SLOTS ━━━

/*EYEBROW*/ — ALL CAPS, max 5 words. Warm brand tag. e.g. "FOR THE FAMILIES WE LOVE" · "TANTANGAN, SOUTH COTABATO"

/*HL_SIZE*/ — count headline characters: ≤20 chars → 58 · 21–32 chars → 50 · 33+ chars → 42

/*HEADLINE*/ — max 7 words, title-case. Speaks directly to family togetherness, love, or remembrance. Warm and soft — NOT about death, NOT a product pitch.
  Examples: "Still Together, Always." · "Love That Stays Long After." · "Some Bonds Were Never Meant to End."

/*BODY*/ — 1 gentle italic sentence, MAX 10 words. About the feeling — not the features.
  Examples: "Because some visits still feel like coming home." · "Where love quietly waits between every visit."

/*CTA*/ — soft 3-word invite. e.g. "TALK TO US" · "LET'S TALK" · "REACH OUT TODAY"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Emotional template ─────────────────────────────────────────────────────────
function buildEmotionalPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700;800;900&family=Cormorant+Garamond:ital,wght@1,400&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,4,2,0.48) 0%,rgba(12,4,2,0.14) 28%,rgba(12,4,2,0.72) 58%,rgba(12,4,2,0.96) 100%);}
.logo-top{margin-bottom:auto;align-self:center;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:center;margin-bottom:36px;}
.eyebrow{margin-bottom:18px;}
.headline{font-family:'Inter',sans-serif;font-size:/*HL_SIZE*/px;font-weight:900;color:#f7f3ee;line-height:1.06;text-align:center;text-transform:uppercase;margin-bottom:18px;letter-spacing:-0.01em;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:19px;font-style:italic;color:rgba(247,243,238,0.82);line-height:1.5;text-align:center;}
.cta-btn{background:${gold};color:#1a1a1a;font-size:11px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;padding:13px 34px;margin-top:auto;margin-bottom:22px;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta-btn">/*CTA*/</div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in an Emotional Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Dark, dramatic mood — heavy overlay so the photo is moody and cinematic. This ad meets the family at their pain point. Loss framing formula: headline names what the family fears losing or has already lost. Bold sans-serif headline, filled gold CTA button.

━━━ SLOTS ━━━

/*EYEBROW*/ — empathetic label ALL CAPS e.g. "PARA SA MGA PAMILYANG NAGMAMAHAL" or short location tag

/*HL_SIZE*/ — 58 for ≤22 chars · 50 for 23–34 chars · 42 for 35+ chars

/*HEADLINE*/ — ALL CAPS, max 7 words. Use Loss Framing: name the fear, the pain, or what is at risk.
  Examples: "HUWAG HAYAANG MAGING AGAHAN ITO" · "MAHAL MO BA SIYA PARA IBIGAY ANG PINAKAMAGANDA"

/*BODY*/ — 1 short italic sentence max 12 words. Raw, emotional, not a feature list.

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Story template ─────────────────────────────────────────────────────────────
function buildStoryPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(35,18,4,0.42) 0%,rgba(22,10,2,0.08) 30%,rgba(22,10,2,0.72) 62%,rgba(14,6,1,0.96) 100%);}
.logo-top{margin-bottom:auto;align-self:center;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:center;margin-bottom:32px;}
.eyebrow{margin-bottom:16px;font-style:italic;font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;letter-spacing:0.06em;color:rgba(247,243,238,0.65);text-transform:none;font-weight:400;}
.headline{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-weight:700;font-style:italic;color:#f7f3ee;line-height:1.1;text-align:center;margin-bottom:18px;}
.rule{width:44px;height:1px;background:${gold};margin:0 auto 16px;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:17px;font-style:italic;color:rgba(247,243,238,0.8);line-height:1.5;text-align:center;}
.cta-text{color:${gold};font-size:10px;font-weight:600;letter-spacing:0.3em;text-transform:uppercase;margin-top:auto;margin-bottom:22px;text-shadow:none;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*SETUP*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="rule"></div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta-text">/*CTA*/</div>
  <div class="footer">Where Every Life is Celebrated</div>
</div></div></body></html>`

  return `You are filling in a Story-style Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Warm editorial tone. Opens a story the reader recognizes — a moment, a memory, a situation. The headline is the story opener (italic serif, large). The body line continues it. No hard sell. Small italic setup line above the headline sets the scene.

━━━ SLOTS ━━━

/*SETUP*/ — 1 short italic setup line (not all-caps), max 8 words. Sets the scene.
  e.g. "Noong gabing iyon…" or "May isa siyang hiling bago umalis…"

/*HL_SIZE*/ — 62 for ≤24 chars · 54 for 25–36 chars · 46 for 37+ chars

/*HEADLINE*/ — story opening, title-case or sentence-case, max 8 words. The hook moment. Italic serif.
  e.g. "Sabi niya, ayaw niyang maging abala pa." or "Binigyan niya kami ng pinakamagandang paalam."

/*BODY*/ — 1 italic sentence max 14 words. Continues the story or reveals the emotional insight.

/*CTA*/ — soft text CTA max 4 words e.g. "INQUIRE NOW" or "ALAMIN ANG MGA OPSYON"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Authority template ─────────────────────────────────────────────────────────
function buildAuthorityPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Cormorant+Garamond:ital,wght@1,400&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(14,6,2,0.42) 0%,rgba(14,6,2,0.10) 25%,rgba(14,6,2,0.68) 58%,rgba(14,6,2,0.94) 100%);}
.logo-top{margin-bottom:auto;align-self:center;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:center;margin-bottom:24px;}
.eyebrow{margin-bottom:10px;display:inline-block;background:rgba(0,0,0,0.52);padding:4px 14px;}
.stat{font-size:/*STAT_SIZE*/px;font-weight:900;color:${gold};line-height:1;text-align:center;margin-bottom:6px;text-shadow:0 2px 18px rgba(0,0,0,0.7);letter-spacing:-0.02em;}
.stat-label{font-size:10px;letter-spacing:0.22em;color:rgba(247,243,238,0.55);text-transform:uppercase;margin-bottom:18px;text-align:center;}
.headline{font-family:'Inter',sans-serif;font-size:/*HL_SIZE*/px;font-weight:800;color:#f7f3ee;line-height:1.1;text-align:center;text-transform:uppercase;margin-bottom:14px;letter-spacing:-0.01em;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-style:italic;color:rgba(247,243,238,0.82);line-height:1.45;text-align:center;}
.cta-btn{border:1.5px solid ${gold};color:${gold};font-size:10.5px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;padding:11px 30px;margin-top:auto;margin-bottom:22px;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="stat">/*STAT*/</div>
    <div class="stat-label">/*STAT_LABEL*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta-btn">/*CTA*/</div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in an Authority Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Builds credibility and trust. The visual anchor is a large bold number or credential (stat). Social proof headline. Reassuring body line. Gold outline CTA.

━━━ SLOTS ━━━

/*EYEBROW*/ — credential label ALL CAPS e.g. "PINAGKAKATIWALAAN MULA PA 2001" or "FULL-SERVICE MEMORIAL PARK"

/*STAT_SIZE*/ — 90 if stat is 1–4 chars · 70 if 5–8 chars · 54 if 9+ chars

/*STAT*/ — a bold trust number or credential e.g. "1,000+" or "24/7" or "20 YRS"
  If no stat fits naturally, write: <span style="display:none"></span>

/*STAT_LABEL*/ — label under the stat e.g. "FAMILIES SERVED" or "CHAPEL SUPPORT" or "OF TRUSTED SERVICE"
  If stat is hidden, leave this empty.

/*HL_SIZE*/ — 44 for ≤26 chars · 38 for 27–38 chars · 32 for 39+ chars

/*HEADLINE*/ — Social Proof formula, ALL CAPS, max 8 words. Cite trust, families, or community.

/*BODY*/ — 1 italic sentence max 14 words. Specific reassurance about service or care.

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Soft Direct Response template ─────────────────────────────────────────────
function buildSoftDRPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@1,400&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(135deg,rgba(14,6,2,0.38) 0%,rgba(14,6,2,0.18) 30%,rgba(14,6,2,0.72) 65%,rgba(14,6,2,0.96) 100%);}
.content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:flex-start;padding:30px 52px 28px;box-sizing:border-box;}
.logo-top{align-self:flex-end;margin-bottom:auto;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.eyebrow{font-size:9.5px;letter-spacing:0.38em;color:${gold};font-weight:700;text-transform:uppercase;margin-bottom:14px;display:inline-block;background:rgba(0,0,0,0.52);padding:4px 12px;}
.headline{font-family:'Inter',sans-serif;font-size:/*HL_SIZE*/px;font-weight:800;color:#f7f3ee;line-height:1.1;text-align:left;margin-bottom:18px;text-transform:uppercase;letter-spacing:-0.01em;text-shadow:0 2px 18px rgba(0,0,0,0.85);}
.benefits{display:flex;flex-direction:column;gap:11px;margin-bottom:24px;}
.benefit{display:flex;align-items:flex-start;gap:10px;}
.benefit-dash{color:${gold};font-size:15px;font-weight:700;flex-shrink:0;line-height:1.38;text-shadow:none;}
.benefit-text{font-size:13.5px;color:rgba(247,243,238,0.88);line-height:1.4;text-shadow:0 1px 8px rgba(0,0,0,0.8);}
.cta-wrap{margin-top:auto;margin-bottom:22px;}
.cta-btn{border:1.5px solid ${gold};color:${gold};font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;padding:12px 28px;display:inline-block;}
.cta-sub{font-size:9px;letter-spacing:0.18em;color:rgba(247,243,238,0.45);text-transform:uppercase;margin-top:8px;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="eyebrow">/*EYEBROW*/</div>
  <div class="headline">/*HEADLINE*/</div>
  <div class="benefits">
    <div class="benefit"><div class="benefit-dash">—</div><div class="benefit-text">/*BENEFIT_1*/</div></div>
    <div class="benefit"><div class="benefit-dash">—</div><div class="benefit-text">/*BENEFIT_2*/</div></div>
    <div class="benefit"><div class="benefit-dash">—</div><div class="benefit-text">/*BENEFIT_3*/</div></div>
  </div>
  <div class="cta-wrap">
    <div class="cta-btn">✆ /*CTA*/</div>
    <div class="cta-sub">/*CTA_SUB*/</div>
  </div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in a Soft Direct Response Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Layout: Left-aligned, photo visible top-right. Logo sits top-RIGHT. Clear benefit headline + 3 gold-dash benefit points + phone-icon CTA. Zero pressure — make inquiry feel easy and no-commitment.

━━━ SLOTS ━━━

/*EYEBROW*/ — approachable label ALL CAPS e.g. "LIBRE KUMONSULTA" or "WALANG OBLIGASYON"

/*HL_SIZE*/ — 50 for ≤24 chars · 42 for 25–36 chars · 36 for 37+ chars

/*HEADLINE*/ — Promise formula, ALL CAPS, max 7 words. Clear benefit, stated plainly. Not scary or urgent.

/*BENEFIT_1*/ to /*BENEFIT_3*/ — 3 real RP benefits, each max 10 words. Conversational, no jargon.
  e.g. "No downpayment, bayad lang ng ₱240/month" · "Open daily — puwede bisitahin kahit kailan" · "GCash accepted, walang lalabas na collector"

/*CTA*/ — 3–5 words after ✆ e.g. "MAKIPAG-USAP SA AMIN" or "CALL US TODAY"

/*CTA_SUB*/ — 1 short reassurance e.g. "LIBRE · WALANG OBLIGASYON" or "OPEN MON–SAT 8AM–5PM"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Direct Response template ───────────────────────────────────────────────────
function buildDirectResponsePrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,400;1,600;1,700&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(14,6,2,0.62) 0%,rgba(14,6,2,0.42) 22%,rgba(14,6,2,0.80) 62%,rgba(14,6,2,0.97) 100%);}
.content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:flex-start;padding:28px 44px 24px;box-sizing:border-box;}
.logo-top{margin-bottom:auto;}
.logo-img{max-width:120px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.eyebrow{font-size:9px;letter-spacing:0.4em;color:${gold};font-weight:700;text-transform:uppercase;margin-bottom:18px;text-shadow:0 1px 8px rgba(0,0,0,0.9);}
.headline-setup{font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-style:italic;color:rgba(247,243,238,0.75);line-height:1.2;margin-bottom:4px;text-shadow:0 2px 14px rgba(0,0,0,0.9);}
.headline-payoff{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-style:italic;font-weight:700;color:#f7f3ee;line-height:1.06;margin-bottom:20px;text-shadow:0 2px 22px rgba(0,0,0,0.95);}
.features{display:flex;flex-direction:column;gap:9px;margin-bottom:18px;}
.feature{display:flex;align-items:flex-start;gap:10px;}
.feat-dash{color:${gold};font-size:16px;font-weight:700;flex-shrink:0;line-height:1.32;text-shadow:none;}
.feat-text{font-size:13px;color:rgba(247,243,238,0.86);line-height:1.35;text-shadow:0 1px 8px rgba(0,0,0,0.8);}
.body-italic{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;font-style:italic;color:rgba(247,243,238,0.70);line-height:1.4;margin-bottom:auto;text-shadow:0 1px 10px rgba(0,0,0,0.8);}
.cta{border:1.5px solid ${gold};color:${gold};font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;padding:11px 28px;display:inline-flex;align-items:center;gap:8px;margin-top:16px;margin-bottom:20px;}
</style>
<!-- gold corner brackets -->
<style>
.c-tl,.c-tr,.c-bl,.c-br{position:absolute;width:38px;height:38px;pointer-events:none;}
.c-tl{top:16px;left:16px;border-top:1.5px solid rgba(201,168,76,0.55);border-left:1.5px solid rgba(201,168,76,0.55);}
.c-tr{top:16px;right:16px;border-top:1.5px solid rgba(201,168,76,0.55);border-right:1.5px solid rgba(201,168,76,0.55);}
.c-bl{bottom:16px;left:16px;border-bottom:1.5px solid rgba(201,168,76,0.55);border-left:1.5px solid rgba(201,168,76,0.55);}
.c-br{bottom:16px;right:16px;border-bottom:1.5px solid rgba(201,168,76,0.55);border-right:1.5px solid rgba(201,168,76,0.55);}
</style>
</head><body>
<div class="bg">
  <div class="hero"></div><div class="overlay"></div>
  <div class="c-tl"></div><div class="c-tr"></div><div class="c-bl"></div><div class="c-br"></div>
  <div class="content">
    <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="headline-setup">/*HEADLINE_SETUP*/</div>
    <div class="headline-payoff">/*HEADLINE_PAYOFF*/</div>
    <div class="features">
      <div class="feature"><div class="feat-dash">—</div><div class="feat-text">/*FEAT_1*/</div></div>
      <div class="feature"><div class="feat-dash">—</div><div class="feat-text">/*FEAT_2*/</div></div>
      <div class="feature"><div class="feat-dash">—</div><div class="feat-text">/*FEAT_3*/</div></div>
    </div>
    <div class="body-italic">/*BODY_ITALIC*/</div>
    <div class="cta">→ /*CTA*/</div>
    <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
  </div>
</div></body></html>`

  return `You are filling in a Direct Response Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Layout: Left-aligned. Logo top-LEFT. Gold corner bracket accents at all 4 corners. Two-part italic serif headline (small setup line + large payoff). 3 gold-dash feature lines. Italic body price hint. Gold outline "→ CTA" button. Urgency without aggression.

━━━ SLOTS ━━━

/*EYEBROW*/ — ALL CAPS, max 5 words. e.g. "MEMORIAL LOT · ONLINE APPLICATION" or "INQUIRE NA NGAYON"

/*HEADLINE_SETUP*/ — smaller italic opener, max 5 words. Question or situation the reader recognizes.
  e.g. "Naghihintay ka pa ba?" or "Hindi mo pa rin naisip?"

/*HL_SIZE*/ — font size for the payoff headline: 52 for ≤20 chars · 46 for 21–30 chars · 40 for 31+ chars

/*HEADLINE_PAYOFF*/ — bold italic serif, max 6 words. The compelling answer or resolution.
  e.g. "Simulan mo na ngayon." or "Ang pinakamagandang regalo para sa pamilya."

/*FEAT_1*/ to /*FEAT_3*/ — 3 real RP advantages, max 10 words each. Specific and direct.
  e.g. "No downpayment, ₱240/month lang · 20-year plan" · "Perpetual care — walang annual fee habambuhay" · "GCash payment · walang collector na lalapit"

/*BODY_ITALIC*/ — 1 short italic sentence max 12 words. Price anchor or emotional reason to act now.

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Comparison template ────────────────────────────────────────────────────────
function buildComparisonPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'
  const green = s.bgColor || '#0c2a22'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.hero{background-image:url({{HERO_URI}});background-size:cover;background-position:center;}
.overlay-base{position:absolute;inset:0;background:rgba(12,4,1,0.30);}
.left-zone{position:absolute;top:0;left:0;bottom:0;width:50%;background:linear-gradient(90deg,rgba(55,20,5,0.7) 0%,rgba(55,20,5,0.55) 100%);}
.right-zone{position:absolute;top:0;right:0;bottom:0;width:50%;background:linear-gradient(270deg,rgba(7,55,47,0.75) 0%,rgba(7,55,47,0.6) 100%);}
.divider-line{position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(201,168,76,0.55);transform:translateX(-50%);}
.header-band{position:absolute;top:0;left:0;right:0;height:/*HEADER_H*/px;background:rgba(7,55,47,0.88);border-bottom:2px solid ${gold};display:flex;align-items:center;justify-content:center;padding:0 48px;text-align:center;}
.headline{font-family:'Inter',sans-serif;font-size:/*HL_SIZE*/px;font-weight:900;color:#f7f3ee;line-height:1.08;text-transform:uppercase;hyphens:none;word-break:keep-all;letter-spacing:-0.01em;}
.headline .gold{color:${gold};}
.panels{position:absolute;top:/*HEADER_H*/px;left:0;right:0;bottom:100px;display:flex;}
.panel{flex:1;display:flex;flex-direction:column;padding:24px 26px;}
.panel-label{font-size:10px;letter-spacing:0.28em;font-weight:700;text-transform:uppercase;margin-bottom:16px;}
.panel.left .panel-label{color:rgba(247,210,180,0.65);}
.panel.right .panel-label{color:${gold};}
.point{display:flex;align-items:flex-start;gap:10px;margin-bottom:13px;}
.dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;margin-top:6px;}
.panel.left .dot{background:rgba(247,210,180,0.5);}
.panel.right .dot{background:${gold};}
.point-text{font-size:15px;color:#f7f3ee;line-height:1.45;text-shadow:0 1px 8px rgba(0,0,0,0.7);}
.panel.left .point-text{color:rgba(247,210,180,0.85);}
.footer-band{position:absolute;bottom:0;left:0;right:0;height:100px;background:${green};border-top:2px solid rgba(201,168,76,0.35);display:flex;align-items:center;justify-content:center;gap:18px;}
.footer-logo{max-width:72px;height:auto;filter:brightness(0) invert(1) sepia(1) saturate(1.8) hue-rotate(2deg) brightness(0.9);}
.footer-tag{font-size:9px;letter-spacing:0.3em;color:rgba(247,243,238,0.45);text-transform:uppercase;}
</style></head><body>
<div class="bg">
  <div class="hero"></div><div class="overlay-base"></div>
  <div class="left-zone"></div><div class="right-zone"></div><div class="divider-line"></div>
  <div class="header-band"><div class="headline">/*HEADLINE*/</div></div>
  <div class="panels">
    <div class="panel left">
      <div class="panel-label">/*LEFT_LABEL*/</div>
      <div class="point"><div class="dot"></div><div class="point-text">/*LEFT_1*/</div></div>
      <div class="point"><div class="dot"></div><div class="point-text">/*LEFT_2*/</div></div>
      <div class="point"><div class="dot"></div><div class="point-text">/*LEFT_3*/</div></div>
    </div>
    <div class="panel right">
      <div class="panel-label">RENAISSANCE PARK</div>
      <div class="point"><div class="dot"></div><div class="point-text">/*RIGHT_1*/</div></div>
      <div class="point"><div class="dot"></div><div class="point-text">/*RIGHT_2*/</div></div>
      <div class="point"><div class="dot"></div><div class="point-text">/*RIGHT_3*/</div></div>
    </div>
  </div>
  <div class="footer-band">
    <img src="{{LOGO_URI}}" class="footer-logo" onerror="this.style.display='none'">
    <div class="footer-tag">Where Every Life is Celebrated</div>
  </div>
</div></body></html>`

  return `You are filling in a Comparison Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Split-panel layout. Left = competitor/public cemetery (warm dark tint, pain points). Right = Renaissance Park (green tint, advantages). A headline band spans the top. 3 bullet points per side.

━━━ SLOTS ━━━

/*HEADER_H*/ — header height in px: 150 for headlines ≤30 chars · 170 for 31–45 chars · 190 for 46+ chars

/*HL_SIZE*/ — headline font size: 42 for ≤30 chars · 36 for 31–45 chars · 30 for 46+ chars

/*HEADLINE*/ — contrast headline spanning both panels, ALL CAPS, max 9 words. Can use <span class="gold">KEY</span> for Renaissance Park's side.
  Example: "HINDI LAHAT NG <span class="gold">LIBINGAN</span> AY PANTAY-PANTAY."

/*LEFT_LABEL*/ — label for the left (competitor) side e.g. "PUBLIC CEMETERY" or "IBANG MEMORIAL PARK"

/*LEFT_1*/ to /*LEFT_3*/ — 3 pain points or weaknesses of the left side. Short phrases (max 8 words each). Honest, not mean.

/*RIGHT_1*/ to /*RIGHT_3*/ — 3 advantages of Renaissance Park. Same length. Specific, match the left pain points.

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Retargeting template ────────────────────────────────────────────────────────
function buildRetargetingPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@1,400;1,700&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(30,16,4,0.32) 0%,rgba(22,10,2,0.08) 28%,rgba(22,10,2,0.62) 58%,rgba(14,6,1,0.92) 100%);}
.logo-top{margin-bottom:auto;align-self:center;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:center;margin-bottom:28px;}
.eyebrow{margin-bottom:14px;}
.headline{font-family:'Cormorant Garamond',Georgia,serif;font-size:/*HL_SIZE*/px;font-weight:700;font-style:italic;color:#f7f3ee;line-height:1.12;text-align:center;margin-bottom:16px;}
.rule{width:36px;height:1px;background:${gold};margin:0 auto 14px;}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:17px;font-style:italic;color:rgba(247,243,238,0.82);line-height:1.5;text-align:center;}
.cta-btn{border:1.5px solid ${gold};color:${gold};font-size:10.5px;font-weight:700;letter-spacing:0.26em;text-transform:uppercase;padding:11px 32px;margin-top:auto;margin-bottom:16px;}
.urgency-note{font-size:9px;letter-spacing:0.2em;color:rgba(247,243,238,0.4);text-transform:uppercase;text-align:center;margin-bottom:16px;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="headline">/*HEADLINE*/</div>
    <div class="rule"></div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta-btn">/*CTA*/</div>
  <div class="urgency-note">/*URGENCY_NOTE*/</div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in a Retargeting Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

This audience has seen the brand before — they're warm but haven't acted. Tone is familiar, not cold. The headline acknowledges the relationship ("you've been thinking about this"). Soft urgency — a reason to act now (price lock, limited slots) without being pushy. Serif italic headline.

━━━ SLOTS ━━━

/*EYEBROW*/ — familiarity cue ALL CAPS e.g. "NAALALA MO PA BA KAMI?" or "MATAGAL MO NA ITONG INIISIP"

/*HL_SIZE*/ — 58 for ≤26 chars · 50 for 27–38 chars · 42 for 39+ chars

/*HEADLINE*/ — italic serif, max 8 words. Acknowledges they've been thinking about this. Warm nudge, not pressure.
  e.g. "Marahil ito na ang tamang panahon." or "Ang desisyong ito ay para sa kanila."

/*BODY*/ — 1 italic sentence max 14 words. Soft urgency — price lock, peace of mind, limited availability.

/*CTA*/ — 2–4 words e.g. "INQUIRE NOW" or "MAKIPAG-USAP SA AMIN"

/*URGENCY_NOTE*/ — 1 very short note e.g. "PRICES SUBJECT TO CHANGE" or "OPEN MON–SAT · 8AM–5PM"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Conversational template ────────────────────────────────────────────────────
function buildConversationalPrompt(brief: AdBrief, s: BrandSettings): string {
  const gold = s.accentColor || '#c9a84c'

  const scaffold = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Cormorant+Garamond:ital,wght@1,400&display=swap" rel="stylesheet">
<style>
${photoBase(gold)}
.overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,7,2,0.30) 0%,rgba(16,7,2,0.08) 25%,rgba(16,7,2,0.56) 55%,rgba(16,7,2,0.88) 100%);}
.logo-top{margin-bottom:auto;align-self:center;}
.logo-img{max-width:130px!important;filter:brightness(0) invert(1) sepia(1) saturate(2.4) hue-rotate(4deg) brightness(0.78)!important;}
.copy{text-align:center;margin-bottom:24px;}
.eyebrow{margin-bottom:12px;}
.question{font-family:'Inter',sans-serif;font-size:/*Q_SIZE*/px;font-weight:800;color:#f7f3ee;line-height:1.1;text-align:center;margin-bottom:16px;hyphens:none;word-break:keep-all;text-shadow:0 2px 18px rgba(0,0,0,0.72);}
.body-line{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-style:italic;color:rgba(247,243,238,0.82);line-height:1.5;text-align:center;}
.cta-wrap{margin-top:auto;margin-bottom:20px;text-align:center;}
.cta-msg{background:${gold};color:#1a1a1a;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;padding:14px 38px;display:inline-block;}
.cta-sub{font-size:9px;letter-spacing:0.2em;color:rgba(247,243,238,0.38);text-transform:uppercase;margin-top:8px;}
</style></head><body>
<div class="bg"><div class="hero"></div><div class="overlay"></div>
<div class="content">
  <div class="logo-top"><img src="{{LOGO_URI}}" class="logo-img" onerror="this.style.display='none'"></div>
  <div class="copy">
    <div class="eyebrow">/*EYEBROW*/</div>
    <div class="question">/*QUESTION*/</div>
    <div class="body-line">/*BODY*/</div>
  </div>
  <div class="cta-wrap">
    <div class="cta-msg">💬 /*CTA*/</div>
    <div class="cta-sub">/*CTA_SUB*/</div>
  </div>
  <div class="footer">Brgy. San Felipe · Tantangan, South Cotabato</div>
</div></div></body></html>`

  return `You are filling in a Conversational Ad for a Philippine memorial park brand.

Business: ${brief.product ?? 'Renaissance Park & Chapels'}
Concept:  ${brief.concept ?? ''}
${brief.caption ? `Caption: "${brief.caption}"` : ''}

Friendly, direct. The headline is a genuine question asked to the reader — invites them to reflect and respond. Lighter overlay keeps the tone warm and approachable. The CTA is a bold "SEND MESSAGE"-style button (chat icon included). Goal is to start a 1-on-1 Messenger conversation.

━━━ SLOTS ━━━

/*EYEBROW*/ — friendly opener ALL CAPS e.g. "NAISIP MO NA BA ITO?" or "LIBRE LANG MAGTANONG"

/*Q_SIZE*/ — 52 for ≤26 chars · 44 for 27–38 chars · 36 for 39+ chars

/*QUESTION*/ — direct question to the reader, max 8 words, sentence-case or title-case.
  e.g. "Nag-iisip ka na bang mag-pre-need?" or "Ready ka na bang mag-usap?"

/*BODY*/ — 1 italic sentence max 14 words. Invites them to start a conversation — reassuring, no pressure.

/*CTA*/ — "SEND MESSAGE" or "MAKIPAG-USAP SA AMIN" or "CHAT WITH US"

/*CTA_SUB*/ — "WE REPLY FAST · WALANG OBLIGASYON" or "OPEN MON–SAT 8AM–5PM"

━━━ SCAFFOLD ━━━
${scaffold}

Output ONLY the filled-in HTML.`
}

// ─── Design prompt: base HTML prompt with brand tokens ───────────────────────
function buildDesignPrompt(brief: AdBrief, s: BrandSettings, revisionNotes?: string): string {
  const kb = loadKnowledgeBaseSync()
  const kbBlock = kb ? `\nBrand knowledge base — use EXACT prices and service names from here:\n${kb}\n` : ''
  return `You are a senior HTML/CSS designer creating a Facebook ad image for a luxury Philippine memorial park.

Canvas: exactly 680px wide by 850px tall. Single self-contained HTML document with inline <style>.

Business: ${brief.product ?? ''}
Concept:  ${brief.concept  ?? ''}
${brief.location ? `Location: ${brief.location}` : ''}
${brief.caption ? `Facebook caption for this ad:\n"${brief.caption}"\nThe headline MUST reflect the theme of this caption — do not write generic copy.` : ''}
${kbBlock}
Brand palette:
- Background:   ${s.bgColor      || '#07372f'}
- Accent gold:  ${s.accentColor  || '#c9a84c'}
- Gold dark:    ${s.accentDark   || '#b28648'}
- Off-white:    ${s.offWhite     || '#f7f3ee'}
- Body text:    ${s.bodyText     || '#b9aa94'}

Asset placeholders — copy EXACTLY into your HTML, swapped at render time:
- Hero photo:    {{HERO_URI}}   → background-image:url({{HERO_URI}}) on a full-bleed div
- Logo/wordmark: {{LOGO_URI}}   → <img src="{{LOGO_URI}}"> tinted gold via CSS filter — omit if not needed
- Icon badge:    {{ICON_URI}}   → <img src="{{ICON_URI}}"> — omit if not needed
IMPORTANT: never alter these placeholder strings.

PERMANENT RULES — these apply always, revision notes cannot override them:
- NEVER repeat the brand name "Renaissance Park" or "Renaissance Park & Chapels" or "Renaissance Park and Chapels" as plain text anywhere in the ad — the logo image IS the brand identifier; do not add a text version of the name below, beside, or near the logo, in the footer, or anywhere else
- NEVER include a phone number anywhere in the ad — not in the footer, not in the CTA, not anywhere
- Text must NEVER compete with the hero photo — the overlay must always be dark enough that every text element is fully legible; use text-shadow:0 1px 10px rgba(0,0,0,0.8) on ALL text elements without exception; small text (eyebrow, footer, labels) must be especially protected since they sit outside the darkest overlay zone
- Headline must have max-width set (340px for left-aligned layouts, 560px for centered) so words never break mid-hyphen or overflow the panel
- CTA button must ALWAYS contain visible text — use "MAKIPAG-USAP SA AMIN" with a ✆ icon if no other CTA text is specified; never render an empty button outline
- Footer must always show the address "Brgy. San Felipe · Tantangan, South Cotabato" in small gold caps — never leave the footer blank
- Total visible words across the entire ad (eyebrow + headline + body line + CTA + footer) must not exceed 40 words — count before rendering and cut if over limit; the headline and body line are where to trim first
- Do NOT place a diamond rule, decorative divider, or any ornamental line directly below the logo — the logo stands alone
- The hero photo must remain visually meaningful — the overlay must never be so dark that the photo becomes unrecognizable or looks like a solid color; at least 40% of the photo's subject must be clearly visible through the overlay; use a gradient that protects text zones while keeping the photo's emotional subject (faces, flowers, park scenery) visible and impactful

Default design directives (apply unless revision notes override):
- Centered layout — all text center-aligned, headline is the dominant visual element
- Large headline — minimum 52px, Cormorant Garamond, takes up the most visual weight on the canvas
- Minimal elements — headline + short body line + optional CTA button only; no clutter
- Full-bleed hero photo as background with a DARK gradient overlay — rgba(7,55,47,0.55) minimum in the lightest zone, rgba(7,55,47,0.92) at bottom where copy lives
- Logo/wordmark tinted gold at top center (small, not competing with headline)
- Single thin gold border frame (1px, rgba 60% opacity)
- CTA button at bottom — thin gold outline, all caps spaced text, transparent background
- Gold decorative rule between headline and body line (diamond or dot-line-dot)
- Fonts: Cormorant Garamond from Google Fonts for all text; fallback Georgia,serif
- body { width:680px; height:850px; overflow:hidden; }
- Do NOT use external images other than the three placeholders

Copy rules:
- Headline: max 8 words, no end punctuation, must work even if body line is never read
- Headline formula — pick ONE: Promise, Problem→Solution, or Social Proof
- Loss framing preferred: what the family risks by not acting > gain framing
- Body line: max 15 words, italic, emotional not functional
- One ad, one job — single objective, no mixed messaging
- Write in Filipino-English mix if the concept calls for it

${revisionNotes ? `Revision notes — apply these on top of the defaults above:\n${revisionNotes}` : ''}

Output ONLY the complete HTML document — no explanation, no markdown fences.`
}

// ─── Main entry point ──────────────────────────────────────────────────────────
export async function generateImageAd(brief: AdBrief, assets: MediaAsset[], revisionNotes?: string): Promise<ImageAdResult> {
  console.log('[ImageGen] Starting image ad generation')

  await loadKnowledgeBase() // warm cache so sync build*Prompt helpers can read it
  const { hero, logo, icon } = await classifyAssets(assets)

  const isVMTemplate = revisionNotes === 'VISUAL_METAPHOR_TEMPLATE'
  const W = isVMTemplate ? 543 : 680
  const H = isVMTemplate ? 466 : 850
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

  // Templates that render without a hero photo
  const NO_PHOTO_TEMPLATES = new Set([
    'VISUAL_METAPHOR_TEMPLATE',
    'WITTY_FILIPINO_TEMPLATE',
    'EDUCATIONAL_TEMPLATE',
  ])
  // All scaffold templates (no photo + photo-required)
  const ALL_TEMPLATES = new Set([
    ...NO_PHOTO_TEMPLATES,
    'SOCIAL_PROOF_TEMPLATE',
    'PROBLEM_SOLUTION_TEMPLATE',
    'LIFESTYLE_TEMPLATE',
    'LIGHT_EMOTIONAL_TEMPLATE',
    'EMOTIONAL_TEMPLATE',
    'STORY_TEMPLATE',
    'AUTHORITY_TEMPLATE',
    'SOFT_DR_TEMPLATE',
    'DIRECT_RESPONSE_TEMPLATE',
    'COMPARISON_TEMPLATE',
    'RETARGETING_TEMPLATE',
    'CONVERSATIONAL_TEMPLATE',
  ])

  const isScaffoldTemplate = !isHtmlMode && ALL_TEMPLATES.has(revisionNotes ?? '')
  const isDesignReprompt = !isHtmlMode && !isScaffoldTemplate && !!revisionNotes &&
    /\b(color|colour|dark|light|bright|layout|font|size|bold|minimal|clean|style|design|background|border|spacing|align|centered|overlay|gradient|shadow|theme|modern|elegant|warm|cool|simple|wide|narrow|compact|bigger|smaller|larger|thinner|thicker|bolder|red|blue|green|yellow|orange|purple|pink|black|white|gray|grey|gold|silver|teal|cyan|magenta|crimson|navy|beige|ivory|cream|maroon|violet|indigo|turquoise|coral|amber|bronze|copper|rose|monochrome|duotone|vibrant|vivid|saturated|desaturated|faded|pastel|neon|muted|washed|earthy|neutral|contrast|hue|tint|shade|tone|palette|italic|underline|uppercase|lowercase|serif|sans|monospace|script|cursive|condensed|extended|regular|medium|semibold|heavy|typeface|weight|tracking|leading|kerning|heading|caption|wordmark|grid|flex|column|row|horizontal|vertical|split|half|full|stack|sidebar|banner|card|panel|section|block|header|footer|margin|padding|gap|indent|corner|inner|outer|edge|middle|blur|glow|shine|shimmer|highlight|sharp|crisp|haze|vignette|bloom|grain|noise|texture|pattern|stripe|curve|wave|diagonal|geometric|organic|abstract|glossy|matte|metallic|sleek|luxury|premium|vintage|retro|classic|timeless|transparent|opaque|translucent|solid|outline|stroke|fill|rounded|radius|circle|square|pill|badge|icon|logo|photo|image|illustration|resize|scale|stretch|shrink|expand|crop|rotate|flip|replace|swap|remove|brighter|darker|lighter|heavier|cinematic|dramatic|moody|airy|crowded|clutter|asymmetric|symmetric|balanced|framed|boxed|contained|bleed)\b/i.test(revisionNotes)

  let html: string
  const needsHero = !NO_PHOTO_TEMPLATES.has(revisionNotes ?? '') && !isHtmlMode
  if (needsHero && !heroUri) throw new Error('No hero image available — please attach a park/venue photo')

  if (isHtmlMode) {
    console.log('[ImageGen] HTML mode — Claude generates full layout')
    html = await generateHtmlAd(s.adPrompt!, heroUri!, wordmarkUri, iconUri, brief, revisionNotes)
  } else if (revisionNotes === 'VISUAL_METAPHOR_TEMPLATE') {
    console.log('[ImageGen] Template: Visual Metaphor')
    html = await generateHtmlAd(buildVisualMetaphorPrompt(brief, s), heroUri ?? '', wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'WITTY_FILIPINO_TEMPLATE') {
    console.log('[ImageGen] Template: Witty / Filipino')
    html = await generateHtmlAd(buildWittyFilipinoPrompt(brief, s), '', wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'EDUCATIONAL_TEMPLATE') {
    console.log('[ImageGen] Template: Educational')
    html = await generateHtmlAd(buildEducationalPrompt(brief, s), '', wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'SOCIAL_PROOF_TEMPLATE') {
    console.log('[ImageGen] Template: Social Proof')
    const reviews = await fetchPageReviews()
    const review = getRandomReview(reviews) ?? undefined
    if (review) console.log(`[ImageGen] Using real FB review from ${review.reviewerName} (${review.rating}★)`)
    html = await generateHtmlAd(buildSocialProofPrompt(brief, s, review), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'OFFER_PROMO_TEMPLATE') {
    console.log('[ImageGen] Template: Offer / Promo')
    html = await generateHtmlAd(buildOfferPromoPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'PROBLEM_SOLUTION_TEMPLATE') {
    console.log('[ImageGen] Template: Problem → Solution')
    html = await generateHtmlAd(buildProblemSolutionPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'LIFESTYLE_TEMPLATE') {
    console.log('[ImageGen] Template: Lifestyle / Positioning')
    html = await generateHtmlAd(buildLifestylePrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'LIGHT_EMOTIONAL_TEMPLATE') {
    console.log('[ImageGen] Template: Light Emotional')
    html = await generateHtmlAd(buildLightEmotionalPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'EMOTIONAL_TEMPLATE') {
    console.log('[ImageGen] Template: Emotional')
    html = await generateHtmlAd(buildEmotionalPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'STORY_TEMPLATE') {
    console.log('[ImageGen] Template: Story')
    html = await generateHtmlAd(buildStoryPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'AUTHORITY_TEMPLATE') {
    console.log('[ImageGen] Template: Authority')
    html = await generateHtmlAd(buildAuthorityPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'SOFT_DR_TEMPLATE') {
    console.log('[ImageGen] Template: Soft Direct Response')
    html = await generateHtmlAd(buildSoftDRPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'DIRECT_RESPONSE_TEMPLATE') {
    console.log('[ImageGen] Template: Direct Response')
    html = await generateHtmlAd(buildDirectResponsePrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'COMPARISON_TEMPLATE') {
    console.log('[ImageGen] Template: Comparison')
    html = await generateHtmlAd(buildComparisonPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'RETARGETING_TEMPLATE') {
    console.log('[ImageGen] Template: Retargeting')
    html = await generateHtmlAd(buildRetargetingPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (revisionNotes === 'CONVERSATIONAL_TEMPLATE') {
    console.log('[ImageGen] Template: Conversational')
    html = await generateHtmlAd(buildConversationalPrompt(brief, s), heroUri!, wordmarkUri, iconUri, brief)
  } else if (isDesignReprompt) {
    console.log('[ImageGen] Design reprompt — switching to HTML mode')
    const designPrompt = buildDesignPrompt(brief, s, revisionNotes)
    html = await generateHtmlAd(designPrompt, heroUri!, wordmarkUri, iconUri, brief, revisionNotes)
  } else {
    const content = await generateAdContent(brief, assets, s, revisionNotes)
    console.log('[ImageGen] Content:', content.eyebrow, '|', content.headline)
    html = buildAdHTML(content, heroUri!, iconUri, wordmarkUri)
  }

  console.log('[ImageGen] Rendering with Puppeteer...')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 })

    const jobId = `img_${Date.now()}`
    const outputDir = path.join(process.cwd(), 'public', 'outputs')
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

    const outputPath = path.join(outputDir, `${jobId}.png`)
    const screenshotTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Puppeteer screenshot timed out after 60s')), 60_000)
    )
    const buffer = await Promise.race([
      page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H }, omitBackground: false }),
      screenshotTimeout,
    ]) as Buffer

    fs.writeFileSync(outputPath, buffer)
    console.log(`[ImageGen] Saved → ${outputPath} (${buffer.length} bytes)`)

    return { localPath: outputPath, buffer, jobId }
  } finally {
    await browser.close()
  }
}
