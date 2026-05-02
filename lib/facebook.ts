import fs from 'fs'
import path from 'path'
import https from 'https'

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
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN

  if (!pageId || !accessToken) {
    throw new Error('FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN must be set in .env.local')
  }

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
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN

  if (!pageId || !accessToken) {
    throw new Error('FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN must be set in .env.local')
  }

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

export async function scheduleImageToFacebook(imagePath: string, caption: string, scheduledTime: Date): Promise<string> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN

  if (!pageId || !accessToken) {
    throw new Error('FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN must be set in .env.local')
  }

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

  console.log(`[Facebook] Photo scheduled — ID: ${result.id}`)
  return `https://www.facebook.com/photo/?fbid=${result.id}`
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
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN
  if (!adAccountId || !accessToken) throw new Error('FB_AD_ACCOUNT_ID or FACEBOOK_ACCESS_TOKEN not set')

  const now = Math.floor(Date.now() / 1000)
  const dailyBudgetCentavos = String(budgetPHP * 100)

  const campaign = await graphApiPost(`/v21.0/${adAccountId}/campaigns`, {
    name: `Boost ${new Date().toISOString().slice(0, 10)}`,
    objective: 'OUTCOME_ENGAGEMENT',
    status: 'ACTIVE',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
    access_token: accessToken,
  })

  const adSet = await graphApiPost(`/v21.0/${adAccountId}/adsets`, {
    name: 'Boost Ad Set',
    campaign_id: campaign.id,
    daily_budget: dailyBudgetCentavos,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'POST_ENGAGEMENT',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: { geo_locations: { countries: [country] }, age_min: ageMin, age_max: ageMax },
    advantage_audience: 0,
    start_time: now,
    status: 'ACTIVE',
    access_token: accessToken,
  })

  const creative = await graphApiPost(`/v21.0/${adAccountId}/adcreatives`, {
    name: 'Boost Creative',
    object_story_id: objectStoryId,
    access_token: accessToken,
  })

  const ad = await graphApiPost(`/v21.0/${adAccountId}/ads`, {
    name: 'Boost Ad',
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: 'ACTIVE',
    access_token: accessToken,
  })

  console.log(`[Facebook] Boosted — campaign:${campaign.id} adset:${adSet.id} ad:${ad.id}`)
  const rawAccountId = adAccountId.replace('act_', '')
  return `https://www.facebook.com/adsmanager/manage/ads?act=${rawAccountId}&selected_ad_ids=${ad.id}`
}

export async function scheduleTextToFacebook(message: string, scheduledTime: Date): Promise<string> {
  const pageId = process.env.FACEBOOK_PAGE_ID
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN

  if (!pageId || !accessToken) {
    throw new Error('FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN must be set in .env.local')
  }

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
