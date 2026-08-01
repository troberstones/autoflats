// A test harness with no framework and no new dependencies: `node
// --experimental-transform-types test/run.ts` is the whole story.
//
// The point of this suite is not coverage, it is INVARIANTS. The bug that
// motivated it (see checkSegmentation) made every flat over 2MP silently wrong
// while still reporting a plausible fill count -- there was nothing to notice
// unless you probed the label map by hand. Assertions here are therefore about
// the shape of the result rather than exact numbers, which drift whenever the
// algorithm is tuned.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface Case { name: string; fn: () => void | Promise<void> }
const cases: Case[] = []
let current = ''

export const test = (name: string, fn: () => void | Promise<void>) => { cases.push({ name, fn }) }

export class Failure extends Error {}
const fail = (msg: string): never => { throw new Failure(msg) }

export function ok(cond: unknown, what: string) {
  if (!cond) fail(`${what}: expected truthy, got ${cond}`)
}
export function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) fail(`${what}: expected ${expected}, got ${actual}`)
}
export function near(actual: number, expected: number, tol: number, what: string) {
  if (!(Math.abs(actual - expected) <= tol)) fail(`${what}: expected ${expected} +/-${tol}, got ${actual.toFixed(4)}`)
}
export function between(actual: number, lo: number, hi: number, what: string) {
  if (!(actual >= lo && actual <= hi)) fail(`${what}: expected ${lo}..${hi}, got ${actual}`)
}

export async function run(): Promise<void> {
  let passed = 0
  const failures: string[] = []
  for (const c of cases) {
    current = c.name
    const t = Date.now()
    try {
      await c.fn()
      passed++
      console.log(`  ok   ${c.name} (${Date.now() - t}ms)`)
    } catch (e) {
      const msg = e instanceof Failure ? e.message : `threw ${(e as Error)?.stack ?? e}`
      failures.push(`${c.name}\n       ${msg}`)
      console.log(`  FAIL ${c.name} (${Date.now() - t}ms)\n       ${msg}`)
    }
  }
  console.log(`\n${passed}/${cases.length} passed`)
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

// ---------- fixtures ----------

export interface Art { W: number; H: number; line: Uint8Array; ink: Uint8Array }

const blank = (W: number, H: number): Art => ({ W, H, line: new Uint8Array(W * H), ink: new Uint8Array(W * H) })

function stroke(a: Art, x0: number, y0: number, x1: number, y1: number, w = 2) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2)
  for (let s = 0; s <= steps; s++) {
    const cx = Math.round(x0 + (x1 - x0) * s / steps), cy = Math.round(y0 + (y1 - y0) * s / steps)
    for (let dy = 0; dy < w; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || y < 0 || x >= a.W || y >= a.H) continue
        a.line[y * a.W + x] = 1
        a.ink[y * a.W + x] = 255
      }
    }
  }
}

export function rect(a: Art, x0: number, y0: number, x1: number, y1: number, gap = 0) {
  stroke(a, x0, y0, x1, y0)
  stroke(a, x1, y0, x1, y1)
  stroke(a, x1, y1, x0, y1)
  // an optional break in the left wall, centred, `gap` px wide
  const mid = (y0 + y1) / 2
  if (gap > 0) { stroke(a, x0, y1, x0, mid + gap / 2); stroke(a, x0, mid - gap / 2, x0, y0) }
  else stroke(a, x0, y1, x0, y0)
}

// Three closed boxes in open space: the simplest thing with a known answer.
export function threeBoxes(W = 400, H = 300): Art {
  const a = blank(W, H)
  rect(a, 30, 30, 150, 150)
  rect(a, 180, 30, 300, 150)
  rect(a, 30, 180, 300, 260)
  return a
}

// One box whose left wall has a break of `gap` px -- the case the whole app
// exists for. Narrow gaps must not leak; wide ones may.
export function leakyBox(gap: number, W = 400, H = 300): Art {
  const a = blank(W, H)
  rect(a, 100, 60, 300, 240, gap)
  return a
}

// A box filled with parallel hatching: pockets between strokes are shading,
// not areas, and should not each become their own fill.
export function hatchedBox(W = 400, H = 300): Art {
  const a = blank(W, H)
  rect(a, 60, 60, 340, 240)
  for (let x = 80; x < 330; x += 12) stroke(a, x, 70, x + 30, 230, 2)
  return a
}

// The exact line mask the multigrid diverged on. Synthetic hatching will not
// reproduce it (regular strokes coarsen predictably, and alpha=1 is stable on
// every crop of this image too) -- only the whole picture does. It is committed
// RLE-packed so the regression runs without ffmpeg.
export function divergingMask(): { W: number; H: number; line: Uint8Array } {
  const path = new URL('./fixtures/diverging-mask.json', import.meta.url)
  const { w, h, rle } = JSON.parse(readFileSync(path, 'utf8'))
  const line = new Uint8Array(w * h)
  let i = 0, v = 0
  for (const run of rle.split(',')) {
    const n = parseInt(run, 36)
    if (v) line.fill(1, i, i + n)
    i += n; v ^= 1
  }
  if (i !== w * h) throw new Error(`fixture RLE covers ${i} of ${w * h} pixels`)
  return { W: w, H: h, line }
}

// ---------- optional: the real sample images ----------
// Needs ffmpeg. Those tests skip (loudly) rather than fail when it is absent,
// so the suite stays runnable anywhere.

let ffmpegChecked = false, ffmpegOk = false
export function hasFfmpeg(): boolean {
  if (!ffmpegChecked) {
    ffmpegChecked = true
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegOk = true } catch { ffmpegOk = false }
  }
  return ffmpegOk
}

export const SAMPLES = ['Lineart1', 'Lineart2', 'Lineart3', 'Lineart4', 'Lineart4_crop', 'Lineart5', 'Lineart6_notclean']

export function loadSample(name: string): { W: number; H: number; data: Uint8ClampedArray } {
  const root = new URL('..', import.meta.url).pathname
  const file = `${root}${name}.png`
  const probe = execFileSync('ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const [W, H] = probe.split(',').map(Number)
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 1 << 30 })
  return { W, H, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, W * H * 4) }
}

export const skip = (why: string) => console.log(`  skip ${current} -- ${why}`)
