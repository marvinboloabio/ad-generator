import Anthropic from '@anthropic-ai/sdk'
import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { pathToFileURL } from 'url'
import { generateConceptImage, generateVideoFromImage } from './runway'
import { generateSpeech, stitchVideoClips, mixVideoAudio } from './tts'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface GuideScene {
  title: string
  narration: string      // 22–26 words, 10s
  slidePrompt: string    // generateConceptImage prompt
  visualPrompt: string   // Runway animation prompt
}

// ── Checkpoint helpers ────────────────────────────────────────────────────
function pdfHash(pdfBuffer: Buffer): string {
  return crypto.createHash('md5').update(pdfBuffer).digest('hex').slice(0, 12)
}

function scriptPath(hash: string)          { return path.join(os.tmpdir(), `rp_guide_${hash}_script.json`) }
function clipPath(hash: string, i: number) { return path.join(os.tmpdir(), `rp_guide_${hash}_clip_${i}.mp4`) }

async function cleanupCheckpoint(hash: string) {
  await Promise.all([
    fs.promises.unlink(scriptPath(hash)).catch(() => {}),
    ...Array.from({ length: 6 }, (_, i) => fs.promises.unlink(clipPath(hash, i)).catch(() => {})),
  ])
}

// ── PDF text extraction (pdfjs-dist legacy ESM, no canvas needed) ─────────
let _pdfjs: any = null
async function getPdfJs() {
  if (!_pdfjs) {
    _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any)
    _pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
    ).href
  }
  return _pdfjs
}

async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const pdfjsLib = await getPdfJs()
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
  }).promise

  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item: any) => item.str ?? '')
      .filter((s: string) => s.trim().length > 0)
      .join(' ')
    if (text) pages.push(text)
  }
  return pages.join('\n\n')
}

// ── Claude: PDF content → 6-scene script ─────────────────────────────────
async function generateGuideScript(pdfText: string): Promise<GuideScene[]> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: `You write 6-scene 60-second explainer video scripts from document content. Each scene = 10 seconds.

For each scene produce:
- title: 3–5 word section label
- narration: exactly 22–26 words, calm professional voice, the single most important thing a viewer needs to know
- slidePrompt: image generation prompt for a branded slide — include: dark navy blue background (#0d1b3e), gold (#c9a227) accent line, white heading text, clean flat UI icon or mockup related to the section, Renaissance Park RP logo, 16:9 landscape, minimalist, no people, no photos
- visualPrompt: Runway animation — keep it simple: "slow gentle push in on dark navy presentation slide, professional corporate, gold accent, clean typography"

Respond ONLY with a valid JSON array of exactly 6 objects:
[{"title":"...","narration":"...","slidePrompt":"...","visualPrompt":"..."},...]`,
    messages: [{
      role: 'user',
      content: `Write a 60-second 6-scene explainer video script for this agent portal guide:\n\n${pdfText.slice(0, 5000)}`,
    }],
  })

  const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
  return (parsed as GuideScene[]).slice(0, 6)
}

// ── Download a URL to a Buffer ────────────────────────────────────────────
export function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject)
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

// ── Main orchestrator (with checkpoint/resume) ────────────────────────────
export async function buildGuideVideo(
  pdfBuffer: Buffer,
  onProgress: (msg: string) => Promise<void>,
): Promise<Buffer> {
  const hash = pdfHash(pdfBuffer)

  // ── Script: reuse saved script if available ──
  let scenes: GuideScene[]
  const savedScript = scriptPath(hash)
  if (fs.existsSync(savedScript)) {
    scenes = JSON.parse(fs.readFileSync(savedScript, 'utf8'))
    await onProgress('📋 Resuming from checkpoint — script loaded...')
  } else {
    await onProgress('📄 Extracting PDF content...')
    const pdfText = await extractPdfText(pdfBuffer)
    await onProgress('📝 Writing 6-scene script...')
    scenes = await generateGuideScript(pdfText)
    fs.writeFileSync(savedScript, JSON.stringify(scenes, null, 2))
  }

  const clips: Buffer[] = []

  for (let i = 0; i < scenes.length; i++) {
    const saved = clipPath(hash, i)

    // Resume: skip scenes whose clip was already saved
    if (fs.existsSync(saved)) {
      await onProgress(`⏭️ Scene ${i + 1}/6 — ${scenes[i].title} (resuming)`)
      clips.push(await fs.promises.readFile(saved))
      continue
    }

    const scene = scenes[i]
    await onProgress(`🎬 Scene ${i + 1}/6 — ${scene.title}`)

    const [slideImageBuf, audioBuf] = await Promise.all([
      generateConceptImage(scene.slidePrompt),
      generateSpeech(scene.narration),
    ])

    const dataUri = `data:image/png;base64,${slideImageBuf.toString('base64')}`
    const videoBuf = await generateVideoFromImage(dataUri, scene.visualPrompt, 10)
    const mixed = await mixVideoAudio(videoBuf, audioBuf)

    // Save clip so a retry can skip this scene
    await fs.promises.writeFile(saved, mixed)
    clips.push(mixed)
  }

  await onProgress('🔗 Stitching 6 clips into final video...')
  const final = await stitchVideoClips(clips)

  // Clean up checkpoint files now that we're done
  await cleanupCheckpoint(hash)

  return final
}
