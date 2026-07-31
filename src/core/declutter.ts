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

// Stroke half-width (px) at or above which a boundary counts as a contour --
// a drawn edge between two areas -- rather than a hatch/detail mark. Fills must
// never merge across one.
const STRONG_PX = 2

const invLine = (line: Uint8Array, N: number) => {
  const inv = new Uint8Array(N)
  for (let i = 0; i < N; i++) inv[i] = line[i] ? 0 : 1
  return inv
}

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

  // Shared boundaries, classified by WHAT separates the two regions. Growth
  // stops at the medial axis of the separating stroke, so the distance to the
  // nearest non-line pixel at a boundary is that stroke's half-width:
  //   open   - no stroke at all (an arbitrary cut through free space)
  //   thin   - a hatch/detail mark; absorbing it is the whole point
  //   strong - a contour. Merging across one lets a fill invade the area on the
  //            other side of a drawn line, which is never right.
  const wd = distanceTransform(invLine(line, N), W, H)
  interface B { total: number; open: number; thin: number; strong: number }
  const nbr = new Map<number, Map<number, B>>()
  const bump = (a: number, b: number, cls: 0 | 1 | 2) => {
    let m = nbr.get(a)
    if (!m) nbr.set(a, (m = new Map()))
    let e = m.get(b)
    if (!e) m.set(b, (e = { total: 0, open: 0, thin: 0, strong: 0 }))
    e.total++
    if (cls === 0) e.open++; else if (cls === 1) e.thin++; else e.strong++
  }
  const OPEN = 7 // chamfer units: > ~2.3px from any line
  const classify = (i: number, q: number): 0 | 1 | 2 => {
    if (ld[i] > OPEN && ld[q] > OPEN) return 0
    return Math.max(wd[i], wd[q]) / 3 >= STRONG_PX ? 2 : 1
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = labels[i]
      if (x < W - 1) { const b = labels[i + 1]; if (a !== b) { const c = classify(i, i + 1); bump(a, b, c); bump(b, a, c) } }
      if (y < H - 1) { const b = labels[i + W]; if (a !== b) { const c = classify(i, i + W); bump(a, b, c); bump(b, a, c) } }
    }
  }
  // A merge may not cross a predominantly-contour boundary, and needs some
  // genuine open/thin contact to justify it. Open contact counts far more.
  const allowed = (e: B) => e.strong <= 0.4 * e.total && e.open + e.thin > 0
  const score = (e: B) => e.open * 20 + e.thin

  const parent = new Int32Array(maxId + 1)
  for (let i = 0; i <= maxId; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  // pass 1: a hatched patch is many touching clutter cells -- collapse it first
  // (but never across a contour: two cells either side of a drawn edge are two
  // different areas, however cluttered the neighbourhood is)
  for (const [a, m] of nbr) {
    if (!clutter[a]) continue
    for (const [b, e] of m) if (b && clutter[b] && allowed(e)) union(a, b)
  }
  // pass 2: attach each collapsed patch to the real area it shades
  const tally = new Map<number, Map<number, B>>()
  for (const [a, m] of nbr) {
    if (!a || !clutter[a]) continue
    const ra = find(a)
    let t = tally.get(ra)
    if (!t) tally.set(ra, (t = new Map()))
    for (const [b, e] of m) {
      if (!b || clutter[b] || find(b) === ra) continue
      const rb = find(b)
      let acc = t.get(rb)
      if (!acc) t.set(rb, (acc = { total: 0, open: 0, thin: 0, strong: 0 }))
      acc.total += e.total; acc.open += e.open; acc.thin += e.thin; acc.strong += e.strong
    }
  }
  for (const [ra, t] of tally) {
    let best = 0, bw = 0
    for (const [b, e] of t) {
      if (!allowed(e)) continue // would cross a drawn line
      const s = score(e) * (isBg && b < isBg.length && isBg[b] ? 0.05 : 1)
      if (s > bw) { bw = s; best = b }
    }
    // no acceptable host: this is a real enclosed area, so leave it alone
    if (best) union(ra, best)
  }

  for (let i = 0; i < N; i++) { core[i] = find(core[i]); labels[i] = find(labels[i]) }
  return true
}
