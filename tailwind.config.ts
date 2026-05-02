import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        gold:         '#C9A84C',
        'gold-light': '#E8D08A',
        'gold-dim':   '#7A6530',
        black:        '#080808',
        surface:      '#111111',
        'surface-2':  '#1A1A1A',
        'surface-3':  '#242424',
        border:       '#2A2A2A',
        ink:          '#F0EDE6',
        muted:        '#7A7870',
      },
      fontFamily: {
        display: ['Cormorant Garamond', 'serif'],
        sans:    ['Outfit', 'sans-serif'],
        mono:    ['DM Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config