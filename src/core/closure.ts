// Gestalt closure + Praegnanz, at the level of regions rather than contours.
//
// Closure: a bridge is worth drawing only if it actually CLOSES something --
// i.e. drawing it separates one fill into two meaningfully-sized parts. A
// bridge that merely decorates open space inside a region closes nothing.
//
// Praegnanz (the "simplest organization" principle): prefer the FEWEST
// completions that achieve those closures. Several candidates often cross the
// same leak; once one is accepted the others are redundant and adding them just
// clutters the suggestion list. Candidates are therefore considered best-first
// and each is kept only if the two sides it separates are still connected given
// everything already accepted.
//
// Both tests run in a local window around the bridge -- leaks are local, and a
// bounded box keeps this linear in the number of candidates.

const BOX = 96          // local window half-size, px
export const MIN_SPLIT = 150  // px^2 each side must gain to be worth bridging

export interface Selection { keep: number[]; gain: number[] }

// Choose a non-redundant subset of `paths` (polylines, best-first). Returns the
// indices kept and, for each, the closure gain = area of the smaller side.
export function selectBridges(paths: number[][], labels: Int32Array, line: Uint8Array,
  W: number, H: number, minSplit = MIN_SPLIT): Selection {
  const side = 2 * BOX + 1
  const mark = new Int32Array(side * side) // stamped with a per-test id
  const queue = new Int32Array(side * side)
  const accepted = new Uint8Array(W * H)   // bridges taken so far, as barriers
  const keep: number[] = [], gain: number[] = []
  let stamp = 0

  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi]
    if (p.length < 4) continue
    // window centred on the path's midpoint
    let cx = 0, cy = 0
    for (let i = 0; i < p.length; i += 2) { cx += p[i]; cy += p[i + 1] }
    cx = Math.round(cx / (p.length / 2)); cy = Math.round(cy / (p.length / 2))
    const bx = cx - BOX, by = cy - BOX

    // seeds either side of the path's midsegment
    const mi = ((p.length / 2) >> 1) * 2
    const ax = p[Math.max(0, mi - 2)], ay = p[Math.max(0, mi - 1)]
    const bx2 = p[Math.min(p.length - 2, mi)], by2 = p[Math.min(p.length - 1, mi + 1)]
    const len = Math.hypot(bx2 - ax, by2 - ay) || 1
    const nx = -(by2 - ay) / len, ny = (bx2 - ax) / len
    const mx = (ax + bx2) / 2, my = (ay + by2) / 2
    const seed = (sign: number): number => {
      for (const d of [2, 3, 4, 6]) {
        const px = Math.round(mx + nx * d * sign), py = Math.round(my + ny * d * sign)
        if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue
        if (Math.abs(px - cx) > BOX - 2 || Math.abs(py - cy) > BOX - 2) continue
        const gi = py * W + px
        if (!line[gi] && !accepted[gi] && labels[gi]) return gi
      }
      return -1
    }
    const sa = seed(1), sb = seed(-1)
    if (sa < 0 || sb < 0 || labels[sa] !== labels[sb]) continue
    const region = labels[sa]

    // flood within the box, over pixels of `region`, blocked by line + accepted
    // (+ this path when `wall` is set). Returns [area, reachedTarget].
    const flood = (start: number, target: number, wall: Uint8Array | null): [number, boolean] => {
      const id = ++stamp
      let qt = 0, head = 0, area = 0, spill = false
      queue[qt++] = start
      mark[((start / W | 0) - by) * side + (start % W - bx)] = id
      while (head < qt) {
        const q = queue[head++]
        area++
        if (q === target) return [area, true]
        const qx = q % W, qy = (q / W) | 0
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const rx = qx + dx, ry = qy + dy
          if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue
          const lx = rx - bx, ly = ry - by
          if (lx < 0 || ly < 0 || lx >= side || ly >= side) { spill = true; continue }
          const li = ly * side + lx
          if (mark[li] === id) continue
          const gi = ry * W + rx
          if (line[gi] || accepted[gi] || labels[gi] !== region) continue
          if (wall && wall[li]) continue
          mark[li] = id
          queue[qt++] = gi
        }
      }
      return [spill ? 1e9 : area, false]
    }

    // (1) Praegnanz: if the sides are ALREADY separated by accepted bridges,
    // this candidate closes nothing new -- drop it.
    const [, connected] = flood(sa, sb, null)
    if (!connected) continue

    // (2) Closure: rasterize this path as a wall and check both sides are real.
    const wall = new Uint8Array(side * side)
    for (let i = 0; i + 3 < p.length; i += 2) {
      const steps = Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1])) || 1
      for (let s = 0; s <= steps; s++) {
        const px = Math.round(p[i] + (p[i + 2] - p[i]) * s / steps)
        const py = Math.round(p[i + 1] + (p[i + 3] - p[i + 1]) * s / steps)
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const lx = px + ox - bx, ly = py + oy - by
          if (lx >= 0 && ly >= 0 && lx < side && ly < side) wall[ly * side + lx] = 1
        }
      }
    }
    const [areaA, joined] = flood(sa, sb, wall)
    if (joined) continue // the wall doesn't actually separate the seeds
    const [areaB] = flood(sb, -1, wall)
    const g = Math.min(areaA, areaB)
    if (g < minSplit) continue

    keep.push(pi); gain.push(g)
    // commit: this bridge now blocks later candidates (redundancy source)
    for (let i = 0; i + 3 < p.length; i += 2) {
      const steps = Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1])) || 1
      for (let s = 0; s <= steps; s++) {
        const px = Math.round(p[i] + (p[i + 2] - p[i]) * s / steps)
        const py = Math.round(p[i + 1] + (p[i + 3] - p[i + 1]) * s / steps)
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const gx = px + ox, gy = py + oy
          if (gx >= 0 && gy >= 0 && gx < W && gy < H) accepted[gy * W + gx] = 1
        }
      }
    }
  }
  return { keep, gain }
}
