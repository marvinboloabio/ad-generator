import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { Readable } from 'stream'

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getAuthUrl(): string {
  const oauth2 = getOAuthClient()
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    prompt: 'consent',
  })
}

export async function listFolderImages(folderId: string): Promise<Array<{ id: string; name: string; directUrl: string; webViewLink: string }>> {
  const drive = getDriveClient()
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id,name,mimeType,webViewLink)',
    pageSize: 100,
  })
  return (res.data.files ?? []).map(f => ({
    id: f.id!,
    name: f.name!,
    directUrl: `https://drive.google.com/uc?export=download&id=${f.id}`,
    webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
  }))
}

export async function exchangeCode(code: string) {
  const oauth2 = getOAuthClient()
  const { tokens } = await oauth2.getToken(code)
  return tokens
}

function getDriveClient() {
  const oauth2 = getOAuthClient()
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    // Only set refresh token — googleapis will fetch a fresh access token automatically
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  } else if (process.env.GOOGLE_ACCESS_TOKEN) {
    oauth2.setCredentials({ access_token: process.env.GOOGLE_ACCESS_TOKEN })
  } else {
    throw new Error('No Google credentials found. Visit /api/auth/google/login to authenticate.')
  }
  return google.drive({ version: 'v3', auth: oauth2 })
}

async function uploadFile(
  filePath: string,
  fileName: string,
  mimeType: string
): Promise<string> {
  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  const fileMetadata: { name: string; parents?: string[] } = { name: fileName }
  if (folderId) fileMetadata.parents = [folderId]

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id,webViewLink',
  })

  const fileId = res.data.id!
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  })

  return res.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`
}

export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient()
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  )
  return Buffer.from(res.data as ArrayBuffer)
}

export async function uploadImage(filePath: string, fileName: string): Promise<string> {
  return uploadFile(filePath, fileName, 'image/png')
}

export async function uploadImageFromUrl(imageUrl: string, fileName: string): Promise<string> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const client = imageUrl.startsWith('https') ? https : http
    const request = (url: string) => client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        request(res.headers.location)
        return
      }
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
    request(imageUrl)
  })

  const drive = getDriveClient()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
  const mimeType = imageUrl.match(/\.(png)$/i) ? 'image/png' : 'image/jpeg'

  const fileMetadata: { name: string; parents?: string[] } = { name: fileName }
  if (folderId) fileMetadata.parents = [folderId]

  const stream = Readable.from(buffer)
  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: { mimeType, body: stream },
    fields: 'id,webViewLink',
  })

  const fileId = res.data.id!
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  })

  return res.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`
}
