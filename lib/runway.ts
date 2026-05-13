import https from 'https'
import http from 'http'

const BASE_URL = 'https://api.dev.runwayml.com'

function runwayPost(path: string, body: Record<string, any>): Promise<any> {
  const apiKey = process.env.RUNWAY_API_KEY
  if (!apiKey) throw new Error('RUNWAY_API_KEY not set in .env.local')

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const req = https.request({
      hostname: 'api.dev.runwayml.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': '2024-11-06',
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          const result = JSON.parse(raw)
          if (result.error) return reject(new Error(`Runway API: ${result.error} — ${JSON.stringify(result.issues ?? '')}`))
          resolve(result)
        } catch {
          reject(new Error(`Runway API non-JSON: ${raw.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

function runwayGet(path: string): Promise<any> {
  const apiKey = process.env.RUNWAY_API_KEY
  if (!apiKey) throw new Error('RUNWAY_API_KEY not set in .env.local')

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.dev.runwayml.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': '2024-11-06',
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('Runway API non-JSON response')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function pollTask(taskId: string, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    const task = await runwayGet(`/v1/tasks/${taskId}`)
    if (task.status === 'SUCCEEDED') {
      const url: string = task.output?.[0]
      if (!url) throw new Error('Runway task succeeded but output URL is missing')
      return url
    }
    if (task.status === 'FAILED') {
      throw new Error(`Runway task failed: ${task.failure ?? task.failureCode ?? 'unknown'}`)
    }
  }
  throw new Error(`Runway task timed out after ${Math.round(timeoutMs / 60000)} minutes`)
}

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject)
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

// Generate a still concept image from an ad brief text
export async function generateConceptImage(prompt: string): Promise<Buffer> {
  const task = await runwayPost('/v1/text_to_image', {
    model: 'gen4_image',
    promptText: prompt,
    ratio: '1360:768',
  })
  const outputUrl = await pollTask(task.id)
  return downloadUrl(outputUrl)
}

// Generate a short video ad — text-to-video (no source image required)
export async function generateVideoAd(prompt: string): Promise<Buffer> {
  const task = await runwayPost('/v1/text_to_video', {
    model: 'gen4.5',
    promptText: prompt,
    ratio: '1280:720',
    duration: 5,
  })
  const outputUrl = await pollTask(task.id)
  return downloadUrl(outputUrl)
}

// Generate a video ad from an existing image (image-to-video)
export async function generateVideoFromImage(imageDataUri: string, prompt: string, duration: 5 | 10 = 10): Promise<Buffer> {
  const task = await runwayPost('/v1/image_to_video', {
    model: 'gen4.5',
    promptImage: imageDataUri,
    promptText: prompt,
    ratio: '1280:720',
    duration,
  })
  const outputUrl = await pollTask(task.id, 300_000) // 5 min timeout for 10s video
  return downloadUrl(outputUrl)
}
