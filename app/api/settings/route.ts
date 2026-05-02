import { NextRequest } from 'next/server'
import { loadSettings, saveSettings, BrandSettings } from '@/lib/brandSettings'

export async function GET() {
  return Response.json(loadSettings())
}

export async function POST(req: NextRequest) {
  const body = await req.json() as BrandSettings
  saveSettings(body)
  return Response.json({ ok: true })
}
