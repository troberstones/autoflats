// Stroke-orientation field via structure tensor of the ink map, computed at
// 1/4 resolution (flow varies slowly). fx/fy = unit stroke tangent (axial:
// v and -v are equivalent), coh = 0..1 how directional the strokes are there.
export interface Flow { fx: Float32Array; fy: Float32Array; coh: Float32Array; W2: number; H2: number }

export function flowField(ink: Uint8Array, W: number, H: number): Flow {
  const W2 = Math.max(2, W >> 2), H2 = Math.max(2, H >> 2)
  const M = W2 * H2
  const a = new Float32Array(M)
  for (let y2 = 0; y2 < H2; y2++) {
    for (let x2 = 0; x2 < W2; x2++) {
      let s = 0
      const bx = x2 * 4, by = y2 * 4
      for (let dy = 0; dy < 4; dy++) {
        const y = Math.min(H - 1, by + dy) * W
        for (let dx = 0; dx < 4; dx++) s += ink[y + Math.min(W - 1, bx + dx)]
      }
      a[y2 * W2 + x2] = s / 16
    }
  }
  const jxx = new Float32Array(M), jxy = new Float32Array(M), jyy = new Float32Array(M)
  for (let y = 1; y < H2 - 1; y++) {
    for (let x = 1; x < W2 - 1; x++) {
      const i = y * W2 + x
      const gx = (a[i + 1] - a[i - 1]) / 2
      const gy = (a[i + W2] - a[i - W2]) / 2
      jxx[i] = gx * gx; jxy[i] = gx * gy; jyy[i] = gy * gy
    }
  }
  for (const j of [jxx, jxy, jyy]) { boxBlur(j, W2, H2, 2); boxBlur(j, W2, H2, 2) }
  const fx = new Float32Array(M), fy = new Float32Array(M), coh = new Float32Array(M)
  for (let i = 0; i < M; i++) {
    const d = jxx[i] - jyy[i], tr = jxx[i] + jyy[i]
    const ang = 0.5 * Math.atan2(2 * jxy[i], d) + Math.PI / 2 // tangent ⟂ dominant gradient
    fx[i] = Math.cos(ang); fy[i] = Math.sin(ang)
    coh[i] = tr > 1e-4 ? Math.sqrt(d * d + 4 * jxy[i] * jxy[i]) / tr : 0
  }
  return { fx, fy, coh, W2, H2 }
}

export function sampleFlow(f: Flow, x: number, y: number): [number, number, number] {
  const i = Math.min(f.H2 - 1, Math.max(0, y >> 2)) * f.W2 + Math.min(f.W2 - 1, Math.max(0, x >> 2))
  return [f.fx[i], f.fy[i], f.coh[i]]
}

function boxBlur(v: Float32Array, W: number, H: number, r: number) {
  const tmp = new Float32Array(v.length)
  const n = 2 * r + 1
  for (let y = 0; y < H; y++) {
    const row = y * W
    let s = 0
    for (let x = -r; x <= r; x++) s += v[row + Math.min(W - 1, Math.max(0, x))]
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / n
      s += v[row + Math.min(W - 1, x + r + 1)] - v[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0
    for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]
    for (let y = 0; y < H; y++) {
      v[y * W + x] = s / n
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]
    }
  }
}
