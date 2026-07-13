// Ink density 0..255 per pixel: dark + desaturated counts as line.
// Handles alpha-only line art (RGB black, alpha = strokes) and rejects
// colored underdrawings (e.g. red construction lines) via saturation.
export function extractInk(img: ImageData, satTol: number): Uint8Array {
  const d = img.data
  const N = img.width * img.height
  const ink = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const o = i * 4
    const a = d[o + 3]
    if (a === 0) continue
    const r = d[o], g = d[o + 1], b = d[o + 2]
    // composite over white
    const L = (0.299 * r + 0.587 * g + 0.114 * b) * a / 255 + 255 * (1 - a / 255)
    let dark = (255 - L) / 255
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const sat = (mx - mn) / 255
    if (sat > satTol) dark *= Math.max(0, 1 - (sat - satTol) / 0.25)
    ink[i] = Math.round(dark * 255)
  }
  return ink
}

export function thresholdInk(ink: Uint8Array, thr: number): Uint8Array {
  const line = new Uint8Array(ink.length)
  const t = thr * 255
  for (let i = 0; i < ink.length; i++) if (ink[i] > t) line[i] = 1
  return line
}
