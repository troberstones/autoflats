import { trappedBall, labelPockets } from './core/trappedBall.ts'
import { GpuGrower } from './core/gpuGrow.ts'
import { expandLabels } from './core/expand.ts'
import { finalizeRegions, type RegionInfo } from './core/regions.ts'
import { suggestGaps, strokeEndpoints } from './core/gaps.ts'
import { completionField, fieldBridges } from './core/completionField.ts'
import { selectBridges } from './core/closure.ts'
import { distanceTransform } from './core/morphology.ts'
import { flowField } from './core/flow.ts'
import { analyzeFronts } from './core/fronts.ts'
import { mergeSlivers } from './core/slivers.ts'
import { declutter, declutterOpts } from './core/declutter.ts'
import { sagSegment } from './core/sag.ts'
import { curveBridge, coCompleteBridge } from './core/curves.ts'
import type { Flow } from './core/flow.ts'

// 4-tuples [x1,y1,x2,y2,...] -> polylines: parallel-partner co-completion
// when a partner stroke spans the gap, else flow-curved Hermite
function toPaths(segs: number[], flow: Flow | null, line: Uint8Array, W: number, H: number): number[][] {
  const paths: number[][] = []
  for (let i = 0; i < segs.length; i += 4) {
    paths.push(coCompleteBridge(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], line, W, H)
      ?? curveBridge(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], flow))
  }
  return paths
}

// Gestalt closure + Praegnanz: keep only bridges that actually split a fill,
// and only the fewest needed -- candidates arrive best-first, so a bridge whose
// sides an earlier one already separated is dropped as redundant.
function closeAndPrune(paths: number[][], labels: Int32Array | null, line: Uint8Array, W: number, H: number): number[][] {
  if (!labels) return paths
  const { keep } = selectBridges(paths, labels, line, W, H)
  return keep.map(i => paths[i])
}

// Stage caches: raw segmentation is the expensive stage; postprocess-only
// parameter changes (min region, sliver, auto-merge) reuse it. The flow field
// only depends on the ink. Keys are opaque strings built by the main thread.
// two slots so full-res and quarter-res preview runs don't evict each other
const segCache = new Map<string, { core: Int32Array; labels: Int32Array }>()
let flowCache: { key: string; flow: ReturnType<typeof flowField> } | null = null

// GPU growth: lazy init; any failure permanently falls back to CPU
let gpu: GpuGrower | null | undefined // undefined = not tried yet
async function segment(line: Uint8Array, ink: Uint8Array, W: number, H: number, maxGap: number, useGpu: boolean,
                       sagTau: number) {
  // Rubber sheet: one membrane solve replaces the whole radius ladder, and the
  // regions come out of the field's topology rather than out of flood order.
  if (sagTau > 0) {
    const { core } = sagSegment(line, W, H, sagTau, maxGap)
    return { core, labels: expandLabels(core, W, H, ink) }
  }
  if (useGpu && gpu === undefined) gpu = await GpuGrower.create()
  if (useGpu && gpu) {
    try {
      const { core: seeds } = trappedBall(line, W, H, maxGap, ink, false)
      const core = await gpu.grow(seeds, line, ink, W, H)   // leftover attachment
      labelPockets(core, line, W, H)
      const labels = await gpu.grow(core.slice(), null, ink, W, H) // under-line expansion
      return { core, labels }
    } catch {
      gpu = null // device lost or unsupported op: CPU from now on
    }
  }
  const { core } = trappedBall(line, W, H, maxGap, ink)
  return { core, labels: expandLabels(core, W, H, ink) }
}

onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (m.t === 'flat') {
    const line = new Uint8Array(m.line)
    const ink = new Uint8Array(m.ink)
    let core: Int32Array, labels: Int32Array
    const hit = segCache.get(m.segKey)
    if (hit) {
      core = hit.core.slice()
      labels = hit.labels.slice()
    } else {
      ;({ core, labels } = await segment(line, ink, m.W, m.H, m.maxGap,
        !!m.useGpu && m.W * m.H > 2e6, m.sagTau ?? 0))
      segCache.set(m.segKey, { core: core.slice(), labels: labels.slice() })
      for (const k of segCache.keys()) { if (segCache.size <= 2) break; segCache.delete(k) }
    }
    let { regions } = finalizeRegions(core, labels, m.W, m.H, m.minArea)
    if (mergeSlivers(core, labels, line, m.W, m.H, m.sliverW ?? 0)) {
      ;({ regions } = finalizeRegions(core, labels, m.W, m.H, m.minArea))
    }
    // absorb hatching/texture fragments into the areas they shade
    if (declutter(core, labels, line, m.W, m.H, declutterOpts(m.declutter ?? 0), bgLut(regions))) {
      ;({ regions } = finalizeRegions(core, labels, m.W, m.H, m.minArea))
    }
    if (!flowCache || flowCache.key !== m.flowKey) flowCache = { key: m.flowKey, flow: flowField(ink, m.W, m.H) }
    const flow = flowCache.flow
    const maxBridge = Math.max(6, m.maxGap * 2 + 4)
    let res = analyzeFronts(labels, line, m.W, m.H, flow, maxBridge, bgLut(regions), m.autoMerge)
    if (res.merges.length) {
      applyMerges(core, labels, res.merges)
      ;({ regions } = finalizeRegions(core, labels, m.W, m.H, m.minArea))
      // fronts changed after merging: recompute suggestions on the final labels
      res = analyzeFronts(labels, line, m.W, m.H, flow, maxBridge, bgLut(regions), false)
    }
    const paths = closeAndPrune(toPaths(res.segs, flow, line, m.W, m.H), labels, line, m.W, m.H)
    postMessage({ t: 'flat', core: core.buffer, labels: labels.buffer, regions, paths, token: m.token },
      { transfer: [core.buffer, labels.buffer] })
  } else if (m.t === 'carve') {
    const res = carve(new Int32Array(m.core), new Uint8Array(m.line), m.W, m.H, m.idx, m.r, m.ink ? new Uint8Array(m.ink) : null)
    if (!res) { postMessage({ t: 'carve', ok: false, token: m.token }); return }
    postMessage({ t: 'carve', ok: true, core: res.core.buffer, labels: res.labels.buffer, newId: res.newId, newArea: res.newArea, target: res.target, token: m.token },
      { transfer: [res.core.buffer, res.labels.buffer] })
  } else if (m.t === 'cluster') {
    // small regions with an un-inked (open) border to a neighbor -> merge pairs
    const labels = new Int32Array(m.labels) // root-resolved by main
    const line = new Uint8Array(m.line)
    const isBg = new Uint8Array(m.isBg)
    const N = m.W * m.H
    const ld = distanceTransform(line, m.W, m.H)
    let maxId = 0
    for (let i = 0; i < N; i++) if (labels[i] > maxId) maxId = labels[i]
    const area = new Int32Array(maxId + 1)
    for (let i = 0; i < N; i++) if (!line[i]) area[labels[i]]++
    const KEY = 1 << 20
    const open = new Map<number, number>()
    for (let y = 0; y < m.H; y++) {
      for (let x = 0; x < m.W; x++) {
        const i = y * m.W + x, a = labels[i]
        for (const q of [x < m.W - 1 ? i + 1 : -1, y < m.H - 1 ? i + m.W : -1]) {
          if (q < 0) continue
          const b = labels[q]
          if (a === b || ld[i] <= 7 || ld[q] <= 7) continue
          open.set(a * KEY + b, (open.get(a * KEY + b) ?? 0) + 1)
          open.set(b * KEY + a, (open.get(b * KEY + a) ?? 0) + 1)
        }
      }
    }
    const pairs: Array<[number, number]> = []
    for (let id = 1; id <= maxId; id++) {
      if (!area[id] || area[id] >= m.maxArea || (id < isBg.length && isBg[id])) continue
      let best = 0, bw = 3 // need at least 4 open border px
      for (const [k, w] of open) {
        if ((k / KEY | 0) !== id) continue
        const b = k % KEY
        if (b < isBg.length && isBg[b]) continue
        if (w > bw) { bw = w; best = b }
      }
      if (best) pairs.push([id, best])
    }
    postMessage({ t: 'cluster', pairs, token: m.token })
  } else if (m.t === 'gaps') {
    const line = new Uint8Array(m.line)
    const labels = m.labels ? new Int32Array(m.labels) : null
    const maxBridge = Math.max(6, m.maxGap * 2 + 4)
    let segs: number[] = []
    let flow: Flow | null = null
    if (m.ink) flow = flowField(new Uint8Array(m.ink), m.W, m.H)
    if (labels && flow) segs = analyzeFronts(labels, line, m.W, m.H, flow, maxBridge, null, false).segs
    // endpoint bridges: completion-field salience (flagship) or heuristic pairing
    const eps = m.method === 'field'
      ? fieldSuggest(line, m.W, m.H, m.maxGap, maxBridge)
      : suggestGaps(line, m.W, m.H, m.maxGap, labels)
    for (let i = 0; i < eps.length; i += 4) {
      const mx = (eps[i] + eps[i + 2]) / 2, my = (eps[i + 1] + eps[i + 3]) / 2
      let dup = false
      for (let j = 0; j < segs.length; j += 4) {
        if (Math.hypot((segs[j] + segs[j + 2]) / 2 - mx, (segs[j + 1] + segs[j + 3]) / 2 - my) < 12) { dup = true; break }
      }
      if (!dup) segs.push(eps[i], eps[i + 1], eps[i + 2], eps[i + 3])
    }
    const paths = closeAndPrune(toPaths(segs.slice(0, 200 * 4), flow, line, m.W, m.H), labels, line, m.W, m.H)
    postMessage({ t: 'gaps', paths, token: m.token })
  }
}

// Endpoint bridges ranked by stochastic-completion-field salience: tips are
// linked only where the field diffuses a connecting contour between them.
function fieldSuggest(line: Uint8Array, W: number, H: number, maxGap: number, maxBridge: number): number[] {
  const eps = strokeEndpoints(line, W, H, maxGap)
  if (!eps.length) return []
  const f = completionField(line, W, H, eps, maxBridge)
  const inv = new Uint8Array(W * H)
  for (let i = 0; i < inv.length; i++) inv[i] = line[i] ? 0 : 1
  const wd = distanceTransform(inv, W, H)
  return fieldBridges(f, eps, maxBridge, (x, y) => wd[y * W + x])
}

function bgLut(regions: RegionInfo[]): Uint8Array {
  let mx = 0
  for (const r of regions) if (r.id > mx) mx = r.id
  const lut = new Uint8Array(mx + 1)
  for (const r of regions) if (r.isBg) lut[r.id] = 1
  return lut
}

function applyMerges(core: Int32Array, labels: Int32Array, merges: Array<[number, number]>) {
  let mx = 0
  for (const [a, b] of merges) mx = Math.max(mx, a, b)
  for (let i = 0; i < core.length; i++) if (core[i] > mx) mx = core[i] // cheap upper bound pass
  const parent = new Int32Array(mx + 1)
  for (let i = 0; i <= mx; i++) parent[i] = i
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  for (const [a, b] of merges) { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < core.length; i++) { core[i] = find(core[i]); labels[i] = find(labels[i]) }
}

// Carve a new trapped-ball region out of an existing one at click index.
function carve(core: Int32Array, line: Uint8Array, W: number, H: number, idx: number, r: number, ink: Uint8Array | null) {
  const N = W * H
  const target = core[idx]
  if (!target) return null
  // blocked = line or other regions
  const blocked = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (line[i] || (core[i] && core[i] !== target)) blocked[i] = 1
  const dist = distanceTransform(blocked, W, H)
  const thr = r * 3
  // BFS from click through target pixels to nearest ball-fitting pixel
  const queue = new Int32Array(N)
  const seen = new Uint8Array(N)
  let qt = 0, head = 0, seed = -1
  queue[qt++] = idx; seen[idx] = 1
  while (head < qt) {
    const p = queue[head++]
    if (dist[p] > thr) { seed = p; break }
    const x = p % W
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      // line[] includes user barriers: the seed search must not cross them
      if (q < 0 || q >= N || seen[q] || core[q] !== target || line[q]) continue
      seen[q] = 1; queue[qt++] = q
    }
  }
  if (seed < 0) return null
  let newId = 0
  for (let i = 0; i < N; i++) if (core[i] > newId) newId = core[i]
  newId++
  // flood ball-fitting component within target
  qt = 0; head = 0
  core[seed] = newId
  queue[qt++] = seed
  let newArea = 1
  while (head < qt) {
    const p = queue[head++]
    const x = p % W
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      if (q < 0 || q >= N || core[q] !== target || dist[q] <= thr) continue
      core[q] = newId; newArea++; queue[qt++] = q
    }
  }
  // dilate back by r within target
  let levelEnd = qt, steps = r
  head = 0
  while (steps-- > 0 && head < qt) {
    while (head < levelEnd) {
      const p = queue[head++]
      const x = p % W
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= N || core[q] !== target || line[q]) continue
        core[q] = newId; newArea++; queue[qt++] = q
      }
    }
    levelEnd = qt
  }
  const labels = expandLabels(core, W, H, ink)
  return { core, labels, newId, newArea, target }
}
