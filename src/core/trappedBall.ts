import { distanceTransform } from './morphology.ts'
import { growLabels } from './expand.ts'

// Multi-radius trapped-ball segmentation.
// A ball of radius r cannot pass a gap narrower than ~2r, so seeding where the
// ball fits (dist > r) and growing back by r fills regions without leaking
// through gaps. Descending radii: large safe areas first, small details last.
// Leftover free pixels (bands hugging strokes, wedges) are then assigned to
// their nearest connected region — never fragmented into slivers — and only
// truly enclosed pockets become new regions.
export function trappedBall(line: Uint8Array, W: number, H: number, maxGap: number, ink?: Uint8Array | null) {
  const N = W * H
  const dist = distanceTransform(line, W, H)
  const core = new Int32Array(N)
  const queue = new Int32Array(N)
  let next = 0

  const radii: number[] = []
  for (let r = Math.max(1, maxGap); r >= 1; r = r > 4 ? r >> 1 : r - 1) radii.push(r)

  const flood = (s: number, id: number, fits: (q: number) => boolean): number => {
    let sp = 0, qt = 0
    core[s] = id
    queue[qt++] = s
    while (sp < qt) {
      const p = queue[sp++]
      const x = p % W
      let q = p - 1
      if (x > 0 && !core[q] && fits(q)) { core[q] = id; queue[qt++] = q }
      q = p + 1
      if (x < W - 1 && !core[q] && fits(q)) { core[q] = id; queue[qt++] = q }
      q = p - W
      if (q >= 0 && !core[q] && fits(q)) { core[q] = id; queue[qt++] = q }
      q = p + W
      if (q < N && !core[q] && fits(q)) { core[q] = id; queue[qt++] = q }
    }
    return qt
  }

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

  // attach every remaining free pixel to its nearest connected region;
  // ink-weighted so faint sub-threshold strokes still act as soft walls
  growLabels(core, W, H, { blocked: line, cost: ink ?? null })

  // enclosed pockets unreachable from any region become their own regions
  for (let s = 0; s < N; s++) {
    if (!core[s] && !line[s]) flood(s, ++next, q => !line[q])
  }

  return { core, count: next }
}
