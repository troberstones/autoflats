// Deterministic value noise. Shared by the paper and by the simulation, so it
// lives on its own: both need it and neither should own it.
//
// Deterministic matters more here than it usually does. The same drawing has
// to export the same painting twice, and it has to export the painting that
// was on screen a moment earlier -- a wash seeded from Math.random would be a
// different picture every time you looked at it.

export function hash01(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

// A lattice of hashes, smoothly interpolated.
export function noise(x: number, y: number, f: number, s: number): number {
  const px = x / f, py = y / f
  const x0 = Math.floor(px), y0 = Math.floor(py)
  const tx = smooth(px - x0), ty = smooth(py - y0)
  const a = hash01(x0, y0, s), b = hash01(x0 + 1, y0, s)
  const c = hash01(x0, y0 + 1, s), d = hash01(x0 + 1, y0 + 1, s)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

// Octaves at halving amplitude. Paper is not one frequency: there is a weave
// you can see across an inch and a tooth you can only see at the nib.
export function fbm(x: number, y: number, f: number, s: number, octaves = 4): number {
  let v = 0, amp = 0.5, sum = 0, freq = f
  for (let o = 0; o < octaves; o++) {
    v += amp * noise(x, y, freq, s + o * 101)
    sum += amp
    amp *= 0.5
    freq *= 0.5
  }
  return v / sum
}
