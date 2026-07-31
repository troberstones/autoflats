// Stochastic completion field (Williams & Jacobs). The canonical neural model
// of illusory-contour salience, used here to judge which stroke tips human
// vision would link across a gap. It folds three gestalt cues into one field:
//   proximity         -> per-step decay (long completions attenuate)
//   good continuation -> advection along orientation + diffusion in orientation
//                        (particles travel straight, turning only gradually)
//   closure           -> the product u*v: a point scores only if a particle
//                        LEAVING one tip is also heading INTO another tip. An
//                        open ray into the void has high u but ~zero v, so the
//                        field there is ~0 and no bridge is proposed.
// Parallelism falls out for free: two parallel tips both emit and their fields
// reinforce in the corridor between them.
//
// A directed random walk lives on (x, y, theta). We integrate the steady-state
// Fokker-Planck equation by repeated local updates (advect + orientation-
// diffuse + decay), the same iterative-relaxation shape as gpuGrow.ts.
//
// Resolution: HALF res. Gaps are small (8-20px); at 1/4 res an 8px gap is only
// 2 cells and the ink dilation inherent in downsampling seals it completely.
// Half res keeps ~4 free cells across an 8px gap. To afford that, the field is
// stored ONLY over active cells (a band around stroke tips, typically a few
// percent of the image) via a compact index, instead of a dense K*W*H volume.

import { relatable, elasticaCurve } from './relatability.ts'
import type { Endpoint } from './gaps.ts'

const K = 16                     // orientation bins over [0, 2pi)
const DECAY = 0.94               // proximity: mass retained per half-res step
const DIFF = 0.18                // good continuation: orientation diffusion
const COS = new Float32Array(K), SIN = new Float32Array(K)
for (let k = 0; k < K; k++) { const a = 2 * Math.PI * k / K; COS[k] = Math.cos(a); SIN[k] = Math.sin(a) }
const binOf = (tx: number, ty: number) => ((Math.round(Math.atan2(ty, tx) / (2 * Math.PI / K)) % K) + K) % K

// Salience floor, relative to the field's own peak: below this the field failed
// to diffuse across (gap too wide, or a wall between the tips), so the pair is
// not a real completion. Relative so it is invariant to tip count and scale.
const SUPPORT_FRAC = 0.02

export interface CompletionField {
  C: Float32Array      // completion salience per ACTIVE cell (compact)
  idx: Int32Array      // half-res cell -> compact index, or -1
  W2: number; H2: number
  peak: number
}

export function completionField(line: Uint8Array, W: number, H: number, eps: Endpoint[], maxBridge: number): CompletionField {
  const W2 = Math.max(2, W >> 1), H2 = Math.max(2, H >> 1), M = W2 * H2
  // half-res barrier: a cell is ink if any pixel in its 2x2 block is line
  const ink = new Uint8Array(M)
  for (let y = 0; y < H; y++) { const r = (y >> 1) * W2; for (let x = 0; x < W; x++) if (line[y * W + x]) ink[r + (x >> 1)] = 1 }

  // seeds: nudge each tip off its own stroke, one free cell into the gap
  interface Seed { cell: number; kf: number; kb: number }
  const seeds: Seed[] = []
  for (const e of eps) {
    let cell = -1
    for (let s = 1; s <= 6; s++) {
      const nx = (e.x + e.tx * 2 * s) >> 1, ny = (e.y + e.ty * 2 * s) >> 1
      if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) break
      if (!ink[ny * W2 + nx]) { cell = ny * W2 + nx; break }
    }
    if (cell < 0) continue
    const kf = binOf(e.tx, e.ty)
    seeds.push({ cell, kf, kb: (kf + K / 2) % K })
  }

  // band-limit: only relax free cells within R of a seed (gaps are local).
  // maxBridge is in full-res px; the grid is half-res, hence the halving.
  const R = (maxBridge >> 1) + 3
  const idx = new Int32Array(M).fill(-1)
  const seen = new Uint8Array(M)
  let ring: number[] = []
  for (const s of seeds) if (!seen[s.cell]) { seen[s.cell] = 1; ring.push(s.cell) }
  for (let r = 0; r < R && ring.length; r++) {
    const next: number[] = []
    for (const c of ring) {
      const x = c % W2, y = (c / W2) | 0
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) continue
        const n = ny * W2 + nx
        if (!seen[n]) { seen[n] = 1; next.push(n) }
      }
    }
    ring = next
  }
  const cells: number[] = []
  for (let i = 0; i < M; i++) if (seen[i] && !ink[i]) { idx[i] = cells.length; cells.push(i) }
  const A = cells.length
  if (!A) return { C: new Float32Array(0), idx, W2, H2, peak: 0 }

  const u = new Float32Array(K * A), un = new Float32Array(K * A)
  const v = new Float32Array(K * A), vn = new Float32Array(K * A)
  const steps = Math.min(48, (maxBridge >> 1) + 10) // one advection step = one half-res cell
  const adv = new Float32Array(K)

  // bilinear gather of field `f`, bin k, at half-res position (fx,fy)
  const gather = (f: Float32Array, k: number, fx: number, fy: number): number => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const tx = fx - x0, ty = fy - y0
    let acc = 0
    for (let j = 0; j < 4; j++) {
      const xx = x0 + (j & 1), yy = y0 + (j >> 1)
      if (xx < 0 || yy < 0 || xx >= W2 || yy >= H2) continue
      const a = idx[yy * W2 + xx]
      if (a < 0) continue
      acc += (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty) * f[k * A + a]
    }
    return acc
  }

  const relax = (src: Float32Array, dst: Float32Array, back: boolean) => {
    for (let a = 0; a < A; a++) {
      const c = cells[a], x = c % W2, y = (c / W2) | 0
      // advect: forward field pulls from behind (-theta), backward from ahead
      for (let k = 0; k < K; k++) adv[k] = gather(src, k, back ? x + COS[k] : x - COS[k], back ? y + SIN[k] : y - SIN[k])
      for (let k = 0; k < K; k++) {
        const mix = (1 - DIFF) * adv[k] + DIFF * 0.5 * (adv[(k + K - 1) % K] + adv[(k + 1) % K])
        dst[k * A + a] = mix * DECAY
      }
    }
    // re-inject emitters each step (persistent sources / sinks)
    for (const s of seeds) { const a = idx[s.cell]; if (a >= 0) dst[(back ? s.kb : s.kf) * A + a] += 1 }
  }

  for (let it = 0; it < steps; it++) {
    relax(u, un, false); u.set(un)
    relax(v, vn, true); v.set(vn)
  }

  // completion field C = sum_theta u*v (closure), collapsed over orientation
  const C = new Float32Array(A)
  let peak = 0
  for (let a = 0; a < A; a++) {
    let s = 0
    for (let k = 0; k < K; k++) s += u[k * A + a] * v[k * A + a]
    C[a] = s
    if (s > peak) peak = s
  }
  return { C, idx, W2, H2, peak }
}

// Salience at full-res image coords (nearest half-res cell). Returns -1 where
// no field cell exists (ink, or outside the relaxed band) -- distinct from a
// genuine zero, which means "the field reached here and cancelled".
export function sampleC(f: CompletionField, x: number, y: number): number {
  const cx = x >> 1, cy = y >> 1
  if (cx < 0 || cy < 0 || cx >= f.W2 || cy >= f.H2) return -1
  const a = f.idx[cy * f.W2 + cx]
  return a < 0 ? -1 : f.C[a]
}

// Weakest link in the completion along a path: resample the polyline at even
// arc-length intervals and return the MINIMUM salience over the free-space
// part of its interior. Minimum, not mean, because closure demands an unbroken
// connecting contour -- a wall between the tips zeroes the field mid-path,
// which a mean would hide. Samples that land on ink are SKIPPED rather than
// scored zero: tips come from the skeleton, so a thick stroke buries the ends
// of every path in ink, and ink is already-drawn contour, not a gap to bridge.
// (The wall case still fails: free cells flanking a wall have u or v cut off,
// so the field genuinely reads 0 there.)
const TRIM = 0.18
const MIN_FREE = 3 // need this many free samples to judge a completion
function pathSupport(f: CompletionField, poly: number[], samples = 24): number {
  const n = poly.length >> 1
  if (n < 2) return 0
  const seg: number[] = [], cum: number[] = [0]
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(poly[2 * i] - poly[2 * i - 2], poly[2 * i + 1] - poly[2 * i - 1])
    seg.push(d); cum.push(cum[i - 1] + d)
  }
  const total = cum[n - 1]
  if (total <= 0) return 0
  let mn = Infinity, free = 0
  for (let s = 0; s < samples; s++) {
    const t = (TRIM + (1 - 2 * TRIM) * (samples === 1 ? 0.5 : s / (samples - 1))) * total
    let i = 1
    while (i < n - 1 && cum[i] < t) i++
    const f0 = seg[i - 1] > 0 ? (t - cum[i - 1]) / seg[i - 1] : 0
    const x = poly[2 * i - 2] + (poly[2 * i] - poly[2 * i - 2]) * f0
    const y = poly[2 * i - 1] + (poly[2 * i + 1] - poly[2 * i - 1]) * f0
    const v = sampleC(f, Math.round(x), Math.round(y))
    if (v < 0) continue // ink / outside band: not part of the gap
    free++
    if (v < mn) mn = v
  }
  return free >= MIN_FREE ? mn : 0
}

// Field-driven bridges: among relatable tip pairs, keep those the completion
// field actually connects (unbroken salience along the shaped curve, above a
// fraction of the field's peak), greedy by salience, one bridge per tip.
// Returns [x1,y1,x2,y2,...].
export function fieldBridges(f: CompletionField, eps: Endpoint[], maxBridge: number, wdAt?: (x: number, y: number) => number): number[] {
  if (!f.peak) return []
  const floor = SUPPORT_FRAC * f.peak
  interface Cand { s: number; a: number; b: number }
  const cands: Cand[] = []
  for (let a = 0; a < eps.length; a++) {
    for (let b = a + 1; b < eps.length; b++) {
      const A = eps[a], B = eps[b]
      const d = Math.hypot(A.x - B.x, A.y - B.y)
      if (d > maxBridge || d < 2) continue
      if (!relatable(A.x, A.y, A.tx, A.ty, B.x, B.y, B.tx, B.ty).ok) continue
      if (wdAt) { const wa = wdAt(A.x, A.y), wb = wdAt(B.x, B.y); if (Math.max(wa, wb) > 2.5 * Math.min(wa, wb) + 3) continue }
      const s = pathSupport(f, elasticaCurve(A.x, A.y, A.tx, A.ty, B.x, B.y, B.tx, B.ty))
      if (s > floor) cands.push({ s, a, b })
    }
  }
  cands.sort((p, q) => q.s - p.s)
  const used = new Set<number>(), segs: number[] = []
  for (const { a, b } of cands) {
    if (used.has(a) || used.has(b)) continue
    used.add(a); used.add(b)
    segs.push(eps[a].x, eps[a].y, eps[b].x, eps[b].y)
  }
  return segs
}
