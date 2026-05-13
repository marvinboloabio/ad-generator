import https from 'https'
import http from 'http'

// ── Generic HTTP GET → string ─────────────────────────────────────────────
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RenaissanceParkBot/1.0)' } }, (res) => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchText(res.headers.location).then(resolve).catch(reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('fetch timeout')) })
  })
}

function fetchJSON(url: string, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const parsed = new URL(url)
    const req = mod.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'RenaissanceParkBot/1.0', ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch { reject(new Error('non-JSON response')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('fetch timeout')) })
    req.end()
  })
}

// ── Simple RSS parser ─────────────────────────────────────────────────────
function parseRSSTitles(xml: string): string[] {
  const titles: string[] = []
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/g
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1]
    const cdataMatch = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
    const plainMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)
    const raw = cdataMatch ? cdataMatch[1] : plainMatch ? plainMatch[1] : ''
    const title = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim()
    if (title) titles.push(title)
  }
  return titles
}

// ── Google Trends Philippines — Region 12 (SOCCSKSARGEN) ─────────────────
export async function fetchGoogleTrendsPH(): Promise<string[]> {
  // Try Region 12 first; fall back to national PH if no results returned
  const xml12 = await fetchText('https://trends.google.com/trending/rss?geo=PH-12')
  const titles12 = parseRSSTitles(xml12)
  if (titles12.length > 0) return titles12

  const xml = await fetchText('https://trends.google.com/trending/rss?geo=PH')
  return parseRSSTitles(xml)
}

// ── Philippine News RSS ───────────────────────────────────────────────────
const NEWS_FEEDS = [
  // National
  'https://www.rappler.com/feed/',
  'https://newsinfo.inquirer.net/feed',
  'https://www.abs-cbn.com/rss/news',
  // Region 12 / Mindanao
  'https://mindanews.com/feed/',  // MindaNews — confirmed working, covers Mindanao incl. Region 12
]

const NEWS_KEYWORDS = [
  // Family
  'family', 'pamilya', 'magulang', 'anak', 'lolo', 'lola', 'nanay', 'tatay',
  'kapatid', 'asawa', 'kamag-anak',
  // OFW / Distance
  'OFW', 'overseas', 'abroad', 'migrant', 'remittance', 'balikbayan',
  // Grief / Loss
  'grief', 'libing', 'punerarya', 'namatay', 'patay', 'kamatayan', 'pagpanaw',
  'lumipas', 'pumanaw', 'funeral', 'burial', 'interment', 'cremation',
  // Health / Aging
  'aging', 'elderly', 'senior', 'ospital', 'sakit', 'healthcare', 'hospice',
  'cancer', 'stroke', 'heart attack', 'dementia',
  // Memorial / Planning
  'memorial', 'cemetery', 'grave', 'lote', 'preplanning', 'insurance',
  'pamana', 'mana', 'habilin',
  // Emotional
  'pagmamahal', 'alaala', 'paalam', 'huling', 'kalungkutan', 'lungkot',
  'pag-asa', 'puso', 'damdamin',
]

export async function fetchNewsRSS(): Promise<string[]> {
  const results: string[] = []
  for (const feed of NEWS_FEEDS) {
    try {
      const xml = await fetchText(feed)
      const titles = parseRSSTitles(xml)
      for (const t of titles) {
        const lower = t.toLowerCase()
        if (NEWS_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) {
          results.push(t)
        }
      }
    } catch { /* skip failed feeds */ }
  }
  return [...new Set(results)]
}

// ── Reddit OAuth ──────────────────────────────────────────────────────────
let _redditToken: string | null = null
let _redditTokenExpiry = 0

async function getRedditToken(): Promise<string> {
  if (_redditToken && Date.now() < _redditTokenExpiry) return _redditToken

  const clientId = process.env.REDDIT_CLIENT_ID
  const secret   = process.env.REDDIT_CLIENT_SECRET
  const user     = process.env.REDDIT_USERNAME
  const pass     = process.env.REDDIT_PASSWORD
  if (!clientId || !secret || !user || !pass) throw new Error('Reddit credentials not set in .env.local')

  const body = `grant_type=password&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64')

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.reddit.com',
      path: '/api/v1/access_token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `nodejs:RenaissanceParkSignals/1.0 (by /u/${user})`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          if (!data.access_token) return reject(new Error(`Reddit auth failed: ${data.error ?? JSON.stringify(data)}`))
          _redditToken = data.access_token
          _redditTokenExpiry = Date.now() + (data.expires_in - 60) * 1000
          resolve(_redditToken!)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function redditGet(path: string): Promise<any> {
  const token = await getRedditToken()
  const user  = process.env.REDDIT_USERNAME ?? 'bot'
  return fetchJSON(`https://oauth.reddit.com${path}`, {
    Authorization: `Bearer ${token}`,
    'User-Agent': `nodejs:RenaissanceParkSignals/1.0 (by /u/${user})`,
  })
}

// Surface: new/rising posts from last 4 hours, min 10 upvotes
export async function fetchRedditSurface(): Promise<string[]> {
  const subs = 'Philippines+phcareers+CasualPH'
  const data = await redditGet(`/r/${subs}/new?limit=100`)
  const cutoff = Date.now() / 1000 - 4 * 3600
  return (data.data?.children ?? [])
    .filter((p: any) => p.data.created_utc >= cutoff && p.data.score >= 10)
    .map((p: any) => p.data.title as string)
}

// Deep: top posts of month (100+ upvotes) + top 30 comments (20+ upvotes)
export async function fetchRedditDeep(): Promise<string[]> {
  const subs = 'OffMyChestPH+phcareers+Philippines'
  const data = await redditGet(`/r/${subs}/top?t=month&limit=25`)
  const posts = (data.data?.children ?? []).filter((p: any) => p.data.score >= 100)
  const texts: string[] = []

  for (const post of posts.slice(0, 10)) {
    texts.push(post.data.title)
    try {
      const thread = await redditGet(`/r/${post.data.subreddit}/comments/${post.data.id}?limit=30&sort=top`)
      const comments: any[] = thread[1]?.data?.children ?? []
      for (const c of comments) {
        if (c.kind === 't1' && c.data.score >= 20 && c.data.body && c.data.body !== '[deleted]') {
          texts.push(c.data.body.slice(0, 300))
        }
      }
    } catch { /* skip failed comment fetch */ }
  }
  return texts
}

// ── YouTube Data API ──────────────────────────────────────────────────────
const YT_QUERIES = [
  'OFW family Philippines emotion',
  'Filipino nanay tatay sacrifice',
  'pagmamahal pamilya Pilipino',
  'grief loss Philippines family',
]

const YT_CHANNELS = [
  'UCXBpKNBzBkrgB0lQ0nt3BHQ', // GMA News
  'UCyaSHFUFU3TS-ZCwsRgJe6g', // ABS-CBN News (example)
]

export async function fetchYouTubeTitles(): Promise<string[]> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) throw new Error('YOUTUBE_API_KEY not set in .env.local')
  const titles: string[] = []

  for (const q of YT_QUERIES) {
    try {
      const search = await fetchJSON(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&regionCode=PH&order=viewCount&maxResults=10&key=${key}`
      )
      for (const item of (search.items ?? [])) {
        const title: string = item.snippet?.title ?? ''
        if (title && title !== 'Private video' && title !== 'Deleted video') {
          titles.push(title.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim())
        }
      }
    } catch { /* skip failed query */ }
  }
  return [...new Set(titles)]
}

export async function fetchYouTubeComments(): Promise<string[]> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) throw new Error('YOUTUBE_API_KEY not set in .env.local')
  const texts: string[] = []

  for (const q of YT_QUERIES) {
    try {
      const search = await fetchJSON(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&regionCode=PH&order=viewCount&maxResults=5&key=${key}`
      )
      const videoIds: string[] = (search.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean)
      for (const vid of videoIds.slice(0, 3)) {
        try {
          const ct = await fetchJSON(
            `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${vid}&order=relevance&maxResults=20&key=${key}`
          )
          for (const item of (ct.items ?? [])) {
            const text: string = item.snippet?.topLevelComment?.snippet?.textDisplay ?? ''
            const likes: number = item.snippet?.topLevelComment?.snippet?.likeCount ?? 0
            if (likes >= 5 && text.length > 20) texts.push(text.replace(/<[^>]+>/g, '').slice(0, 300))
          }
        } catch { /* comments disabled or error */ }
      }
    } catch { /* query failed */ }
  }
  return texts
}
