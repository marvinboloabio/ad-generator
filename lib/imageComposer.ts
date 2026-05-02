/**
 * Pixel-accurate image processing for the Renaissance Park & Chapels Facebook ad.
 * All operations match the compositing spec exactly.
 */
import sharp from 'sharp'

// ─── Hero Image ──────────────────────────────────────────────────────────────
// Center-crop, brightness ×1.07. No right-edge fade — clean hard cut.
export async function processHeroImage(buffer: Buffer, targetW: number, targetH: number): Promise<string> {
  const png = await sharp(buffer)
    .resize(targetW, targetH, { fit: 'cover', position: 'center' })
    .modulate({ brightness: 1.07 })
    .png()
    .toBuffer()

  return `data:image/png;base64,${png.toString('base64')}`
}

// ─── Logo (background removal via color-distance from corner sample) ──────────
// If corners are already transparent → trust original alpha, just boost RGB.
// Otherwise → sample average corner color as the background and remove pixels
// that are perceptually close to it using Euclidean RGB distance.
// RGB boost ×1.6/1.55/1.35 improves legibility on the dark green panel.
export async function processLogo(buffer: Buffer): Promise<string> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = new Uint8Array(data.buffer)
  const w = info.width, h = info.height, total = w * h

  // Sample all 4 corners (+ 4 near-corner pixels for robustness)
  const sampleCoords = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2],
  ]
  let alphaSum = 0, bgR = 0, bgG = 0, bgB = 0
  for (const [cx, cy] of sampleCoords) {
    const idx = (cy * w + cx) * 4
    alphaSum += pixels[idx + 3]
    bgR += pixels[idx]
    bgG += pixels[idx + 1]
    bgB += pixels[idx + 2]
  }
  const n = sampleCoords.length
  const avgCornerAlpha = alphaSum / n

  for (let i = 0; i < total; i++) {
    const idx = i * 4

    let alpha: number

    if (avgCornerAlpha < 64) {
      // Corners already transparent — image has a pre-cut background.
      // Respect original alpha; no extra removal needed.
      alpha = pixels[idx + 3] / 255
    } else {
      // Solid background — remove pixels similar to the corner color via
      // Euclidean RGB distance (handles white, black, red, green, any color).
      const avgBgR = bgR / n, avgBgG = bgG / n, avgBgB = bgB / n
      const dr = pixels[idx] - avgBgR
      const dg = pixels[idx + 1] - avgBgG
      const db = pixels[idx + 2] - avgBgB
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      // dist < 25  → fully transparent (background)
      // dist > 120 → fully opaque (logo content)
      alpha = Math.min(1, Math.max(0, (dist - 25) / 95))
    }

    // Boost RGB for legibility on dark green panel
    pixels[idx]     = Math.min(255, Math.round(pixels[idx]     * 1.6))
    pixels[idx + 1] = Math.min(255, Math.round(pixels[idx + 1] * 1.55))
    pixels[idx + 2] = Math.min(255, Math.round(pixels[idx + 2] * 1.35))
    pixels[idx + 3] = Math.round(alpha * 255)
  }

  const png = await sharp(Buffer.from(pixels.buffer), {
    raw: { width: w, height: h, channels: 4 },
  }).png().toBuffer()

  return `data:image/png;base64,${png.toString('base64')}`
}

// ─── Icon Square (white-background removal, no circular mask, 64×64) ────────
// Removes white/near-white pixels (threshold >220 RGB) with soft feathering.
// Used for the logo-bar icon in the Ogilvy template.
export async function processIconSquare(buffer: Buffer, size = 64): Promise<string> {
  const { data, info } = await sharp(buffer)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = new Uint8Array(data.buffer)
  const total = info.width * info.height

  for (let i = 0; i < total; i++) {
    const idx = i * 4
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2]
    const brightness = Math.min(r, g, b)
    if (brightness > 200) {
      // 200–220: feather; >220: fully transparent
      const a = brightness > 220 ? 0 : Math.round((220 - brightness) / 20 * 255)
      pixels[idx + 3] = Math.min(pixels[idx + 3], a)
    }
  }

  const png = await sharp(Buffer.from(pixels.buffer), {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer()

  return `data:image/png;base64,${png.toString('base64')}`
}

// ─── Icon Badge (white-background removal + circular mask) ───────────────────
// bg_score = sqrt(clip((brightness−0.75)/0.10,0,1) × clip((0.25−sat)/0.25,0,1))
// circular_mask = clip((radius×0.90 − dist)/4, 0, 1)
// alpha = (1−bg_score) × circular_mask
export async function processIconBadge(buffer: Buffer, size: number): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(size, size, { fit: 'cover', position: 'center' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = new Uint8Array(data.buffer)
  const cx = size / 2, cy = size / 2, radius = size / 2

  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size)
    const idx = i * 4
    const r = pixels[idx] / 255, g = pixels[idx+1] / 255, b = pixels[idx+2] / 255

    const brightness = (r + g + b) / 3
    const maxC = Math.max(r, g, b), minC = Math.min(r, g, b)
    const saturation = maxC > 0 ? (maxC - minC) / maxC : 0

    const bgScore = Math.sqrt(
      Math.min(1, Math.max(0, (brightness - 0.75) / 0.10)) *
      Math.min(1, Math.max(0, (0.25 - saturation) / 0.25))
    )

    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    const circularMask = Math.min(1, Math.max(0, (radius * 0.90 - dist) / 4))

    pixels[idx+3] = Math.round((1 - bgScore) * circularMask * 255)
  }

  const png = await sharp(Buffer.from(pixels.buffer), {
    raw: { width: size, height: size, channels: 4 },
  }).png().toBuffer()

  return `data:image/png;base64,${png.toString('base64')}`
}

// ─── Avatar (crop top 65% → center-square → 72px circular → 88px badge with rings) ──
// Returns 88×88 PNG with layered gold rings baked in:
//   outer glow rgba(178,134,72,0.16) r=44 → dark gap rgba(12,42,34,0.94) r=41
//   → bright gold #c9a84c r=39 → gold #b28648 r=37 → inner fill #0c2a22 r=36
//   → 72×72 circular face composited at (8,8)
export async function processAvatar(buffer: Buffer): Promise<string> {
  const { width: origW, height: origH } = await sharp(buffer).metadata()
  if (!origW || !origH) throw new Error('Avatar: could not read image dimensions')

  const cropH = Math.round(origH * 0.65)
  const squareSize = Math.min(origW, cropH)
  const left = Math.round((origW - squareSize) / 2)

  const resized = await sharp(buffer)
    .extract({ left, top: 0, width: squareSize, height: squareSize })
    .resize(72, 72, { fit: 'cover' })
    .png()
    .toBuffer()

  // Circular mask for the face (72×72)
  const faceMaskSvg = Buffer.from(
    '<svg width="72" height="72" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="36" cy="36" r="36" fill="white"/></svg>'
  )
  const circularFace = await sharp(resized)
    .composite([{ input: faceMaskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer()

  // 88×88 ring layers as SVG (outside → inside)
  const ringsSvg = Buffer.from(
    '<svg width="88" height="88" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="44" cy="44" r="44" fill="rgba(178,134,72,0.16)"/>' +
    '<circle cx="44" cy="44" r="41" fill="rgba(12,42,34,0.94)"/>' +
    '<circle cx="44" cy="44" r="39" fill="#c9a84c"/>' +
    '<circle cx="44" cy="44" r="37" fill="#b28648"/>' +
    '<circle cx="44" cy="44" r="36" fill="#0c2a22"/>' +
    '</svg>'
  )

  const badge = await sharp({
    create: { width: 88, height: 88, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: ringsSvg },
      { input: circularFace, left: 8, top: 8 },
    ])
    .png()
    .toBuffer()

  return `data:image/png;base64,${badge.toString('base64')}`
}
