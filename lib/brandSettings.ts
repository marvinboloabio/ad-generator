import fs from 'fs'
import path from 'path'
import https from 'https'

const SETTINGS_PATH = path.join(process.cwd(), 'brand-settings.json')

export interface BrandSettings {
  // Colors
  bgColor: string
  accentColor: string
  accentDark: string
  offWhite: string
  bodyText: string
  footerBg: string
  featureBoxBg: string

  // Fonts (Google Fonts names)
  headlineFont: string
  bodyFont: string

  // Font sizes (px)
  headlineFontSize: number
  subtitleFontSize: number
  taglineFontSize: number
  bodyFontSize: number
  eyebrowFontSize: number
  ctaFontSize: number

  // Copy overrides
  eyebrowText: string
  footerTagline: string
  defaultCta: string
  footerRight1: string
  footerRight2: string

  // Preset logo — stored as /brand/logo.<ext> in public/, empty string = none
  logoUrl: string

  // Default staff member shown in the avatar row
  staffName: string
  staffRole: string
  staffAvatarUrl: string

  // Claude prompt template — use {{business}}, {{concept}}, {{features}},
  // {{tagline}}, {{location}}, {{cta}}, {{extra_instructions}} as placeholders.
  // The JSON response schema is always appended automatically.
  promptTemplate: string

  // Extra instructions appended via {{extra_instructions}} in the template
  claudeInstructions: string

  // Full custom prompt for the Ogilvy image ad — replaces the hardcoded default entirely
  adPrompt: string

  // Auto-boost settings (Facebook Marketing API)
  boostBudgetPHP: number
  boostAgeMin: number
  boostAgeMax: number
  boostCountry: string
  autoBoostEnabled: boolean

  // Auto-pause rule: pause any boost whose cost-per-message exceeds threshold
  // after it has spent at least minSpendBeforeAction PHP.
  autoPauseEnabled: boolean
  autoPauseCpmThreshold: number     // ₱ per message above which a boost gets paused
  autoPauseMinSpend: number         // ₱ minimum spent before this rule activates

  // Auto-boost-again rule: when a campaign hits WINNER status (score ≥ 6) and
  // has spent at least minSpendForWinner, automatically duplicate it.
  autoBoostAgainEnabled: boolean
  autoBoostAgainMinScore: number    // minimum scaler score to trigger (default 6)
  autoBoostAgainCooldownDays: number // don't re-duplicate the same post more than once per N days

  // Scheduled coverage check
  coverageCheckIntervalDays: number  // 0 = disabled
  coverageCheckHourPHT: number       // 0-23 PHT hour to fire (default 9)
  coverageCheckChannelId: string     // Discord channel to post results in
  coverageCheckLastRun: string       // ISO — when it last ran
}

export const DEFAULT_PROMPT_TEMPLATE = `Create Facebook ad copy for this business.
Business: {{business}}
Concept: {{concept}}
{{features}}
{{tagline}}
{{location}}
{{cta}}
{{extra_instructions}}`

export const DEFAULT_SETTINGS: BrandSettings = {
  bgColor:       '#0c2a22',
  accentColor:   '#c9a84c',
  accentDark:    '#b28648',
  offWhite:      '#f7f3ee',
  bodyText:      '#b9aa94',
  footerBg:      '#071f17',
  featureBoxBg:  '#07372f',

  headlineFont:  'Roboto Slab',
  bodyFont:      'Montserrat',

  logoUrl:          '',

  staffName:        '',
  staffRole:        '',
  staffAvatarUrl:   '',

  headlineFontSize: 34,
  subtitleFontSize: 17,
  taglineFontSize:  15,
  bodyFontSize:     14,
  eyebrowFontSize:  11,
  ctaFontSize:      19,

  eyebrowText:   'TRUSTED MEMORIAL PARK & CHAPEL SERVICES',
  footerTagline: 'Where Every Life is Celebrated',
  defaultCta:    'INQUIRE NOW',
  footerRight1:  'RENAISSANCE',
  footerRight2:  'PARK & CHAPELS',

  promptTemplate:     DEFAULT_PROMPT_TEMPLATE,
  claudeInstructions: '',
  adPrompt:           '',

  boostBudgetPHP:    250,
  boostAgeMin:       25,
  boostAgeMax:       60,
  boostCountry:      'PH',
  autoBoostEnabled:  false,

  autoPauseEnabled:        false,
  autoPauseCpmThreshold:   400,
  autoPauseMinSpend:       500,

  autoBoostAgainEnabled:   false,
  autoBoostAgainMinScore:  6,
  autoBoostAgainCooldownDays: 7,

  coverageCheckIntervalDays: 0,
  coverageCheckHourPHT:      9,
  coverageCheckChannelId:    '',
  coverageCheckLastRun:      '',
}

const KB_PATH = path.join(process.cwd(), '.claude', 'skills', 'brand', 'docs', 'knowledge_base.txt')
const KB_DOC_ID = '1PbRX81f0XueXhqo1g2AKxWrXREiSTL93njulE7VYijc'
const KB_CACHE_TTL = 60 * 60 * 1000 // 1 hour

const kbCache = globalThis as typeof globalThis & {
  __kbContent?: string
  __kbFetchedAt?: number
}

function fetchDocText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchDocText(res.headers.location).then(resolve).catch(reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()))
      res.on('error', reject)
    }).on('error', reject)
  })
}

export function loadKnowledgeBaseSync(): string {
  if (kbCache.__kbContent) return kbCache.__kbContent
  try {
    if (fs.existsSync(KB_PATH)) return fs.readFileSync(KB_PATH, 'utf8').trim()
  } catch { /* ignore */ }
  return ''
}

export async function loadKnowledgeBase(): Promise<string> {
  if (kbCache.__kbContent && kbCache.__kbFetchedAt && Date.now() - kbCache.__kbFetchedAt < KB_CACHE_TTL) {
    return kbCache.__kbContent
  }
  try {
    const text = await fetchDocText(`https://docs.google.com/document/d/${KB_DOC_ID}/export?format=txt`)
    kbCache.__kbContent = text
    kbCache.__kbFetchedAt = Date.now()
    return text
  } catch {
    // network down — fall back to local copy
    try {
      if (fs.existsSync(KB_PATH)) return fs.readFileSync(KB_PATH, 'utf8').trim()
    } catch { /* ignore */ }
    return kbCache.__kbContent ?? ''
  }
}

export function loadSettings(): BrandSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8')
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    }
  } catch {
    // ignore — return defaults
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: BrandSettings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8')
}
