import { membraneSag } from './membrane.ts'

// Segmentation by where the rubber sheet pools.
//
// Given the sag field (see membrane.ts), a drawn area is a VALLEY: the sheet
// hangs lowest somewhere inside it and climbs back to the pinned ink on every
// side. So: flood downhill from every local maximum of sag and let the basins
// meet. The dividing ridge between two basins is the watershed line, and where
// the ink is solid that ridge sits exactly on the stroke, because the stroke is
// pinned to zero -- the deepest possible ridge.
//
// The interesting case is a BROKEN stroke. Then the ridge cannot follow the ink
// all the way; it has to hop the gap through free space, and it crosses at a
// col whose height is the width of the gap. That col is the whole trick:
//
//   * a real gap is narrow, so the col is low, so the two basins are deep
//     relative to where they meet -- they are clearly two things, and the fill
//     does not leak across, even though nothing physically blocks it;
//   * a spurious split inside one area (the waist of a limb, a soft bulge) has
//     a col nearly as high as the basins themselves -- shallow, so it collapses.
//
// That difference is topological persistence: a basin survives if its peak
// stands more than `tau` above the col where it first meets a neighbour. One
// threshold, in pixels, decides both "is this gap real?" and "is this a
// separate area?" -- questions that the trapped-ball path has to answer with
// separate machinery (gap radius, min area, sliver width, declutter).
//
// A corollary worth stating: hatching and texture come out for free. A pocket
// between two hatch strokes is a few px wide, so it peaks a few px up and its
// col with the surface it shades is nearly as high -- persistence near zero,
// absorbed, no density heuristics needed.

const SUB = 8            // sag quantisation, 1/8 px
const REL = 0.3          // also merge when the col is within 30% of the peak

export interface SagResult {
  core: Int32Array       // region id per free pixel, 0 on ink
  sag: Float32Array      // roominess in px (diagnostic / reusable)
}
// Note there is deliberately no list of suggested bridges here. The ridge walk
// below finds every break in the ink that two areas touch through, but a
// boundary this pass keeps is a boundary the fills already respect -- offering
// to bridge it would close nothing that is not closed. (Measured: of ~490 such
// sites on Lineart1, 2 survived the closure test, and only because front
// analysis had found them independently.)

// Local maxima of the quantised field, grouped into plateaus. Each plateau is
// one seed: the deepest point of one valley.
function seedMaxima(q: Int32Array, W: number, H: number, seedOf: Int32Array): number[] {
  const N = W * H
  const isMax = new Uint8Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!q[i]) continue
      const v = q[i]
      let top = 1
      for (let dy = -1; dy <= 1 && top; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if ((!dx && !dy) || nx < 0 || nx >= W) continue
          if (q[ny * W + nx] > v) { top = 0; break }
        }
      }
      isMax[i] = top
    }
  }
  const peaks: number[] = [0]   // 1-based ids; peaks[id] = height of that basin
  const stack: number[] = []
  for (let s = 0; s < N; s++) {
    if (!isMax[s] || seedOf[s]) continue
    const id = peaks.length
    peaks.push(q[s])
    seedOf[s] = id
    stack.length = 0
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const px = p % W, py = (p / W) | 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          if ((!dx && !dy) || nx < 0 || nx >= W) continue
          const n = ny * W + nx
          if (!isMax[n] || seedOf[n] || q[n] !== q[s]) continue
          seedOf[n] = id
          stack.push(n)
        }
      }
    }
  }
  return peaks
}

// Follow the ridge downhill from a col until it meets ink; returns that pixel,
// or -1 if the walk runs out of budget or bottoms out in the open.
function ridgeWalk(s: number, dir: number, q: Int32Array, line: Uint8Array, W: number, H: number, budget: number): number {
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1]
  let p = s, d = dir
  for (let step = 0; step < budget; step++) {
    const x = p % W, y = (p / W) | 0
    let best = -1, bq = Infinity, bd = d
    for (let k = -2; k <= 2; k++) {          // stay roughly on course
      const nd = (d + k + 8) % 8
      const nx = x + DX[nd], ny = y + DY[nd]
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const n = ny * W + nx
      if (line[n]) return n                  // reached the stroke
      if (q[n] < bq) { bq = q[n]; best = n; bd = nd }
    }
    if (best < 0 || bq >= q[p]) return -1    // no way down: not a real leak
    p = best; d = bd
  }
  return -1
}

// A watershed line has to be JUSTIFIED by ink. Walking downhill from a col runs
// along the ridge (both basins are uphill), so if the artist left a break in a
// stroke the two walks arrive at the stroke tips that flank it -- and the
// segment between them is the line they left out. If instead the walks wander
// off without finding ink, nothing in the drawing supports a boundary there:
// it is the seam between two lobes of one wide-open area, and the two basins
// belong together. This one test replaces an absolute width threshold, which
// cannot tell a hundred-pixel background waist from a wide silhouette break.
function inkJustifies(p: number, q: Int32Array, line: Uint8Array, W: number, H: number, budget: number): boolean {
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1]
  const x = p % W, y = (p / W) | 0
  let d0 = -1, bq = Infinity
  for (let d = 0; d < 8; d++) {
    const nx = x + DX[d], ny = y + DY[d]
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
    const n = ny * W + nx
    if (!line[n] && q[n] < bq) { bq = q[n]; d0 = d }
  }
  if (d0 < 0) return false
  const a = ridgeWalk(p, d0, q, line, W, H, budget)
  if (a < 0) return false
  const b = ridgeWalk(p, (d0 + 4) % 8, q, line, W, H, budget)
  if (b < 0) return false
  // both tips found, and close enough together to be one break rather than two
  // unrelated strokes the walks happened to bump into
  return Math.hypot(b % W - a % W, ((b / W) | 0) - ((a / W) | 0)) <= budget
}

// tauPx  — a basin standing less than this above its col is a bulge, not an area.
// maxGap — the widest break the artist might plausibly have left; sets how far
//          the ridge may search for the ink that justifies a boundary.
export function sagSegment(line: Uint8Array, W: number, H: number, tauPx: number, maxGap: number): SagResult {
  const N = W * H
  const sag = membraneSag(line, W, H)

  const q = new Int32Array(N)
  let qmax = 0
  for (let i = 0; i < N; i++) {
    if (line[i]) continue
    const v = Math.max(1, Math.round(sag[i] * SUB))
    q[i] = v
    if (v > qmax) qmax = v
  }

  const core = new Int32Array(N)
  const peaks = seedMaxima(q, W, H, core)
  const K = peaks.length - 1

  // union-find over seeds, with each component's highest peak
  const parent = new Int32Array(K + 1)
  const peak = new Int32Array(K + 1)
  for (let i = 0; i <= K; i++) { parent[i] = i; peak[i] = peaks[i] ?? 0 }
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }

  const tau = Math.max(1, Math.round(tauPx * SUB))

  // Descending priority flood. Buckets are exact (the field is quantised), so
  // this is a linear-time watershed rather than a heap.
  const buckets: (number[] | null)[] = new Array(qmax + 1)
  for (let i = 0; i < N; i++) if (core[i]) (buckets[q[i]] ??= []).push(i)

  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1]
  for (let c = qmax; c >= 1; c--) {
    const b = buckets[c]
    if (!b) continue
    for (let k = 0; k < b.length; k++) {     // b grows while we walk it
      const p = b[k]
      const a = core[p]
      if (!a) continue
      const x = p % W, y = (p / W) | 0
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const n = ny * W + nx
        if (line[n]) continue
        // never slip diagonally between two ink pixels: a 1px stroke drawn on
        // the diagonal would otherwise let two areas touch straight through it
        if (DX[d] && DY[d] && line[y * W + nx] && line[ny * W + x]) continue
        const o = core[n]
        if (!o) {
          core[n] = a
          const nq = q[n] < c ? q[n] : c     // never climb: keep the queue monotone
          ;(buckets[nq] ??= []).push(n)      // nq === c appends to b, walked below
          continue
        }
        const ra = find(a), rb = find(o)
        if (ra === rb) continue
        // First contact is the col. Later contacts sit lower, so they can only
        // be less mergeable -- re-evaluating them is harmless.
        // A basin that barely stands above where it meets its neighbour is a
        // bulge, a limb, a waist -- not a thing of its own.
        const lo = peak[ra] < peak[rb] ? peak[ra] : peak[rb]
        const pers = lo - c
        if (pers < tau || pers < REL * lo) {
          parent[rb] = ra
          if (peak[rb] > peak[ra]) peak[ra] = peak[rb]
        }
      }
    }
    buckets[c] = null
  }

  for (let i = 0; i < N; i++) if (core[i]) core[i] = find(core[i])

  // Two regions can only touch in open space -- the flood never crosses ink --
  // so every surviving adjacency marks a place a stroke failed to close. A given
  // pair may touch in several places (a silhouette broken twice, say), and each
  // has to answer for itself: one gap the artist clearly meant to leave open
  // must not excuse a second one they clearly meant to close. So group the
  // contact pixels into connected SITES and take the highest point of each --
  // the col the fills would pour through there.
  const colSites = () => {
    const byPair = new Map<number, number[]>()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const a = core[i]
        if (!a) continue
        for (let d = 0; d < 4; d++) {        // right/down-right/down/down-left
          const nx = x + DX[d], ny = y + DY[d]
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const n = ny * W + nx
          const o = core[n]
          if (!o || o === a) continue
          if (DX[d] && DY[d] && line[y * W + nx] && line[ny * W + x]) continue
          const key = a < o ? a * 1048576 + o : o * 1048576 + a
          const g = byPair.get(key)
          if (g) g.push(i); else byPair.set(key, [i])
        }
      }
    }
    const sites: Array<[number, number]> = []  // [pair key, col pixel]
    const stack: number[] = []
    for (const [key, pts] of byPair) {
      const open = new Set(pts)
      for (const s of pts) {
        if (!open.has(s)) continue
        open.delete(s)
        let best = s
        stack.length = 0
        stack.push(s)
        while (stack.length) {
          const p = stack.pop()!
          if (q[p] > q[best]) best = p
          const px = p % W, py = (p / W) | 0
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy
            if (ny < 0 || ny >= H) continue
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx
              if ((!dx && !dy) || nx < 0 || nx >= W) continue
              const n = ny * W + nx
              if (open.delete(n)) stack.push(n)
            }
          }
        }
        sites.push([key, best])
      }
    }
    return sites
  }

  // What each site is worth, by how wide the opening is:
  //   under minCol   a pinhole. No fill pours through it; ignore it entirely.
  //   up to `wide`   narrower than the trapped ball, so the two sides stay
  //                  separate on the same guarantee trapped-ball segmentation
  //                  gives -- a ball of radius r cannot pass a gap under 2r.
  //   over `wide`    too wide for the ball. Now it matters whether there is ink
  //                  to justify a wall: a broken silhouette keeps its boundary
  //                  (and beats trapped-ball, which would have leaked), while
  //                  the seam between two lobes of open background does not.
  const minCol = 2 * SUB
  const wide = 2 * maxGap * SUB
  const budget = Math.max(6, 2 * maxGap + 4)
  // Merging changes who is adjacent to whom, so re-scan until it settles.
  for (let round = 0; round < 4; round++) {
    let merged = false
    for (const [key, p] of colSites()) {
      if (q[p] <= wide || q[p] < minCol) continue
      if (inkJustifies(p, q, line, W, H, budget)) continue
      const a = (key / 1048576) | 0, b = key % 1048576
      const ra = find(a), rb = find(b)
      if (ra !== rb) { parent[rb] = ra; merged = true }
    }
    if (!merged) break
    for (let i = 0; i < N; i++) if (core[i]) core[i] = find(core[i])
  }
  return { core, sag }
}
