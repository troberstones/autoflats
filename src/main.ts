import { Doc, Region, Stroke, UndoOp, paletteColor, rgbToHex, hexToRgb, hslToRgb } from './state.ts'
import { CanvasView, Tool } from './ui/canvasView.ts'
import { extractInk, thresholdInk } from './core/ink.ts'
import { smoothMask, skeletonize } from './core/morphology.ts'
import { exportPsd, ExportRegion } from './core/psd.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const doc = new Doc()
const view = new CanvasView($<HTMLCanvasElement>('view'))
let worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const undoStack: UndoOp[] = []
let strokesVersion = 0

// Abort any in-flight worker job instantly by replacing the worker.
// (Also drops the worker-side stage caches — callers only cancel when
// parameters changed, so those caches were stale anyway.)
function cancelWork() {
  if (!busy) return
  worker.terminate()
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  setBusy(false)
}
let busy = false
let token = 0
let mergeFirst = 0
let selected = 0
let dirty = false // segmentation stale (threshold/barrier changed)

// ---------- helpers ----------
const status = (s: string, spin = false) => { const el = $('status'); el.textContent = s; el.className = spin ? 'spin' : '' }
const setBusy = (b: boolean) => {
  busy = b
  for (const id of ['bFlat', 'bGaps', 'bAcceptAll', 'bReflat', 'bCluster', 'bExport']) ($(id) as HTMLButtonElement).disabled = b || !doc.src
  ;($('bAcceptAll') as HTMLButtonElement).disabled = b || !view.paths.length
}
const setDirty = (d: boolean) => {
  dirty = d
  $('badge').style.display = d && doc.labels ? '' : 'none'
  if (d) scheduleAutoFlat()
}
let autoTimer = 0
function scheduleAutoFlat(delay = 600) {
  clearTimeout(autoTimer)
  if (!($<HTMLInputElement>('cAuto')).checked || !doc.ink) return
  autoTimer = window.setTimeout(() => {
    if (busy) scheduleAutoFlat(300) // flat in progress: try again shortly
    else if (dirty) runFlat(true)
  }, delay)
}
const pushUndo = (op: UndoOp) => {
  undoStack.push(op)
  let heavies = 0
  for (let i = undoStack.length - 1; i >= 0; i--) if (undoStack[i].heavy && ++heavies > 3) { undoStack.splice(i, 1); heavies-- }
  if (undoStack.length > 30) undoStack.shift()
  ;($('bUndo') as HTMLButtonElement).disabled = false
}
const sl = (id: string) => +($(id) as HTMLInputElement).value
const pickColor = (): [number, number, number] =>
  ($<HTMLInputElement>('cRand')).checked
    ? hslToRgb(Math.random() * 360, 0.45 + Math.random() * 0.3, 0.6 + Math.random() * 0.2)
    : hexToRgb(($('curColor') as HTMLInputElement).value)
const params = () => ({ thr: sl('sThr') / 100, sat: sl('sSat') / 100, gap: sl('sGap'), min: sl('sMin'), smooth: sl('sSm'), sliver: sl('sSliv') })

function currentLineMask(includeBarriers = true): Uint8Array {
  let line = smoothMask(thresholdInk(doc.ink!, params().thr), doc.W, doc.H, params().smooth)
  if (includeBarriers && doc.barrierMask) for (let i = 0; i < line.length; i++) if (doc.barrierMask[i]) line[i] = 1
  // erode to a 1px skeleton so segmentation is independent of stroke thickness
  if (($<HTMLInputElement>('cSkel')).checked) line = skeletonize(line, doc.W, doc.H)
  return line
}

// ---------- rendering ----------
let fillsCv: HTMLCanvasElement, fillsCtx: CanvasRenderingContext2D, fillsImg: ImageData
let lineCv: HTMLCanvasElement
let barrierCv: HTMLCanvasElement, barrierCtx: CanvasRenderingContext2D

function rebuildLineCanvas() {
  const { W, H } = doc
  const img = new ImageData(W, H)
  const showBin = ($<HTMLInputElement>('cLines')).checked
  if (showBin) {
    const line = currentLineMask(false) // what segmentation sees (smoothed), minus barriers
    for (let i = 0; i < line.length; i++) img.data[i * 4 + 3] = line[i] ? 255 : 0
  } else {
    for (let i = 0; i < doc.ink!.length; i++) img.data[i * 4 + 3] = doc.ink![i]
  }
  lineCv.getContext('2d')!.putImageData(img, 0, 0)
  view.render()
}

function rebuildFills() {
  if (!doc.labels) { view.fills = null; view.render(); return }
  const lut = doc.rootLut()
  const n = doc.regions.length
  const cr = new Uint8Array(n), cg = new Uint8Array(n), cb = new Uint8Array(n), ca = new Uint8Array(n)
  for (let i = 1; i < n; i++) {
    const root = doc.regions[lut[i]]
    if (!root || !root.visible) continue
    cr[i] = root.color[0]; cg[i] = root.color[1]; cb[i] = root.color[2]; ca[i] = 255
  }
  const d = fillsImg.data, lb = doc.labels
  for (let i = 0; i < lb.length; i++) {
    const id = lb[i], o = i * 4
    d[o] = cr[id]; d[o + 1] = cg[id]; d[o + 2] = cb[id]; d[o + 3] = ca[id]
  }
  fillsCtx.putImageData(fillsImg, 0, 0)
  view.fills = fillsCv
  view.render()
}

function rasterizeBarriers() {
  barrierCtx.clearRect(0, 0, doc.W, doc.H)
  barrierCtx.lineCap = barrierCtx.lineJoin = 'round'
  for (const s of doc.strokes) {
    barrierCtx.globalCompositeOperation = s.mode === 'draw' ? 'source-over' : 'destination-out'
    barrierCtx.strokeStyle = '#39f'
    barrierCtx.lineWidth = s.mode === 'draw' ? 3 : 12
    barrierCtx.beginPath()
    barrierCtx.moveTo(s.pts[0], s.pts[1])
    if (s.pts.length === 2) barrierCtx.lineTo(s.pts[0] + 0.1, s.pts[1])
    for (let i = 2; i < s.pts.length; i += 2) barrierCtx.lineTo(s.pts[i], s.pts[i + 1])
    barrierCtx.stroke()
  }
  barrierCtx.globalCompositeOperation = 'source-over'
  const a = barrierCtx.getImageData(0, 0, doc.W, doc.H).data
  const mask = new Uint8Array(doc.W * doc.H)
  for (let i = 0; i < mask.length; i++) if (a[i * 4 + 3] > 64) mask[i] = 1
  doc.barrierMask = mask
  strokesVersion++
  view.render()
}

// ---------- layers panel ----------
function rebuildPanel() {
  const panel = $('layers')
  panel.innerHTML = ''
  for (const r of doc.roots()) {
    const row = document.createElement('div')
    row.className = 'row' + (r.id === selected ? ' sel' : '')
    const vis = document.createElement('input')
    vis.type = 'checkbox'
    vis.checked = r.visible
    vis.onchange = () => { r.visible = vis.checked; rebuildFills() }
    const sw = document.createElement('input')
    sw.type = 'color'
    sw.value = rgbToHex(r.color)
    sw.oninput = () => { r.color = hexToRgb(sw.value); rebuildFills() }
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = r.name + (r.isBg ? ' (bg)' : '')
    nm.ondblclick = () => { const v = prompt('Layer name', r.name); if (v) { r.name = v; rebuildPanel() } }
    const ar = document.createElement('span')
    ar.className = 'ar'
    ar.textContent = fmtArea(r.area)
    row.onclick = e => { if (e.target === vis || e.target === sw) return; selected = r.id; rebuildPanel() }
    row.append(vis, sw, nm, ar)
    panel.append(row)
  }
}
const fmtArea = (a: number) => a > 1e6 ? (a / 1e6).toFixed(1) + 'M' : a > 1000 ? (a / 1000 | 0) + 'k' : '' + a

// ---------- flatting ----------
function runFlat(matchOld: boolean) {
  if (!doc.ink) return
  cancelWork() // a newer request supersedes any running one
  setBusy(true)
  status('Flatting…', true)
  const line = currentLineMask()
  const tk = ++token
  const oldLabels = matchOld ? doc.labels : null
  const oldRegions = matchOld ? doc.regions : null
  const oldLut = matchOld && doc.labels ? doc.rootLut() : null
  const prev = { core: doc.core, labels: doc.labels, regions: doc.regions.slice() }
  worker.onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    if (m.t === 'flat') {
      doc.core = new Int32Array(m.core)
      doc.labels = new Int32Array(m.labels)
      const regs: Region[] = []
      for (const ri of m.regions as { id: number; area: number; isBg: boolean }[]) {
        regs[ri.id] = { id: ri.id, color: paletteColor(ri.id), name: 'Fill ' + ri.id, visible: !ri.isBg, parent: ri.id, area: ri.area, isBg: ri.isBg }
      }
      doc.regions = regs
      if (oldLabels && oldRegions && oldLut) matchColors(oldLabels, oldRegions, oldLut)
      if (prev.core) pushUndo({ label: 'flat', heavy: true, undo: () => { doc.core = prev.core; doc.labels = prev.labels; doc.regions = prev.regions; afterModelChange() } })
      setDirty(false)
      view.paths = m.paths ?? []
      view.segFocus = -1
      afterModelChange()
      status(`${m.regions.length} fills` + (view.paths.length ? ` · ${view.paths.length} suggested gaps — Tab to review, click or Enter to bridge` : ''))
      setBusy(false)
    }
  }
  const ink = doc.ink!.slice()
  const p = params()
  worker.postMessage({
    t: 'flat', line: line.buffer, ink: ink.buffer, W: doc.W, H: doc.H,
    maxGap: p.gap, minArea: p.min, sliverW: p.sliver, autoMerge: ($<HTMLInputElement>('cMerge')).checked,
    segKey: `${doc.W}|${p.thr}|${p.smooth}|${p.gap}|${p.sat}|${strokesVersion}|${($<HTMLInputElement>('cSkel')).checked}`,
    flowKey: `${doc.W}|${p.sat}`,
    useGpu: ($<HTMLInputElement>('cGpu')).checked,
    token: tk,
  }, [line.buffer, ink.buffer])
}

// carry colors/names/visibility from old regions to best-overlapping new ones
function matchColors(oldLabels: Int32Array, oldRegions: Region[], oldLut: Int32Array) {
  const tally = new Map<number, number>()
  const KEY = 1 << 20
  for (let i = 0; i < doc.labels!.length; i += 3) {
    const n = doc.labels![i], o = oldLut[oldLabels[i]]
    if (!n || !o) continue
    const k = n * KEY + o
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  // one-to-one greedy by overlap: an old region colors at most ONE new region,
  // so a region split by a barrier visibly becomes two fills
  const entries = [...tally].map(([k, c]) => [(k / KEY) | 0, k % KEY, c] as const)
  entries.sort((a, b) => b[2] - a[2])
  const usedNew = new Set<number>(), usedOld = new Set<number>()
  for (const [n, o] of entries) {
    if (usedNew.has(n) || usedOld.has(o)) continue
    const nr = doc.regions[n], or = oldRegions[o]
    if (!nr || !or) continue
    usedNew.add(n); usedOld.add(o)
    nr.color = or.color; nr.name = or.name; nr.visible = or.visible
  }
}

function afterModelChange() {
  selected = 0
  rebuildFills()
  rebuildPanel()
}

// ---------- tools ----------
function setTool(t: Tool) {
  view.tool = t
  mergeFirst = 0
  for (const [id, tt] of [['tPan', 'pan'], ['tFill', 'fill'], ['tBarrier', 'barrier'], ['tEraser', 'eraser'], ['tMerge', 'merge'], ['tDraw', 'dmerge']] as const)
    $(id).classList.toggle('active', tt === t)
}

view.onClick = (fx, fy, e) => {
  const x = fx | 0, y = fy | 0
  if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) return
  // accepting a gap suggestion works with any tool
  if (view.paths.length && acceptSegNear(fx, fy)) return
  if (!doc.labels) return
  const id = doc.root(doc.labels[y * doc.W + x])
  if (!id) return
  const r = doc.regions[id]
  if (view.tool === 'fill') {
    if (e.altKey) { ($('curColor') as HTMLInputElement).value = rgbToHex(r.color); return }
    if (r.isBg) { carveAt(y * doc.W + x); return }
    const prev = r.color
    r.color = pickColor()
    r.visible = true
    pushUndo({ label: 'recolor', undo: () => { r.color = prev; rebuildFills(); rebuildPanel() } })
    selected = id
    rebuildFills(); rebuildPanel()
  } else if (view.tool === 'merge') {
    if (!mergeFirst) { mergeFirst = id; selected = id; rebuildPanel(); status(`Merge: now click the region to merge into "${r.name}"`) }
    else if (mergeFirst !== id) {
      const a = doc.regions[mergeFirst], b = r
      b.parent = a.id
      a.area += b.area
      pushUndo({ label: 'merge', undo: () => { b.parent = b.id; a.area -= b.area; rebuildFills(); rebuildPanel() } })
      mergeFirst = 0
      status(`Merged "${b.name}" into "${a.name}"`)
      rebuildFills(); rebuildPanel()
    }
  }
}

function carveAt(idx: number) {
  if (busy || !doc.core) return
  setBusy(true)
  status('Filling…', true)
  const tk = ++token
  const line = currentLineMask()
  const coreCopy = doc.core.slice()
  const prev = { core: doc.core, labels: doc.labels, regions: doc.regions.slice().map(r => r && { ...r }) }
  worker.onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    setBusy(false)
    if (!m.ok) { status('No room to fill here — increase Gap size or pick another spot') ; return }
    doc.core = new Int32Array(m.core)
    doc.labels = new Int32Array(m.labels)
    const target = doc.regions[m.target]
    if (target) target.area -= m.newArea
    doc.regions[m.newId] = { id: m.newId, color: pickColor(), name: 'Fill ' + m.newId, visible: true, parent: m.newId, area: m.newArea, isBg: false }
    pushUndo({ label: 'carve', heavy: true, undo: () => { doc.core = prev.core; doc.labels = prev.labels; doc.regions = prev.regions as Region[]; afterModelChange() } })
    selected = m.newId
    afterModelChange()
    status('Filled')
  }
  const inkCopy = doc.ink!.slice()
  worker.postMessage({ t: 'carve', core: coreCopy.buffer, line: line.buffer, ink: inkCopy.buffer, W: doc.W, H: doc.H, idx, r: params().gap, token: tk }, [coreCopy.buffer, line.buffer, inkCopy.buffer])
}

view.onStroke = pts => {
  if (!doc.src) return
  if (view.tool === 'dmerge') { mergeAlongStroke(pts); return }
  if (view.tool !== 'barrier' && view.tool !== 'eraser') return
  const s: Stroke = { pts, mode: view.tool === 'eraser' ? 'erase' : 'draw' }
  doc.strokes.push(s)
  pushUndo({ label: 'barrier', undo: () => { doc.strokes.splice(doc.strokes.indexOf(s), 1); rasterizeBarriers(); setDirty(true) } })
  rasterizeBarriers()
  setDirty(true)
}

// Draw merge: every fill the stroke crosses merges into the fill under its start
function mergeAlongStroke(pts: number[]) {
  if (!doc.labels) return
  let start = 0
  const crossed = new Set<number>()
  const visit = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) return
    const id = doc.root(doc.labels![(y | 0) * doc.W + (x | 0)])
    if (!id) return
    if (!start) start = id
    else if (id !== start) crossed.add(id)
  }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x1 = pts[i], y1 = pts[i + 1], x2 = pts[i + 2], y2 = pts[i + 3]
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)))
    for (let s = 0; s <= steps; s++) visit(x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps)
  }
  if (pts.length === 2) visit(pts[0], pts[1])
  if (!start) return
  const a = doc.regions[start]
  if (a.isBg) { status('Draw merge: start the stroke on a fill, not the background'); return }
  const merged: Region[] = []
  for (const cid of crossed) {
    const r = doc.regions[cid]
    if (!r || r.isBg) continue
    r.parent = start
    a.area += r.area
    merged.push(r)
  }
  if (!merged.length) { status('Draw merge: stroke crossed no other fills'); return }
  pushUndo({
    label: 'draw merge',
    undo: () => { for (const r of merged) { r.parent = r.id; a.area -= r.area } rebuildFills(); rebuildPanel() },
  })
  selected = start
  rebuildFills()
  rebuildPanel()
  status(`Merged ${merged.length} fill${merged.length > 1 ? 's' : ''} into "${a.name}"`)
}

// ---------- quarter-res live preview ----------
function maxPool4(src: Uint8Array, W: number, H: number, W4: number, H4: number): Uint8Array {
  const out = new Uint8Array(W4 * H4)
  for (let y = 0; y < H; y++) {
    const row = y * W, row4 = (y >> 2) * W4
    for (let x = 0; x < W; x++) {
      const v = src[row + x]
      const o = row4 + (x >> 2)
      if (v > out[o]) out[o] = v
    }
  }
  return out
}

// Full pipeline at 1/4 resolution (~16x faster) for instant feedback while a
// slider drags; the full-res auto re-flat lands after the drag settles.
function runPreviewFlat() {
  if (!doc.ink) return
  cancelWork()
  setBusy(true)
  status('Preview…', true)
  const tk = ++token
  const W4 = Math.ceil(doc.W / 4), H4 = Math.ceil(doc.H / 4)
  const p = params()
  const ink4 = maxPool4(doc.ink, doc.W, doc.H, W4, H4)
  let line4 = smoothMask(thresholdInk(ink4, p.thr), W4, H4, Math.round(p.smooth / 4), 3)
  if (doc.barrierMask) {
    const b4 = maxPool4(doc.barrierMask, doc.W, doc.H, W4, H4)
    for (let i = 0; i < line4.length; i++) if (b4[i]) line4[i] = 1
  }
  if (($<HTMLInputElement>('cSkel')).checked) line4 = skeletonize(line4, W4, H4)
  worker.onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    setBusy(false)
    renderPreview(new Int32Array(m.labels), m.regions, W4, H4)
  }
  worker.postMessage({
    t: 'flat', line: line4.buffer, ink: ink4.buffer, W: W4, H: H4,
    maxGap: Math.max(1, Math.round(p.gap / 4)), minArea: Math.max(4, Math.round(p.min / 16)),
    sliverW: Math.round(p.sliver / 4), autoMerge: ($<HTMLInputElement>('cMerge')).checked,
    segKey: `pv|${W4}|${p.thr}|${p.smooth}|${p.gap}|${p.sat}|${strokesVersion}|${($<HTMLInputElement>('cSkel')).checked}`,
    flowKey: `pv|${W4}|${p.sat}`,
    token: tk,
  }, [line4.buffer, ink4.buffer])
}

function renderPreview(labels4: Int32Array, regions: Array<{ id: number; area: number; isBg: boolean }>, W4: number, H4: number) {
  let maxId = 0
  for (const r of regions) if (r.id > maxId) maxId = r.id
  const cr = new Uint8Array(maxId + 1), cg = new Uint8Array(maxId + 1), cb = new Uint8Array(maxId + 1), ca = new Uint8Array(maxId + 1)
  for (const r of regions) {
    const [rr, gg, bb] = paletteColor(r.id)
    cr[r.id] = rr; cg[r.id] = gg; cb[r.id] = bb; ca[r.id] = r.isBg ? 0 : 255
  }
  // steal colors from the current full-res fills by overlap so the preview
  // doesn't flash a whole new palette
  if (doc.labels) {
    const lut = doc.rootLut()
    const KEY = 1 << 20
    const tally = new Map<number, number>()
    for (let y4 = 0; y4 < H4; y4++) {
      const y = Math.min(doc.H - 1, y4 * 4)
      for (let x4 = 0; x4 < W4; x4++) {
        const n = labels4[y4 * W4 + x4]
        const o = lut[doc.labels[y * doc.W + Math.min(doc.W - 1, x4 * 4)]]
        if (n && o) tally.set(n * KEY + o, (tally.get(n * KEY + o) ?? 0) + 1)
      }
    }
    const best = new Map<number, [number, number]>()
    for (const [k, c] of tally) {
      const n = (k / KEY) | 0
      if (!best.has(n) || c > best.get(n)![1]) best.set(n, [k % KEY, c])
    }
    for (const [n, [o]] of best) {
      const or = doc.regions[o]
      if (!or) continue
      cr[n] = or.color[0]; cg[n] = or.color[1]; cb[n] = or.color[2]; ca[n] = or.visible ? 255 : 0
    }
  }
  const img = new ImageData(W4, H4)
  for (let i = 0; i < labels4.length; i++) {
    const id = labels4[i], o = i * 4
    img.data[o] = cr[id]; img.data[o + 1] = cg[id]; img.data[o + 2] = cb[id]; img.data[o + 3] = ca[id]
  }
  const cv = document.createElement('canvas')
  cv.width = W4; cv.height = H4
  cv.getContext('2d')!.putImageData(img, 0, 0)
  view.fills = cv
  view.render()
}

let quickTimer = 0
function scheduleQuickFlat() {
  if (!($<HTMLInputElement>('cAuto')).checked || !doc.labels) return
  clearTimeout(quickTimer)
  quickTimer = window.setTimeout(runPreviewFlat, 120)
}

// Cluster Small: merge small fills into the neighbor they share an un-inked border with
function clusterSmall() {
  if (busy || !doc.labels) return
  setBusy(true)
  status('Clustering small fills…', true)
  const tk = ++token
  const lut = doc.rootLut()
  const labels = new Int32Array(doc.labels.length)
  for (let i = 0; i < labels.length; i++) labels[i] = lut[doc.labels[i]]
  const line = currentLineMask()
  const isBg = new Uint8Array(doc.regions.length)
  for (const r of doc.roots()) if (r.isBg) isBg[r.id] = 1
  worker.onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    setBusy(false)
    const merged: Array<[Region, Region]> = [] // [child, target]
    for (const [a, b] of m.pairs as Array<[number, number]>) {
      const ra = doc.root(a), rb = doc.root(b)
      if (ra === rb) continue
      const child = doc.regions[ra], target = doc.regions[rb]
      if (!child || !target || child.isBg || target.isBg) continue
      child.parent = rb
      target.area += child.area
      merged.push([child, target])
    }
    if (!merged.length) { status('No small open-bordered fills to cluster'); return }
    pushUndo({
      label: 'cluster',
      undo: () => { for (const [c, t] of merged) { c.parent = c.id; t.area -= c.area } rebuildFills(); rebuildPanel() },
    })
    rebuildFills()
    rebuildPanel()
    status(`Clustered ${merged.length} small fill${merged.length > 1 ? 's' : ''}`)
  }
  worker.postMessage({
    t: 'cluster', labels: labels.buffer, line: line.buffer, isBg: isBg.buffer,
    W: doc.W, H: doc.H, maxArea: Math.max(500, params().min * 10), token: tk,
  }, [labels.buffer, line.buffer, isBg.buffer])
}

// ---------- gap suggestions ----------
function suggestGapsNow() {
  if (busy || !doc.ink) return
  setBusy(true)
  status('Finding gaps…', true)
  const tk = ++token
  const line = currentLineMask()
  worker.onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    view.paths = m.paths
    view.segFocus = -1
    view.render()
    setBusy(false)
    status(m.paths.length ? `${m.paths.length} gap suggestions — Tab to review, click or Enter to bridge, or Accept All` : 'No gaps found')
  }
  const labels = doc.labels ? doc.labels.slice() : null
  const ink = doc.ink!.slice()
  const method = ($<HTMLInputElement>('cField')).checked ? 'field' : 'heuristic'
  worker.postMessage({ t: 'gaps', line: line.buffer, ink: ink.buffer, W: doc.W, H: doc.H, maxGap: params().gap, labels: labels?.buffer ?? null, method, token: tk },
    labels ? [line.buffer, ink.buffer, labels.buffer] : [line.buffer, ink.buffer])
}

function acceptSegNear(x: number, y: number): boolean {
  const tol = 8 / view.scale
  for (let pi = 0; pi < view.paths.length; pi++) {
    const p = view.paths[pi]
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (distToSeg(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) < tol) {
        acceptSeg(pi)
        view.render()
        return true
      }
    }
  }
  return false
}

function acceptSeg(pi: number) {
  const s: Stroke = { pts: view.paths[pi], mode: 'draw' }
  doc.strokes.push(s)
  view.paths.splice(pi, 1)
  if (view.segFocus >= view.paths.length) view.segFocus = view.paths.length ? 0 : -1
  pushUndo({ label: 'bridge', undo: () => { doc.strokes.splice(doc.strokes.indexOf(s), 1); rasterizeBarriers(); setDirty(true) } })
  rasterizeBarriers()
  setDirty(true)
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy)
}

// ---------- file open / export ----------
async function openFile(f: File) {
  const bmp = await createImageBitmap(f)
  doc.W = bmp.width; doc.H = bmp.height
  doc.name = f.name.replace(/\.[^.]+$/, '')
  doc.src = document.createElement('canvas')
  doc.src.width = doc.W; doc.src.height = doc.H
  const sctx = doc.src.getContext('2d')!
  sctx.drawImage(bmp, 0, 0)
  doc.ink = extractInk(sctx.getImageData(0, 0, doc.W, doc.H), params().sat)
  doc.core = doc.labels = null
  doc.regions = []
  doc.strokes = []
  doc.barrierMask = new Uint8Array(doc.W * doc.H)
  undoStack.length = 0
  view.paths = []
  fillsCv = document.createElement('canvas'); fillsCv.width = doc.W; fillsCv.height = doc.H
  fillsCtx = fillsCv.getContext('2d')!
  fillsImg = new ImageData(doc.W, doc.H)
  lineCv = document.createElement('canvas'); lineCv.width = doc.W; lineCv.height = doc.H
  barrierCv = document.createElement('canvas'); barrierCv.width = doc.W; barrierCv.height = doc.H
  barrierCtx = barrierCv.getContext('2d')!
  // scale min-region default with resolution (~190 px² at 5.6 MP)
  ;($('sMin') as HTMLInputElement).value = '' + Math.min(500, Math.max(50, Math.round(doc.W * doc.H / 30000)))
  $('vMin').textContent = ($('sMin') as HTMLInputElement).value + 'px²'
  view.imgW = doc.W; view.imgH = doc.H
  view.fills = null; view.lineCv = lineCv; view.barrierCv = barrierCv
  rebuildLineCanvas()
  rebuildPanel()
  view.fit()
  setBusy(false)
  runFlat(false) // auto-flat on load
}

async function doExport() {
  if (!doc.labels) return
  status('Exporting…', true)
  await new Promise(r => setTimeout(r))
  const regions: ExportRegion[] = doc.roots().map(r => ({ id: r.id, color: r.color, name: r.name, hidden: !r.visible }))
  const blob = new Blob([exportPsd(doc.W, doc.H, doc.labels, doc.rootLut(), regions, doc.ink!)], { type: 'image/vnd.adobe.photoshop' })
  const name = doc.name + '.psd'
  const w = window as any
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': ['.psd'] } }] })
      const ws = await h.createWritable()
      await ws.write(blob)
      await ws.close()
      status('Saved ' + name)
      return
    } catch (e: any) { if (e.name === 'AbortError') { status('Export cancelled'); return } }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
  status('Saved ' + name)
}

// ---------- wiring ----------
$('bOpen').onclick = () => $<HTMLInputElement>('file').click()
$<HTMLInputElement>('file').onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f) }
$('bFlat').onclick = () => runFlat(false)
$('bReflat').onclick = () => runFlat(true)
$('bCluster').onclick = clusterSmall
$('bGaps').onclick = suggestGapsNow
$('bAcceptAll').onclick = () => {
  while (view.paths.length) acceptSeg(0)
  view.render()
  runFlat(true)
}
$('bExport').onclick = doExport
$('bUndo').onclick = doUndo
$('tPan').onclick = () => setTool('pan')
$('tFill').onclick = () => setTool('fill')
$('tBarrier').onclick = () => setTool('barrier')
$('tEraser').onclick = () => setTool('eraser')
$('tMerge').onclick = () => setTool('merge')
$('tDraw').onclick = () => setTool('dmerge')

function doUndo() {
  const op = undoStack.pop()
  if (!op) return
  op.undo()
  status('Undid ' + op.label)
  ;($('bUndo') as HTMLButtonElement).disabled = !undoStack.length
}

function focusSeg(dir: number) {
  const n = view.paths.length
  if (!n) return
  view.segFocus = ((view.segFocus + dir) % n + n) % n
  const p = view.paths[view.segFocus]
  const mid = (p.length >> 2) << 1
  const mx = p[mid], my = p[mid + 1]
  if (view.scale < 1) view.scale = 1.5
  view.ox = view.canvas.width / 2 - mx * view.scale
  view.oy = view.canvas.height / 2 - my * view.scale
  view.render()
  status(`Gap ${view.segFocus + 1}/${n} — Enter to bridge, Tab for next`)
}

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); doUndo(); return }
  if (e.key === 'Tab') { e.preventDefault(); focusSeg(e.shiftKey ? -1 : 1); return }
  if (e.key === 'Enter' && view.segFocus >= 0 && view.paths.length) {
    e.preventDefault()
    acceptSeg(view.segFocus)
    if (view.segFocus >= 0) focusSeg(0)
    else { view.render(); status('Bridged — Re-Flat to apply') }
    return
  }
  const k = e.key.toLowerCase()
  if (k === 'v') setTool('pan')
  else if (k === 'b') setTool('fill')
  else if (k === 'g') setTool('barrier')
  else if (k === 'e') setTool('eraser')
  else if (k === 'm') setTool('merge')
  else if (k === 'd') setTool('dmerge')
})

const sliderLive = () => {
  $('vThr').textContent = sl('sThr') + '%'
  $('vSat').textContent = sl('sSat') + '%'
  $('vGap').textContent = sl('sGap') + 'px'
  $('vMin').textContent = sl('sMin') + 'px²'
  $('vSm').textContent = sl('sSm') + 'px'
  $('vSliv').textContent = sl('sSliv') + 'px'
}
let pvTimer = 0
let lastSat = -1
const schedulePreview = () => {
  clearTimeout(pvTimer)
  pvTimer = window.setTimeout(() => {
    if (!doc.src) return
    if (params().sat !== lastSat) {
      lastSat = params().sat
      doc.ink = extractInk(doc.src.getContext('2d')!.getImageData(0, 0, doc.W, doc.H), lastSat)
    }
    rebuildLineCanvas()
  }, 150)
}
for (const id of ['sThr', 'sSat', 'sSm']) $(id).oninput = () => { sliderLive(); setDirty(true); schedulePreview(); scheduleQuickFlat() }
for (const id of ['sGap', 'sMin', 'sSliv']) $(id).oninput = () => { sliderLive(); setDirty(true); scheduleQuickFlat() }
$('cMerge').onchange = () => { setDirty(true); scheduleQuickFlat() }
$('cSkel').onchange = () => { if (doc.src) rebuildLineCanvas(); setDirty(true); scheduleQuickFlat() }
$('cAuto').onchange = () => { if (dirty) scheduleAutoFlat(0) }
$('sOp').oninput = () => { view.lineOpacity = sl('sOp') / 100; view.render() }
$('cLines').onchange = () => { view.showLines = ($<HTMLInputElement>('cLines')).checked; if (doc.src) rebuildLineCanvas() }

// drag & drop
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) openFile(f) })

setTool('pan')
if ((navigator as any).gpu) $('lGpu').hidden = false
// automation/test hook
;(window as any).__openUrl = async (u: string) =>
  openFile(new File([await (await fetch(u)).blob()], u.split('/').pop() || 'img.png'))
