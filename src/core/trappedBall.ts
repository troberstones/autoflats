import { distanceTransform } from './morphology.ts'
import { growLabels } from './expand.ts'

// Multi-radius trapped-ball segmentation.
// A ball of radius r cannot pass a gap narrower than ~2r, so seeding where the
// ball fits (dist > r) and growing back by r fills regions without leaking
// through gaps. Descending radii: large safe areas first, small details last.
// Leftover free pixels (bands hugging strokes, wedges) are then assigned to
// their nearest connected region — never fragmented into slivers — and only
// truly enclosed pockets become new regions.
// attach=false skips the final leftover-attachment growth and pocket labeling
// (the worker substitutes a GPU-accelerated growth, then calls labelPockets).
export function trappedBall(line: Uint8Array, W: number, H: number, maxGap: number, ink?: Uint8Array | null, attach = true) {
  const N = W * H
  const dist = distanceTransform(line, W, H)
  const core = new Int32Array(N)
  const queue = new Int32Array(N)
  let next = 0

  const radii: number[] = []
  for (let r = Math.max(1, maxGap); r >= 1; r = r > 4 ? r >> 1 : r - 1) radii.push(r)

  for (const r of radii) {
    const thr = r * 3
    let total = 0
    for (let s = 0; s < N; s++) {
      if (core[s] || line[s] || dist[s] <= thr) continue
      // flood one ball-fitting component, appending to the shared queue
      const id = ++next
      let sp = total
      core[s] = id
      queue[total++] = s
      while (sp < total) {
        const p = queue[sp++]
        const x = p % W
        let q = p - 1
        if (x > 0 && !core[q] && !line[q] && dist[q] > thr) { core[q] = id; queue[total++] = q }
        q = p + 1
        if (x < W - 1 && !core[q] && !line[q] && dist[q] > thr) { core[q] = id; queue[total++] = q }
        q = p - W
        if (q >= 0 && !core[q] && !line[q] && dist[q] > thr) { core[q] = id; queue[total++] = q }
        q = p + W
        if (q < N && !core[q] && !line[q] && dist[q] > thr) { core[q] = id; queue[total++] = q }
      }
    }
    if (total) growLabels(core, W, H, { blocked: line, maxCost: thr, seeds: queue.subarray(0, total) })
  }

  if (attach) {
    // attach every remaining free pixel to its nearest connected region;
    // ink-weighted so faint sub-threshold strokes still act as soft walls
    growLabels(core, W, H, { blocked: line, cost: ink ?? null })
    next = labelPockets(core, line, W, H)
  }

  return { core, count: next }
}

// Enclosed pockets unreachable from any region become their own regions.
// Returns the highest label id in use.
export function labelPockets(core: Int32Array, line: Uint8Array, W: number, H: number): number {
  const N = W * H
  let next = 0
  for (let i = 0; i < N; i++) if (core[i] > next) next = core[i]
  const stack: number[] = []
  for (let s = 0; s < N; s++) {
    if (core[s] || line[s]) continue
    const id = ++next
    core[s] = id
    stack.length = 0
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % W
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= N || core[q] || line[q]) continue
        core[q] = id
        stack.push(q)
      }
    }
  }
  return next
}
