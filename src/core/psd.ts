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
    const o = i * 4
    merged.data[o] = r.color[0]; merged.data[o + 1] = r.color[1]; merged.data[o + 2] = r.color[2]
    merged.data[o + 3] = 255
    any = true
  }
  if (any) children.push({ name: 'Flats (merged)', imageData: merged as ImageData, left: 0, top: 0 })

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
