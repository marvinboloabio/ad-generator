import { NextRequest } from 'next/server'
import { startBot, stopBot, getBot } from '@/lib/discordBot'

export async function GET() {
  const bot = getBot()
  return Response.json({ running: !!bot, tag: bot?.user?.tag ?? null })
}

export async function POST(request: NextRequest) {
  const { action } = await request.json()

  if (action === 'start') {
    await startBot()
    return Response.json({ ok: true, message: 'Bot started' })
  }

  if (action === 'stop') {
    await stopBot()
    return Response.json({ ok: true, message: 'Bot stopped' })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
