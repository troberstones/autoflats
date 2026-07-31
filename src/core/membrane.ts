// The drawing as a rubber sheet.
//
// Pin the sheet to the frame everywhere there is ink, let gravity pull the rest
// down, and read off how far each point sagged. That is a Poisson problem:
//
//     -laplace(u) = 1   on free space,    u = 0  on ink and at the image border
//
// Sag grows with the SQUARE of how much room there is -- an infinite strip of
// width w reaches u = w^2/8 at its centre -- so we return sqrt(8u), which puts
// the answer back in pixels: in the middle of a w-wide channel it reads ~w, and
// in a disc of radius R it reads ~1.4R. Call it the local "roominess".
//
// Why bother, when the distance transform also measures roominess?  Because
// distance is only C0. It ridges along the entire medial axis, so a watershed
// on it shatters every limb into a basin per bump. The membrane is smooth, and
// for a convex region sqrt(u) is concave (Makar-Limanov), which means a convex
// region has exactly ONE maximum -- basins land on drawn areas, not on noise.
// And roominess is quadratic in width, so a narrow leak between two areas sits
// in a deep col that separates them, while the same leak barely dents a
// distance field. That quadratic contrast is what closes gaps.
//
// Solved with a geometric multigrid V-cycle (red-black Gauss-Seidel smoother,
// full-weighting restriction, bilinear prolongation) so cost is linear in
// pixels rather than the O(N^2) a plain relaxation would need.

interface Level {
  W: number; H: number
  free: Uint8Array      // 1 = sheet may move here, 0 = pinned to 0
  u: Float32Array       // solution / correction
  b: Float32Array       // right-hand side (h^2 * load)
  e: Float32Array       // prolonged coarse correction, before it is accepted
}

const level = (W: number, H: number, free: Uint8Array): Level =>
  ({ W, H, free, u: new Float32Array(W * H), b: new Float32Array(W * H), e: new Float32Array(W * H) })

// A coarse cell is free only if ALL of its children are. Ink therefore thickens
// as we coarsen, which is the safe direction: the coarse grid can under-correct
// near a stroke (the smoother mops that up) but can never carry a correction
// across one.
function coarsenMask(free: Uint8Array, W: number, H: number) {
  const W2 = (W + 1) >> 1, H2 = (H + 1) >> 1
  const f2 = new Uint8Array(W2 * H2)
  for (let cy = 0; cy < H2; cy++) {
    for (let cx = 0; cx < W2; cx++) {
      const x = cx << 1, y = cy << 1
      let all = 1
      for (let dy = 0; dy < 2 && all; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = x + dx, py = y + dy
          if (px >= W || py >= H) continue
          if (!free[py * W + px]) { all = 0; break }
        }
      }
      f2[cy * W2 + cx] = all
    }
  }
  return { f2, W2, H2 }
}

// u <- (sum of neighbours + b) / 4 on free cells. Pinned and out-of-bounds
// neighbours contribute 0, so the denominator is always 4.
// Red-black ordering: each colour reads only the other, so the sweep is
// order-independent and converges roughly twice as fast as Jacobi.
function smooth(L: Level, sweeps: number) {
  const { W, H, free, u, b } = L
  const last = W - 1
  // Edge cells need bounds checks; the interior does not. Pinned cells are kept
  // at zero by multiplying rather than branching -- `free` is unpredictable at
  // every stroke, and a mispredict costs more than the multiply.
  const edge = (x: number, y: number) => {
    const i = y * W + x
    if (!free[i]) return
    let sum = b[i]
    if (x > 0) sum += u[i - 1]
    if (x < last) sum += u[i + 1]
    if (y > 0) sum += u[i - W]
    if (y < H - 1) sum += u[i + W]
    u[i] = sum * 0.25
  }
  for (let s = 0; s < sweeps; s++) {
    for (let color = 0; color < 2; color++) {
      for (let x = color & 1; x < W; x += 2) edge(x, 0)
      for (let y = 1; y < H - 1; y++) {
        const row = y * W
        let x = (y ^ color) & 1
        if (x === 0) { edge(0, y); x = 2 }
        for (; x < last; x += 2) {
          const i = row + x
          u[i] = (b[i] + u[i - 1] + u[i + 1] + u[i - W] + u[i + W]) * 0.25 * free[i]
        }
        if (x === last) edge(last, y)
      }
      if (H > 1) for (let x = ((H - 1) ^ color) & 1; x < W; x += 2) edge(x, H - 1)
    }
  }
}

// Residual r = b - Lu, restricted onto the coarse right-hand side in one pass.
// Full weighting is the sum over the four children (the 1/4 average times the
// 4x that h^2 -> (2h)^2 rescaling demands), so the two factors cancel.
function restrictResidual(L: Level, C: Level) {
  const { W, H, free, u, b } = L
  C.b.fill(0)
  C.u.fill(0)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!free[i]) continue
      let sum = 0
      if (x > 0) sum += u[i - 1]
      if (x < W - 1) sum += u[i + 1]
      if (y > 0) sum += u[i - W]
      if (y < H - 1) sum += u[i + W]
      const r = b[i] - (4 * u[i] - sum)
      const ci = (y >> 1) * C.W + (x >> 1)
      if (C.free[ci]) C.b[ci] += r
    }
  }
}

// Bilinear (cell-centred 9/3/3/1) interpolation of the coarse correction into
// L.e. Pinned coarse cells read as 0, so the correction tapers off smoothly as
// it approaches a stroke. It must taper rather than stop: zeroing e wherever
// the coarse grid has nothing to say would put a cliff into the correction at
// every thin channel, and the line search below would then be measuring those
// cliffs instead of the correction.
function prolong(C: Level, L: Level) {
  const { W, H, free, e: out } = L
  const { W: CW, H: CH, u: e, free: cf } = C
  out.fill(0)
  const at = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= CW || cy >= CH) return 0
    const ci = cy * CW + cx
    return cf[ci] ? e[ci] : 0
  }
  for (let y = 0; y < H; y++) {
    const row = y * W, cy = y >> 1, sy = (y & 1) ? 1 : -1
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!free[i]) continue
      const cx = x >> 1, sx = (x & 1) ? 1 : -1
      out[i] = (9 * at(cx, cy) + 3 * at(cx + sx, cy) + 3 * at(cx, cy + sy) + at(cx + sx, cy + sy)) / 16
    }
  }
}

// Accept the correction only as far as it actually helps: u += alpha*e with the
// alpha that minimises the error along e. The measure has to be the A-norm of
// the error (alpha = <r,e>/<e,Ae>), not the plain residual: a coarse-grid
// correction is *expected* to raise the residual, because it trades smooth
// error for the rough error that post-smoothing then clears. Line-searching on
// the residual instead fights the algorithm -- it settles on alpha ~ 0.08 and
// the solver stalls.
//
// Without this the solver DIVERGES on real line art -- roughly doubling per
// cycle -- while behaving perfectly on a clean disc. The reason is that the
// coarse grids cannot represent a drawing: coarsening conservatively turns
// every thin channel into ink, so the coarse problem is a different problem,
// and a correction computed on it can point the wrong way. A textbook V-cycle
// takes that correction on faith. The line search cannot: at worst it picks
// alpha = 0 and the cycle degenerates to plain smoothing.
function correct(L: Level): number {
  const { W, H, free, u, b, e } = L
  const lap = (a: Float32Array, i: number, x: number, y: number) => {
    let sum = 0
    if (x > 0) sum += a[i - 1]
    if (x < W - 1) sum += a[i + 1]
    if (y > 0) sum += a[i - W]
    if (y < H - 1) sum += a[i + W]
    return 4 * a[i] - sum
  }
  let num = 0, den = 0
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!free[i]) continue
      num += (b[i] - lap(u, i, x, y)) * e[i]
      den += e[i] * lap(e, i, x, y)
    }
  }
  if (!(den > 0)) return 0
  const alpha = num / den
  for (let i = 0; i < W * H; i++) if (free[i]) u[i] += alpha * e[i]
  return alpha
}

function residual(L: Level): number {
  const { W, H, free, u, b } = L
  let s = 0
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!free[i]) continue
      let sum = 0
      if (x > 0) sum += u[i - 1]
      if (x < W - 1) sum += u[i + 1]
      if (y > 0) sum += u[i - W]
      if (y < H - 1) sum += u[i + W]
      const r = b[i] - (4 * u[i] - sum)
      s += r * r
    }
  }
  return Math.sqrt(s)
}

const NU = 6   // smoothing sweeps each side of the coarse correction

function vcycle(ls: Level[], k: number) {
  const L = ls[k]
  if (k === ls.length - 1) { smooth(L, 40); return }
  smooth(L, NU)
  restrictResidual(L, ls[k + 1])
  vcycle(ls, k + 1)
  prolong(ls[k + 1], L)
  correct(L)
  smooth(L, NU)
}

// Sag height in pixels: ~the width of the channel at that point, 0 on ink.
export function membraneSag(line: Uint8Array, W: number, H: number, cycles = 30, tol = 1e-2): Float32Array {
  const N = W * H
  const free = new Uint8Array(N)
  for (let i = 0; i < N; i++) free[i] = line[i] ? 0 : 1

  const ls: Level[] = [level(W, H, free)]
  while (ls[ls.length - 1].W > 8 && ls[ls.length - 1].H > 8) {
    const p = ls[ls.length - 1]
    const { f2, W2, H2 } = coarsenMask(p.free, p.W, p.H)
    ls.push(level(W2, H2, f2))
  }

  const top = ls[0]
  for (let i = 0; i < N; i++) if (free[i]) top.b[i] = 1 // unit gravity, h = 1
  // `cycles` is a ceiling, not a setting: stop as soon as the residual is small
  // enough that further sag changes land inside the quantisation used downstream.
  const r0 = residual(top)
  for (let c = 0; c < cycles; c++) if (residual(top) < tol * r0) break; else vcycle(ls, 0)

  const sag = new Float32Array(N)
  for (let i = 0; i < N; i++) if (free[i] && top.u[i] > 0) sag[i] = Math.sqrt(8 * top.u[i])
  return sag
}
