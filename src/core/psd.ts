import { writePsd, type Psd, type Layer } from 'ag-psd'

export interface ExportRegion {
  id: number; color: [number, number, number]; name: string; hidden: boolean
  isBg?: boolean // left out of the merged-flats layer
  group?: string // user-drawn group -> its own PSD folder
}

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

// How many layers the fills will take, without building any of them. The
// caller needs this before export because watercolor turns every layer into a
// full-size textured buffer, and a file with hundreds of those is one nobody
// can open. Counts fills only: Background, the merged layer and Line Art are
// three more on top, and folders are containers rather than pixels.
export function layerCount(regions: ExportRegion[], mode: ExportMode): number {
  const keys = new Set<string>()
  for (const r of regions) {
    if (mode !== 'region' && r.hidden) continue
    const g = r.group ?? ''
    keys.add(g + '|' + (mode === 'flat' ? '' : mode === 'color' ? r.color.join(',') : r.id))
  }
  return keys.size
}

// --- watercolor -------------------------------------------------------------
// A flat fill is a slab of one colour. Real washes are not: the pigment pools
// and dries darker where the water stops (the edge), the paper's tooth breaks
// the colour up at high frequency, and the wash blooms unevenly at low
// frequency. Those three terms are all this does -- edge pooling, grain,
// bloom -- because they are what the eye reads as "painted" and everything
// beyond them is a different program.
export interface Watercolor { pool: number; grain: number; bloom: number }
export const WATERCOLOR: Watercolor = { pool: 0.24, grain: 0.1, bloom: 0.16 }
const POOL_W = 7 // px the edge darkening reaches in from the boundary

const hash = (x: number, y: number, s: number): number => {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
const smooth = (t: number) => t * t * (3 - 2 * t)
// value noise: a lattice of hashes, smoothly interpolated. Cheap, seamless and
// deterministic, which matters -- exporting twice must give the same painting.
function noise(x: number, y: number, f: number, s: number): number {
  const px = x / f, py = y / f
  const x0 = Math.floor(px), y0 = Math.floor(py)
  const tx = smooth(px - x0), ty = smooth(py - y0)
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s)
  const c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

// Distance from every pixel to the nearest edge of its own region, by a
// two-pass chamfer. One field for the whole image rather than one per fill:
// the fills partition the canvas, so a single sweep answers it for all of them.
function edgeDistance(W: number, H: number, labels: Int32Array, rootOf: Int32Array): Float32Array {
  const d = new Float32Array(W * H)
  const INF = 1e9
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, r = rootOf[labels[i]]
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
        rootOf[labels[i - 1]] !== r || rootOf[labels[i + 1]] !== r ||
        rootOf[labels[i - W]] !== r || rootOf[labels[i + W]] !== r
      d[i] = edge ? 0 : INF
    }
  }
  const D = 1, Q = 1.414
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    let v = d[i]
    if (y > 0) {
      v = Math.min(v, d[i - W] + D)
      if (x > 0) v = Math.min(v, d[i - W - 1] + Q)
      if (x < W - 1) v = Math.min(v, d[i - W + 1] + Q)
    }
    if (x > 0) v = Math.min(v, d[i - 1] + D)
    d[i] = v
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    let v = d[i]
    if (y < H - 1) {
      v = Math.min(v, d[i + W] + D)
      if (x > 0) v = Math.min(v, d[i + W - 1] + Q)
      if (x < W - 1) v = Math.min(v, d[i + W + 1] + Q)
    }
    if (x < W - 1) v = Math.min(v, d[i + 1] + D)
    d[i] = v
  }
  return d
}

// White background at bottom, fills in the middle, line art (black + ink alpha)
// on top. Canvas-free: plain ImageData buffers.
export function exportPsd(W: number, H: number, labels: Int32Array, rootOf: Int32Array,
                          regions: ExportRegion[], ink: Uint8Array, mode: ExportMode = 'region',
                          wc: Watercolor | null = null): ArrayBuffer {
  const N = W * H
  const dist = wc ? edgeDistance(W, H, labels, rootOf) : null

  // The wash at one pixel, as premultiplied-by-nothing rgba. Paper shows
  // through in the middle of a wash but not at its rim, so the alpha dip is
  // tied to the same distance term as the pooling and vanishes at the edge --
  // otherwise the fills would gain a translucent seam exactly where a painter
  // would have laid down the most pigment.
  const shade = (i: number, c: [number, number, number], out: Uint8ClampedArray, o: number): void => {
    if (!wc || !dist) {
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255
      return
    }
    const x = i % W, y = (i / W) | 0, d = dist[i]
    const inside = 1 - Math.exp(-d / POOL_W)
    const k = (1 - wc.pool * (1 - inside)) *
              (1 + wc.bloom * (noise(x, y, 24, 1) - 0.5)) *
              (1 + wc.grain * (noise(x, y, 1.7, 2) - 0.5))
    out[o] = c[0] * k; out[o + 1] = c[1] * k; out[o + 2] = c[2] * k
    out[o + 3] = 255 - 30 * inside * (1 - noise(x, y, 1.7, 3))
  }
  const byRoot = new Map<number, ExportRegion>()
  for (const r of regions) byRoot.set(r.id, r)
  const ckey = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2]

  // In the merged modes a hidden fill could not be toggled back on, so it is
  // left out of the export entirely; per-region keeps it as a hidden layer.
  const included = (r: ExportRegion) => mode === 'region' || !r.hidden

  // User groups become folders, and the export mode applies WITHIN each folder:
  // the same colour appearing in two groups stays two layers, one per folder.
  // Group index is therefore part of the layer key.
  const groupNames: string[] = []
  const gi = new Map<number, number>() // region id -> 0 (ungrouped) or 1+
  for (const r of regions) {
    if (!r.group) { gi.set(r.id, 0); continue }
    let k = groupNames.indexOf(r.group)
    if (k < 0) { groupNames.push(r.group); k = groupNames.length - 1 }
    gi.set(r.id, k + 1)
  }
  const GSPAN = 2 ** 25
  const keyOf = (r: ExportRegion) =>
    gi.get(r.id)! * GSPAN + (mode === 'flat' ? 0 : mode === 'color' ? ckey(r.color) : r.id)

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
      shade(y * W + x, r.color, img.data, ((y - b[1]) * img.width + (x - b[0])) * 4)
    }
  }
  const layerOf = (k: number, name: string, hidden = false): Layer | null => {
    const img = imgs.get(k), b = bounds.get(k)
    return img && b ? { name, imageData: img as ImageData, left: b[0], top: b[1], hidden } : null
  }

  const bg = raw(W, H)
  bg.data.fill(255)
  // watercolor paper: the same grain, under everything
  if (wc) for (let i = 0; i < N; i++) {
    const v = 255 - 12 * (1 - noise(i % W, (i / W) | 0, 1.7, 4))
    bg.data[i * 4] = v; bg.data[i * 4 + 1] = v; bg.data[i * 4 + 2] = v
  }
  const lineImg = raw(W, H)
  for (let i = 0; i < N; i++) lineImg.data[i * 4 + 3] = ink[i]

  const children: Layer[] = [{ name: 'Background', imageData: bg as ImageData, left: 0, top: 0 }]

  // layers for one bucket of regions, per the export mode
  const layersFor = (rs: ExportRegion[], label: string): Layer[] => {
    if (!rs.length) return []
    if (mode === 'flat') {
      const l = layerOf(keyOf(rs[0]), label) // whole bucket shares one key
      return l ? [l] : []
    }
    if (mode === 'color') {
      const seen = new Map<number, number>(), order: number[] = []
      for (const r of rs) {
        if (r.hidden) continue
        const k = keyOf(r)
        if (!seen.has(k)) { seen.set(k, 0); order.push(k) }
        seen.set(k, seen.get(k)! + 1)
      }
      return order.map((k, i) => layerOf(k, `Color ${i + 1} (${seen.get(k)} fills)`)).filter(Boolean) as Layer[]
    }
    return rs.map(r => layerOf(keyOf(r), r.name, r.hidden)).filter(Boolean) as Layer[]
  }

  const ungrouped = regions.filter(r => !r.group)
  const hasGroups = groupNames.length > 0
  // Ungrouped fills stay at the top level. Colour folders are used only when
  // the user has not drawn groups of their own, so folders never nest 2 deep.
  if (mode === 'region' && !hasGroups) {
    const byColor = new Map<number, ExportRegion[]>()
    for (const r of ungrouped) {
      const k = ckey(r.color)
      const g = byColor.get(k)
      if (g) g.push(r); else byColor.set(k, [r])
    }
    if (byColor.size < ungrouped.length) {
      let i = 0
      for (const [, rs] of byColor) {
        const kids = layersFor(rs, '')
        if (kids.length) children.push({ name: `Color ${++i} (${kids.length} fills)`, opened: false, children: kids })
      }
    } else children.push(...layersFor(ungrouped, 'Flats'))
  } else {
    children.push(...layersFor(ungrouped, 'Flats'))
  }
  // one folder per user-drawn group
  groupNames.forEach((name, k) => {
    const kids = layersFor(regions.filter(r => gi.get(r.id) === k + 1), name)
    if (kids.length) children.push({ name, opened: false, children: kids })
  })

  // Every fill on one layer, with the background left out, sitting directly
  // under the line art. This is the layer you actually paint on top of: the
  // per-fill layers below are for correcting the flatting, and once that is
  // done you want the flats as a single piece of artwork with the paper still
  // transparent behind the figure. Transparent (not white) outside the fills,
  // so it composites over whatever background the colourist chooses.
  const merged = raw(W, H)
  let any = false
  for (let i = 0; i < N; i++) {
    const r = byRoot.get(rootOf[labels[i]])
    if (!r || r.hidden || r.isBg) continue
    shade(i, r.color, merged.data, i * 4)
    any = true
  }
  if (any) children.push({ name: 'Flats (merged)', imageData: merged as ImageData, left: 0, top: 0 })

  children.push({ name: 'Line Art', imageData: lineImg as ImageData, left: 0, top: 0 })

  // flattened composite (fills over white, ink multiplied on top)
  const comp = raw(W, H)
  const px = new Uint8ClampedArray(4)
  for (let i = 0; i < N; i++) {
    const r = byRoot.get(rootOf[labels[i]])
    const o = i * 4
    let cr = bg.data[o], cg = bg.data[o + 1], cb = bg.data[o + 2]
    if (r && !r.hidden) {
      shade(i, r.color, px, 0)
      const a = px[3] / 255 // the wash sits over the paper, not instead of it
      cr = px[0] * a + cr * (1 - a); cg = px[1] * a + cg * (1 - a); cb = px[2] * a + cb * (1 - a)
    }
    const k = 1 - ink[i] / 255
    comp.data[o] = cr * k; comp.data[o + 1] = cg * k; comp.data[o + 2] = cb * k; comp.data[o + 3] = 255
  }

  const psd: Psd = { width: W, height: H, children, imageData: comp as ImageData }
  return writePsd(psd, { generateThumbnail: false })
}
