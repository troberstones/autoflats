import { distanceTransform } from './morphology.ts'
import { sampleFlow, type Flow } from './flow.ts'
import { relatable } from './relatability.ts'

// Analyze region-collision fronts: boundary runs between two regions that lie
// in OPEN space (far from any line) are leak artifacts, not drawn edges.
// Classification per adjacent pair:
//  - mostly-open border, NOT aligned with stroke flow  -> auto-merge (fragment)
//  - open border aligned with flow / narrow throat     -> suggest a gap bridge
// Bridges anchor on the actual line pixels flanking the narrowest point of
// the front, so they sit exactly where the line work fails to close.
export interface FrontsResult { merges: Array<[number, number]>; segs: number[] }

export function analyzeFronts(labels: Int32Array, line: Uint8Array, W: number, H: number,
  flow: Flow, maxBridge: number, isBg: Uint8Array | null, doMerge: boolean): FrontsResult {
  const ld = distanceTransform(line, W, H)
  // stroke half-width at line pixels = distance to free space (similarity cue)
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < inv.length; i++) inv[i] = line[i] ? 0 : 1
  const wd = distanceTransform(inv, W, H)
  const OPEN = 7 // > ~2.3 px from any line = open space
  const KEY = 1 << 20

  interface P {
    a: number; b: number; T: number; O: number
    sx: number; sy: number; sxx: number; syy: number; sxy: number
    tx: number; ty: number; tmin: number
  }
  const pairs = new Map<number, P>()
  const touch = (a: number, b: number, x: number, y: number, open: boolean, d: number) => {
    if (a > b) { const t = a; a = b; b = t }
    const k = a * KEY + b
    let p = pairs.get(k)
    if (!p) pairs.set(k, (p = { a, b, T: 0, O: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, tx: 0, ty: 0, tmin: 1e9 }))
    p.T++
    if (open) {
      p.O++
      p.sx += x; p.sy += y; p.sxx += x * x; p.syy += y * y; p.sxy += x * y
      if (d < p.tmin) { p.tmin = d; p.tx = x; p.ty = y }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = labels[i]
      if (x < W - 1) {
        const b = labels[i + 1]
        if (a !== b) touch(a, b, x, y, ld[i] > OPEN && ld[i + 1] > OPEN, ld[i])
      }
      if (y < H - 1) {
        const b = labels[i + W]
        if (a !== b) touch(a, b, x, y, ld[i] > OPEN && ld[i + W] > OPEN, ld[i])
      }
    }
  }

  const merges: Array<[number, number]> = []
  const cands: Array<[number, number[]]> = [] // [throat narrowness, seg]
  for (const p of pairs.values()) {
    if (!p.O) continue
    // front axis (PCA of open boundary points) vs local stroke flow
    let aligned = false
    if (p.O >= 6) {
      const mx = p.sx / p.O, my = p.sy / p.O
      const cxx = p.sxx / p.O - mx * mx, cyy = p.syy / p.O - my * my, cxy = p.sxy / p.O - mx * my
      const phi = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
      const ax = Math.cos(phi), ay = Math.sin(phi)
      const [fx, fy, coh] = sampleFlow(flow, Math.round(mx), Math.round(my))
      aligned = coh > 0.25 && Math.abs(ax * fx + ay * fy) > 0.82
    }
    const openFrac = p.O / p.T
    const bgPair = !!(isBg && (isBg[p.a] || isBg[p.b]))
    if (doMerge && !bgPair && openFrac > 0.6 && p.O >= 12 && !aligned) {
      merges.push([p.a, p.b])
      continue
    }
    // suggest a bridge across the narrowest open point
    const seg = bridgeAt(p.tx, p.ty, line, W, H, flow, maxBridge, wd)
    if (seg) {
      const e = bridgeEnergy(seg, flow, p.tmin)
      if (e < Infinity) cands.push([e, seg])
    }
  }
  cands.sort((a, b) => a[0] - b[0])
  const segs: number[] = []
  for (const [, s] of cands.slice(0, 150)) segs.push(...s)
  return { merges, segs }
}

// Rank a throat bridge by elastica energy using stroke flow as the tip
// tangents. When both anchors have coherent flow, also enforce relatability
// (smooth, monotonic, bend <= 90deg); reject if it fails. Falls back to the
// raw throat distance when flow is too incoherent to judge continuation.
function bridgeEnergy(seg: number[], flow: Flow, fallback: number): number {
  const [x1, y1, x2, y2] = seg
  const L = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / L, uy = (y2 - y1) / L
  const [f1x, f1y, c1] = sampleFlow(flow, x1, y1)
  const [f2x, f2y, c2] = sampleFlow(flow, x2, y2)
  if (c1 <= 0.25 || c2 <= 0.25) return fallback
  // orient each axial flow vector to point out of its tip, into the gap
  const s1 = f1x * ux + f1y * uy >= 0 ? 1 : -1
  const s2 = f2x * ux + f2y * uy <= 0 ? 1 : -1
  const rel = relatable(x1, y1, s1 * f1x, s1 * f1y, x2, y2, s2 * f2x, s2 * f2y)
  return rel.ok ? rel.energy : Infinity
}

function localWidth(wd: Int32Array, i: number, W: number, H: number): number {
  const x = i % W, y = (i / W) | 0
  let mx = 0
  for (let dy = -3; dy <= 3; dy++) {
    const yy = y + dy
    if (yy < 0 || yy >= H) continue
    for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx
      if (xx < 0 || xx >= W) continue
      const v = wd[yy * W + xx]
      if (v > mx) mx = v
    }
  }
  return mx
}

// Build a bridge through open point (tx,ty): nearest line pixel on one side,
// then march the opposite way to the line pixel on the other side.
function bridgeAt(tx: number, ty: number, line: Uint8Array, W: number, H: number,
  flow: Flow, maxBridge: number, wd: Int32Array): number[] | null {
  let l1 = -1, d1 = 1e9
  const R = Math.min(maxBridge, 40)
  for (let dy = -R; dy <= R; dy++) {
    const y = ty + dy
    if (y < 0 || y >= H) continue
    for (let dx = -R; dx <= R; dx++) {
      const x = tx + dx
      if (x < 0 || x >= W || !line[y * W + x]) continue
      const d = dx * dx + dy * dy
      if (d < d1) { d1 = d; l1 = y * W + x }
    }
  }
  if (l1 < 0) return null
  const x1 = l1 % W, y1 = (l1 / W) | 0
  const len1 = Math.hypot(tx - x1, ty - y1) || 1
  const vx = (tx - x1) / len1, vy = (ty - y1) / len1
  for (let s = 1; s <= maxBridge; s++) {
    const x = Math.round(tx + vx * s), y = Math.round(ty + vy * s)
    if (x < 0 || y < 0 || x >= W || y >= H) return null
    if (!line[y * W + x]) continue
    // similarity: don't bridge a thick contour to thin hatching.
    // Anchors sit on stroke EDGES where wd≈1px, so sample the local max
    // (the stroke's half-width) in a 7x7 window.
    const w1 = localWidth(wd, l1, W, H), w2 = localWidth(wd, y * W + x, W, H)
    if (Math.max(w1, w2) > 2.5 * Math.min(w1, w2) + 3) return null
    // flow check: the bridge should run along stroke tangents at its anchors
    const bl = Math.hypot(x - x1, y - y1) || 1
    const bx = (x - x1) / bl, by = (y - y1) / bl
    for (const [ax, ay] of [[x1, y1], [x, y]] as const) {
      const [fx, fy, coh] = sampleFlow(flow, ax, ay)
      if (coh > 0.25 && Math.abs(bx * fx + by * fy) < 0.6) return null
    }
    return [x1, y1, x, y]
  }
  return null
}
