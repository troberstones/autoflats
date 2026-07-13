import { distanceTransform, skeletonize } from './morphology.ts'

// Gap-bridge suggestions: thin the line mask (Zhang-Suen), find stroke
// endpoints, pair nearby endpoints (or endpoint -> nearby stroke) that aren't
// already connected along the skeleton. If labels are given, only bridges
// where the SAME fill region flows through the gap are kept — i.e. gaps that
// actually caused (or would cause) a leak. Returns [x1,y1,x2,y2, ...].
export function suggestGaps(line: Uint8Array, W: number, H: number, maxGap: number, labels?: Int32Array | null): number[] {
  // stroke half-width at skeleton pixels (similarity cue for pairing)
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < inv.length; i++) inv[i] = line[i] ? 0 : 1
  const wd = distanceTransform(inv, W, H)
  const sk = skeletonize(line, W, H)

  const maxBridge = Math.max(6, maxGap * 2 + 4)
  const eps: number[] = []
  for (let i = 0; i < sk.length; i++) {
    if (sk[i] && skNbrCount(sk, i, W) <= 1 && !isSpur(sk, i, W)) eps.push(i)
  }
  if (eps.length > 4000) eps.length = 4000

  interface Ep { i: number; x: number; y: number; branch: Set<number>; dx: number; dy: number }
  const info: Ep[] = eps.map(i => {
    const branch = walkBranch(sk, i, W, maxBridge * 2)
    const arr = [...branch]
    const back = arr[Math.min(arr.length - 1, 6)]
    const x = i % W, y = (i / W) | 0
    let dx = x - back % W, dy = y - ((back / W) | 0)
    const n = Math.hypot(dx, dy) || 1
    return { i, x, y, branch, dx: dx / n, dy: dy / n }
  })

  const segs: number[] = []
  const used = new Set<number>()
  // endpoint <-> endpoint, nearest pairs first
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
      // near-collinear continuation at BOTH ends (±45°) — kills bridges that
      // cut across open space between unrelated stroke tips
      if (A.dx * (B.x - A.x) + A.dy * (B.y - A.y) < 0.7 * d) continue
      if (B.dx * (A.x - B.x) + B.dy * (A.y - B.y) < 0.7 * d) continue
      pairs.push([d, a, b])
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

