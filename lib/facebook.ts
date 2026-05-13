import fs from 'fs'
import path from 'path'
import https from 'https'

const reviewCache = globalThis as typeof globalThis & {
  __fbReviews?: PageReview[]
  __fbReviewsFetchedAt?: number
}
const REVIEW_CACHE_TTL = 6 * 60 * 60 * 1000 // 6 hours

// ── Token helpers ─────────────────────────────────────────────────────────
// Page operations (posts, scheduled_posts, photos, feed, ratings) require a
// Page Access Token under the "New Pages Experience". Ad operations require
// the System User token with ads_management scope.
function pageToken(): string {
  const t = process.env.FACEBOOK_PAGE_TOKEN ?? process.env.FACEBOOK_ACCESS_TOKEN
  if (!t) throw new Error('FACEBOOK_PAGE_TOKEN (or FACEBOOK_ACCESS_TOKEN as fallback) must be set in .env.local')
  return t
}

function adToken(): string {
  const t = process.env.FACEBOOK_ACCESS_TOKEN
  if (!t) throw new Error('FACEBOOK_ACCESS_TOKEN must be set in .env.local')
  return t
}

function postMultipart(
  hostname: string,
  urlPath: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  filename: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now().toString(16)}`
    const fileBuffer = fs.readFileSync(filePath)

    const parts: Buffer[] = []
    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        )
      )
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
      )
    )
    parts.push(fileBuffer)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const options = {
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('Facebook API returned non-JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export async function postImageUrlToFacebook(imageUrl: string, caption: string): Promise<string> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set in .env.local')
  const accessToken = pageToken()

  console.log(`[Facebook] Posting photo by URL for page ${pageId}...`)

  const body = JSON.stringify({ url: imageUrl, caption, access_token: accessToken })
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v20.0/${pageId}/photos`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (result.error) return reject(new Error(`Facebook API error: ${result.error.message}`))
          console.log(`[Facebook] Photo posted — ID: ${result.id}`)
          resolve(`https://www.facebook.com/photo/?fbid=${result.id}`)
        } catch {
          reject(new Error('Facebook API returned non-JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export async function postToFacebook(imagePath: string, caption: string): Promise<{ url: string; postId: string | null }> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set in .env.local')
  const accessToken = pageToken()

  console.log(`[Facebook] Uploading photo for page ${pageId}...`)
  console.log(`[FB Debug] Token prefix: ${accessToken?.slice(0, 20)}... length: ${accessToken?.length}`)

  const filename = path.basename(imagePath)
  const result = await postMultipart(
    'graph.facebook.com',
    `/v20.0/${pageId}/photos`,
    { caption, access_token: accessToken },
    'source',
    imagePath,
    filename
  )

  console.log(`[FB Debug] Photo upload response:`, JSON.stringify(result))

  if (result.error) {
    throw new Error(`Facebook API error: ${result.error.message}`)
  }

  const photoId: string = result.id
  const postId: string | null = result.post_id ?? `${pageId}_${photoId}`
  console.log(`[Facebook] Photo posted — ID: ${photoId}, post_id: ${postId}`)
  return { url: `https://www.facebook.com/photo/?fbid=${photoId}`, postId }
}

export async function scheduleImageToFacebook(imagePath: string, caption: string, scheduledTime: Date): Promise<{ url: string; photoId: string; postId: string | null }> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set in .env.local')
  const accessToken = pageToken()

  const unixTime = String(Math.floor(scheduledTime.getTime() / 1000))
  console.log(`[Facebook] Scheduling photo for page ${pageId} at ${scheduledTime.toISOString()}...`)

  const filename = path.basename(imagePath)
  const result = await postMultipart(
    'graph.facebook.com',
    `/v20.0/${pageId}/photos`,
    { caption, access_token: accessToken, published: 'false', scheduled_publish_time: unixTime },
    'source',
    imagePath,
    filename
  )

  if (result.error) {
    throw new Error(`Facebook API error: ${result.error.message}`)
  }

  const photoId: string = result.id
  const postId: string | null = result.post_id ?? null
  console.log(`[Facebook] Photo scheduled — photoId: ${photoId}, postId: ${postId ?? 'none'}`)
  return { url: `https://www.facebook.com/photo/?fbid=${photoId}`, photoId, postId }
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const isTransient = err.message?.includes('ECONNRESET') || err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT')
      if (!isTransient || attempt === retries) throw err
      await sleep(baseDelayMs * Math.pow(2, attempt))
    }
  }
  throw new Error('unreachable')
}

function graphApiPost(apiPath: string, body: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    console.log(`[Facebook] POST ${apiPath}`, JSON.stringify(body).slice(0, 200))
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 15000,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        console.log(`[Facebook] Response ${apiPath}:`, raw.slice(0, 800))
        try {
          const result = JSON.parse(raw)
          if (result.error) return reject(new Error(`Facebook API: ${result.error.message} (code ${result.error.code})`))
          resolve(result)
        } catch {
          reject(new Error(`Facebook API returned non-JSON: ${raw.slice(0, 200)}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error(`Facebook API timeout on ${apiPath}`)) })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

export async function boostPost(
  objectStoryId: string,
  budgetPHP: number,
  ageMin: number,
  ageMax: number,
  country: string
): Promise<string> {
  const adAccountId = process.env.FB_AD_ACCOUNT_ID
  if (!adAccountId) throw new Error('FB_AD_ACCOUNT_ID not set')
  const accessToken = adToken()

  const now = Math.floor(Date.now() / 1000)
  const dailyBudgetCentavos = String(budgetPHP * 100)

  const campaign = await withRetry(() => graphApiPost(`/v21.0/${adAccountId}/campaigns`, {
    name: `Boost ${new Date().toISOString().slice(0, 10)}`,
    objective: 'OUTCOME_ENGAGEMENT',
    status: 'ACTIVE',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
    access_token: accessToken,
  }))

  const adSet = await withRetry(() => graphApiPost(`/v21.0/${adAccountId}/adsets`, {
    name: 'Boost Ad Set',
    campaign_id: campaign.id,
    daily_budget: dailyBudgetCentavos,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'CONVERSATIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    destination_type: 'MESSENGER',
    targeting: {
      geo_locations: { countries: [country] },
      age_min: ageMin,
      age_max: ageMax,
      targeting_automation: { advantage_audience: 0 },
    },
    start_time: now,
    status: 'ACTIVE',
    access_token: accessToken,
  }))

  const creative = await withRetry(() => graphApiPost(`/v21.0/${adAccountId}/adcreatives`, {
    name: 'Boost Creative',
    object_story_id: objectStoryId,
    call_to_action: {
      type: 'MESSAGE_PAGE',
      value: { page: process.env.FACEBOOK_PAGE_ID },
    },
    access_token: accessToken,
  }))

  const ad = await withRetry(() => graphApiPost(`/v21.0/${adAccountId}/ads`, {
    name: 'Boost Ad',
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: 'ACTIVE',
    access_token: accessToken,
  }))

  console.log(`[Facebook] Boosted — campaign:${campaign.id} adset:${adSet.id} ad:${ad.id}`)
  const rawAccountId = adAccountId.replace('act_', '')
  return `https://www.facebook.com/adsmanager/manage/ads?act=${rawAccountId}&selected_ad_ids=${ad.id}`
}

export interface FBPost {
  id: string
  photoId?: string   // object_id — the photo attached to the post
  message?: string   // post caption
  createdTime: string // ISO
}

export async function fetchPagePosts(limit = 20): Promise<FBPost[]> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set')
  const accessToken = pageToken()

  // Include subattachments so album posts expose their individual photo IDs
  const fields = 'id,message,created_time,attachments{type,target,subattachments{type,target}}'
  const apiPath = `/v20.0/${pageId}/posts?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: apiPath,
      method: 'GET',
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
          const posts: FBPost[] = (result.data ?? []).map((p: any) => {
            const attachment = p.attachments?.data?.[0]
            const attachType: string = attachment?.type ?? ''

            let photoId: string | undefined

            if (attachType === 'photo' && attachment?.target?.id) {
              // Single photo post — target.id is the photo ID
              photoId = attachment.target.id
            } else if ((attachType === 'album' || attachType === 'native_templates') && attachment?.subattachments?.data) {
              // Album or native template — find first photo subattachment
              const firstPhoto = (attachment.subattachments.data as any[]).find(s => s.type === 'photo')
              if (firstPhoto?.target?.id) photoId = firstPhoto.target.id
            }
            // video_inline and other non-photo types are intentionally skipped —
            // their IDs are not usable for photo insights queries

            console.log(`[fetchPagePosts] post ${p.id} — attachType: "${attachType}", photoId: ${photoId ?? 'none'}`)

            return {
              id: p.id,
              photoId,
              message: p.message ?? undefined,
              createdTime: p.created_time,
            }
          })
          resolve(posts)
        } catch {
          reject(new Error('Facebook API returned non-JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

export async function checkPhotoExists(photoId: string): Promise<boolean> {
  const accessToken = process.env.FACEBOOK_PAGE_TOKEN ?? process.env.FACEBOOK_ACCESS_TOKEN
  if (!accessToken) return true // can't verify without token — assume it exists

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v20.0/${photoId}?fields=id&access_token=${encodeURIComponent(accessToken)}`,
      method: 'GET',
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(!result.error)
        } catch {
          resolve(true) // parse error — assume it exists
        }
      })
    })
    req.on('error', () => resolve(true)) // network error — assume it exists
    req.end()
  })
}

export async function scheduleTextToFacebook(message: string, scheduledTime: Date): Promise<string> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set in .env.local')
  const accessToken = pageToken()

  const unixTime = Math.floor(scheduledTime.getTime() / 1000)
  console.log(`[Facebook] Scheduling text post for page ${pageId} at ${scheduledTime.toISOString()}...`)

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message, access_token: accessToken, published: false, scheduled_publish_time: unixTime })
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v20.0/${pageId}/feed`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (result.error) return reject(new Error(`Facebook API error: ${result.error.message}`))
          console.log(`[Facebook] Text post scheduled — ID: ${result.id}`)
          resolve(`https://www.facebook.com/${result.id}`)
        } catch {
          reject(new Error('Facebook API returned non-JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export interface ScheduledPost {
  id: string
  message?: string
  scheduledTime: Date
  thumbnailUrl?: string
}

export async function fetchScheduledPosts(limit = 25): Promise<ScheduledPost[]> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  if (!pageId) throw new Error('FACEBOOK_PAGE_ID must be set')
  const accessToken = pageToken()

  const fields = 'id,message,scheduled_publish_time,attachments{type,media}'
  const apiPath = `/v20.0/${pageId}/scheduled_posts?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path: apiPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            const posts: ScheduledPost[] = (result.data ?? []).map((p: any) => {
              const attachment = p.attachments?.data?.[0]
              const thumbnailUrl: string | undefined = attachment?.media?.image?.src
              return {
                id: p.id,
                message: p.message ?? undefined,
                scheduledTime: new Date(p.scheduled_publish_time * 1000),
                thumbnailUrl,
              }
            })
            posts.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime())
            resolve(posts)
          } catch {
            reject(new Error('Facebook API returned non-JSON response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

// Delete a boost campaign (permanent — used to clean up empty shells).
export async function deleteCampaign(campaignId: string): Promise<void> {
  const accessToken = adToken()
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ access_token: accessToken })
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v21.0/${campaignId}`,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            resolve()
          } catch {
            reject(new Error('Facebook API returned non-JSON response'))
          }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); reject(new Error('Facebook API timeout on delete')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Resume (unpause) a previously paused boost campaign.
export async function resumeBoostCampaign(campaignId: string): Promise<void> {
  const accessToken = adToken()
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ status: 'ACTIVE', access_token: accessToken })
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v21.0/${campaignId}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            resolve()
          } catch { reject(new Error('Facebook API returned non-JSON response')) }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); reject(new Error('Facebook API timeout on resume')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Pause a boost campaign (stops spend immediately, reversible).
// Pass campaign_id from Ads Manager, NOT post/photo id.
export async function pauseBoostCampaign(campaignId: string): Promise<void> {
  const accessToken = adToken()
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ status: 'PAUSED', access_token: accessToken })
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v21.0/${campaignId}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            resolve()
          } catch {
            reject(new Error('Facebook API returned non-JSON response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Reschedule a still-unpublished post. FB accepts a POST to /{post_id}
// with the new scheduled_publish_time (Unix seconds).
export async function updateScheduledPostTime(postId: string, newTime: Date): Promise<void> {
  const accessToken = pageToken()
  const unixTime = Math.floor(newTime.getTime() / 1000)

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ scheduled_publish_time: unixTime, access_token: accessToken })
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v20.0/${postId}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            resolve()
          } catch {
            reject(new Error('Facebook API returned non-JSON response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export async function deletePost(postId: string): Promise<void> {
  const accessToken = pageToken()

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ access_token: accessToken })
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v20.0/${postId}`,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) return reject(new Error(`Facebook API: ${result.error.message}`))
            resolve()
          } catch {
            reject(new Error('Facebook API returned non-JSON response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export interface PageReview {
  reviewerName: string
  rating: number
  text: string
  createdTime: string
}

export async function fetchPageReviews(minRating = 4): Promise<PageReview[]> {
  if (
    reviewCache.__fbReviews &&
    reviewCache.__fbReviewsFetchedAt &&
    Date.now() - reviewCache.__fbReviewsFetchedAt < REVIEW_CACHE_TTL
  ) {
    return reviewCache.__fbReviews.filter(r => r.rating >= minRating)
  }

  const pageId = process.env.FACEBOOK_PAGE_ID
  const accessToken = process.env.FACEBOOK_PAGE_TOKEN ?? process.env.FACEBOOK_ACCESS_TOKEN
  if (!pageId || !accessToken) {
    console.warn('[FB Reviews] Missing FACEBOOK_PAGE_ID or page/access token — skipping review fetch')
    return []
  }

  const fields = 'reviewer{name},rating,recommendation_type,review_text,created_time'
  const apiPath = `/v20.0/${pageId}/ratings?fields=${fields}&limit=50&access_token=${encodeURIComponent(accessToken)}`

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path: apiPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (result.error) {
              console.warn(`[FB Reviews] API error: ${result.error.message} (code ${result.error.code})`)
              resolve([]); return
            }
            if (!result.data) { console.warn('[FB Reviews] No data field in response'); resolve([]); return }
            const raw: any[] = result.data as any[]
            const MAX_REVIEW_CHARS = 180
            const reviews: PageReview[] = raw
              .filter(r => r.review_text && (r.review_text as string).trim().length <= MAX_REVIEW_CHARS)
              .map(r => {
                let rating: number
                if (typeof r.rating === 'number') {
                  rating = r.rating
                } else if (r.recommendation_type === 'positive') {
                  rating = 5
                } else if (r.recommendation_type === 'negative') {
                  rating = 1
                } else {
                  rating = 5
                }
                return {
                  reviewerName: (r.reviewer?.name as string | undefined) ?? 'Isang Pamilya',
                  rating,
                  text: (r.review_text as string).trim(),
                  createdTime: r.created_time as string,
                }
              })
            console.log(`[FB Reviews] Fetched ${reviews.length} reviews (${reviews.filter(r => r.rating >= minRating).length} with rating ≥${minRating})`)
            reviewCache.__fbReviews = reviews
            reviewCache.__fbReviewsFetchedAt = Date.now()
            resolve(reviews.filter(r => r.rating >= minRating))
          } catch (e) { console.warn('[FB Reviews] Parse error:', e); resolve([]) }
        })
      }
    )
    req.on('error', (e) => { console.warn('[FB Reviews] Network error:', e.message); resolve([]) })
    req.end()
  })
}

export function getRandomReview(reviews: PageReview[]): PageReview | null {
  if (reviews.length === 0) return null
  return reviews[Math.floor(Math.random() * reviews.length)]
}
