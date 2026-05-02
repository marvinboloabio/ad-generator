import fs from 'fs'
import path from 'path'

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

  boostBudgetPHP: 250,
  boostAgeMin:    25,
  boostAgeMax:    60,
  boostCountry:   'PH',
}

const KB_PATH = path.join(process.cwd(), '.claude', 'skills', 'brand', 'docs', 'knowledge_base.txt')

export function loadKnowledgeBase(): string {
  try {
    if (fs.existsSync(KB_PATH)) return fs.readFileSync(KB_PATH, 'utf8').trim()
  } catch { /* ignore */ }
  return ''
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
