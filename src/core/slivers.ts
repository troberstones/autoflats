import { distanceTransform } from './morphology.ts'

// Merge "corridor slivers": regions that are thinner than sliverW everywhere
// (their max distance to line art is small) are the space between parallel /
// double-drawn strokes, not intentional cells. Each merges into the neighbor
// it shares the most OPEN border with (the area the corridor opens into),
// falling back to the longest border overall.
export function mergeSlivers(core: Int32Array, labels: Int32Array, line: Uint8Array,
  W: number, H: number, sliverW: number): boolean {
  if (sliverW <= 0) return false
  const N = W * H
  const ld = distanceTransform(line, W, H)
  let maxId = 0
  for (let i = 0; i < N; i++) if (core[i] > maxId) maxId = core[i]
  const maxD = new Int32Array(maxId + 1)
  for (let i = 0; i < N; i++) if (core[i] && ld[i] > maxD[core[i]]) maxD[core[i]] = ld[i]
  const thin = new Uint8Array(maxId + 1)
  let any = false
  for (let id = 1; id <= maxId; id++) if (maxD[id] > 0 && maxD[id] <= sliverW * 3) { thin[id] = 1; any = true }
  if (!any) return false

  // neighbor tallies for thin regions: open borders weighted heavily
  const OPEN = 7
  const tally = new Map<number, Map<number, number>>()
  const bump = (a: number, b: number, w: number) => {
    if (!thin[a]) return
    let m = tally.get(a)
    if (!m) tally.set(a, (m = new Map()))
    m.set(b, (m.get(b) ?? 0) + w)
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = labels[i]
      for (const q of [x < W - 1 ? i + 1 : -1, y < H - 1 ? i + W : -1]) {
        if (q < 0) continue
        const b = labels[q]
        if (a === b) continue
        const w = ld[i] > OPEN && ld[q] > OPEN ? 20 : 1
        bump(a, b, w); bump(b, a, w)
      }
    }
  }

  const parent = new Int32Array(maxId + 1)
  for (let i = 0; i <= maxId; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  for (const [id, m] of tally) {
    let best = 0, bw = -1
    for (const [b, w] of m) {
      // prefer merging into a non-thin region when weights tie-ish
      const ww = w * (thin[b] ? 1 : 2)
      if (ww > bw) { bw = ww; best = b }
    }
    if (best) { const ra = find(id), rb = find(best); if (ra !== rb) parent[ra] = rb }
  }
  for (let i = 0; i < N; i++) { core[i] = find(core[i]); labels[i] = find(labels[i]) }
  return true
}
