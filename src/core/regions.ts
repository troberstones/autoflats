export interface RegionInfo { id: number; area: number; isBg: boolean }

// Absorb regions smaller than minArea into the neighbor sharing the most
// boundary, then compact ids to 1..K. Mutates core & labels in place.
export function finalizeRegions(core: Int32Array, labels: Int32Array, W: number, H: number, minArea: number) {
  const N = W * H
  let maxId = 0
  for (let i = 0; i < N; i++) if (core[i] > maxId) maxId = core[i]
  const area = new Int32Array(maxId + 1)
  for (let i = 0; i < N; i++) area[core[i]]++

  // boundary lengths between expanded labels
  const nbr = new Map<number, Map<number, number>>()
  const bump = (a: number, b: number) => {
    let m = nbr.get(a)
    if (!m) nbr.set(a, (m = new Map()))
    m.set(b, (m.get(b) ?? 0) + 1)
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = labels[i]
      if (x < W - 1) { const b = labels[i + 1]; if (a !== b) { bump(a, b); bump(b, a) } }
      if (y < H - 1) { const b = labels[i + W]; if (a !== b) { bump(a, b); bump(b, a) } }
    }
  }

  // union-find, absorb smallest first
  const parent = new Int32Array(maxId + 1)
  for (let i = 0; i <= maxId; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  const ids: number[] = []
  for (let i = 1; i <= maxId; i++) ids.push(i)
  ids.sort((a, b) => area[a] - area[b])
  for (const s of ids) {
    if (area[find(s)] >= minArea) continue
    const m = nbr.get(s)
    if (!m) continue
    let best = 0, bw = -1
    for (const [b, w] of m) {
      const rb = find(b)
      if (rb !== find(s) && w > bw) { bw = w; best = rb }
    }
    if (best) {
      const rs = find(s)
      area[best] += area[rs]
      parent[rs] = best
    }
  }

  // compact ids
  const remap = new Int32Array(maxId + 1)
  let K = 0
  for (let i = 1; i <= maxId; i++) if (find(i) === i && area[i] > 0) remap[i] = ++K
  for (let i = 1; i <= maxId; i++) remap[i] = remap[find(i)]
  for (let i = 0; i < N; i++) { core[i] = remap[core[i]]; labels[i] = remap[labels[i]] }

  const outArea = new Int32Array(K + 1)
  for (let i = 0; i < N; i++) outArea[core[i]]++
  const isBg = new Uint8Array(K + 1)
  for (let x = 0; x < W; x++) { isBg[labels[x]] = 1; isBg[labels[(H - 1) * W + x]] = 1 }
  for (let y = 0; y < H; y++) { isBg[labels[y * W]] = 1; isBg[labels[y * W + W - 1]] = 1 }

  const regions: RegionInfo[] = []
  for (let i = 1; i <= K; i++) regions.push({ id: i, area: outArea[i], isBg: !!isBg[i] })
  regions.sort((a, b) => b.area - a.area)
  return { regions, count: K }
}
