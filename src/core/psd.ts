import { writePsd, type Psd, type Layer } from 'ag-psd'

export interface ExportRegion { id: number; color: [number, number, number]; name: string; hidden: boolean }

interface Raw { width: number; height: number; data: Uint8ClampedArray }
const raw = (w: number, h: number): Raw => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })

// One layer per fill (tight bounds), white background at bottom,
// line art (black + ink alpha) on top. Canvas-free: plain ImageData buffers.
export function exportPsd(W: number, H: number, labels: Int32Array, rootOf: Int32Array,
                          regions: ExportRegion[], ink: Uint8Array): ArrayBuffer {
  const N = W * H
  const byRoot = new Map<number, ExportRegion>()
  for (const r of regions) byRoot.set(r.id, r)

  // bounds per root
  const bounds = new Map<number, [number, number, number, number]>() // minX,minY,maxX,maxY
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const root = rootOf[labels[y * W + x]]
      if (!byRoot.has(root)) continue
      const b = bounds.get(root)
      if (!b) bounds.set(root, [x, y, x, y])
      else {
        if (x < b[0]) b[0] = x
        if (y < b[1]) b[1] = y
        if (x > b[2]) b[2] = x
        if (y > b[3]) b[3] = y
      }
    }
  }
  const imgs = new Map<number, Raw>()
  for (const [root, b] of bounds) imgs.set(root, raw(b[2] - b[0] + 1, b[3] - b[1] + 1))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const root = rootOf[labels[y * W + x]]
      const img = imgs.get(root)
      if (!img) continue
      const r = byRoot.get(root)!
      const b = bounds.get(root)!
      const o = ((y - b[1]) * img.width + (x - b[0])) * 4
      img.data[o] = r.color[0]; img.data[o + 1] = r.color[1]; img.data[o + 2] = r.color[2]; img.data[o + 3] = 255
    }
  }

  const bg = raw(W, H)
  bg.data.fill(255)
  const lineImg = raw(W, H)
  for (let i = 0; i < N; i++) lineImg.data[i * 4 + 3] = ink[i]

  const children: Layer[] = [{ name: 'Background', imageData: bg as ImageData, left: 0, top: 0 }]
  for (const r of regions) {
    const img = imgs.get(r.id)
    if (!img) continue
    const b = bounds.get(r.id)!
    children.push({ name: r.name, imageData: img as ImageData, left: b[0], top: b[1], hidden: r.hidden })
  }
  children.push({ name: 'Line Art', imageData: lineImg as ImageData, left: 0, top: 0 })

  // flattened composite (fills over white, ink multiplied on top)
  const comp = raw(W, H)
  for (let i = 0; i < N; i++) {
    const root = rootOf[labels[i]]
    const r = byRoot.get(root)
    const o = i * 4
    let cr = 255, cg = 255, cb = 255
    if (r && !r.hidden) { cr = r.color[0]; cg = r.color[1]; cb = r.color[2] }
    const k = 1 - ink[i] / 255
    comp.data[o] = cr * k; comp.data[o + 1] = cg * k; comp.data[o + 2] = cb * k; comp.data[o + 3] = 255
  }

  const psd: Psd = { width: W, height: H, children, imageData: comp as ImageData }
  return writePsd(psd, { generateThumbnail: false })
}
