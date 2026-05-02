import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { loadSettings, saveSettings } from '@/lib/brandSettings'

export async function POST(req: NextRequest) {
  const data = await req.formData()
  const file = data.get('logo') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const buf = Buffer.from(await file.arrayBuffer())
  const brandDir = path.join(process.cwd(), 'public', 'brand')
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png'
  const filename = `logo.${ext}`
  fs.writeFileSync(path.join(brandDir, filename), buf)

  const logoUrl = `/brand/${filename}`
  const settings = loadSettings()
  saveSettings({ ...settings, logoUrl })

  return NextResponse.json({ url: logoUrl })
}

export async function DELETE() {
  const settings = loadSettings()
  if (settings.logoUrl) {
    const filePath = path.join(process.cwd(), 'public', settings.logoUrl.replace(/^\//, ''))
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    saveSettings({ ...settings, logoUrl: '' })
  }
  return NextResponse.json({ ok: true })
}
