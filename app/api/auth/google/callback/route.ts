import { NextRequest } from 'next/server'
import { exchangeCode } from '@/lib/googleDrive'
import fs from 'fs'
import path from 'path'

function updateEnvLocal(updates: Record<string, string>) {
  const envPath = path.join(process.cwd(), '.env.local')
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^#?${key}=.*$`, 'm')
    const line = `${key}=${value}`
    if (regex.test(content)) {
      content = content.replace(regex, line)
    } else {
      content += `\n${line}`
    }
  }

  fs.writeFileSync(envPath, content, 'utf8')
  // Apply to current process immediately
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    return Response.json({ error: error ?? 'Missing code' }, { status: 400 })
  }

  const tokens = await exchangeCode(code)

  const updates: Record<string, string> = {}
  if (tokens.access_token) updates['GOOGLE_ACCESS_TOKEN'] = tokens.access_token
  if (tokens.refresh_token) updates['GOOGLE_REFRESH_TOKEN'] = tokens.refresh_token

  updateEnvLocal(updates)
  console.log('[Google OAuth] Tokens saved to .env.local')

  return new Response(
    `<html><body style="font-family:monospace;background:#080808;color:#C9A84C;padding:40px">
      <h2>✓ Google Drive Connected</h2>
      <p style="color:#4CAF73">Tokens saved to .env.local automatically.</p>
      ${tokens.refresh_token ? '<p style="color:#4CAF73">Refresh token saved — you will not need to re-authenticate again.</p>' : '<p style="color:#E87B4C">No refresh token returned. If this token expires, visit this page again.</p>'}
      <p style="margin-top:24px"><a href="/" style="color:#C9A84C">← Back to dashboard</a></p>
    </body></html>`,
    { headers: { 'content-type': 'text/html' } }
  )
}
