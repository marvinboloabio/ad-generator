import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

const FFMPEG = fs.existsSync('C:\\ffmpeg\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe')
  ? 'C:\\ffmpeg\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe'
  : 'ffmpeg'

// Condense caption to ~25 words for a 10-second voiceover
function condenseForVoiceover(text: string): string {
  const clean = text
    .replace(/#\w+/g, '')
    .replace(/\*+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean]
  let result = ''
  for (const s of sentences) {
    if ((result + s).split(' ').length > 30) break
    result += s + ' '
  }
  return result.trim() || clean.slice(0, 150)
}

export async function generateSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in .env.local')

  const narration = condenseForVoiceover(text)

  // Rachel — warm, calm, empathetic English/Filipino voice
  const voiceId = 'EXAVITQu4vr4xnSDxMaL'

  const body = JSON.stringify({
    text: narration,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.65,
      similarity_boost: 0.80,
      style: 0.30,
      use_speaker_boost: true,
    },
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'audio/mpeg',
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        // ElevenLabs returns audio directly — check for error JSON
        if (res.statusCode && res.statusCode >= 400) {
          try {
            const err = JSON.parse(buf.toString())
            return reject(new Error(`ElevenLabs API: ${err.detail?.message ?? JSON.stringify(err)}`))
          } catch {
            return reject(new Error(`ElevenLabs API error (${res.statusCode})`))
          }
        }
        resolve(buf)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export async function stitchVideoClips(clips: Buffer[]): Promise<Buffer> {
  if (clips.length === 0) throw new Error('No clips to stitch')
  if (clips.length === 1) return clips[0]

  const tmpDir = os.tmpdir()
  const ts = Date.now()
  const clipPaths = clips.map((_, i) => path.join(tmpDir, `rp_clip_${ts}_${i}.mp4`))
  const listPath  = path.join(tmpDir, `rp_list_${ts}.txt`)
  const outputPath = path.join(tmpDir, `rp_concat_${ts}.mp4`)

  try {
    await Promise.all(clips.map((buf, i) => fs.promises.writeFile(clipPaths[i], buf)))
    await fs.promises.writeFile(listPath, clipPaths.map(p => `file '${p}'`).join('\n'), 'utf8')

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG, [
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-y', outputPath,
      ])
      const errLines: string[] = []
      proc.stderr?.on('data', (d: Buffer) => errLines.push(d.toString()))
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`FFmpeg concat (code ${code}): ${errLines.slice(-3).join(' ')}`))
      })
      proc.on('error', reject)
    })

    return await fs.promises.readFile(outputPath)
  } finally {
    await Promise.all([
      ...clipPaths.map(p => fs.promises.unlink(p).catch(() => {})),
      fs.promises.unlink(listPath).catch(() => {}),
      fs.promises.unlink(outputPath).catch(() => {}),
    ])
  }
}

export async function mixVideoAudio(videoBuf: Buffer, audioBuf: Buffer): Promise<Buffer> {
  const tmpDir = os.tmpdir()
  const ts = Date.now()
  const videoPath  = path.join(tmpDir, `rp_vid_${ts}.mp4`)
  const audioPath  = path.join(tmpDir, `rp_aud_${ts}.mp3`)
  const outputPath = path.join(tmpDir, `rp_out_${ts}.mp4`)

  try {
    await fs.promises.writeFile(videoPath, videoBuf)
    await fs.promises.writeFile(audioPath, audioBuf)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG, [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-y',
        outputPath,
      ])
      const errLines: string[] = []
      proc.stderr?.on('data', (d: Buffer) => errLines.push(d.toString()))
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`FFmpeg error (code ${code}): ${errLines.slice(-3).join(' ')}`))
      })
      proc.on('error', reject)
    })

    return await fs.promises.readFile(outputPath)
  } finally {
    await Promise.all([
      fs.promises.unlink(videoPath).catch(() => {}),
      fs.promises.unlink(audioPath).catch(() => {}),
      fs.promises.unlink(outputPath).catch(() => {}),
    ])
  }
}
