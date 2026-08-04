// Invariant tests for the flatting pipeline.  npm test
import { readPsd, initializeCanvas } from 'ag-psd'

// ag-psd decodes layer pixels through a canvas, which node has no notion of. It
// only ever needs somewhere to put the bytes, so hand it a plain object; the
// canvas factory stays a thrower, since nothing here should reach it.
initializeCanvas(
  () => { throw new Error('no canvas in node') },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData)
import { test, run, ok, eq, near, between, skip,
         threeBoxes, leakyBox, hatchedBox, divergingMask, hasFfmpeg, loadSample, SAMPLES, type Art } from './harness.ts'
import { extractInk, thresholdInk } from '../src/core/ink.ts'
import { smoothMask } from '../src/core/morphology.ts'
import { trappedBall } from '../src/core/trappedBall.ts'
import { expandLabels } from '../src/core/expand.ts'
import { finalizeRegions, type RegionInfo } from '../src/core/regions.ts'
import { membraneSag } from '../src/core/membrane.ts'
import { sagSegment } from '../src/core/sag.ts'
import { exportPsd, layerCount, type ExportRegion, type ExportMode } from '../src/core/psd.ts'
import { WATERCOLOR, washField, washLut, DMAX, type Watercolor } from '../src/core/watercolor.ts'

// ---------- the shared invariant check ----------
// Every one of these held false at some point while the GPU growth path was
// silently returning a zero-filled label map, and none of them was checked
// anywhere -- which is why that bug survived: the fill COUNT stayed plausible.
function checkSegmentation(what: string, core: Int32Array, labels: Int32Array,
                           regions: RegionInfo[], line: Uint8Array, W: number, H: number) {
  const N = W * H
  let zeroLabels = 0, inkWithCore = 0, freeWithoutCore = 0
  for (let i = 0; i < N; i++) {
    if (labels[i] === 0) zeroLabels++
    if (line[i]) { if (core[i] !== 0) inkWithCore++ } else if (core[i] === 0) freeWithoutCore++
  }
  eq(zeroLabels, 0, `${what}: every pixel must belong to a region (expansion covers the ink)`)
  eq(inkWithCore, 0, `${what}: core must be empty on ink`)
  eq(freeWithoutCore, 0, `${what}: every free pixel must have a core label`)

  ok(regions.length > 0, `${what}: produced no regions`)
  ok(regions.some(r => r.isBg), `${what}: nothing was identified as background`)

  const ids = regions.map(r => r.id).sort((a, b) => a - b)
  eq(ids[0], 1, `${what}: region ids must start at 1`)
  eq(ids[ids.length - 1], ids.length, `${what}: region ids must be compact 1..K`)
  ok(regions.every(r => r.area > 0), `${what}: every region must cover at least one pixel`)

  let free = 0
  for (let i = 0; i < N; i++) if (!line[i]) free++
  eq(regions.reduce((s, r) => s + r.area, 0), free, `${what}: region areas must tile the free space`)
}

const flatBall = (a: Art, maxGap = 8, minArea = 50) => {
  const { core } = trappedBall(a.line, a.W, a.H, maxGap, a.ink)
  const labels = expandLabels(core, a.W, a.H, a.ink)
  const { regions } = finalizeRegions(core, labels, a.W, a.H, minArea)
  return { core, labels, regions }
}
const flatSag = (a: Art, tau = 6, maxGap = 8, minArea = 50) => {
  const { core } = sagSegment(a.line, a.W, a.H, tau, maxGap)
  const labels = expandLabels(core, a.W, a.H, a.ink)
  const { regions } = finalizeRegions(core, labels, a.W, a.H, minArea)
  return { core, labels, regions }
}
// how many regions cover a given point, and which
const regionAt = (labels: Int32Array, W: number, x: number, y: number) => labels[y * W + x]

// ---------- membrane ----------

test('membrane: matches the analytic strip solution', () => {
  const W = 200, H = 32
  const line = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) { line[x] = 1; line[(H - 1) * W + x] = 1 }
  const sag = membraneSag(line, W, H, 60, 1e-4)
  // discrete u_i = i(n+1-i)/2 with n=30 -> u_max = 120, sag = sqrt(8*120)
  near(sag[15 * W + 100], Math.sqrt(8 * 120), 0.1, 'strip centre sag')
})

test('membrane: matches the analytic disc solution', () => {
  const S = 201, R = 80
  const line = new Uint8Array(S * S).fill(1)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.hypot(x - 100, y - 100) < R) line[y * S + x] = 0
  const sag = membraneSag(line, S, S, 60, 1e-4)
  near(sag[100 * S + 100], R * Math.SQRT2, R * Math.SQRT2 * 0.01, 'disc centre sag')
})

test('membrane: converges rather than diverging on real line work', () => {
  // Regression for the coarse-correction line search. Without it this exact
  // input blew up roughly 2x per cycle (max sag 279 -> 93500 by cycle 80) while
  // behaving perfectly on a clean disc, because the coarse grids cannot
  // represent thin channels and an unchecked correction can point the wrong
  // way. Solving harder must not move the answer.
  //
  // It has to be this whole picture: synthetic hatching does not reproduce it,
  // and neither does any crop of the original -- both are stable at alpha=1.
  const { W, H, line } = divergingMask()
  const loose = membraneSag(line, W, H, 80, 1e-2)
  const tight = membraneSag(line, W, H, 200, 1e-5)
  let mLoose = 0, mTight = 0
  for (let i = 0; i < loose.length; i++) { if (loose[i] > mLoose) mLoose = loose[i]; if (tight[i] > mTight) mTight = tight[i] }
  ok(mTight > 0, 'tight solve produced a flat field')
  near(mLoose / mTight, 1, 0.05, 'max sag must not drift as the solve tightens')
})

// ---------- segmentation invariants ----------

for (const [name, art] of [['three boxes', threeBoxes()], ['hatched box', hatchedBox()], ['leaky box (4px)', leakyBox(4)]] as const) {
  test(`trapped ball: invariants hold on ${name}`, () => {
    const { core, labels, regions } = flatBall(art)
    checkSegmentation(`ball/${name}`, core, labels, regions, art.line, art.W, art.H)
  })
  test(`rubber sheet: invariants hold on ${name}`, () => {
    const { core, labels, regions } = flatSag(art)
    checkSegmentation(`sag/${name}`, core, labels, regions, art.line, art.W, art.H)
  })
}

test('three closed boxes become three fills plus background', () => {
  const a = threeBoxes()
  const { labels, regions } = flatBall(a)
  const inside = new Set([regionAt(labels, a.W, 90, 90), regionAt(labels, a.W, 240, 90), regionAt(labels, a.W, 165, 220)])
  eq(inside.size, 3, 'the three box interiors must be three distinct fills')
  const bg = regionAt(labels, a.W, 5, 5)
  ok(!inside.has(bg), 'no box interior may share the background region')
  between(regions.length, 4, 8, 'region count for three boxes')
})

test('a narrow gap does not leak; a wide one does', () => {
  // The trapped-ball guarantee: a ball of radius r cannot pass a gap under 2r.
  const narrow = leakyBox(6)
  const nf = flatBall(narrow, 8)
  ok(regionAt(nf.labels, narrow.W, 200, 150) !== regionAt(nf.labels, narrow.W, 5, 5),
    'a 6px gap must not leak with gap size 8')
  const wide = leakyBox(40)
  const wf = flatBall(wide, 8)
  eq(regionAt(wf.labels, wide.W, 200, 150), regionAt(wf.labels, wide.W, 5, 5),
    'a 40px gap is wider than the ball and is expected to leak')
})

test('rubber sheet holds a narrow gap closed', () => {
  const a = leakyBox(6)
  const { labels } = flatSag(a)
  ok(regionAt(labels, a.W, 200, 150) !== regionAt(labels, a.W, 5, 5),
    'sag must keep the box interior separate across a 6px break')
})

test('rubber sheet absorbs hatching instead of seeding a fill per pocket', () => {
  const a = hatchedBox()
  const ball = flatBall(a).regions.length
  const sag = flatSag(a).regions.length
  ok(sag < ball, `sag (${sag}) should produce fewer fills than the ball (${ball}) on hatching`)
})

// ---------- PSD ----------

function tinyDoc() {
  const W = 40, H = 20
  const labels = new Int32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) labels[y * W + x] = x < 20 ? 1 : 2
  const rootOf = new Int32Array([0, 1, 2])
  const ink = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) ink[y * W + 20] = 255
  return { W, H, labels, rootOf, ink }
}
const REGIONS: ExportRegion[] = [
  { id: 1, color: [200, 40, 40], name: 'Left', hidden: false },
  { id: 2, color: [40, 80, 200], name: 'Right', hidden: false },
]

for (const mode of ['region', 'color', 'flat'] as ExportMode[]) {
  test(`psd: ${mode} mode round-trips`, () => {
    const { W, H, labels, rootOf, ink } = tinyDoc()
    const buf = exportPsd(W, H, labels, rootOf, REGIONS, ink, mode)
    const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
    eq(psd.width, W, 'psd width')
    eq(psd.height, H, 'psd height')
    const names = (psd.children ?? []).map(c => c.name)
    ok(names.includes('Background'), 'white background layer must be at the bottom')
    ok(names.includes('Line Art'), 'line art layer must be present')
    eq(names[0], 'Background', 'background must be the bottom layer')
    eq(names[names.length - 1], 'Line Art', 'line art must be the top layer')
  })
}

test('psd: a user group becomes a folder', () => {
  const { W, H, labels, rootOf, ink } = tinyDoc()
  const grouped: ExportRegion[] = [REGIONS[0], { ...REGIONS[1], group: 'Torso' }]
  const buf = exportPsd(W, H, labels, rootOf, grouped, ink, 'region')
  const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
  const folder = (psd.children ?? []).find(c => c.name === 'Torso')
  ok(folder, 'expected a folder named after the group')
  eq(folder!.children?.length, 1, 'the group folder should hold its one fill')
})

test('psd: the merged-flats layer holds every fill but the background', () => {
  const { W, H, labels, rootOf, ink } = tinyDoc()
  const withBg: ExportRegion[] = [{ ...REGIONS[0], isBg: true }, REGIONS[1]]
  const psd = readPsd(exportPsd(W, H, labels, rootOf, withBg, ink, 'region'),
    { skipCompositeImageData: true, skipThumbnail: true, useImageData: true })
  const names = (psd.children ?? []).map(c => c.name)
  eq(names[names.length - 1], 'Line Art', 'line art must stay the top layer')
  eq(names[names.length - 2], 'Flats (merged)', 'the merged layer sits directly under the line art')
  const merged = (psd.children ?? []).find(c => c.name === 'Flats (merged)')!
  const d = (merged.imageData ?? merged.canvas?.getContext('2d')?.getImageData(0, 0, W, H))!.data
  // left half is the background region: must be transparent. right half opaque.
  const at = (x: number, y: number) => d[(y * W + x) * 4 + 3]
  eq(at(5, 10), 0, 'background must be left out of the merged layer')
  eq(at(30, 10), 255, 'a non-background fill must be present in the merged layer')
})

test('psd: hidden fills survive per-fill export and vanish from merged export', () => {
  const { W, H, labels, rootOf, ink } = tinyDoc()
  const withHidden: ExportRegion[] = [REGIONS[0], { ...REGIONS[1], hidden: true }]
  const perFill = readPsd(exportPsd(W, H, labels, rootOf, withHidden, ink, 'region'),
    { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
  const flat = readPsd(exportPsd(W, H, labels, rootOf, withHidden, ink, 'flat'),
    { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
  const nameSet = (p: any) => new Set((p.children ?? []).flatMap((c: any) => c.children ? c.children.map((k: any) => k.name) : [c.name]))
  ok(nameSet(perFill).has('Right'), 'per-fill export keeps a hidden fill as a hidden layer')
  ok(!nameSet(flat).has('Right'), 'merged export drops hidden fills entirely')
})

test('psd: layerCount predicts what the export actually writes', () => {
  const { W, H, labels, rootOf, ink } = tinyDoc()
  // The warning the user sees before a watercolor export is computed from this
  // number, so it has to agree with the file for every mode -- a prediction
  // that drifts from reality is worse than no prediction.
  for (const mode of ['region', 'color', 'flat'] as ExportMode[]) {
    const psd = readPsd(exportPsd(W, H, labels, rootOf, REGIONS, ink, mode),
      { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
    const leaves = (psd.children ?? []).flatMap((c: any) => c.children ?? [c])
      .filter((c: any) => !['Background', 'Line Art', 'Flats (merged)'].includes(c.name))
    eq(layerCount(REGIONS, mode), leaves.length, `${mode}: predicted fill-layer count`)
  }
})

test('psd: a watercolor export varies across a fill and repeats exactly', () => {
  const { W, H, labels, rootOf, ink } = tinyDoc()
  const read = (wc: Watercolor | null) => {
    const psd = readPsd(exportPsd(W, H, labels, rootOf, REGIONS, ink, 'flat', wc),
      { skipCompositeImageData: true, skipThumbnail: true, useImageData: true })
    const l = (psd.children ?? []).find(c => c.name === 'Flats')!
    return (l.imageData ?? l.canvas?.getContext('2d')?.getImageData(0, 0, l.right! - l.left!, l.bottom! - l.top!))!
  }
  const flatImg = read(null), wet = read(WATERCOLOR)
  // flat mode puts both fills on one layer, so a plain export has exactly the
  // two colours that were asked for and nothing in between; a wash has a range.
  const tones = (d: ImageData) => new Set([...d.data].filter((_, k) => k % 4 === 0))
  eq(tones(flatImg).size, 2, 'a plain export is flat colour, one tone per fill')
  ok(tones(wet).size > 6, `a wash must vary, got ${tones(wet).size} tones`)
  // Deterministic, or the file would not match the preview it was judged from.
  eq([...wet.data].join(), [...read(WATERCOLOR).data].join(), 'watercolor must be reproducible')
})

test('wash: the pigment field depends on shape alone, and repeats exactly', () => {
  // The preview design rests on this: the simulation is cached against the
  // shape of the fills and recolouring is a table lookup. If the field ever
  // depended on the colours, every recolour would show a stale wash -- and if
  // it were not deterministic, the export would not match what was on screen.
  const { W, H, labels, rootOf } = tinyDoc()
  const a = washField(W, H, labels, rootOf, WATERCOLOR)
  const b = washField(W, H, labels, rootOf, WATERCOLOR)
  eq([...a.d].join(), [...b.d].join(), 'same shape and settings must give the same field')
  ok(new Set(a.d).size > 8, 'the wash must actually vary across the image')
})

test('wash: the simulation banks pigment at the rim of each wash', () => {
  // Edge darkening is the effect that reads as watercolor more than any other,
  // and unlike the version this replaced it is not drawn -- the water is
  // pushed outward and the pigment it carries dries where it stops. So the
  // test is on the outcome: the rim must end up denser than the middle.
  const W = 64, H = 64
  const labels = new Int32Array(W * H).fill(1)
  const rootOf = new Int32Array([0, 1])
  const f = washField(W, H, labels, rootOf, { ...WATERCOLOR, edge: 1 })
  const ring = (r: number) => {
    let sum = 0, n = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = Math.min(x, W - 1 - x), dy = Math.min(y, H - 1 - y)
      if (Math.min(dx, dy) === r) { sum += f.d[y * W + x]; n++ }
    }
    return sum / n
  }
  const rim = (ring(3) + ring(4) + ring(5)) / 3
  const mid = (ring(20) + ring(24) + ring(28)) / 3
  ok(rim > mid, `pigment should dry heavier at the rim (rim ${rim.toFixed(1)} vs middle ${mid.toFixed(1)})`)
})

test('wash: the lookup table is the picked colour at density 1 and darker above', () => {
  const lut = washLut([200, 120, 60])
  const at = (d: number) => { const q = Math.round(d / DMAX * 255) * 4; return [lut[q], lut[q + 1], lut[q + 2]] }
  const one = at(1)
  ok(Math.abs(one[0] - 200) <= 2 && Math.abs(one[1] - 120) <= 2 && Math.abs(one[2] - 60) <= 2,
    `density 1 must be the colour that was picked, got ${one}`)
  const deep = at(1.6)
  ok(deep[0] < one[0] && deep[1] < one[1] && deep[2] < one[2], 'more pigment must absorb more light')
  // absorbing, not fading to grey: the channel that was already dark stays the
  // darkest, and the gap between channels widens rather than closing
  ok((one[0] - one[2]) < (deep[0] - deep[2]) || deep[2] === 0, 'pooling must saturate, not desaturate')
})

// ---------- the real sample art (optional) ----------

test('samples: invariants hold on every sample image', () => {
  if (!hasFfmpeg()) return skip('ffmpeg not installed')
  for (const name of SAMPLES) {
    const { W, H, data } = loadSample(name)
    const ink = extractInk({ width: W, height: H, data } as ImageData, 0.30)
    const line = smoothMask(thresholdInk(ink, 0.25), W, H, 1)
    const art: Art = { W, H, line, ink }
    const { core, labels, regions } = flatBall(art, 8, 150)
    checkSegmentation(`ball/${name}`, core, labels, regions, line, W, H)
    // the background of these samples is open paper, so it must be the largest
    const biggest = regions.reduce((a, b) => (a.area >= b.area ? a : b))
    ok(biggest.isBg, `${name}: the largest region should be the background, got ${biggest.area}px un-flagged`)
  }
})

await run()
