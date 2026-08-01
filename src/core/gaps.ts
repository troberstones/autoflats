import { distanceTransform, skeletonize } from './morphology.ts'
import { relatable } from './relatability.ts'

// Gap-bridge suggestions: thin the line mask (Zhang-Suen), find stroke
// endpoints, pair nearby endpoints (or endpoint -> nearby stroke) that aren't
// already connected along the skeleton. If labels are given, only bridges
// where the SAME fill region flows through the gap are kept — i.e. gaps that
// actually caused (or would cause) a leak. Returns [x1,y1,x2,y2, ...].
interface Ep { i: number; x: number; y: number; branch: Set<number>; dx: number; dy: number }

// Skeleton stroke tips with outward unit tangents (dx,dy point out of the tip,
// into the gap). Shared by suggestGaps and the completion field. `wd` is the
// stroke half-width transform (similarity cue); `sk` the 1px skeleton.
// keepSpurs: a tip whose branch forks a few steps in is normally dropped as
// skeleton noise, but at a real break the OTHER side of the gap is often close
// enough to fork the skeleton right behind the tip -- so the filter throws away
// one tip of a genuine pair and the gap can never be closed. Measured on
// LineartCircles1: 16 raw tips, 8 gaps, and isSpur left only one tip on four of
// them. suggestGaps keeps the filter (it also pairs tip->stroke, so it survives
// losing one side); the tight-closure pass cannot, and compensates with its own
// much stricter cone, bend and openness tests.
function extractEndpoints(line: Uint8Array, W: number, H: number, maxBridge: number,
                          keepSpurs = false): { info: Ep[]; wd: Int32Array; sk: Uint8Array } {
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < inv.length; i++) inv[i] = line[i] ? 0 : 1
  const wd = distanceTransform(inv, W, H)
  const sk = skeletonize(line, W, H)

  const eps: number[] = []
  for (let i = 0; i < sk.length; i++) {
    if (sk[i] && skNbrCount(sk, i, W) <= 1 && (keepSpurs || !isSpur(sk, i, W))) eps.push(i)
  }
  if (eps.length > 4000) eps.length = 4000

  const info: Ep[] = eps.map(i => {
    const branch = walkBranch(sk, i, W, maxBridge * 2)
    const arr = [...branch]
    const back = arr[Math.min(arr.length - 1, 6)]
    const x = i % W, y = (i / W) | 0
    let dx = x - back % W, dy = y - ((back / W) | 0)
    const n = Math.hypot(dx, dy) || 1
    return { i, x, y, branch, dx: dx / n, dy: dy / n }
  })
  return { info, wd, sk }
}

export interface Endpoint { x: number; y: number; tx: number; ty: number }
export function strokeEndpoints(line: Uint8Array, W: number, H: number, maxGap: number): Endpoint[] {
  const maxBridge = Math.max(6, maxGap * 2 + 4)
  return extractEndpoints(line, W, H, maxBridge).info.map(e => ({ x: e.x, y: e.y, tx: e.dx, ty: e.dy }))
}

export function suggestGaps(line: Uint8Array, W: number, H: number, maxGap: number, labels?: Int32Array | null): number[] {
  const maxBridge = Math.max(6, maxGap * 2 + 4)
  const { info, wd, sk } = extractEndpoints(line, W, H, maxBridge)

  const segs: number[] = []
  const used = new Set<number>()
  // endpoint <-> endpoint, most-relatable (lowest elastica energy) pairs first
  const pairs: [number, number, number][] = []
  for (let a = 0; a < info.length; a++) {
    for (let b = a + 1; b < info.length; b++) {
      const A = info[a], B = info[b]
      const d = Math.hypot(A.x - B.x, A.y - B.y)
      if (d > maxBridge || d < 2) continue
      if (A.branch.has(B.i)) continue // already connected along the stroke
      // similar stroke widths (don't join a contour break to thin hatching)
      const wa = wd[A.i], wb = wd[B.i]
      if (Math.max(wa, wb) > 2.5 * Math.min(wa, wb) + 3) continue
      // gestalt good continuation: relatable (smooth, monotonic, bend <= 90deg,
      // no inflection). Tangents point out of each tip into the gap.
      const rel = relatable(A.x, A.y, A.dx, A.dy, B.x, B.y, B.dx, B.dy)
      if (!rel.ok) continue
      pairs.push([rel.energy, a, b])
    }
  }
  pairs.sort((p, q) => p[0] - q[0])
  for (const [, a, b] of pairs) {
    if (used.has(a) || used.has(b)) continue
    used.add(a); used.add(b)
    segs.push(info[a].x, info[a].y, info[b].x, info[b].y)
  }
  // endpoint -> nearest foreign line pixel
  for (let a = 0; a < info.length; a++) {
    if (used.has(a)) continue
    const A = info[a]
    const hit = nearestForeignLine(line, sk, A, W, H, maxBridge)
    if (hit >= 0) segs.push(A.x, A.y, hit % W, (hit / W) | 0)
  }
  return labels ? filterLeaky(segs, labels, line, W, H) : segs
}

// Virtual-bridge test: keep a suggestion only if actually drawing the bridge
// would locally split one fill region into two meaningfully-sized parts.
// Dead-end sketch strokes inside a region fail this and are dropped.
const BOX = 96          // local window half-size, px
const MIN_SPLIT = 150   // px² each side must gain to be worth bridging
function filterLeaky(segs: number[], labels: Int32Array, line: Uint8Array, W: number, H: number): number[] {
  const side = 2 * BOX + 1
  const visited = new Uint8Array(side * side) // 0 unseen, 1 blocked-by-bridge, 2 side A, 3 side B
  const queue = new Int32Array(side * side)
  const out: number[] = []

  for (let i = 0; i < segs.length; i += 4) {
    const x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3]
    const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2)
    const bx = cx - BOX, by = cy - BOX // box origin in image coords
    visited.fill(0)
    // rasterize bridge (thick) as a wall
    const len = Math.hypot(x2 - x1, y2 - y1) || 1
    const steps = Math.ceil(len)
    for (let s = 0; s <= steps; s++) {
      const px = Math.round(x1 + (x2 - x1) * s / steps), py = Math.round(y1 + (y2 - y1) * s / steps)
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const lx = px + ox - bx, ly = py + oy - by
        if (lx >= 0 && ly >= 0 && lx < side && ly < side) visited[ly * side + lx] = 1
      }
    }
    // seeds on both sides of the midpoint
    const nx = -(y2 - y1) / len, ny = (x2 - x1) / len
    const seed = (sign: number): number => {
      for (const d of [2, 3, 4, 6]) {
        const px = Math.round(cx + nx * d * sign), py = Math.round(cy + ny * d * sign)
        if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue
        const gi = py * W + px
        const li = (py - by) * side + (px - bx)
        if (!line[gi] && labels[gi] && !visited[li]) return gi
      }
      return -1
    }
    const sa = seed(1), sb = seed(-1)
    if (sa < 0 || sb < 0 || labels[sa] !== labels[sb]) continue // already split (or unusable)
    const region = labels[sa]

    // flood side A within box; if it reaches seed B the bridge separates nothing
    const flood = (start: number, mark: number, other: number): [number, boolean] => {
      let qt = 0, head = 0, area = 0, big = false
      queue[qt++] = start
      visited[((start / W | 0) - by) * side + (start % W - bx)] = mark
      while (head < qt) {
        const p = queue[head++]
        area++
        if (p === other) return [area, true] // reached the other side
        const px = p % W, py = (p / W) | 0
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const qx = px + dx, qy = py + dy
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue
          const lx = qx - bx, ly = qy - by
          if (lx < 0 || ly < 0 || lx >= side || ly >= side) { big = true; continue } // spills out of box
          const li = ly * side + lx
          if (visited[li]) continue
          const gi = qy * W + qx
          if (line[gi] || labels[gi] !== region) continue
          visited[li] = mark
          queue[qt++] = gi
        }
      }
      return [big ? 1e9 : area, false]
    }
    const [areaA, joined] = flood(sa, 2, sb)
    if (joined) continue
    const [areaB] = flood(sb, 3, -1)
    if (Math.min(areaA, areaB) >= MIN_SPLIT) out.push(x1, y1, x2, y2)
  }
  return out
}

// A spur is a short noise nub: walking from the endpoint along the skeleton
// hits a junction (>=2 onward paths) within a few steps. Real stroke tips
// have long branches.
function isSpur(sk: Uint8Array, i: number, W: number, K = 6): boolean {
  let prev = -1, cur = i
  for (let s = 0; s < K; s++) {
    const nbrs: number[] = []
    for (const d of [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1]) {
      const q = cur + d
      if (!sk[q] || q === prev) continue
      if (prev >= 0 && Math.abs(q % W - prev % W) <= 1 && Math.abs(((q / W) | 0) - ((prev / W) | 0)) <= 1) continue // 8-adjacent to prev: same path, not a fork
      nbrs.push(q)
    }
    if (nbrs.length === 0) return false // dead end: genuine tip (or isolated dot)
    if (nbrs.length >= 2) return true   // junction close to the tip: spur
    prev = cur
    cur = nbrs[0]
  }
  return false
}

function skNbrCount(sk: Uint8Array, i: number, W: number): number {
  return sk[i - W - 1] + sk[i - W] + sk[i - W + 1] + sk[i - 1] + sk[i + 1] + sk[i + W - 1] + sk[i + W] + sk[i + W + 1]
}

function walkBranch(sk: Uint8Array, start: number, W: number, maxSteps: number): Set<number> {
  const seen = new Set<number>([start])
  let frontier = [start]
  for (let s = 0; s < maxSteps && frontier.length; s++) {
    const nf: number[] = []
    for (const p of frontier) {
      for (const d of [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1]) {
        const q = p + d
        if (sk[q] && !seen.has(q)) { seen.add(q); nf.push(q) }
      }
    }
    frontier = nf
  }
  return seen
}

function nearestForeignLine(line: Uint8Array, sk: Uint8Array, A: { x: number; y: number; branch: Set<number>; dx: number; dy: number }, W: number, H: number, maxR: number): number {
  for (let r = 3; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const y = A.y + dy
      if (y < 1 || y >= H - 1) continue
      const step = Math.abs(dy) === r ? 1 : 2 * r
      for (let dx = -r; dx <= r; dx += step) {
        const x = A.x + dx
        if (x < 1 || x >= W - 1) continue
        const i = y * W + x
        if (!line[i]) continue
        if (A.dx * dx + A.dy * dy < 0.7 * r) continue // must continue the stroke direction (±45°)
        let own = false // skip pixels of our own stroke (near its skeleton branch)
        for (let oy = -3; oy <= 3 && !own; oy++)
          for (let ox = -3; ox <= 3; ox++)
            if (A.branch.has(i + oy * W + ox)) { own = true; break }
        if (!own) return i
      }
    }
  }
  return -1
}


// ---------- tight closures ----------
// A different question from suggestGaps. That one asks "where might the artist
// have left a gap?" and answers generously, because a human reviews the list.
// This one asks "which gaps are so obviously gaps that we can close them
// unreviewed, before segmenting at all?" -- so it is deliberately mean.
//
// It exists because the rubber sheet places a boundary on a CREST, not across
// an opening. Where a silhouette is broken the crest runs inward along the
// shape's axis instead of over the break, which both puts the wall in the wrong
// place and leaves the area's basin merged with whatever floods in. Sealing the
// break first sidesteps the whole problem: the sheet then sees a closed shape,
// so the basin is real and the crest lands on the artist's line.
//
// "Short and tight" is three tests, all of which must pass:
//   short   the two tips are within maxBridge of each other, and among the
//           candidates the shortest/straightest are taken first;
//   tight   they face each other inside a 45-degree cone with at most 60
//           degrees of total bend (suggestGaps allows 60/90) -- a pair that has
//           to swing to meet is a guess, and guesses are what the review list
//           is for;
//   open    the straight run between them is blank paper. If there is ink in
//           the middle the two tips are already joined by something, and what
//           looks like a gap is the far side of a curve.
// One closure per tip, best-first, so nothing gets fanned out to three
// neighbours.
const TIGHT_CONE = 0.7    // cos, ~45 degrees off the chord
// Degrees of total turn allowed across the join (suggestGaps allows 90). Was 60,
// which rejected the base of a horn on Lineart4_crop by three degrees -- that
// join needs 63 -- and that one gap was the difference between the horn being a
// fill and being background. Swept over the seven samples at 60/70/80/90: 70
// costs at most +2 fills anywhere, never splits the background, and never makes
// the swallowed-area figure worse (Lineart4_crop 0.53% -> 0.24%, the horn). 80
// and 90 add closures but buy no further area back, so they are risk with no
// return.
const TIGHT_BEND = 70

// Is the chord's interior free of ink? The tips are SKELETON points, sitting on
// the centreline half a stroke deep in their own ink, so every chord starts and
// ends inside ink and that part has to be skipped before the question means
// anything. A fixed skip cannot do it: a blunt stroke end cut at an angle to the
// chord reaches much further along it than the stroke's half-width, which is why
// this rejected the horn-tip gap on LineartCircles1 (tips 11px apart, half-width
// 3 and 4, and still ink at step 5).
//
// So skip each end's OWN ink run instead of guessing a distance: walk in from
// both ends while the chord is inked, and require what is left in the middle to
// be blank. If the two runs meet there was never a gap -- the tips are joined by
// ink and what looks like a break is the far side of a curve.
function crossingIsOpen(line: Uint8Array, W: number, H: number,
                        x1: number, y1: number, x2: number, y2: number): boolean {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1))
  if (steps < 2) return false
  // 1 = ink, 0 = paper, -1 = off the image (never acceptable in a closure)
  const at = (s: number): number => {
    const x = Math.round(x1 + (x2 - x1) * s / steps), y = Math.round(y1 + (y2 - y1) * s / steps)
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : line[y * W + x] ? 1 : 0
  }
  let a = 0, b = steps
  while (a <= steps && at(a) === 1) a++
  while (b >= 0 && at(b) === 1) b--
  if (a > b) return false
  for (let s = a; s <= b; s++) if (at(s) !== 0) return false
  return true
}

export function tightClosures(line: Uint8Array, W: number, H: number, maxGap: number,
                               cone = TIGHT_CONE, bend = TIGHT_BEND): number[] {
  const maxBridge = Math.max(6, maxGap * 2 + 4)
  const { info, wd } = extractEndpoints(line, W, H, maxBridge, true)
  const pairs: Array<[number, number, number]> = []
  for (let a = 0; a < info.length; a++) {
    for (let b = a + 1; b < info.length; b++) {
      const A = info[a], B = info[b]
      const d = Math.hypot(A.x - B.x, A.y - B.y)
      if (d > maxBridge || d < 2) continue
      if (A.branch.has(B.i)) continue                     // same stroke, already joined
      const wa = wd[A.i], wb = wd[B.i]
      if (Math.max(wa, wb) > 2.5 * Math.min(wa, wb) + 3) continue
      const rel = relatable(A.x, A.y, A.dx, A.dy, B.x, B.y, B.dx, B.dy, cone, bend)
      if (!rel.ok) continue
      if (!crossingIsOpen(line, W, H, A.x, A.y, B.x, B.y)) continue
      pairs.push([rel.energy, a, b])
    }
  }
  pairs.sort((p, q) => p[0] - q[0])
  const used = new Set<number>()
  const segs: number[] = []
  for (const [, a, b] of pairs) {
    if (used.has(a) || used.has(b)) continue
    used.add(a); used.add(b)
    segs.push(info[a].x, info[a].y, info[b].x, info[b].y)
  }
  return segs
}
