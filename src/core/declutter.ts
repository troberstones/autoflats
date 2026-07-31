import { distanceTransform } from './morphology.ts'

// Figure/ground cleanup for dense line work.
//
// Where the drawing gets busy -- hatching, cross-hatching, folds, texture --
// the strokes do not enclose anything; they shade an area that visually reads
// as ONE surface. Trapped-ball segmentation cannot know that: it dutifully
// seeds every pocket between neighbouring strokes, so a hatched sleeve becomes
// fifty slivers instead of one sleeve. Those fills are numerous but tiny, and
// they are the main source of layer bloat.
//
// Measured over the sample art, three signals separate them cleanly from real
// drawn cells (an eye, a button, a pocket):
//   area      small fills are ~76% of all fills but <10% of the picture
//   meanD     mean distance to the nearest stroke -- clutter is SQUEEZED
//             between strokes (~3px) where real cells have room (~8px)
//   density   fraction of ink nearby -- clutter sits in neighbourhoods about
//             twice as inky (~0.20) as real cells (~0.10)
//
// A region matching all three is absorbed into the surrounding area, which is
// the semantically right answer: shading marks belong to the surface they
// shade. Touching clutter regions merge with each other first, so a whole
// hatched patch collapses as one unit and then attaches to its host.

export interface DeclutterOpts { maxArea: number; maxMeanD: number; minDensity: number }

// strength 0..100 -> thresholds. 0 disables the pass entirely.
export function declutterOpts(strength: number): DeclutterOpts | null {
  if (strength <= 0) return null
  const s = Math.min(100, strength)
  return { maxArea: 100 + 12 * s, maxMeanD: 2 + 0.03 * s, minDensity: 0.32 - 0.0017 * s }
}

export function declutter(core: Int32Array, labels: Int32Array, line: Uint8Array,
  W: number, H: number, opts: DeclutterOpts | null, isBg: Uint8Array | null): boolean {
  if (!opts) return false
  const N = W * H
  const ld = distanceTransform(line, W, H)
  let maxId = 0
  for (let i = 0; i < N; i++) if (core[i] > maxId) maxId = core[i]
  if (maxId < 2) return false

  // per-region geometry, measured on `core` (the open-space part of a region;
  // `labels` also covers the pixels grown under the strokes, whose distance is
  // zero and would drag every mean down)
  const area = new Int32Array(maxId + 1)
  const sumD = new Float64Array(maxId + 1)
  const sumX = new Float64Array(maxId + 1), sumY = new Float64Array(maxId + 1)
  for (let i = 0; i < N; i++) {
    const id = core[i]
    if (!id) continue
    area[id]++
    sumD[id] += ld[i]
    sumX[id] += i % W
    sumY[id] += (i / W) | 0
  }

  // summed-area table of the line mask, for O(1) local ink density
  const S = W + 1
  const ii = new Float64Array(S * (H + 1))
  for (let y = 0; y < H; y++) {
    let run = 0
    for (let x = 0; x < W; x++) {
      run += line[y * W + x]
      ii[(y + 1) * S + x + 1] = ii[y * S + x + 1] + run
    }
  }
  const R = 20 // ~41px window: wide enough to see a hatch patch, not a whole limb
  const density = (x: number, y: number): number => {
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R)
    const x1 = Math.min(W, x + R), y1 = Math.min(H, y + R)
    const s = ii[y1 * S + x1] - ii[y0 * S + x1] - ii[y1 * S + x0] + ii[y0 * S + x0]
    return s / Math.max(1, (x1 - x0) * (y1 - y0))
  }

  const clutter = new Uint8Array(maxId + 1)
  let any = false
  for (let id = 1; id <= maxId; id++) {
    if (!area[id] || (isBg && id < isBg.length && isBg[id])) continue
    if (area[id] >= opts.maxArea) continue
    if (sumD[id] / area[id] / 3 >= opts.maxMeanD) continue // chamfer units -> px
    if (density(Math.round(sumX[id] / area[id]), Math.round(sumY[id] / area[id])) <= opts.minDensity) continue
    clutter[id] = 1
    any = true
  }
  if (!any) return false

  // shared boundary lengths between adjacent regions
  const nbr = new Map<number, Map<number, number>>()
  const bump = (a: number, b: number) => {
    let m = nbr.get(a)
    if (!m) nbr.set(a, (m = new Map()))
    m.set(b, (m.get(b) ?? 0) + 1)
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = labels[i]
      if (x < W - 1) { const b = labels[i + 1]; if (a !== b) { bump(a, b); bump(b, a) } }
      if (y < H - 1) { const b = labels[i + W]; if (a !== b) { bump(a, b); bump(b, a) } }
    }
  }

  const parent = new Int32Array(maxId + 1)
  for (let i = 0; i <= maxId; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  // pass 1: a hatched patch is many touching clutter cells -- collapse it first
  for (const [a, m] of nbr) {
    if (!clutter[a]) continue
    for (const b of m.keys()) if (b && clutter[b]) union(a, b)
  }
  // pass 2: attach each collapsed patch to the real area it shades (longest
  // shared boundary; background only as a last resort)
  const tally = new Map<number, Map<number, number>>()
  for (const [a, m] of nbr) {
    if (!a || !clutter[a]) continue
    const ra = find(a)
    let t = tally.get(ra)
    if (!t) tally.set(ra, (t = new Map()))
    for (const [b, w] of m) {
      if (!b || clutter[b] || find(b) === ra) continue
      t.set(find(b), (t.get(find(b)) ?? 0) + w)
    }
  }
  for (const [ra, t] of tally) {
    let best = 0, bw = -1
    for (const [b, w] of t) {
      const bgPenalty = isBg && b < isBg.length && isBg[b] ? 0.05 : 1
      const score = w * bgPenalty
      if (score > bw) { bw = score; best = b }
    }
    if (best) union(ra, best)
  }

  for (let i = 0; i < N; i++) { core[i] = find(core[i]); labels[i] = find(labels[i]) }
  return true
}
