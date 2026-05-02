import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { loadSettings, saveSettings } from '@/lib/brandSettings'

export async function POST(req: NextRequest) {
  const data = await req.formData()
  const file = data.get('avatar') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const buf = Buffer.from(await file.arrayBuffer())
  const brandDir = path.join(process.cwd(), 'public', 'brand')
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png'
  const filename = `avatar.${ext}`
  fs.writeFileSync(path.join(brandDir, filename), buf)

  const staffAvatarUrl = `/brand/${filename}`
  const settings = loadSettings()
  saveSettings({ ...settings, staffAvatarUrl })

  return NextResponse.json({ url: staffAvatarUrl })
}

export async function DELETE() {
  const settings = loadSettings()
  if (settings.staffAvatarUrl) {
    const filePath = path.join(process.cwd(), 'public', settings.staffAvatarUrl.replace(/^\//, ''))
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    saveSettings({ ...settings, staffAvatarUrl: '' })
  }
  return NextResponse.json({ ok: true })
}
