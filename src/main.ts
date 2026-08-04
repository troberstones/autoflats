import { Doc, Region, Stroke, UndoOp, type MergePair, type ShapeFill, type Recolor, paletteColor, anchorColor, rgbToHex, hexToRgb, hslToRgb, rgbToHsl } from './state.ts'
import { CanvasView, Tool } from './ui/canvasView.ts'
import { extractInk, thresholdInk } from './core/ink.ts'
import { smoothMask, skeletonize } from './core/morphology.ts'
import { exportPsd, layerCount, ExportRegion, type ExportMode } from './core/psd.ts'
import { WATERCOLOR, edgeDistance, washField, type Watercolor, type WashField } from './core/wash.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const doc = new Doc()
const view = new CanvasView($<HTMLCanvasElement>('view'))
// Created lazily, NOT at module scope: if the browser can't start a module
// worker, a throw here would abort the whole module and leave every button
// dead (which reads as "the app does nothing"). Deferring it keeps the UI
// alive and confines the failure to flatting, with a message that says so.
let _worker: Worker | null = null
const newWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
function worker(): Worker {
  if (!_worker) _worker = newWorker()
  return _worker
}
const undoStack: UndoOp[] = []
let strokesVersion = 0

// Abort any in-flight worker job instantly by replacing the worker.
// (Also drops the worker-side stage caches — callers only cancel when
// parameters changed, so those caches were stale anyway.)
function cancelWork() {
  if (!busy) return
  _worker?.terminate()
  _worker = null
  setBusy(false)
}
let busy = false
let token = 0
// The merge tool's first click, kept as a point as well as a region: the point
// is what gets remembered, since region ids do not survive a re-flat.
let mergeFirst: { id: number; x: number; y: number } | null = null
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
  // 'inline', not '': clearing the inline style falls back to the stylesheet,
  // which sets display:none -- so the badge could never actually appear
  $('badge').style.display = d && doc.labels ? 'inline' : 'none'
  if (d) scheduleAutoFlat()
}
// Auto-bridge rounds since the last explicit user action; bounded so a
// bridge -> re-flat -> new suggestion cycle always terminates.
let autoBridgeRounds = 0
const resetAutoBridge = () => { autoBridgeRounds = 0 }
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
const params = () => ({ thr: sl('sThr') / 100, sat: sl('sSat') / 100, gap: sl('sGap'), min: sl('sMin'), smooth: sl('sSm'), sliver: sl('sSliv'), decl: sl('sDecl'), sag: sl('sSag'), hybrid: ($<HTMLInputElement>('cHybrid')).checked })

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
let sagCv: HTMLCanvasElement | null = null, ridgeCv: HTMLCanvasElement | null = null

// pinned -> deepest sag. Roughly inferno: near-black at the ink, through purple
// and red to pale yellow, with the steps spaced so mid-range values stay apart
const SAG_RAMP: Array<[number, number, number]> =
  [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]]

const layerCanvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = doc.W; c.height = doc.H
  return c
}

// The rubber sheet as a height map: black where the sheet is pinned to the ink,
// climbing through red and orange to white in the middle of the roomiest areas
// (the ramp is log — see sagView in the worker). Reading it is the point of the
// mode: a drawn area is plainly a basin, and a break in a stroke is only a
// shallow notch between two of them, which is exactly why fills don't pour
// through one.
function rebuildSagCanvas() {
  if (!doc.sag) { sagCv = null; view.sagCv = null; return }
  const { W, H } = doc
  const img = new ImageData(W, H)
  const d = img.data
  // 256-entry lookup built once per rebuild; a naive red->yellow ramp saturates
  // halfway up and throws away everything above it, so use evenly-spaced stops
  const ramp = new Uint8Array(256 * 3)
  // Zebra: quantise the ramp into n flat bands, i.e. contour lines on the sheet.
  // Two things it buys over the smooth ramp: the level sets become visible, so
  // stripe spacing reads as slope (tight = a wall falling away, wide = a
  // plateau), and a col shows up as the stripe that pinches and pairs across an
  // opening. Banding alone is not enough -- neighbouring bands of a smooth ramp
  // still blend at a glance -- so every other one is dimmed, which is what makes
  // it a zebra rather than a posterisation. Bands are even on the STORED byte,
  // which is log (see sagView in the worker): linear bands would put the whole
  // interior of a figure in one stripe while the open background ate the rest.
  const n = sl('sZebra')
  for (let v = 0; v < 256; v++) {
    const band = n ? Math.min(n - 1, (v * n) >> 8) : 0
    // sample the ramp at the middle of the band so a stripe is one flat colour
    const q = n ? Math.min(255, Math.round((band + 0.5) * 256 / n)) : v
    const t = (q / 255) * (SAG_RAMP.length - 1)
    const k = Math.min(SAG_RAMP.length - 2, t | 0), f = t - k
    const dim = n && (band & 1) ? 0.55 : 1
    for (let c = 0; c < 3; c++) ramp[v * 3 + c] = (SAG_RAMP[k][c] + (SAG_RAMP[k + 1][c] - SAG_RAMP[k][c]) * f) * dim
  }
  for (let i = 0; i < doc.sag.length; i++) {
    const v = doc.sag[i] * 3, o = i * 4
    d[o] = ramp[v]; d[o + 1] = ramp[v + 1]; d[o + 2] = ramp[v + 2]; d[o + 3] = 255
  }
  sagCv ??= layerCanvas()
  sagCv.getContext('2d')!.putImageData(img, 0, 0)
  view.sagCv = sagCv
}

// Ridges: the watershed lines between fills — the creases the sheet folds along.
// Two colours, and the distinction is the whole reason to look:
//   dim white  the ridge is sitting on ink, i.e. the artist drew this boundary;
//   cyan       the ridge crosses open paper. Nothing is drawn there and the fills
//              still don't mix — this is a gap the segmenter closed for you.
// Cyan because it has to stay legible over the sag ramp, which is warm all the
// way up; anything in the magenta-to-orange range disappears into it. It is also
// dilated a pixel, since open ridge is only ~5% of the total length and a hairline
// vanishes when the view is zoomed to fit.
let ridgeKey = ''
function rebuildRidgeCanvas() {
  if (!doc.labels) { ridgeCv = null; view.ridgeCv = null; return }
  const { W, H } = doc
  const lut = doc.rootLut()
  // Recolouring a fill leaves every ridge exactly where it was, and this rebuild
  // is a full-resolution pass plus a line-mask rebuild — ~290ms at 5.6MP, which
  // is felt on every tick of a colour picker. Only merges/splits move a ridge,
  // and those show up in the root table.
  const p = params()
  const key = `${lut.join(',')}|${p.thr}|${p.smooth}|${strokesVersion}|${($<HTMLInputElement>('cSkel')).checked}`
  if (key === ridgeKey && ridgeCv) { view.ridgeCv = ridgeCv; return }
  ridgeKey = key
  const line = currentLineMask()
  const img = new ImageData(W, H)
  const d = img.data
  const put = (i: number, open: boolean) => {
    const o = i * 4
    if (open) { d[o] = 0; d[o + 1] = 245; d[o + 2] = 255; d[o + 3] = 255 }
    else if (d[o + 3] < 150) { d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 150 }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const a = lut[doc.labels[i]]
      const right = x < W - 1 && lut[doc.labels[i + 1]] !== a
      const down = y < H - 1 && lut[doc.labels[i + W]] !== a
      if (!right && !down) continue
      if (line[i]) { put(i, false); continue }
      put(i, true)
      if (x > 0) put(i - 1, true)
      if (x < W - 1) put(i + 1, true)
      if (y > 0) put(i - W, true)
      if (y < H - 1) put(i + W, true)
    }
  }
  ridgeCv ??= layerCanvas()
  const c = ridgeCv.getContext('2d')!
  c.clearRect(0, 0, W, H)
  c.putImageData(img, 0, 0)
  view.ridgeCv = ridgeCv
}

// There is no sag field unless the Rubber sheet slider is up, so say so rather
// than leaving the checkbox to do nothing; when there is one, the label reports
// what full brightness is worth in pixels.
function sagLabel() {
  const has = !!doc.sag
  $('lSagView').className = 's' + (has ? '' : ' off')
  $('lZebra').className = 's' + (has ? '' : ' off')
  ;($<HTMLInputElement>('sZebra')).disabled = !has
  $('vSagView').textContent = has ? `(0–${Math.round(doc.sagMax)}px)` : '(needs Rubber sheet)'
}

// Controls the rubber sheet makes inert. Measured across the six samples with
// sag at tau 6: sliver merging moves 0-2 fills (persistence already dissolves
// corridors), auto-merge finds 0-1 leaks where the trapped ball finds 7-30
// (the ink-justification test got there first), and the GPU flag is not even
// reachable -- segment() returns before that branch when sagTau > 0.
//
// They are greyed rather than hidden so the bar does not reflow, and disabled
// so the greying is not a lie. The parameters are forced inert to match: a
// control that looks switched off must actually be switched off.
//
// Declutter stays: it is much less load-bearing under sag but still worth up to
// 22 fills. Completion field stays too -- it ranks endpoint bridges from the ink
// alone, so it behaves the same either way.
const SAG_INERT: Array<[string, string]> = [['lSliv', 'sSliv'], ['lMerge', 'cMerge'], ['lGpu', 'cGpu']]
const INERT_WHY = 'Not used by the rubber sheet — its work is already done by the sag field. Set Rubber sheet to 0 to re-enable.'
const originalTitles = new Map<string, string>()

function syncSagUI() {
  const off = sl('sSag') > 0
  for (const [labelId, inputId] of SAG_INERT) {
    const label = $(labelId), input = $<HTMLInputElement>(inputId)
    if (!originalTitles.has(labelId)) originalTitles.set(labelId, label.title)
    label.classList.toggle('off', off)
    input.disabled = off
    label.title = off ? INERT_WHY : originalTitles.get(labelId)!
  }
}

function refreshOverlays() {
  const sagOn = ($<HTMLInputElement>('cSagView')).checked
  const ridgeOn = ($<HTMLInputElement>('cRidge')).checked
  view.showSag = sagOn
  view.showRidges = ridgeOn
  if (sagOn) rebuildSagCanvas()
  if (ridgeOn) rebuildRidgeCanvas()
  view.render()
}

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

// The wash field, cached. It depends on the shape of the fills and on the
// watercolor settings, never on the colours, so it survives every recolour and
// is rebuilt only by a re-flat, a merge or a drag of one of the sliders.
let washCache: { labels: Int32Array; key: string; field: WashField } | null = null
function washFor(lut: Int32Array): WashField {
  const key = lut.join(',') + '|' + JSON.stringify(wcParams)
  if (washCache && washCache.labels === doc.labels && washCache.key === key) return washCache.field
  const field = washField(doc.W, doc.H, edgeDistance(doc.W, doc.H, doc.labels!, lut), wcParams)
  washCache = { labels: doc.labels!, key, field }
  return field
}

function rebuildFills() {
  if (!doc.labels) { view.fills = null; view.render(); return }
  const lut = doc.rootLut()
  const n = doc.regions.length
  const cr = new Uint8Array(n), cg = new Uint8Array(n), cb = new Uint8Array(n), ca = new Uint8Array(n)
  for (let i = 1; i < n; i++) {
    const root = doc.regions[lut[i]]
    if (!root || !root.visible || root.deleted) continue
    cr[i] = root.color[0]; cg[i] = root.color[1]; cb[i] = root.color[2]; ca[i] = 255
  }
  const d = fillsImg.data, lb = doc.labels
  const wash = wcPreviewOn() ? washFor(lut) : null
  if (wash) {
    // The wash is a per-pixel multiply against a field that depends only on the
    // SHAPE of the fills, so this stays a single cheap pass and recolouring
    // does not re-synthesize anything. Composited onto the paper here rather
    // than left translucent: the canvas behind this is dark grey, and a wash
    // over dark grey is not the wash that gets exported over white.
    for (let i = 0; i < lb.length; i++) {
      const id = lb[i], o = i * 4, k = wash.k[i], p = wash.paper[i], a = wash.a[i] / 255
      d[o] = cr[id] * k * a + p * (1 - a)
      d[o + 1] = cg[id] * k * a + p * (1 - a)
      d[o + 2] = cb[id] * k * a + p * (1 - a)
      d[o + 3] = ca[id]
    }
  } else {
    for (let i = 0; i < lb.length; i++) {
      const id = lb[i], o = i * 4
      d[o] = cr[id]; d[o + 1] = cg[id]; d[o + 2] = cb[id]; d[o + 3] = ca[id]
    }
  }
  fillsCtx.putImageData(fillsImg, 0, 0)
  view.fills = fillsCv
  // merges/splits move the ridges, and every structural edit lands here; the
  // rebuild is skipped entirely unless the overlay is switched on
  refreshOverlays()
}

const ERASE_R = 6 // barrier eraser radius, px

// One pixel, 8-connected: the thinnest barrier that still blocks every flood we
// run. A barrier is pinned into the membrane exactly like ink, so every pixel of
// width is a pixel of roominess taken from the areas either side of it, and the
// rubber sheet decides what survives by how far an area sags. Measured on a
// square split down the middle, a 3px barrier costs the neighbouring basin
// ~0.9px of peak sag whatever its size (7.62 -> 6.72 on a 7px-wide half, 19.08
// -> 18.23 on a 19px one) -- the pixel it eats on each side, no more. Small in
// absolute terms, but that is 12% of a narrow one, and a hand-closed gap is
// usually next to exactly such a sliver, where persistence is already near tau.
//
// 1px is enough because of how the floods step: the trapped ball moves
// 4-connected (trappedBall.ts:75), and the sag flood is 8-connected but refuses
// a diagonal when both orthogonal cells are ink (sag.ts:207) -- which is exactly
// the staircase a Bresenham line presents at every bend.
function markLine(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  const { W, H } = doc
  let x = Math.round(x0), y = Math.round(y0)
  const ex = Math.round(x1), ey = Math.round(y1)
  const dx = Math.abs(ex - x), dy = -Math.abs(ey - y)
  const sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1
  let err = dx + dy
  for (;;) {
    if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1
    if (x === ex && y === ey) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

// The eraser stays fat -- it is a pointing device, not a wall.
function clearDisc(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  const { W, H } = doc
  const lo = (v: number) => Math.max(0, Math.floor(v - ERASE_R))
  for (let y = lo(Math.min(y0, y1)); y <= Math.min(H - 1, Math.ceil(Math.max(y0, y1) + ERASE_R)); y++)
    for (let x = lo(Math.min(x0, x1)); x <= Math.min(W - 1, Math.ceil(Math.max(x0, x1) + ERASE_R)); x++)
      if (distToSeg(x, y, x0, y0, x1, y1) <= ERASE_R) mask[y * W + x] = 0
}

function rasterizeBarriers() {
  // The overlay is drawn thicker than the mask on purpose: a 1px line is
  // invisible at fit-to-window zoom, and legibility is a display concern with no
  // business in the sag field.
  barrierCtx.clearRect(0, 0, doc.W, doc.H)
  barrierCtx.lineCap = barrierCtx.lineJoin = 'round'
  const mask = new Uint8Array(doc.W * doc.H)
  for (const s of doc.strokes) {
    barrierCtx.globalCompositeOperation = s.mode === 'draw' ? 'source-over' : 'destination-out'
    barrierCtx.strokeStyle = '#39f'
    barrierCtx.lineWidth = s.mode === 'draw' ? 3 : ERASE_R * 2
    barrierCtx.beginPath()
    barrierCtx.moveTo(s.pts[0], s.pts[1])
    if (s.pts.length === 2) barrierCtx.lineTo(s.pts[0] + 0.1, s.pts[1])
    for (let i = 2; i < s.pts.length; i += 2) barrierCtx.lineTo(s.pts[i], s.pts[i + 1])
    barrierCtx.stroke()
    // A dab is a single point; give it a zero-length segment so it still marks.
    const p = s.pts
    const step = s.mode === 'draw' ? markLine : clearDisc
    if (p.length === 2) step(mask, p[0], p[1], p[0], p[1])
    for (let i = 2; i < p.length; i += 2) step(mask, p[i - 2], p[i - 1], p[i], p[i + 1])
  }
  barrierCtx.globalCompositeOperation = 'source-over'
  doc.barrierMask = mask
  strokesVersion++
  view.render()
}

// ---------- layers panel ----------
const expanded = new Set<string>() // colour groups opened in the panel

function regionRow(r: Region, kid: boolean): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'row' + (kid ? ' kid' : '') + (r.id === selected ? ' sel' : '')
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
  const grp = r.group ? doc.groups.find(g => g.id === r.group) : null
  nm.textContent = r.name + (r.isBg ? ' (bg)' : '') + (grp ? ' · ' + grp.name : '')
  if (grp) nm.title = 'In group "' + grp.name + '" — exports as a PSD folder'
  else nm.title = 'Double-click to rename (Enter moves to the next fill)'
  nm.ondblclick = () => startRename(row)
  row.dataset.rid = '' + r.id
  const ar = document.createElement('span')
  ar.className = 'ar'
  ar.textContent = fmtArea(r.area)
  row.onclick = e => { if (e.target === vis || e.target === sw) return; selected = r.id; rebuildPanel() }
  row.append(vis, sw, nm, ar)
  return row
}

// Rename in place, and keep going: Enter commits and opens the next fill's
// editor, so a whole drawing can be named without touching the mouse again.
// Renaming a hundred fills through prompt() -- a modal per fill -- was the
// reason nobody named anything.
function startRename(row: HTMLElement) {
  const r = doc.regions[+(row.dataset.rid ?? 0)]
  if (!r) return
  const nm = row.querySelector('.nm') as HTMLElement
  if (!nm || row.querySelector('input.ren')) return
  const inp = document.createElement('input')
  inp.className = 'ren'
  inp.value = r.name
  nm.replaceWith(inp)
  inp.focus(); inp.select()
  let done = false
  const finish = (commit: boolean, next: boolean) => {
    if (done) return
    done = true
    if (commit && inp.value.trim()) r.name = inp.value.trim()
    const sib = row.nextElementSibling as HTMLElement | null
    rebuildPanel()
    if (!next || !sib?.dataset.rid) return
    const again = $('layers').querySelector(`.row[data-rid="${sib.dataset.rid}"]`)
    if (again) startRename(again as HTMLElement)
  }
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true, true) }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false, false) }
    e.stopPropagation()   // the canvas shortcuts must not see letters typed here
  }
  inp.onblur = () => finish(true, false)
}

// Panel order. Area-descending is the old behaviour and is still the right
// default for finding the big shapes; the sweep is for naming, where you want
// the list to follow the drawing the way your eye does. A diagonal sweep
// (cx + cy) rather than strict reading order, because reading order sorts on a
// single row of pixels: two fills whose tops differ by one pixel land far apart
// in the list even though they sit side by side.
//
// The sweep runs on the CENTROID, not the bounding box corner. A corner is the
// most extreme pixel of a shape, so a long thin fill -- a strand of hair, a
// cast shadow, an arm reaching up -- sorts by wherever its tip happens to
// point, which is nowhere near where you would say the shape is. The centroid
// is where the shape actually sits.
type SortMode = 'area' | 'sweep'
let sortMode: SortMode = 'sweep'
let sweepCache: { key: string; at: Map<number, number> } | null = null

// Centroid of each root, in one pass over the labels.
function sweepKeys(): Map<number, number> {
  const key = `${doc.labels ? doc.W * doc.H : 0}|${doc.rootLut().join(',')}`
  if (sweepCache && sweepCache.key === key) return sweepCache.at
  const at = new Map<number, number>()
  if (doc.labels) {
    const lut = doc.rootLut(), { W, H, labels } = doc
    const sx = new Map<number, number>(), sy = new Map<number, number>(), n = new Map<number, number>()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = lut[labels[y * W + x]]
        if (!r) continue
        sx.set(r, (sx.get(r) ?? 0) + x)
        sy.set(r, (sy.get(r) ?? 0) + y)
        n.set(r, (n.get(r) ?? 0) + 1)
      }
    }
    for (const [r, c] of n) at.set(r, ((sx.get(r) ?? 0) + (sy.get(r) ?? 0)) / c)
  }
  sweepCache = { key, at }
  return at
}

function sortedRoots(): Region[] {
  const roots = doc.roots().filter(r => !r.deleted)
  if (sortMode === 'area') return roots
  const at = sweepKeys()
  // Background last whatever the order: it surrounds everything, so its
  // centroid lands in the middle of the drawing and it would sort into the
  // middle of the list, which is never where you want to meet it.
  return roots.sort((a, b) =>
    (a.isBg ? 1 : 0) - (b.isBg ? 1 : 0) ||
    (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0))
}

// Sort control plus a bulk renumber. Renumbering exists because the useful
// names are positional ("Fill 1" being the top-left one), and that is only true
// if the numbers follow the current order rather than the order the segmenter
// happened to emit.
function panelHeader(): HTMLElement {
  const h = document.createElement('div')
  h.className = 'phead'
  const sel = document.createElement('select')
  sel.title = 'Order of the fill list'
  for (const [v, label] of [['sweep', 'sort: top-left sweep'], ['area', 'sort: largest first']] as const) {
    const o = document.createElement('option')
    o.value = v; o.textContent = label; o.selected = sortMode === v
    sel.append(o)
  }
  sel.onchange = () => { sortMode = sel.value as SortMode; rebuildPanel() }
  const num = document.createElement('button')
  num.className = 'link'
  num.textContent = 'Renumber'
  num.title = 'Rename every fill to Fill 1..N in the current list order'
  num.onclick = () => {
    const rs = sortedRoots()
    const prev = rs.map(r => r.name)
    rs.forEach((r, i) => { r.name = r.isBg ? 'Background' : `Fill ${i + 1}` })
    pushUndo({ label: 'renumber', undo: () => { rs.forEach((r, i) => { r.name = prev[i] }); rebuildPanel() } })
    rebuildPanel()
  }
  h.append(sel, num)
  return h
}

// One row per fill, or -- once fills share colours (Colors slider) -- one
// collapsible row per colour with bulk show/hide and recolour, so the panel
// stays short no matter how many regions there are.
function rebuildPanel() {
  const panel = $('layers')
  panel.innerHTML = ''
  panel.append(panelHeader())
  const roots = sortedRoots()
  const groups = new Map<string, Region[]>()
  for (const r of roots) {
    const k = rgbToHex(r.color)
    const g = groups.get(k)
    if (g) g.push(r); else groups.set(k, [r])
  }
  if (groups.size >= roots.length) { // every fill a unique colour: flat list
    for (const r of roots) panel.append(regionRow(r, false))
    return
  }
  for (const [hex, rs] of groups) {
    const open = expanded.has(hex)
    const row = document.createElement('div')
    row.className = 'row grp'
    const tw = document.createElement('span')
    tw.className = 'tw'
    tw.textContent = open ? '▼' : '▶'
    const vis = document.createElement('input')
    vis.type = 'checkbox'
    vis.checked = rs.some(r => r.visible)
    vis.onchange = () => { for (const r of rs) r.visible = vis.checked; rebuildFills(); rebuildPanel() }
    const sw = document.createElement('input')
    sw.type = 'color'
    sw.value = hex
    sw.oninput = () => { const c = hexToRgb(sw.value); for (const r of rs) r.color = c; rebuildFills() }
    sw.onchange = () => rebuildPanel() // regroup once the picker closes
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = `${rs.length} fill${rs.length > 1 ? 's' : ''}`
    const ar = document.createElement('span')
    ar.className = 'ar'
    ar.textContent = fmtArea(rs.reduce((s, r) => s + r.area, 0))
    row.onclick = e => {
      if (e.target === vis || e.target === sw) return
      open ? expanded.delete(hex) : expanded.add(hex)
      rebuildPanel()
    }
    row.append(tw, vis, sw, nm, ar)
    panel.append(row)
    if (open) for (const r of rs) panel.append(regionRow(r, true))
  }
}
const fmtArea = (a: number) => a > 1e6 ? (a / 1e6).toFixed(1) + 'M' : a > 1000 ? (a / 1000 | 0) + 'k' : '' + a

// ---------- flatting ----------
function runFlat(matchOld: boolean) {
  if (!doc.ink) return
  cancelWork() // a newer request supersedes any running one
  let w: Worker
  try {
    w = worker()
  } catch (e) {
    // image is loaded and viewable; only the off-thread stages are lost
    console.error('worker unavailable', e)
    status('Image loaded, but flatting needs module Worker support (Safari 15+)')
    return
  }
  void w
  setBusy(true)
  status('Flatting…', true)
  const line = currentLineMask()
  const tk = ++token
  const oldLabels = matchOld ? doc.labels : null
  const oldRegions = matchOld ? doc.regions : null
  const oldLut = matchOld && doc.labels ? doc.rootLut() : null
  const prev = { core: doc.core, labels: doc.labels, regions: doc.regions.slice() }
  worker().onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    if (m.t === 'flat') {
      doc.core = new Int32Array(m.core)
      doc.labels = new Int32Array(m.labels)
      doc.sag = m.sag ? new Uint8Array(m.sag) : null
      doc.sagMax = m.sagMax ?? 0
      doc.closures = m.closures ?? []
      sagLabel()
      const regs: Region[] = []
      for (const ri of m.regions as { id: number; area: number; isBg: boolean }[]) {
        regs[ri.id] = { id: ri.id, color: paletteColor(ri.id), name: 'Fill ' + ri.id, visible: !ri.isBg, parent: ri.id, area: ri.area, isBg: ri.isBg }
      }
      doc.regions = regs
      // Colours come from where each fill IS, so a fill the settings did not
      // change keeps the colour it had. The overlap match below still runs on
      // top of this -- it carries names, visibility and hand-picked colours
      // across -- but the base palette no longer depends on it.
      applyAutoColors()
      // re-flat carries colours over from the old regions (preserving both the
      // palette and any manual recolouring); a fresh flat assigns the palette
      if (oldLabels && oldRegions && oldLut) matchColors(oldLabels, oldRegions, oldLut)
      else applyPalette(sl('sPal'))
      // draw-merges, deletions and groups are all stored as the geometry the
      // user drew, so re-derive them against the freshly renumbered regions --
      // this is what makes them survive a re-flat
      replayEdits()
      if (prev.core) pushUndo({ label: 'flat', heavy: true, undo: () => { doc.core = prev.core; doc.labels = prev.labels; doc.regions = prev.regions; afterModelChange() } })
      setDirty(false)
      view.paths = m.paths ?? []
      view.segFocus = -1
      afterModelChange()
      const nClosed = doc.closures.length / 4
      status(`${m.regions.length} fills`
        + (nClosed ? ` · sealed ${nClosed} tight gap${nClosed > 1 ? 's' : ''}` : '')
        + (view.paths.length ? ` · ${view.paths.length} suggested gaps — Tab to review, click or Enter to bridge` : ''))
      setBusy(false)
      // Auto-bridge: every suggestion has already been proven to close a fill
      // (closure test in closure.ts), so accepting them is safe. Bounded rounds
      // — bridging changes segmentation, which can surface further gaps.
      if (($<HTMLInputElement>('cBridge')).checked && view.paths.length && autoBridgeRounds < 3) {
        autoBridgeRounds++
        const n = view.paths.length
        while (view.paths.length) acceptSeg(0)
        status(`${m.regions.length} fills · auto-bridged ${n} gap${n > 1 ? 's' : ''}, re-flatting…`, true)
        runFlat(true)
      }
    }
  }
  const ink = doc.ink!.slice()
  const p = params()
  worker().postMessage({
    t: 'flat', line: line.buffer, ink: ink.buffer, W: doc.W, H: doc.H,
    maxGap: p.gap, minArea: p.min, sliverW: p.sag ? 0 : p.sliver,
    autoMerge: !p.sag && ($<HTMLInputElement>('cMerge')).checked,
    declutter: p.decl, sagTau: p.sag, hybrid: p.hybrid,
    segKey: `${doc.W}|${p.thr}|${p.smooth}|${p.gap}|${p.sat}|${strokesVersion}|${($<HTMLInputElement>('cSkel')).checked}|${p.sag}|${($<HTMLInputElement>('cGpu')).checked}|${p.hybrid}`,
    flowKey: `${doc.W}|${p.sat}`,
    useGpu: !p.sag && ($<HTMLInputElement>('cGpu')).checked,  // sag never reaches the GPU branch
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
    nr.deleted = or.deleted // a fill the user removed stays removed after a re-flat
  }
}

// ---------- groups ----------
// Rasterize a lasso: the closed polygon's interior PLUS the drawn path itself,
// so a stroke dragged *through* fills selects them just as an enclosing loop does.
function rasterizeLasso(path: number[]): Uint8Array {
  const cv = document.createElement('canvas')
  cv.width = doc.W; cv.height = doc.H
  const c = cv.getContext('2d')!
  c.fillStyle = '#fff'
  c.strokeStyle = '#fff'
  c.lineWidth = 3
  c.lineCap = c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(path[0], path[1])
  for (let i = 2; i < path.length; i += 2) c.lineTo(path[i], path[i + 1])
  c.closePath()
  c.fill()
  c.stroke()
  const d = c.getImageData(0, 0, doc.W, doc.H).data
  const m = new Uint8Array(doc.W * doc.H)
  for (let i = 0; i < m.length; i++) if (d[i * 4 + 3] > 64) m[i] = 1
  return m
}

// Recompute group membership from the stored lasso geometry. Called after every
// flat, which is what lets groups survive re-flatting even though a flat
// renumbers every region.
const GROUP_COVER = 0.25 // fraction of a fill that must fall inside the lasso
function assignGroups() {
  if (!doc.labels) return
  for (const r of doc.regions) if (r) r.group = 0
  if (!doc.groups.length) return
  const lut = doc.rootLut(), lb = doc.labels
  for (const g of doc.groups) {
    const mask = rasterizeLasso(g.path)
    const inside = new Map<number, number>(), total = new Map<number, number>()
    for (let i = 0; i < lb.length; i++) {
      const root = lut[lb[i]]
      if (!root) continue
      total.set(root, (total.get(root) ?? 0) + 1)
      if (mask[i]) inside.set(root, (inside.get(root) ?? 0) + 1)
    }
    for (const [root, n] of inside) {
      const r = doc.regions[root]
      if (!r || r.isBg || r.deleted) continue // never swallow the background
      if (n >= GROUP_COVER * (total.get(root) ?? 1)) r.group = g.id
    }
  }
}

function groupFromStroke(pts: number[]) {
  if (!doc.labels || pts.length < 6) return
  const name = prompt('Group name', 'Group ' + doc.nextGroup)
  if (!name) return
  const g = { id: doc.nextGroup++, name, path: pts }
  doc.groups.push(g)
  assignGroups()
  const n = doc.roots().filter(r => r.group === g.id).length
  if (!n) {
    doc.groups.pop(); doc.nextGroup--
    status('Group: the lasso caught no fills')
    return
  }
  pushUndo({ label: 'group', undo: () => { doc.groups.splice(doc.groups.indexOf(g), 1); assignGroups(); refreshView() } })
  refreshView()
  status(`Grouped ${n} fill${n > 1 ? 's' : ''} as "${name}" — exports as a PSD folder, and survives re-flatting`)
}

function deleteFill(id: number, x: number, y: number) {
  const r = doc.regions[id]
  if (!r || r.deleted) return
  const mark = { id: doc.nextEdit++, x, y }
  doc.deleteMarks.push(mark)
  r.deleted = true
  pushUndo({
    label: 'delete fill',
    undo: () => { doc.deleteMarks.splice(doc.deleteMarks.indexOf(mark), 1); r.deleted = false; refreshView() },
  })
  refreshView()
  status(`Deleted "${r.name}" — the ✖ marker survives re-flatting; ⬚ removes it`)
}

// Replay every remembered edit against the current regions. Called after each
// flat, which renumbers everything: merges first because they decide which
// roots exist, then deletions, then group membership. Deletion is rebuilt from
// scratch rather than carried over, so removing a mark genuinely un-deletes.
function replayEdits() {
  if (!doc.labels) return
  for (const s of doc.mergeStrokes) applyMergeStroke(s.pts)
  for (const p of doc.mergePairs) applyMergePair(p)
  for (const r of doc.regions) if (r) r.deleted = false
  for (const m of doc.deleteMarks) {
    const x = m.x | 0, y = m.y | 0
    if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) continue
    const r = doc.regions[doc.root(doc.labels[y * doc.W + x])]
    if (r) r.deleted = true
  }
  // Shapes stamp last: they overwrite the label map, so they must land on the
  // regions as they finally are rather than on ones a later merge would change.
  if (doc.shapeFills.length) {
    const line = currentLineMask()   // one mask for all of them, not one each
    for (const sf of doc.shapeFills) applyShapeFill(sf, line)
  }
  // Colours last of all, so they land on the regions as they finally are --
  // including the ones a shape fill just stamped over the top.
  for (const rc of doc.recolors) {
    const x = rc.x | 0, y = rc.y | 0
    if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) continue
    const r = doc.regions[doc.root(doc.labels[y * doc.W + x])]
    if (!r) continue
    r.color = rc.color
    if (rc.slot === null) delete r.swatch; else r.swatch = rc.slot
  }
  assignGroups()
}

// ---------- remembered colours ----------
// A recolour has to be replayable after a re-flat, which means it has to be
// stored as a place rather than as a region id. The place is the region's
// centroid, snapped to a pixel that is actually inside it: a crescent's
// centroid lands in the notch, and a point outside the shape would come back
// after re-flatting as whatever is now in the notch instead.
let anchorCache = new Map<number, [number, number]>()
let anchorKey = ''
function regionAnchor(id: number): [number, number] | null {
  if (!doc.labels) return null
  const { W, labels } = doc
  const lut = doc.rootLut()
  // Merging or re-flatting moves every boundary, so the cache is keyed on the
  // shape of the region tree rather than cleared by hand at each call site.
  const key = lut.join(',')
  if (key !== anchorKey) { anchorCache = new Map(); anchorKey = key }
  // Every root at once, in two passes over the image rather than two per
  // region: shift-clicking a shared colour recolours dozens of fills in one
  // go, and doing this per region would have made that a multi-second stall.
  if (!anchorCache.size) {
    const n = new Map<number, number>(), sx = new Map<number, number>(), sy = new Map<number, number>()
    for (let i = 0; i < labels.length; i++) {
      const r = lut[labels[i]]
      if (!r) continue
      n.set(r, (n.get(r) ?? 0) + 1)
      sx.set(r, (sx.get(r) ?? 0) + (i % W))
      sy.set(r, (sy.get(r) ?? 0) + ((i / W) | 0))
    }
    const cx = new Map<number, number>(), cy = new Map<number, number>(), bd = new Map<number, number>()
    for (const [r, c] of n) { cx.set(r, sx.get(r)! / c); cy.set(r, sy.get(r)! / c); bd.set(r, Infinity) }
    for (let i = 0; i < labels.length; i++) {
      const r = lut[labels[i]]
      if (!r) continue
      const x = i % W, y = (i / W) | 0
      const dx = x - cx.get(r)!, dy = y - cy.get(r)!, d = dx * dx + dy * dy
      if (d < bd.get(r)!) { bd.set(r, d); anchorCache.set(r, [x, y]) }
    }
  }
  return anchorCache.get(id) ?? null
}

// One record per region, found by asking which record's point still lands in
// it -- so recolouring the same area twice replaces the note rather than
// stacking a pile of them that all have to be replayed.
function recolorRecordFor(id: number): Recolor | undefined {
  if (!doc.labels) return undefined
  return doc.recolors.find(rc => {
    const x = rc.x | 0, y = rc.y | 0
    if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) return false
    return doc.root(doc.labels![y * doc.W + x]) === id
  })
}

// The single place a fill's colour is set by hand. Everything a user can do to
// colour a region goes through here, so the link to the swatch and the note
// that survives re-flatting can never be forgotten by one path and remembered
// by another.
function paintRegion(r: Region, rgb: [number, number, number], slot: number | null = curSwatch) {
  r.color = rgb
  if (slot === null) delete r.swatch; else r.swatch = slot
  const at = regionAnchor(r.id)
  if (!at) return
  const rec = recolorRecordFor(r.id)
  if (rec) { rec.color = rgb; rec.slot = slot; rec.x = at[0]; rec.y = at[1] }
  else doc.recolors.push({ id: doc.nextEdit++, x: at[0], y: at[1], slot, color: rgb })
}

// Stamp a hand-drawn shape into the label map as a region of its own. It is
// applied AFTER segmentation and overwrites whatever was underneath, because a
// shape the user drew deliberately outranks anything the segmenter inferred --
// which is the whole point of having the tool. Areas of the regions it covers
// are decremented so the panel keeps telling the truth.
function applyShapeFill(sf: ShapeFill, line = currentLineMask()): boolean {
  if (!doc.labels) return false
  const { W, H, labels } = doc
  const p = sf.pts
  if (p.length < 6) return false
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0))
  x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1))
  const id = doc.regions.length
  const reg: Region = { id, color: sf.color, name: sf.name, visible: true, parent: id, area: 0, isBg: false }
  doc.regions.push(reg)
  const lut = doc.rootLut()
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInPoly(x + 0.5, y + 0.5, p)) continue
      const i = y * W + x
      // Label every pixel, ink included, so the shape reads as a fill under the
      // line art like any other. Area is a count of FREE pixels only, which is
      // the convention finalizeRegions uses -- counting ink here would make the
      // panel's figures disagree with every other region's.
      if (!line[i]) {
        const prev = doc.regions[lut[labels[i]] ?? 0]
        if (prev && prev.id !== id) prev.area--
        reg.area++
      }
      labels[i] = id
    }
  }
  // Nothing stamped -- drawn off the image, or entirely on ink. Take the
  // region back out rather than leaving an empty one in the panel.
  if (!reg.area) { doc.regions.pop(); return false }
  return true
}

function shapeFillFromStroke(pts: number[]) {
  if (!doc.labels) return
  const sf: ShapeFill = {
    id: doc.nextEdit++, pts: pts.slice(), color: pickColor(),
    name: 'Shape ' + (doc.shapeFills.length + 1),
  }
  if (!applyShapeFill(sf)) { status('Shape fill: that shape covers no free pixels'); return }
  doc.shapeFills.push(sf)
  pushUndo({
    label: 'shape fill',
    undo: () => { doc.shapeFills.splice(doc.shapeFills.indexOf(sf), 1); setDirty(true); replayAndRefresh() },
  })
  rebuildFills(); rebuildPanel(); rebuildEditView()
  status(`Drew "${sf.name}" — it is a fill like any other, and survives re-flatting`)
}

// Shapes are stamped into the label map, so undoing one means rebuilding the
// map. Cheapest correct route is to re-run the replay from the last flat.
function replayAndRefresh() {
  replayEdits()
  rebuildFills(); rebuildPanel(); rebuildEditView()
}

// Re-run one two-click merge against whatever regions now sit under its two
// points. Silent when either point has landed on ink, off the image, or in the
// same region as the other: a re-flat can legitimately have joined them
// already, and there is nothing to do about that but leave it alone.
function applyMergePair(p: MergePair) {
  const at = (x: number, y: number): Region | null => {
    const ix = x | 0, iy = y | 0
    if (ix < 0 || iy < 0 || ix >= doc.W || iy >= doc.H) return null
    return doc.regions[doc.root(doc.labels![iy * doc.W + ix])] ?? null
  }
  const a = at(p.ax, p.ay), b = at(p.bx, p.by)
  if (!a || !b || a.id === b.id) return
  b.parent = a.id
  a.area += b.area
}

// ---------- remembered edits: overlay, picking, removal ----------
type EditKind = 'merge' | 'delete' | 'group'
interface EditRef { kind: EditKind; id: number; pts: number[]; label: string }
const selectedEdits = new Set<string>() // `${kind}:${id}`
const editKey = (h: { kind: EditKind; id: number }) => h.kind + ':' + h.id

function editList(): EditRef[] {
  const out: EditRef[] = []
  for (const s of doc.mergeStrokes) out.push({ kind: 'merge', id: s.id, pts: s.pts, label: 'draw merge' })
  // Same kind as a draw-merge: it is the same operation, drawn the same green,
  // and ids come from one counter so the keys stay unique across both lists.
  for (const p of doc.mergePairs) out.push({ kind: 'merge', id: p.id, pts: [p.ax, p.ay, p.bx, p.by], label: 'merge' })
  for (const m of doc.deleteMarks) out.push({ kind: 'delete', id: m.id, pts: [m.x, m.y], label: 'deleted fill' })
  for (const g of doc.groups) out.push({ kind: 'group', id: g.id, pts: g.path, label: `group "${g.name}"` })
  return out
}

function rebuildEditView() {
  view.showEdits = ($<HTMLInputElement>('cEdits')).checked
  view.edits = editList().map(h => ({ kind: h.kind, pts: h.pts, selected: selectedEdits.has(editKey(h)) }))
  // Auto-sealed gaps ride along in the same overlay but are not in editList, so
  // the picker never sees them: they are an output of segmentation, not an edit
  // to be removed. Switch the feature off if you don't want them.
  for (let i = 0; i < doc.closures.length; i += 4)
    view.edits.push({ kind: 'closure', pts: doc.closures.slice(i, i + 4), selected: false })
  view.render()
}

const pointInPoly = (x: number, y: number, p: number[]) => {
  let inside = false
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > y) !== (p[j + 1] > y) &&
        x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside
  }
  return inside
}

// Nearest edit within a constant on-screen radius. A group's interior counts as
// a hit, but scores worse than any actual line, so a merge stroke drawn inside
// a lasso is still the thing you pick when you click it.
function editAt(x: number, y: number): EditRef | null {
  const reach = 10 / view.scale
  let best: EditRef | null = null, bd = reach
  for (const h of editList()) {
    let d = Infinity
    if (h.kind === 'delete') d = Math.hypot(h.pts[0] - x, h.pts[1] - y)
    else {
      for (let i = 0; i + 3 < h.pts.length; i += 2) d = Math.min(d, distToSeg(x, y, h.pts[i], h.pts[i + 1], h.pts[i + 2], h.pts[i + 3]))
      if (h.kind === 'group' && h.pts.length >= 6) {
        d = Math.min(d, distToSeg(x, y, h.pts[h.pts.length - 2], h.pts[h.pts.length - 1], h.pts[0], h.pts[1]))
        if (d > reach && pointInPoly(x, y, h.pts)) d = reach * 0.99
      }
    }
    if (d < bd) { bd = d; best = h }
  }
  return best
}

function pickEdit(x: number, y: number, additive: boolean) {
  const h = editAt(x, y)
  if (!h) { if (!additive) { selectedEdits.clear(); rebuildEditView(); status('') } return }
  const k = editKey(h)
  if (!additive) selectedEdits.clear()
  if (selectedEdits.has(k)) selectedEdits.delete(k); else selectedEdits.add(k)
  rebuildEditView()
  status(selectedEdits.size
    ? `${selectedEdits.size} edit${selectedEdits.size > 1 ? 's' : ''} selected (${h.label}) — Delete removes, Shift-click adds`
    : '')
}

function boxSelectEdits(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
  if (!additive) selectedEdits.clear()
  for (const h of editList()) {
    for (let i = 0; i < h.pts.length; i += 2) {
      if (h.pts[i] >= x0 && h.pts[i] <= x1 && h.pts[i + 1] >= y0 && h.pts[i + 1] <= y1) { selectedEdits.add(editKey(h)); break }
    }
  }
  rebuildEditView()
  status(selectedEdits.size ? `${selectedEdits.size} edit${selectedEdits.size > 1 ? 's' : ''} selected — Delete removes` : 'Nothing in the box')
}

function deleteSelectedEdits() {
  if (!selectedEdits.size) return
  const keys = new Set(selectedEdits)
  const prev = { m: doc.mergeStrokes.slice(), p: doc.mergePairs.slice(), d: doc.deleteMarks.slice(), g: doc.groups.slice() }
  doc.mergeStrokes = doc.mergeStrokes.filter(s => !keys.has('merge:' + s.id))
  doc.mergePairs = doc.mergePairs.filter(p => !keys.has('merge:' + p.id))
  doc.deleteMarks = doc.deleteMarks.filter(m => !keys.has('delete:' + m.id))
  doc.groups = doc.groups.filter(g => !keys.has('group:' + g.id))
  const droppedMerge = prev.m.length !== doc.mergeStrokes.length || prev.p.length !== doc.mergePairs.length
  selectedEdits.clear()
  pushUndo({
    label: 'remove edits',
    undo: () => {
      doc.mergeStrokes = prev.m; doc.mergePairs = prev.p; doc.deleteMarks = prev.d; doc.groups = prev.g
      restoreAfterEditChange(droppedMerge)
    },
  })
  restoreAfterEditChange(droppedMerge)
  status(`Removed ${keys.size} edit${keys.size > 1 ? 's' : ''}` +
    (droppedMerge ? ' — Re-Flat to un-merge the fills a removed stroke had joined' : ''))
}

// Deletions and groups are pure labels on the current regions, so dropping one
// takes effect at once. A merge already collapsed two regions into one and
// there is no record of the boundary any more, so undoing it needs the
// segmentation rebuilt: flag the document instead of pretending.
function restoreAfterEditChange(needsReflat: boolean) {
  for (const r of doc.regions) if (r) r.deleted = false
  if (doc.labels) {
    for (const m of doc.deleteMarks) {
      const x = m.x | 0, y = m.y | 0
      if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) continue
      const r = doc.regions[doc.root(doc.labels[y * doc.W + x])]
      if (r) r.deleted = true
    }
  }
  assignGroups()
  if (needsReflat) setDirty(true)
  refreshView()
}

// ---------- palette quantization ----------
// Adjacency of merged (root) regions, from the label map. Only boundary pixels
// contribute, so this is much cheaper than it looks.
function regionAdjacency(): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>()
  const lut = doc.rootLut(), lb = doc.labels!, { W, H } = doc
  const add = (a: number, b: number) => {
    let s = adj.get(a)
    if (!s) adj.set(a, s = new Set())
    s.add(b)
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = lut[lb[i]]
      if (!a) continue
      if (x < W - 1) { const b = lut[lb[i + 1]]; if (b && b !== a) { add(a, b); add(b, a) } }
      if (y < H - 1) { const b = lut[lb[i + W]]; if (b && b !== a) { add(a, b); add(b, a) } }
    }
  }
  return adj
}

// Recolor every fill from a K-colour palette by greedy graph colouring, so no
// two touching fills ever share a colour. Without that constraint quantization
// would visually merge neighbours and collapse them into one export layer.
// Largest regions are coloured first (they have the most neighbours to satisfy).
// K = 0 restores a unique colour per fill.
// A colour per fill, from the fill's own anchor. Every root gets one, so this
// is also the only place the "unique colour per fill" palette is produced.
function applyAutoColors() {
  if (!doc.labels) return
  for (const r of doc.roots()) {
    const at = regionAnchor(r.id)
    if (at) r.color = anchorColor(at[0], at[1])
  }
}

function applyPalette(K: number) {
  if (!doc.labels) return
  const roots = doc.roots()
  if (!K) { applyAutoColors(); return }
  const adj = regionAdjacency()
  const idx = new Map<number, number>()
  for (const r of roots) {
    const nbrs = adj.get(r.id)
    const used = new Set<number>()
    if (nbrs) for (const n of nbrs) { const c = idx.get(n); if (c !== undefined) used.add(c) }
    let pick = -1
    for (let c = 0; c < K; c++) if (!used.has(c)) { pick = c; break }
    if (pick < 0) {
      // every palette entry clashes (K too small here): take the one used by
      // the fewest neighbours so the collision is least visible
      const count = new Int32Array(K)
      if (nbrs) for (const n of nbrs) { const c = idx.get(n); if (c !== undefined) count[c]++ }
      pick = 0
      for (let c = 1; c < K; c++) if (count[c] < count[pick]) pick = c
    }
    idx.set(r.id, pick)
    r.color = paletteColor(pick)
  }
}

function afterModelChange() {
  selected = 0
  refreshView()
}

// Everything the canvas and panel show, without disturbing the selection.
function refreshView() {
  rebuildFills()
  rebuildPanel()
  rebuildEditView()
}

// ---------- tools ----------
function setTool(t: Tool) {
  view.tool = t
  mergeFirst = null
  view.mergeAnchor = null
  for (const [id, tt] of [['tPan', 'pan'], ['tFill', 'fill'], ['tRecolor', 'recolor'], ['tBarrier', 'barrier'], ['tEraser', 'eraser'], ['tMerge', 'merge'], ['tDraw', 'dmerge'], ['tDel', 'delfill'], ['tGroup', 'group'], ['tShape', 'shape'], ['tPick', 'pick']] as const)
    $(id).classList.toggle('active', tt === t)
  // picking edits you cannot see would be a guessing game
  if (t === 'pick' && !($<HTMLInputElement>('cEdits')).checked) ($<HTMLInputElement>('cEdits')).checked = true
  if (t !== 'pick' && selectedEdits.size) selectedEdits.clear()
  rebuildEditView()
}

view.onClick = (fx, fy, e) => {
  const x = fx | 0, y = fy | 0
  // the picker works on the overlay, not the fills, so it runs before the
  // bounds/label checks and before gap acceptance
  if (view.tool === 'pick') { pickEdit(fx, fy, e.shiftKey); return }
  if (x < 0 || y < 0 || x >= doc.W || y >= doc.H) return
  // accepting a gap suggestion works with any tool
  if (view.paths.length && acceptSegNear(fx, fy)) return
  if (!doc.labels) return
  const id = doc.root(doc.labels[y * doc.W + x])
  if (!id) return
  const r = doc.regions[id]
  if (view.tool === 'delfill') { deleteFill(id, fx, fy); return }
  // Recolour, and only recolour. The bucket carves a new fill out of the
  // background when you click it, which is right while you are still fixing the
  // flatting and wrong once you are painting: at that point a stray click on
  // the paper should change a colour, not the segmentation.
  if (view.tool === 'recolor') {
    // Picking up a fill's colour picks up its swatch link too, so the next
    // thing you paint joins the same group rather than quietly leaving it.
    if (e.altKey) { curSwatch = r.swatch ?? null; setCurHex(rgbToHex(r.color)); repaintPalette(); return }
    const c = hexToRgb(curHex())
    // Shift takes every fill wearing the same colour -- the whole point of
    // flatting from a palette is that a tone is shared, so changing one's mind
    // about it should not mean hunting down forty regions.
    const same = e.shiftKey ? rgbToHex(r.color).toLowerCase() : null
    const hit = doc.roots().filter(t => !t.deleted && (same ? rgbToHex(t.color).toLowerCase() === same : t.id === id))
    if (!hit.length) return
    const prev = hit.map(t => ({ color: t.color, swatch: t.swatch }))
    for (const t of hit) { paintRegion(t, c); t.visible = true }
    pushUndo({ label: same ? `recolor ${hit.length} fills` : 'recolor',
               undo: () => { hit.forEach((t, i) => paintRegion(t, prev[i].color, prev[i].swatch ?? null))
                             rebuildFills(); rebuildPanel() } })
    selected = id
    rebuildFills(); rebuildPanel()
    if (same) status(`Recolored ${hit.length} fills`)
    return
  }
  if (view.tool === 'fill') {
    if (e.altKey) { ($('curColor') as HTMLInputElement).value = rgbToHex(r.color); return }
    if (r.isBg) { carveAt(y * doc.W + x); return }
    const prev = r.color, prevSlot = r.swatch ?? null
    // A random colour is nobody's swatch, so the bucket only claims the link
    // when it is actually painting the current colour.
    const rand = ($<HTMLInputElement>('cRand')).checked
    paintRegion(r, pickColor(), rand ? null : curSwatch)
    r.visible = true
    pushUndo({ label: 'recolor', undo: () => { paintRegion(r, prev, prevSlot); rebuildFills(); rebuildPanel() } })
    selected = id
    rebuildFills(); rebuildPanel()
  } else if (view.tool === 'merge') {
    if (!mergeFirst) {
      mergeFirst = { id, x, y }
      view.mergeAnchor = [x, y]
      selected = id; rebuildPanel(); view.render()
      status(`Merge: now click the region to merge into "${r.name}" — Esc, right-click or a click off the canvas cancels`)
    } else if (mergeFirst.id !== id) {
      const a = doc.regions[mergeFirst.id], b = r
      b.parent = a.id
      a.area += b.area
      // Remembered as the two points, so a re-flat can find the regions again.
      const pair = { id: doc.nextEdit++, ax: mergeFirst.x, ay: mergeFirst.y, bx: x, by: y }
      doc.mergePairs.push(pair)
      pushUndo({ label: 'merge', undo: () => {
        doc.mergePairs.splice(doc.mergePairs.indexOf(pair), 1)
        b.parent = b.id; a.area -= b.area; rebuildFills(); rebuildPanel(); rebuildEditView()
      } })
      mergeFirst = null
      view.mergeAnchor = null
      status(`Merged "${b.name}" into "${a.name}" — survives re-flatting; ⬚ removes it`)
      rebuildFills(); rebuildPanel(); rebuildEditView()
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
  worker().onmessage = ev => {
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
  worker().postMessage({ t: 'carve', core: coreCopy.buffer, line: line.buffer, ink: inkCopy.buffer, W: doc.W, H: doc.H, idx, r: params().gap, token: tk }, [coreCopy.buffer, line.buffer, inkCopy.buffer])
}

view.onBox = (x0, y0, x1, y1, additive) => { if (view.tool === 'pick') boxSelectEdits(x0, y0, x1, y1, additive) }

// Esc / right-click / a click off the canvas: drop the armed merge.
view.onCancel = () => {
  if (!mergeFirst) return
  mergeFirst = null
  selected = 0
  rebuildPanel()
  status('Merge cancelled')
}

view.onStroke = pts => {
  if (!doc.src) return
  if (view.tool === 'group') { groupFromStroke(pts); return }
  if (view.tool === 'shape') { shapeFillFromStroke(pts); return }
  if (view.tool === 'dmerge') { mergeAlongStroke(pts); return }
  if (view.tool !== 'barrier' && view.tool !== 'eraser') return
  const s: Stroke = { pts, mode: view.tool === 'eraser' ? 'erase' : 'draw' }
  doc.strokes.push(s)
  pushUndo({ label: 'barrier', undo: () => { doc.strokes.splice(doc.strokes.indexOf(s), 1); rasterizeBarriers(); setDirty(true) } })
  rasterizeBarriers()
  setDirty(true)
}

// Draw merge: every fill the stroke crosses merges into the fill under its
// start. Recorded as the stroke, so replayEdits() can run it again against the
// renumbered regions after a re-flat.
function mergeAlongStroke(pts: number[]) {
  const res = applyMergeStroke(pts)
  if (typeof res === 'string') { status('Draw merge: ' + res); return }
  const s = { id: doc.nextEdit++, pts }
  doc.mergeStrokes.push(s)
  pushUndo({
    label: 'draw merge',
    undo: () => {
      doc.mergeStrokes.splice(doc.mergeStrokes.indexOf(s), 1)
      for (const r of res.merged) { r.parent = r.id; res.into.area -= r.area }
      refreshView()
    },
  })
  selected = res.into.id
  refreshView()
  status(`Merged ${res.merged.length} fill${res.merged.length > 1 ? 's' : ''} into "${res.into.name}"`)
}

// The merge itself, with no bookkeeping: returns what it did, or why it didn't.
function applyMergeStroke(pts: number[]): { into: Region; merged: Region[] } | string {
  if (!doc.labels) return 'no fills yet'
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
  if (!start) return 'stroke missed every fill'
  const a = doc.regions[start]
  if (!a || a.isBg) return 'start the stroke on a fill, not the background'
  const merged: Region[] = []
  for (const cid of crossed) {
    const r = doc.regions[cid]
    if (!r || r.isBg) continue
    r.parent = start
    a.area += r.area
    merged.push(r)
  }
  if (!merged.length) return 'stroke crossed no other fills'
  return { into: a, merged }
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
  worker().onmessage = ev => {
    const m = ev.data
    if (m.token !== tk) return
    setBusy(false)
    renderPreview(new Int32Array(m.labels), m.regions, W4, H4)
  }
  worker().postMessage({
    t: 'flat', line: line4.buffer, ink: ink4.buffer, W: W4, H: H4,
    maxGap: Math.max(1, Math.round(p.gap / 4)), minArea: Math.max(4, Math.round(p.min / 16)),
    sliverW: p.sag ? 0 : Math.round(p.sliver / 4), autoMerge: !p.sag && ($<HTMLInputElement>('cMerge')).checked,
    declutter: p.decl, sagTau: p.sag ? Math.max(1, p.sag / 4) : 0,
    // No tight-closing in the preview: at quarter res the gaps it targets are
    // 1-2px wide, so the answer would not resemble the full-res one.
    segKey: `pv|${W4}|${p.thr}|${p.smooth}|${p.gap}|${p.sat}|${strokesVersion}|${($<HTMLInputElement>('cSkel')).checked}|${p.sag}`,
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
  worker().onmessage = ev => {
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
  worker().postMessage({
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
  worker().onmessage = ev => {
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
  worker().postMessage({ t: 'gaps', line: line.buffer, ink: ink.buffer, W: doc.W, H: doc.H, maxGap: params().gap, labels: labels?.buffer ?? null, method, token: tk },
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
// Decode to something drawable. Safari only gained createImageBitmap in 15 and
// still rejects some blobs, so fall back to decoding through an <img>.
async function decodeImage(f: File): Promise<{ src: CanvasImageSource; w: number; h: number; release(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(f)
      return { src: b, w: b.width, h: b.height, release: () => b.close?.() }
    } catch { /* fall through to the <img> path */ }
  }
  const url = URL.createObjectURL(f)
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error(`the browser could not decode "${f.name}"`))
      img.src = url
    })
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

async function openFile(f: File) {
  try {
    await loadFile(f)
  } catch (e: any) {
    setBusy(false)
    status('Could not open: ' + (e?.message ?? e))
    console.error('openFile failed', e)
  }
}

async function loadFile(f: File) {
  status('Opening…', true)
  const img = await decodeImage(f)
  if (!img.w || !img.h) throw new Error(`"${f.name}" has no image data`)
  doc.W = img.w; doc.H = img.h
  doc.name = f.name.replace(/\.[^.]+$/, '')
  doc.src = document.createElement('canvas')
  doc.src.width = doc.W; doc.src.height = doc.H
  const sctx = doc.src.getContext('2d')
  if (!sctx) throw new Error('could not get a 2D canvas context')
  sctx.drawImage(img.src, 0, 0)
  img.release()
  // Safari caps canvas area (~16.7MP on iOS); over it getImageData yields blank
  // or throws, so say so plainly instead of flatting an empty image.
  let pixels: ImageData
  try {
    pixels = sctx.getImageData(0, 0, doc.W, doc.H)
  } catch {
    throw new Error(`${doc.W}×${doc.H} is too large for this browser's canvas — try a smaller image`)
  }
  doc.ink = extractInk(pixels, params().sat)
  doc.core = doc.labels = null
  doc.sag = null; doc.sagMax = 0   // stale field would be the previous image's size
  doc.closures = []
  sagCv = ridgeCv = view.sagCv = view.ridgeCv = null
  sagLabel()
  doc.regions = []
  doc.strokes = []
  doc.groups = []
  doc.nextGroup = 1
  doc.mergeStrokes = []
  doc.mergePairs = []
  doc.shapeFills = []
  doc.recolors = []
  doc.deleteMarks = []
  doc.nextEdit = 1
  anchorCache = new Map(); anchorKey = ''
  curSwatch = null
  selectedEdits.clear()
  view.edits = []
  doc.barrierMask = new Uint8Array(doc.W * doc.H)
  undoStack.length = 0
  resetAutoBridge()
  view.paths = []
  fillsCv = document.createElement('canvas'); fillsCv.width = doc.W; fillsCv.height = doc.H
  fillsCtx = fillsCv.getContext('2d')!
  fillsImg = new ImageData(doc.W, doc.H)
  lineCv = document.createElement('canvas'); lineCv.width = doc.W; lineCv.height = doc.H
  barrierCv = document.createElement('canvas'); barrierCv.width = doc.W; barrierCv.height = doc.H
  barrierCtx = barrierCv.getContext('2d')!
  // Min region is left alone on open. It used to be rewritten to a
  // resolution-scaled value (>= 50 px²) every time a file loaded, which quietly
  // overrode the 0 default and any figure the user had dialled in.
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
  // Layers come out in the panel's order. Reversed, because a PSD stacks
  // bottom-first while Photoshop's layer list reads top-first: without the
  // reverse, the fill at the top of this app's list lands at the bottom of
  // theirs. Flats never overlap, so the order is organisation, not compositing.
  const regions: ExportRegion[] = sortedRoots().reverse().map(r => ({
    id: r.id, color: r.color, name: r.name, hidden: !r.visible, isBg: r.isBg,
    group: r.group ? doc.groups.find(g => g.id === r.group)?.name : undefined,
  }))
  const mode = ($('expMode') as HTMLSelectElement).value as ExportMode

  // Watercolor costs a full-size textured buffer per layer, so the layer count
  // stops being a matter of taste and starts being whether the file opens at
  // all. Warn and let it through rather than clamp: a hundred washes may be
  // exactly what a big drawing needs, and the only person who knows is the one
  // about to wait for it. Saying no here would just move the work off the tool.
  const wc = wcOn()
  if (wc) {
    const n = layerCount(regions, mode)
    const max = Math.max(1, +$<HTMLInputElement>('nWcMax').value || 30)
    if (n > max && !confirm(
      `Watercolor would paint ${n} textured layers (limit ${max}).\n\n` +
      `Each one is a full ${doc.W}×${doc.H} image, so the PSD will be large and may be slow ` +
      `or impossible to open. Switching export to "one layer per color" is usually the better answer.\n\n` +
      `Export ${n} layers anyway?`)) { status(`Export cancelled — ${n} watercolor layers, limit ${max}`); return }
  }

  status('Exporting…', true)
  await new Promise(r => setTimeout(r))
  const blob = new Blob([exportPsd(doc.W, doc.H, doc.labels, doc.rootLut(), regions, doc.ink!, mode,
                                   wc ? wcParams : null)], { type: 'image/vnd.adobe.photoshop' })
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
$('bFlat').onclick = () => { resetAutoBridge(); runFlat(false) }
$('bReflat').onclick = () => { resetAutoBridge(); runFlat(true) }
$('bCluster').onclick = clusterSmall
$('bGaps').onclick = suggestGapsNow
$('bAcceptAll').onclick = () => {
  while (view.paths.length) acceptSeg(0)
  view.render()
  runFlat(true)
}
$('bExport').onclick = doExport
// ---------- palette ----------
// A colourist works from a set of colours, not from a picker: the point is that
// the same skin tone lands on every skin fill. Swatches persist across sessions,
// because a palette outlives the drawing it was built for.
const PAL_KEY = 'autoflats.palette'
const PAL_SLOTS = 40 // 5 rows of 8
const isHex = (h: unknown): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h)
const curHex = () => ($('curColor') as HTMLInputElement).value.toLowerCase()
// writeCur only moves the colour well; setCurHex also drags the R/G/B/H/S/L
// sliders along. They are split because the sliders themselves call writeCur,
// and a slider that rewrites its own value mid-drag snaps and jitters.
const writeCur = (hex: string) => { ($('curColor') as HTMLInputElement).value = hex; view.shapePreview = shapeTint() }
const setCurHex = (hex: string) => { writeCur(hex); syncSliders(hex) }
// Which slot the sliders are editing. Null once its colour is gone.
let palSel: number | null = null
// Which slot the CURRENT colour came from, if any. This is what makes a fill
// painted from the palette stay attached to it: the link is recorded at the
// moment of painting, so a colour typed into the well never claims to be a
// swatch and a swatch never loses track of what it painted.
let curSwatch: number | null = null

// Pad or trim to the grid. Older versions stored a dense array of colours with
// no holes, and that reads correctly here as "the first N slots are filled".
const normalizePalette = (list: unknown[]): (string | null)[] =>
  Array.from({ length: PAL_SLOTS }, (_, i) => (isHex(list[i]) ? (list[i] as string).toLowerCase() : null))

function loadPalette() {
  try {
    const raw = localStorage.getItem(PAL_KEY)
    doc.palette = normalizePalette(raw ? JSON.parse(raw) : [])
  } catch { doc.palette = normalizePalette([]) /* absent or corrupt */ }
}
function savePalette() {
  try { localStorage.setItem(PAL_KEY, JSON.stringify(doc.palette)) } catch { /* private mode */ }
}
function repaintPalette() { savePalette(); rebuildPalette(); rebuildPalGrid() }

// The menu strip: quick access, filled slots only. The grid in the panel is
// where a palette is built; this is where it gets used.
function rebuildPalette() {
  const bar = $('pal')
  bar.innerHTML = ''
  doc.palette.forEach((hex, i) => {
    if (!hex) return
    const sw = document.createElement('i')
    sw.style.background = hex
    sw.title = hex
    if (palSel === i) sw.className = 'cur'
    sw.onclick = e => {
      if (e.altKey) { removeSwatch(hex); return }
      palSel = i; curSwatch = i
      setCurHex(hex)
      applyColorToSelection(hexToRgb(hex))
      repaintPalette()
    }
    sw.oncontextmenu = e => { e.preventDefault(); removeSwatch(hex) }
    bar.append(sw)
  })
}

// Press-and-hold, because a tablet has no ⌥ and no right button, and a palette
// you can fill but not empty fills up. 550ms and an 8px slop: long enough not
// to fire on a tap, short enough not to feel broken.
const LONG_PRESS = 550
let lpFired = false
// Lifting after a hold still sends a click, and by then the swatch under the
// finger is an EMPTY slot -- which would take the current colour and undo the
// deletion on the spot. So the flag is cleared once per press, on the grid
// itself in the capture phase, and every click handler in the grid honours it.
$('palGrid').addEventListener('pointerdown', () => { lpFired = false }, true)
function onLongPress(el: HTMLElement, run: () => void) {
  let t = 0, sx = 0, sy = 0
  const stop = () => { clearTimeout(t); t = 0 }
  el.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY
    t = window.setTimeout(() => { lpFired = true; stop(); run() }, LONG_PRESS)
  })
  el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) stop() })
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop)
}

// The grid. Every slot exists whether or not it holds a colour, because an
// empty slot is the affordance: tapping one is how a palette gets built.
function rebuildPalGrid() {
  const g = $('palGrid')
  g.innerHTML = ''
  doc.palette.forEach((hex, i) => {
    const sw = document.createElement('i')
    if (hex) {
      sw.style.background = hex
      sw.title = hex + ' — click to use; ⌥-click, right-click or hold to empty'
      // Selection is by SLOT, not by colour: two slots can hold the same
      // colour, and the sliders have to know which one they are editing.
      if (palSel === i) sw.className = 'cur'
      // Emptying a slot must not leave fills pointing at a colour that is no
      // longer in the palette: they keep the colour they are wearing and
      // simply stop following anything.
      const clear = () => {
        doc.palette[i] = null
        if (palSel === i) palSel = null
        if (curSwatch === i) curSwatch = null
        for (const t of doc.regions) if (t && t.swatch === i) delete t.swatch
        for (const rc of doc.recolors) if (rc.slot === i) rc.slot = null
        repaintPalette()
      }
      sw.onclick = e => {
        if (lpFired) return // the hold already emptied it
        if (e.altKey) { clear(); return }
        palSel = i; curSwatch = i
        setCurHex(hex)
        applyColorToSelection(hexToRgb(hex))
        repaintPalette()
      }
      sw.oncontextmenu = e => { e.preventDefault(); clear() }
      onLongPress(sw, () => { clear(); status('Swatch removed') })
    } else {
      sw.className = 'mt'
      sw.title = 'Empty — click to drop the current color in'
      // Takes the current colour rather than opening a picker. Choosing a
      // colour is what the well and the sliders are for; this is the act of
      // keeping one, and it should cost a single tap.
      sw.onclick = () => {
        if (lpFired) return // this click is the tail of a hold that just emptied this slot
        doc.palette[i] = curHex(); palSel = i; curSwatch = i; repaintPalette()
      }
    }
    g.append(sw)
  })
}

// ---------- the R/G/B/H/S/L sliders ----------
// Two views of one colour. Whichever set is being dragged is the authority,
// and only the other set is rewritten -- rewriting a slider from a value it
// just produced makes it stick and jump, because the round trip rounds.
const SL = (id: string) => $<HTMLInputElement>(id)
function syncSliders(hex: string) {
  const [r, g, b] = hexToRgb(hex)
  SL('sPR').value = '' + r; SL('sPG').value = '' + g; SL('sPB').value = '' + b
  const [h, s, l] = rgbToHsl([r, g, b])
  SL('sPH').value = '' + Math.round(h); SL('sPS').value = '' + Math.round(s * 100); SL('sPL').value = '' + Math.round(l * 100)
  labelSliders()
}
function labelSliders() {
  $('vPR').textContent = SL('sPR').value
  $('vPG').textContent = SL('sPG').value
  $('vPB').textContent = SL('sPB').value
  $('vPH').textContent = SL('sPH').value + '°'
  $('vPS').textContent = SL('sPS').value + '%'
  $('vPL').textContent = SL('sPL').value + '%'
}
// A drag is one undo step, not one per pixel of travel: the region's colour is
// updated live on every input, and the undo entry is pushed once, on release.
let sliderUndo: { r: Region; color: [number, number, number] }[] | null = null
function slidersChanged(rgb: [number, number, number]) {
  const hex = rgbToHex(rgb)
  writeCur(hex)
  if (palSel === null || !doc.palette[palSel]) { labelSliders(); return }
  doc.palette[palSel] = hex
  savePalette(); rebuildPalette(); rebuildPalGrid()
  // Every fill painted from this swatch follows it. That is the point of the
  // link: a colourist changes their mind about a tone, not about the forty
  // places it was used.
  const linked = doc.roots().filter(r => !r.deleted && r.swatch === palSel)
  if (linked.length) {
    if (!sliderUndo) sliderUndo = linked.map(r => ({ r, color: r.color }))
    for (const r of linked) paintRegion(r, rgb, palSel)
    rebuildFills(); rebuildPanel()
  }
  labelSliders()
}
for (const id of ['sPR', 'sPG', 'sPB']) SL(id).oninput = () => {
  const rgb: [number, number, number] = [+SL('sPR').value, +SL('sPG').value, +SL('sPB').value]
  const [h, s, l] = rgbToHsl(rgb)
  SL('sPH').value = '' + Math.round(h); SL('sPS').value = '' + Math.round(s * 100); SL('sPL').value = '' + Math.round(l * 100)
  slidersChanged(rgb)
}
for (const id of ['sPH', 'sPS', 'sPL']) SL(id).oninput = () => {
  const rgb = hslToRgb(+SL('sPH').value, +SL('sPS').value / 100, +SL('sPL').value / 100)
  SL('sPR').value = '' + rgb[0]; SL('sPG').value = '' + rgb[1]; SL('sPB').value = '' + rgb[2]
  slidersChanged(rgb)
}
for (const id of ['sPR', 'sPG', 'sPB', 'sPH', 'sPS', 'sPL']) SL(id).onchange = () => {
  const u = sliderUndo
  sliderUndo = null
  if (u?.length) pushUndo({ label: u.length > 1 ? `recolor ${u.length} fills` : 'recolor',
    undo: () => { for (const e of u) paintRegion(e.r, e.color, e.r.swatch ?? null); rebuildFills(); rebuildPanel() } })
}
const removeSwatch = (hex: string) => {
  doc.palette = doc.palette.map(h => (h === hex ? null : h))
  if (palSel !== null && !doc.palette[palSel]) palSel = null
  repaintPalette()
}
// First free slot, so "+" and the eyedropper have somewhere obvious to go.
function addSwatch(hex: string) {
  hex = hex.toLowerCase()
  if (doc.palette.includes(hex)) return
  const i = doc.palette.indexOf(null)
  if (i < 0) { status('Palette is full — empty a slot first (⌥-click it)'); return }
  doc.palette[i] = hex
  repaintPalette()
}
// Clicking a swatch recolours the selected fill straight away -- otherwise you
// would pick a colour and then still have to go and apply it.
function applyColorToSelection(c: [number, number, number]) {
  const r = doc.regions[doc.root(selected)]
  if (!r || r.deleted) return
  const prev = r.color, prevSlot = r.swatch ?? null
  paintRegion(r, c)
  pushUndo({ label: 'recolor', undo: () => { paintRegion(r, prev, prevSlot); rebuildFills(); rebuildPanel() } })
  rebuildFills(); rebuildPanel()
}
$('bPalAdd').onclick = () => addSwatch(curHex())
$('bPalPull').onclick = () => {
  // Order by area so the palette reads big-shapes-first rather than by id.
  const seen = new Set<string>()
  const used = doc.roots().filter(r => !r.deleted && !r.isBg)
    .map(r => rgbToHex(r.color).toLowerCase())
    .filter(h => !seen.has(h) && seen.add(h))
  doc.palette = normalizePalette(used)
  palSel = null
  repaintPalette()
  status(`Palette: ${Math.min(used.length, PAL_SLOTS)} colors from the current fills` +
         (used.length > PAL_SLOTS ? ` (${used.length - PAL_SLOTS} more did not fit)` : ''))
}
$('bPalClear').onclick = () => { doc.palette = normalizePalette([]); palSel = null; repaintPalette() }

// A palette outlives the app it was made in, so it has to be a file. Written as
// plain JSON; read back from anything with #rrggbb in it, which covers our own
// files and a GIMP/Krita .gpl without needing a parser per format.
$('bPalSave').onclick = () => {
  const colors = doc.palette.filter(Boolean)
  if (!colors.length) { status('Palette is empty — nothing to download'); return }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ name: 'autoFlats palette', colors }, null, 2)],
    { type: 'application/json' }))
  a.download = 'palette.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
$('bPalLoad').onclick = () => $<HTMLInputElement>('palFile').click()
$<HTMLInputElement>('palFile').onchange = async e => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  ;(e.target as HTMLInputElement).value = '' // so re-picking the same file fires again
  const text = await f.text()
  let found: string[] = []
  try {
    const j = JSON.parse(text)
    found = (Array.isArray(j) ? j : j.colors ?? []).filter(isHex)
  } catch { /* not ours: fall through to scraping */ }
  if (!found.length) found = (text.match(/#[0-9a-fA-F]{6}\b/g) ?? [])
  const seen = new Set<string>()
  found = found.map(h => h.toLowerCase()).filter(h => !seen.has(h) && seen.add(h))
  if (!found.length) { status(`No colors found in ${f.name}`); return }
  doc.palette = normalizePalette(found)
  palSel = null
  repaintPalette()
  status(`Palette: ${Math.min(found.length, PAL_SLOTS)} colors from ${f.name}`)
}

// The reference image. Not a palette of swatches but a picture to pick out of,
// which is how most colourists actually choose: from a photo, a colour script
// or a frame of the film, not from a grid.
const refCv = $<HTMLCanvasElement>('refCv')
let refData: ImageData | null = null
async function setReference(src: Blob | File) {
  const bmp = await createImageBitmap(src)
  // Fit the panel width; the picked colour comes from these pixels, so a
  // downscale is a slight blur of the source -- fine for choosing a tone.
  const w = Math.min(bmp.width, 320), h = Math.max(1, Math.round(bmp.height * w / bmp.width))
  refCv.width = w; refCv.height = h
  const c = refCv.getContext('2d')!
  // On white, because a transparent PNG otherwise reads as pure black wherever
  // there is nothing -- and the colour you see is the colour you must get.
  c.fillStyle = '#fff'
  c.fillRect(0, 0, w, h)
  c.drawImage(bmp, 0, 0, w, h)
  refData = c.getImageData(0, 0, w, h)
  bmp.close()
  $('refWrap').classList.add('has')
}
function pickFromReference(e: PointerEvent) {
  if (!refData) return
  const r = refCv.getBoundingClientRect()
  const x = Math.round((e.clientX - r.left) * refCv.width / r.width)
  const y = Math.round((e.clientY - r.top) * refCv.height / r.height)
  if (x < 0 || y < 0 || x >= refCv.width || y >= refCv.height) return
  const o = (y * refCv.width + x) * 4, d = refData.data
  curSwatch = null
  setCurHex(rgbToHex([d[o], d[o + 1], d[o + 2]]))
  rebuildPalette(); rebuildPalGrid()
}
refCv.onpointerdown = e => {
  try { refCv.setPointerCapture(e.pointerId) } catch { /* stale pointer */ }
  pickFromReference(e)
}
// Dragging scrubs the colour, so a tone can be hunted for rather than hit.
refCv.onpointermove = e => { if (e.buttons) pickFromReference(e) }
// Double-click sends it to the palette: picking and keeping are different acts.
refCv.ondblclick = () => addSwatch(curHex())
$('refWrap').ondragover = e => e.preventDefault()
$('refWrap').ondrop = e => {
  e.preventDefault(); e.stopPropagation() // the whole window is a line-art drop target
  const f = e.dataTransfer?.files?.[0]
  if (f?.type.startsWith('image/')) setReference(f)
}
// Paste anywhere, but only while the palette panel is open -- otherwise a paste
// meant for a rename field would be swallowed by an invisible image slot.
addEventListener('paste', e => {
  if ($('palPanel').hidden) return
  for (const it of e.clipboardData?.items ?? []) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) { e.preventDefault(); setReference(f); status('Reference image pasted — click it to pick colors') }
      return
    }
  }
})

// The well chooses a colour; it does not touch a swatch or a fill. That is the
// division: the well is what you are about to paint with, the sliders adjust
// the swatch you have selected.
$('curColor').oninput = () => { curSwatch = null; syncSliders(curHex()); rebuildPalette(); rebuildPalGrid(); view.shapePreview = shapeTint() }
const shapeTint = () => {
  const [r, g, b] = hexToRgb(($('curColor') as HTMLInputElement).value)
  return `rgba(${r},${g},${b},0.45)`
}

// Advanced: the tuning controls most drawings never need. Remembered across
// sessions, because someone who opens it once usually wants it open.
const ADV_KEY = 'autoflats.adv'
function setAdvanced(open: boolean) {
  $('adv').hidden = !open
  $('bAdv').textContent = open ? 'Advanced ▾' : 'Advanced ▸'
  $('bAdv').setAttribute('aria-expanded', '' + open)
  try { localStorage.setItem(ADV_KEY, open ? '1' : '') } catch { /* private mode */ }
}
$('bAdv').onclick = () => setAdvanced(!!$('adv').hidden)
try { if (localStorage.getItem(ADV_KEY)) setAdvanced(true) } catch { /* private mode */ }

// ---------- floating panels ----------
// One at a time: they share the same corner, and two overlapping popovers over
// the layers list is worse than a click to swap between them.
function showPop(id: string, open: boolean) {
  for (const p of ['palPanel', 'wcPanel']) $(p).hidden = p !== id || !open
}
const togglePop = (id: string) => showPop(id, !!$(id).hidden)
$('bPalPanel').onclick = () => togglePop('palPanel')
$('bWcPanel').onclick = () => togglePop('wcPanel')
$('bPalClose').onclick = () => showPop('', false)
$('bWcClose').onclick = () => showPop('', false)

// ---------- watercolor ----------
const WC_KEY = 'autoflats.wc'
let wcParams: Watercolor = { ...WATERCOLOR }
const wcOn = () => $<HTMLInputElement>('cWater').checked
const wcPreviewOn = () => wcOn() && $<HTMLInputElement>('cWcPrev').checked

function syncWcUi() {
  $<HTMLInputElement>('sWcPool').value = '' + Math.round(wcParams.pool * 100)
  $<HTMLInputElement>('sWcGrain').value = '' + Math.round(wcParams.grain * 100)
  $<HTMLInputElement>('sWcBloom').value = '' + Math.round(wcParams.bloom * 100)
  $('vWcPool').textContent = wcParams.pool.toFixed(2)
  $('vWcGrain').textContent = wcParams.grain.toFixed(2)
  $('vWcBloom').textContent = wcParams.bloom.toFixed(2)
}
function readWcUi() {
  wcParams = {
    pool: +$<HTMLInputElement>('sWcPool').value / 100,
    grain: +$<HTMLInputElement>('sWcGrain').value / 100,
    bloom: +$<HTMLInputElement>('sWcBloom').value / 100,
  }
  try { localStorage.setItem(WC_KEY, JSON.stringify(wcParams)) } catch { /* private mode */ }
  syncWcUi()
  rebuildFills()
}
for (const id of ['sWcPool', 'sWcGrain', 'sWcBloom']) $(id).oninput = readWcUi
$('bWcReset').onclick = () => { wcParams = { ...WATERCOLOR }; syncWcUi(); readWcUi() }
$('cWcPrev').onchange = () => rebuildFills()
$('cWater').onchange = () => { rebuildFills(); if (wcOn()) showPop('wcPanel', true) }
try {
  const raw = localStorage.getItem(WC_KEY)
  if (raw) { const j = JSON.parse(raw); wcParams = { pool: +j.pool || 0, grain: +j.grain || 0, bloom: +j.bloom || 0 } }
} catch { /* private mode or corrupt */ }
syncWcUi()

$('bUndo').onclick = doUndo
$('tPan').onclick = () => setTool('pan')
loadPalette()
rebuildPalette()
rebuildPalGrid()
syncSliders(curHex())
view.shapePreview = shapeTint()
$('tFill').onclick = () => setTool('fill')
$('tRecolor').onclick = () => setTool('recolor')
$('tBarrier').onclick = () => setTool('barrier')
$('tEraser').onclick = () => setTool('eraser')
$('tMerge').onclick = () => setTool('merge')
$('tDraw').onclick = () => setTool('dmerge')
$('tDel').onclick = () => setTool('delfill')
$('tGroup').onclick = () => setTool('group')
$('tShape').onclick = () => setTool('shape')
$('tPick').onclick = () => setTool('pick')
$('cEdits').onchange = () => { if (!($<HTMLInputElement>('cEdits')).checked) selectedEdits.clear(); rebuildEditView() }

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
  view.centerOn(mx, my)
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdits.size) { e.preventDefault(); deleteSelectedEdits(); return }
  if (e.key === 'Escape' && mergeFirst) { view.cancelPending(); return }
  if (e.key === 'Escape' && selectedEdits.size) { selectedEdits.clear(); rebuildEditView(); status(''); return }
  const k = e.key.toLowerCase()
  if (k === 'v') setTool('pan')
  else if (k === 'b') setTool('fill')
  else if (k === 'c') setTool('recolor')
  else if (k === 'g') setTool('barrier')
  else if (k === 'e') setTool('eraser')
  else if (k === 'm') setTool('merge')
  else if (k === 'x') setTool('delfill')
  else if (k === 'r') setTool('group')
  else if (k === 'f') setTool('shape')
  else if (k === 'd') setTool('dmerge')
  else if (k === 's') setTool('pick')
})

const sliderLive = () => {
  $('vThr').textContent = sl('sThr') + '%'
  $('vSat').textContent = sl('sSat') + '%'
  $('vGap').textContent = sl('sGap') + 'px'
  $('vMin').textContent = sl('sMin') + 'px²'
  $('vSm').textContent = sl('sSm') + 'px'
  $('vSliv').textContent = sl('sSliv') + 'px'
  $('vPal').textContent = sl('sPal') ? '' + sl('sPal') : 'unique'
  $('vDecl').textContent = sl('sDecl') ? '' + sl('sDecl') : 'off'
  $('vSag').textContent = sl('sSag') ? sl('sSag') + 'px' : 'off'
  $('vZebra').textContent = sl('sZebra') ? sl('sZebra') + ' bands' : 'off'
  syncSagUI()
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
for (const id of ['sThr', 'sSat', 'sSm']) $(id).oninput = () => { resetAutoBridge(); sliderLive(); setDirty(true); schedulePreview(); scheduleQuickFlat() }
for (const id of ['sGap', 'sMin', 'sSliv', 'sDecl', 'sSag']) $(id).oninput = () => { resetAutoBridge(); sliderLive(); setDirty(true); scheduleQuickFlat() }
$('cSagView').onchange = $('cRidge').onchange = () => refreshOverlays()
// Zebra is a pure recolour of the sag canvas: no re-segmentation, no dirty flag.
$('sZebra').oninput = () => { sliderLive(); if (($<HTMLInputElement>('cSagView')).checked) refreshOverlays() }
// palette is a pure recolour: no re-segmentation, so apply it immediately
$('sPal').oninput = () => {
  sliderLive()
  if (!doc.labels) return
  expanded.clear()
  applyPalette(sl('sPal'))
  rebuildFills()
  rebuildPanel()
}
$('cMerge').onchange = $('cHybrid').onchange = () => { setDirty(true); scheduleQuickFlat() }
$('cSkel').onchange = () => { if (doc.src) rebuildLineCanvas(); setDirty(true); scheduleQuickFlat() }
$('cAuto').onchange = () => { if (dirty) scheduleAutoFlat(0) }
$('sOp').oninput = () => { view.lineOpacity = sl('sOp') / 100; view.render() }
$('cLines').onchange = () => { view.showLines = ($<HTMLInputElement>('cLines')).checked; if (doc.src) rebuildLineCanvas() }

// Drag & drop. preventDefault on dragover is what makes the window a drop
// target at all, but on its own the pointer still shows "no drop" and nothing
// says the app takes files -- so set dropEffect explicitly and put up a target.
// dragenter/dragleave fire for every child element crossed, hence the depth
// count rather than a boolean.
const dragHasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|avif)$/i
let dragDepth = 0
const showDropzone = (on: boolean) => { $('dropzone').style.display = on ? 'flex' : 'none' }

addEventListener('dragenter', e => {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  if (++dragDepth === 1) showDropzone(true)
})
addEventListener('dragover', e => {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
})
addEventListener('dragleave', e => {
  if (!dragHasFiles(e)) return
  if (--dragDepth <= 0) { dragDepth = 0; showDropzone(false) }
})
addEventListener('drop', e => {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  showDropzone(false)
  const files = [...(e.dataTransfer?.files ?? [])]
  // take the first thing that is actually an image; some sources give no MIME
  const img = files.find(f => f.type.startsWith('image/') || IMAGE_NAME.test(f.name))
  if (!img) { status(files.length ? `Not an image: ${files[0].name}` : 'Nothing to open'); return }
  openFile(img)
})

// Never fail silently: an uncaught error used to leave the UI looking idle
// (a click that "does nothing"), with the reason only in the dev console.
addEventListener('error', e => { setBusy(false); status('Error: ' + (e.message || e.error)) })
addEventListener('unhandledrejection', e => {
  setBusy(false)
  status('Error: ' + ((e.reason as any)?.message ?? e.reason))
})

setTool('pan')
// The controls carry non-trivial defaults now (rubber sheet on, min region 0),
// so sync the readouts and the sag greying to the markup rather than to what
// the markup used to say.
sliderLive()
sagLabel()
if ((navigator as any).gpu) $('lGpu').hidden = false
// automation/test hooks
;(window as any).__openUrl = async (u: string) =>
  openFile(new File([await (await fetch(u)).blob()], u.split('/').pop() || 'img.png'))
;(window as any).__view = view
;(window as any).__doc = doc
