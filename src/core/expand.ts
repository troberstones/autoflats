// Multi-source label growth in chamfer-distance order (bucketed Dijkstra,
// 8-conn, 3-4 weights). Growing all regions simultaneously by true distance
// gives smooth, near-euclidean fronts that meet at the medial axis — no
// Manhattan-BFS stair-stepping.
//
// - blocked: pixels labels may never grow into (e.g. line mask), or null.
// - maxCost: growth budget in chamfer units (3 ≈ 1 px).
// - seeds: pixel indices allowed to grow. Labeled pixels NOT in seeds are
//   fixed obstacles-with-identity: never overwritten, never growing.
//   If omitted, every labeled pixel seeds.
// - cost: per-pixel extra weight (e.g. the ink map) — soft watershed: fronts
//   pay to cross dark pixels, so region boundaries snap to faint stroke
//   remnants instead of the geometric midpoint.
export function growLabels(labels: Int32Array, W: number, H: number,
  opts: { blocked?: Uint8Array | null; maxCost?: number; seeds?: Int32Array | null; cost?: Uint8Array | null } = {}) {
  const blocked = opts.blocked ?? null
  const cost = opts.cost ?? null
  const maxCost = opts.maxCost ?? 0x7ffffffe
  const N = W * H
  const INF = 0x7fffffff
  const dist = new Int32Array(N).fill(INF)
  const buckets: number[][] = []
  const push = (i: number, c: number) => { (buckets[c] ??= []).push(i) }

  if (opts.seeds) {
    for (const s of opts.seeds) { dist[s] = 0; push(s, 0) }
  } else {
    for (let i = 0; i < N; i++) if (labels[i]) { dist[i] = 0; push(i, 0) }
  }

  for (let c = 0; c < buckets.length; c++) {
    const b = buckets[c]
    if (!b) continue
    for (let k = 0; k < b.length; k++) {
      const p = b[k]
      if (dist[p] !== c) continue // stale entry
      const id = labels[p]
      const x = p % W, y = (p / W) | 0
      for (let dy = -1; dy <= 1; dy++) {
        const qy = y + dy
        if (qy < 0 || qy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const qx = x + dx
          if (qx < 0 || qx >= W) continue
          const q = qy * W + qx
          if (blocked && blocked[q]) continue
          // fixed pixel (labeled but not a seed): impassable
          if (labels[q] && dist[q] === INF) continue
          // don't slip diagonally between two blocked pixels
          if (dx && dy && blocked && blocked[y * W + qx] && blocked[qy * W + x]) continue
          // ink 255 adds ~23 units (≈8 px) — crossing a faint stroke is expensive
          const nd = c + (dx && dy ? 4 : 3) + (cost ? (cost[q] * 3) >> 5 : 0)
          if (nd > maxCost || nd >= dist[q]) continue
          dist[q] = nd
          labels[q] = id
          push(q, nd)
        }
      }
    }
    buckets[c] = null as any // free as we go
  }
}

// Expand core labels into line pixels; adjacent regions race and meet at the
// stroke's darkest ridge (given ink) or its medial axis, so fills reach the
// middle of every line (no fringe).
export function expandLabels(core: Int32Array, W: number, H: number, ink?: Uint8Array | null): Int32Array {
  const labels = core.slice()
  growLabels(labels, W, H, { cost: ink ?? null })
  return labels
}
