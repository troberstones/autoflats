// Watercolor.
//
// A flat fill is a slab of one colour. Real washes are not: the pigment pools
// and dries darker where the water stops (the edge), the paper's tooth breaks
// the colour up at high frequency, and the wash blooms unevenly at low
// frequency. Those three terms are all this does -- edge pooling, grain,
// bloom -- because they are what the eye reads as "painted" and everything
// beyond them is a different program.
//
// The field is separated from the colours on purpose. Everything here depends
// on the SHAPE of the fills, never on what colour they are, so recolouring is
// a multiply against a cached field rather than a re-synthesis: the difference
// between a preview that keeps up with the palette and one that does not.

export interface Watercolor { pool: number; grain: number; bloom: number }
export const WATERCOLOR: Watercolor = { pool: 0.24, grain: 0.1, bloom: 0.16 }

const POOL_W = 7    // px the edge darkening reaches in from the boundary
const GRAIN_F = 1.7 // px, paper tooth
const BLOOM_F = 24  // px, how wide the uneven patches in a wash are

const hash = (x: number, y: number, s: number): number => {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
const smooth = (t: number) => t * t * (3 - 2 * t)

// Value noise: a lattice of hashes, smoothly interpolated. Cheap, seamless and
// deterministic -- which matters, because exporting the same drawing twice has
// to give the same painting, and so does previewing it and then exporting it.
export function noise(x: number, y: number, f: number, s: number): number {
  const px = x / f, py = y / f
  const x0 = Math.floor(px), y0 = Math.floor(py)
  const tx = smooth(px - x0), ty = smooth(py - y0)
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s)
  const c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

// Distance from every pixel to the nearest edge of its own region, by a
// two-pass chamfer. One field for the whole image rather than one per fill:
// the fills partition the canvas, so a single sweep answers it for all of them.
export function edgeDistance(W: number, H: number, labels: Int32Array, rootOf: Int32Array): Float32Array {
  const d = new Float32Array(W * H)
  const INF = 1e9
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, r = rootOf[labels[i]]
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
        rootOf[labels[i - 1]] !== r || rootOf[labels[i + 1]] !== r ||
        rootOf[labels[i - W]] !== r || rootOf[labels[i + W]] !== r
      d[i] = edge ? 0 : INF
    }
  }
  const D = 1, Q = 1.414
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    let v = d[i]
    if (y > 0) {
      v = Math.min(v, d[i - W] + D)
      if (x > 0) v = Math.min(v, d[i - W - 1] + Q)
      if (x < W - 1) v = Math.min(v, d[i - W + 1] + Q)
    }
    if (x > 0) v = Math.min(v, d[i - 1] + D)
    d[i] = v
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x
    let v = d[i]
    if (y < H - 1) {
      v = Math.min(v, d[i + W] + D)
      if (x > 0) v = Math.min(v, d[i + W - 1] + Q)
      if (x < W - 1) v = Math.min(v, d[i + W + 1] + Q)
    }
    if (x < W - 1) v = Math.min(v, d[i + 1] + D)
    d[i] = v
  }
  return d
}

// The wash itself, as two per-pixel channels that are independent of colour:
//   k -- what to multiply the fill colour by
//   a -- coverage. Paper shows through in the middle of a wash but not at its
//        rim, so the dip is tied to the same distance term as the pooling and
//        vanishes at the edge; otherwise the fills would gain a translucent
//        seam exactly where a painter would have laid down the most pigment.
export interface WashField { k: Float32Array; a: Uint8Array; paper: Uint8Array }

export function washField(W: number, H: number, dist: Float32Array, wc: Watercolor): WashField {
  const N = W * H
  const k = new Float32Array(N), a = new Uint8Array(N), paper = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0
    const inside = 1 - Math.exp(-dist[i] / POOL_W)
    const tooth = noise(x, y, GRAIN_F, 2)
    k[i] = (1 - wc.pool * (1 - inside)) *
           (1 + wc.bloom * (noise(x, y, BLOOM_F, 1) - 0.5)) *
           (1 + wc.grain * (tooth - 0.5))
    a[i] = 255 - 30 * inside * (1 - noise(x, y, GRAIN_F, 3))
    // the paper under everything, from the same tooth at a third the strength
    paper[i] = 255 - 120 * wc.grain * (1 - noise(x, y, GRAIN_F, 4))
  }
  return { k, a, paper }
}
