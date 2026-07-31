import { writePsd, type Psd, type Layer } from 'ag-psd'

export interface ExportRegion { id: number; color: [number, number, number]; name: string; hidden: boolean }

// How fills become layers:
//  'region' - one layer per fill (every region independently editable). When
//             fills share colours (palette quantization), they are nested in a
//             group folder per colour so Photoshop shows a handful of folders
//             rather than hundreds of loose layers.
//  'color'  - one layer per distinct fill colour. This is the usual flatting
//             deliverable: after recolouring, all the skin areas land on one
//             layer, all the hair on another.
//  'flat'   - every fill merged onto a single layer.
export type ExportMode = 'region' | 'color' | 'flat'

interface Raw { width: number; height: number; data: Uint8ClampedArray }
const raw = (w: number, h: number): Raw => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })

// White background at bottom, fills in the middle, line art (black + ink alpha)
// on top. Canvas-free: plain ImageData buffers.
export function exportPsd(W: number, H: number, labels: Int32Array, rootOf: Int32Array,
                          regions: ExportRegion[], ink: Uint8Array, mode: ExportMode = 'region'): ArrayBuffer {
  const N = W * H
  const byRoot = new Map<number, ExportRegion>()
  for (const r of regions) byRoot.set(r.id, r)
  const ckey = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2]

  // In the merged modes a hidden fill could not be toggled back on, so it is
  // left out of the export entirely; per-region keeps it as a hidden layer.
  const included = (r: ExportRegion) => mode === 'region' || !r.hidden
  const keyOf = (r: ExportRegion) => mode === 'flat' ? 0 : mode === 'color' ? ckey(r.color) : r.id

  // tight bounds per output layer
  const bounds = new Map<number, [number, number, number, number]>() // minX,minY,maxX,maxY
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = byRoot.get(rootOf[labels[y * W + x]])
      if (!r || !included(r)) continue
      const k = keyOf(r)
      const b = bounds.get(k)
      if (!b) bounds.set(k, [x, y, x, y])
      else {
        if (x < b[0]) b[0] = x
        if (y < b[1]) b[1] = y
        if (x > b[2]) b[2] = x
        if (y > b[3]) b[3] = y
      }
    }
  }
  const imgs = new Map<number, Raw>()
  for (const [k, b] of bounds) imgs.set(k, raw(b[2] - b[0] + 1, b[3] - b[1] + 1))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = byRoot.get(rootOf[labels[y * W + x]])
      if (!r || !included(r)) continue
      const k = keyOf(r)
      const img = imgs.get(k)!, b = bounds.get(k)!
      const o = ((y - b[1]) * img.width + (x - b[0])) * 4
      img.data[o] = r.color[0]; img.data[o + 1] = r.color[1]; img.data[o + 2] = r.color[2]; img.data[o + 3] = 255
    }
  }
  const layerOf = (k: number, name: string, hidden = false): Layer | null => {
    const img = imgs.get(k), b = bounds.get(k)
    return img && b ? { name, imageData: img as ImageData, left: b[0], top: b[1], hidden } : null
  }

  const bg = raw(W, H)
  bg.data.fill(255)
  const lineImg = raw(W, H)
  for (let i = 0; i < N; i++) lineImg.data[i * 4 + 3] = ink[i]

  const children: Layer[] = [{ name: 'Background', imageData: bg as ImageData, left: 0, top: 0 }]

  if (mode === 'flat') {
    const l = layerOf(0, 'Flats')
    if (l) children.push(l)
  } else if (mode === 'color') {
    // one layer per colour, in the order the colours first appear (regions
    // arrive largest-first, so the biggest areas end up lowest)
    const seen = new Map<number, number>() // colour -> region count
    const order: number[] = []
    for (const r of regions) {
      if (r.hidden) continue
      const k = ckey(r.color)
      if (!seen.has(k)) { seen.set(k, 0); order.push(k) }
      seen.set(k, seen.get(k)! + 1)
    }
    order.forEach((k, i) => {
      const l = layerOf(k, `Color ${i + 1} (${seen.get(k)} fills)`)
      if (l) children.push(l)
    })
  } else {
    // per region; nest into colour folders only when colours are actually
    // shared (otherwise every folder would hold a single layer)
    const groups = new Map<number, ExportRegion[]>()
    for (const r of regions) {
      const k = ckey(r.color)
      const g = groups.get(k)
      if (g) g.push(r); else groups.set(k, [r])
    }
    if (groups.size < regions.length) {
      let i = 0
      for (const [, rs] of groups) {
        const kids: Layer[] = []
        for (const r of rs) {
          const l = layerOf(r.id, r.name, r.hidden)
          if (l) kids.push(l)
        }
        if (kids.length) children.push({ name: `Color ${++i} (${kids.length} fills)`, opened: false, children: kids })
      }
    } else {
      for (const r of regions) {
        const l = layerOf(r.id, r.name, r.hidden)
        if (l) children.push(l)
      }
    }
  }

  children.push({ name: 'Line Art', imageData: lineImg as ImageData, left: 0, top: 0 })

  // flattened composite (fills over white, ink multiplied on top)
  const comp = raw(W, H)
  for (let i = 0; i < N; i++) {
    const r = byRoot.get(rootOf[labels[i]])
    const o = i * 4
    let cr = 255, cg = 255, cb = 255
    if (r && !r.hidden) { cr = r.color[0]; cg = r.color[1]; cb = r.color[2] }
    const k = 1 - ink[i] / 255
    comp.data[o] = cr * k; comp.data[o + 1] = cg * k; comp.data[o + 2] = cb * k; comp.data[o + 3] = 255
  }

  const psd: Psd = { width: W, height: H, children, imageData: comp as ImageData }
  return writePsd(psd, { generateThumbnail: false })
}
