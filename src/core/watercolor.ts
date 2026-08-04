// Watercolor, simulated.
//
// The first version of this multiplied each fill by three noise fields -- a
// distance-based rim, high-frequency grain, low-frequency blotches -- and it
// looked like what it was: a photograph of a flat colour with a filter on it.
// The rim was the giveaway. Pigment does not gather at a constant distance
// from an outline; it gathers where the water stopped, and where the water
// stops is decided by where it went.
//
// So this runs the fluid instead, following Curtis et al., "Computer-Generated
// Watercolor" (SIGGRAPH 1997): a shallow-water layer that carries pigment
// about, a pigment-deposition layer that trades it with the paper, and a
// capillary layer that decides how far the wet area creeps. The effects that
// read as watercolor -- the dark irregular rim, granulation pooling in the
// tooth of the paper, backruns where two wet fronts meet -- are not drawn
// here. They fall out of the simulation, which is the whole reason to run one.
//
// Two things make it affordable. The flow is simulated at a few hundred pixels
// on the long side and scaled up, because the structures that matter are large
// -- it is the paper tooth that is fine, and that is added at full resolution
// afterwards. And the whole thing depends only on the SHAPE of the fills, so
// it is computed once per re-flat and cached; recolouring is a table lookup.

import { fbm, hash01, noise } from './noise.ts'

export interface Watercolor {
  wetness: number     // how long the water runs before the paper takes it
  granulation: number // how strongly pigment settles into the tooth
  edge: number        // how hard the water is pushed to the rim
  bloom: number       // unevenness of the initial load, and of the wet front
}
export const WATERCOLOR: Watercolor = { wetness: 0.55, granulation: 0.5, edge: 0.55, bloom: 0.45 }

// Density 1 is exactly the colour the user picked; the simulation decides
// where there is more and where there is less. The rim commonly reaches 1.5.
export const DMAX = 2.2

// Longest side of the simulation grid. The flow structures that matter are
// large -- it is the paper tooth that is fine, and that goes on at full
// resolution afterwards -- so this buys most of the speed for none of the look.
const SIM_MAX = 256

// ---------------------------------------------------------------- simulation

// 8-neighbour offsets, and the projection weight for each: a diagonal step is
// longer, so the same velocity sends proportionally less that way.
const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]
const DW = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2]
const WT = new Float32Array(8)

interface Sim { w: number; h: number; dep: Float32Array }

// A wash on a closed shape cannot have a sustained outward drift while the
// water is conserved -- an incompressible pool just circulates, which mixes
// the pigment instead of moving it anywhere. The first attempt at this ran a
// pressure projection and produced a perfectly even fill for exactly that
// reason.
//
// What actually darkens an edge is DRYING. Water leaves the sheet, and it
// leaves fastest at the rim where the wash is thinnest and most exposed. The
// rim would recede, except that the pigment already stranded there pins it, so
// water flows outward to replace what evaporated -- and every drop that makes
// the trip leaves its pigment behind when it goes. That is the coffee-ring
// effect (Deegan et al., Nature 389, 1997), and it is the same mechanism in a
// coffee cup and in a wash.
//
// So this is a shallow-water model with a sink: a height field that evaporates,
// flow down the height gradient, pigment carried along with the water, and
// deposition wherever a cell finally dries out. Everything else follows from
// that. The rim goes dark because it dries last and is fed longest. A corner
// that dries early strands a hard line -- a backrun. Pigment settles into the
// tooth of the paper because the paper is part of the height the water is
// running down.
function simulate(reg: Int32Array, w: number, h: number, wc: Watercolor): Sim {
  const N = w * h
  const wet = new Uint8Array(N)
  const wh = new Float32Array(N)    // water height
  const wh2 = new Float32Array(N)
  const g = new Float32Array(N)     // pigment in suspension
  const g2 = new Float32Array(N)
  const dep = new Float32Array(N)   // pigment dried onto the paper
  const ph = new Float32Array(N)    // paper height

  const scale = 256 / Math.max(w, h) // keep the paper the same size whatever the grid
  for (let i = 0; i < N; i++) {
    const x = (i % w) * scale, y = ((i / w) | 0) * scale
    ph[i] = fbm(x, y, 5, 11, 4)
  }

  // Separate pools of water: a fill's rim never depends on what its neighbour
  // happens to be doing, and pigment never crosses into another fill's layer.
  const open = (a: number, b: number) => reg[a] !== 0 && reg[a] === reg[b]

  // The wash does not arrive as a perfect copy of the region -- a brush leaves
  // some of the shape a shade short, and that shortfall is where the ragged
  // edge comes from.
  const dist = edgeDist(reg, w, h)
  const back = 0.3 + 1.6 * wc.bloom
  for (let i = 0; i < N; i++) {
    if (!reg[i]) continue
    const x = i % w, y = (i / w) | 0
    if (dist[i] <= back * fbm(x * scale, y * scale, 20, 3, 3)) continue
    wet[i] = 1
    // The brush was not loaded evenly, and never is. The wetter patches dry
    // last, so this is also what decides where the backruns end up.
    wh[i] = 1 + wc.bloom * 0.7 * (fbm(x * scale, y * scale, 26, 7, 3) - 0.5) * 2
    g[i] = 1
  }

  const steps = Math.round(20 + 46 * wc.wetness)
  const blur = new Float32Array(N)
  boxBlur(wet, blur, w, h, Math.max(1, Math.round(Math.max(w, h) / 30)))

  // Evaporation, and the whole engine of the thing. Uniform loss would just
  // thin the wash evenly; it is the EXTRA loss at the rim -- thinner water,
  // more exposed edge -- that pulls the flow outward and strands the pigment
  // it carries. wc.edge is that excess.
  const evap = new Float32Array(N)
  const base = 1.25 / steps
  for (let i = 0; i < N; i++) {
    if (!wet[i]) continue
    const x = i % w, y = (i / w) | 0
    // The excess is modulated along the rim, not constant around it. A wash
    // that dries at exactly the same rate all the way round gets a rim of
    // exactly one thickness, which is the look of an outline rather than of
    // an edge -- it was the whole complaint about the version this replaces.
    const along = 0.35 + 1.3 * fbm(x * scale, y * scale, 30, 23, 3)
    evap[i] = base * (1 + (0.4 + 5.5 * wc.edge) * (1 - blur[i]) * along) *
              (0.85 + 0.3 * noise(x * scale, y * scale, 9, 29))
  }

  // Where the water goes, solved once rather than diffused step by step.
  //
  // Levelling is fast next to drying -- a wash keeps a flat surface the whole
  // time it is drying -- so stepping the flow explicitly is hopeless: it would
  // take tens of thousands of iterations to carry water across a wash, and the
  // rim dries out long before any of it arrives. That was the last version's
  // problem and it is why its washes came out perfectly even.
  //
  // Conservation says the flow has to make up the DIFFERENCE between local
  // evaporation and the average, since the average is just the whole wash
  // getting thinner together. So the flux is the gradient of a potential with
  // Laplacian E - Ebar, with no flow across the edge of the water. Solve that
  // once and the drift field is done: it does not change as the wash dries.
  const phi = solveFlow(evap, wet, reg, w, h)

  const tooth = 0.05 + 0.22 * wc.granulation       // how much the paper steers the water
  // Enough pigment fixes early that the middle of a wash keeps some body. With
  // none of this the drift strips the centre bare and every fill reads as a
  // ring rather than as a wash.
  const settle = 0.020 + 0.022 * wc.granulation    // pigment fixing while still wet
  const DRIFT = 2.6                                // px of travel per unit of potential gradient
  const SWIRL = 0.04 + 0.09 * wc.bloom             // wander, as the curl of a noise field

  for (let step = 0; step < steps; step++) {
    // -- evaporate
    for (let i = 0; i < N; i++) if (wet[i]) wh[i] -= evap[i]

    // -- carry the pigment along the drift, plus the local slope of the paper
    // tooth, which is what breaks the flow up at grain scale.
    g2.fill(0)
    for (let i = 0; i < N; i++) {
      if (!wet[i] || g[i] <= 0) continue
      if (wh[i] <= 0) { g2[i] += g[i]; continue }
      const x = i % w, y = (i / w) | 0
      const nb = (j: number, ok: boolean) => (ok && wet[j] && open(i, j) ? j : i)
      const iL = nb(i - 1, x > 0), iR = nb(i + 1, x < w - 1)
      const iU = nb(i - w, y > 0), iD = nb(i + w, y < h - 1)
      // thinner water carries the same flux faster, which is why the last of
      // the water moves the most pigment
      const spd = DRIFT / Math.max(0.15, wh[i])
      // A little swirl, taken as the curl of a noise field so it moves water
      // around without creating or destroying any. Four-neighbour transport on
      // a square grid otherwise lays down faint spokes along the axes, and the
      // eye finds them immediately in a large wash.
      const sx = x * scale, sy = y * scale
      const cx = (noise(sx, sy + 1, 18, 31) - noise(sx, sy - 1, 18, 31)) * SWIRL
      const cy = -(noise(sx + 1, sy, 18, 31) - noise(sx - 1, sy, 18, 31)) * SWIRL
      const vx = -(phi[iR] - phi[iL]) * 0.5 * spd - (ph[iR] - ph[iL]) * 0.5 * tooth + cx
      const vy = -(phi[iD] - phi[iU]) * 0.5 * spd - (ph[iD] - ph[iU]) * 0.5 * tooth + cy
      // Eight neighbours, the diagonals weighted by their longer step. With
      // four, the axes drain faster than the diagonals do and a large wash
      // ends up with a pale cross through the middle of it -- an artefact of
      // the grid that the eye picks out instantly because nothing in a
      // painting is ever that symmetrical.
      let tot = 0
      for (let n = 0; n < 8; n++) {
        const dx = DX[n], dy = DY[n]
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { WT[n] = 0; continue }
        const j = i + dy * w + dx
        if (!wet[j] || !open(i, j)) { WT[n] = 0; continue }
        const proj = (vx * dx + vy * dy) * DW[n]
        WT[n] = proj > 0 ? proj : 0
        tot += WT[n]
      }
      if (tot <= 1e-7) { g2[i] += g[i]; continue }
      const moved = g[i] * Math.min(0.7, tot)
      const k = moved / tot
      g2[i] += g[i] - moved
      for (let n = 0; n < 8; n++) if (WT[n]) g2[i + DY[n] * w + DX[n]] += WT[n] * k
    }
    g.set(g2)

    // -- some pigment fixes while the paper is still wet, and it fixes hardest
    // in the valleys of the tooth. This is granulation: it is the paper
    // showing through the wash rather than a texture laid over the top.
    for (let i = 0; i < N; i++) {
      if (!wet[i] || wh[i] <= 0) continue
      const d = g[i] * settle * (1.4 - ph[i])
      g[i] -= d; dep[i] += d
    }

    // -- and where the water finally runs out, everything it was still holding
    // dries exactly where it stands
    for (let i = 0; i < N; i++) {
      if (!wet[i] || wh[i] > 0) continue
      dep[i] += g[i]
      g[i] = 0
      wet[i] = 0
    }
  }
  // anything still wet when the clock runs out dries too
  for (let i = 0; i < N; i++) if (wet[i]) { dep[i] += g[i]; g[i] = 0 }
  return { w, h, dep }
}

// Gauss-Seidel with over-relaxation, Neumann everywhere: no water crosses the
// edge of a wash, so a closed neighbour reads as this cell. Pure Neumann only
// fixes the potential up to a constant, which is all we need -- the flow is
// its gradient. The source is balanced to sum to zero per wash, without which
// the problem has no solution at all.
function solveFlow(evap: Float32Array, wet: Uint8Array, reg: Int32Array,
                   w: number, h: number): Float32Array {
  const N = w * h
  const f = new Float32Array(N)
  const sum = new Map<number, number>(), cnt = new Map<number, number>()
  for (let i = 0; i < N; i++) {
    if (!wet[i]) continue
    sum.set(reg[i], (sum.get(reg[i]) ?? 0) + evap[i])
    cnt.set(reg[i], (cnt.get(reg[i]) ?? 0) + 1)
  }
  for (let i = 0; i < N; i++) if (wet[i]) f[i] = evap[i] - sum.get(reg[i])! / cnt.get(reg[i])!

  const phi = new Float32Array(N)
  const OMEGA = 1.9
  // Not to convergence: the drift only needs the large-scale shape of the
  // potential, and the modes that take longest to settle are finer than the
  // grid this is solved on is trying to represent.
  const sweeps = Math.max(40, Math.round(Math.max(w, h) * 0.7))
  for (let it = 0; it < sweeps; it++) {
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        for (let x = (y + pass) & 1; x < w; x += 2) {
          const i = y * w + x
          if (!wet[i]) continue
          let acc = 0, n = 0
          if (x > 0 && wet[i - 1] && reg[i - 1] === reg[i]) { acc += phi[i - 1]; n++ }
          if (x < w - 1 && wet[i + 1] && reg[i + 1] === reg[i]) { acc += phi[i + 1]; n++ }
          if (y > 0 && wet[i - w] && reg[i - w] === reg[i]) { acc += phi[i - w]; n++ }
          if (y < h - 1 && wet[i + w] && reg[i + w] === reg[i]) { acc += phi[i + w]; n++ }
          if (!n) continue
          phi[i] += OMEGA * ((acc - f[i]) / n - phi[i])
        }
      }
    }
  }
  return phi
}

// ------------------------------------------------------------------ plumbing

// Distance to the nearest pixel of another region, by two chamfer passes. One
// field for the whole image: the fills partition the canvas, so a single sweep
// answers it for all of them.
export function edgeDist(reg: Int32Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h)
  const INF = 1e9
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = reg[i]
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        reg[i - 1] !== r || reg[i + 1] !== r || reg[i - w] !== r || reg[i + w] !== r
      d[i] = edge ? 0 : INF
    }
  }
  const D = 1, Q = 1.414
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    let t = d[i]
    if (y > 0) {
      t = Math.min(t, d[i - w] + D)
      if (x > 0) t = Math.min(t, d[i - w - 1] + Q)
      if (x < w - 1) t = Math.min(t, d[i - w + 1] + Q)
    }
    if (x > 0) t = Math.min(t, d[i - 1] + D)
    d[i] = t
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x
    let t = d[i]
    if (y < h - 1) {
      t = Math.min(t, d[i + w] + D)
      if (x > 0) t = Math.min(t, d[i + w - 1] + Q)
      if (x < w - 1) t = Math.min(t, d[i + w + 1] + Q)
    }
    if (x < w - 1) t = Math.min(t, d[i + 1] + D)
    d[i] = t
  }
  return d
}

// separable box blur, two passes for a roughly gaussian falloff
function boxBlur(src: Uint8Array, out: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h)
  const inv = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[y * w + clamp(x, 0, w - 1)]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum * inv
      sum += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]
    }
  }
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

// --------------------------------------------------------------- the field

export interface WashField {
  d: Uint8Array      // pigment density, 0..255 mapping to 0..DMAX
  paper: Uint8Array  // the paper's own tone, under everything
}

export function washField(W: number, H: number, labels: Int32Array, rootOf: Int32Array,
                          wc: Watercolor): WashField {
  const N = W * H
  const scale = Math.min(1, SIM_MAX / Math.max(W, H))
  const sw = Math.max(8, Math.round(W * scale)), sh = Math.max(8, Math.round(H * scale))

  const reg = new Int32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(H - 1, Math.floor((y + 0.5) * H / sh))
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(W - 1, Math.floor((x + 0.5) * W / sw))
      reg[y * sw + x] = rootOf[labels[sy * W + sx]]
    }
  }
  const sim = simulate(reg, sw, sh, wc)

  const d = new Uint8Array(N), paper = new Uint8Array(N)
  // Full-resolution tooth. The simulation grid is too coarse to hold it, and
  // it is the part you see from six inches away.
  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) * sh / H - 0.5
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const fx = (x + 0.5) * sw / W - 0.5
      let v = bilinear(sim.dep, sw, sh, fx, fy)
      const tooth = fbm(x, y, 2.4, 41, 3)
      // pigment sits in the valleys; the peaks stay paler
      v *= 1 + wc.granulation * 0.55 * (0.5 - tooth) * 2
      // and the paper's own weave shows wherever the wash is thin
      v *= 1 - 0.10 * wc.granulation * hash01(x, y, 5)
      d[i] = Math.max(0, Math.min(255, Math.round(v * 255 / DMAX)))
      paper[i] = 255 - Math.round(26 * (1 - tooth) * (0.35 + 0.65 * wc.granulation))
    }
  }
  return { d, paper }
}

function bilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const tx = x - x0, ty = y - y0
  const xa = clamp(x0, 0, w - 1), xb = clamp(x0 + 1, 0, w - 1)
  const ya = clamp(y0, 0, h - 1), yb = clamp(y0 + 1, 0, h - 1)
  const p00 = a[ya * w + xa], p10 = a[ya * w + xb]
  const p01 = a[yb * w + xa], p11 = a[yb * w + xb]
  return (p00 + (p10 - p00) * tx) * (1 - ty) + (p01 + (p11 - p01) * tx) * ty
}

// One table per fill colour: density in, rgba out. A wash is one colour laid
// at varying strength, so the whole of a layer's rendering is 256 entries and
// an array index -- which is what keeps recolouring instant even though the
// pigment model underneath is not a multiply.
//
// Beer-Lambert rather than a multiply: at density 1 you get exactly the colour
// that was picked, and above it the SAME pigment absorbing more light, which
// darkens and saturates together. A multiply just slides everything to grey,
// and that grey rim is most of why the first attempt looked like mud.
export function washLut(color: [number, number, number]): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  const a = color.map(c => -Math.log(Math.max(1, c) / 255)) // absorbance at density 1
  for (let q = 0; q < 256; q++) {
    const dd = q / 255 * DMAX
    for (let c = 0; c < 3; c++) lut[q * 4 + c] = Math.round(255 * Math.exp(-a[c] * dd))
    lut[q * 4 + 3] = Math.round(255 * Math.min(1, dd * 1.7))
  }
  return lut
}
