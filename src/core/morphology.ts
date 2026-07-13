// Morphological closing (radius r px) + despeckle: seals pinholes and ragged
// texture in grainy strokes, drops isolated specks. Superset of the input
// line pixels is guaranteed.
export function smoothMask(line: Uint8Array, W: number, H: number, r: number, despeckle = 12): Uint8Array {
  const N = W * H
  let m = line
  if (r > 0) {
    const d1 = distanceTransform(line, W, H)
    const dil = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (d1[i] <= 3 * r) dil[i] = 1
    const inv = new Uint8Array(N)
    for (let i = 0; i < N; i++) inv[i] = dil[i] ? 0 : 1
    const d2 = distanceTransform(inv, W, H)
    m = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (d2[i] > 3 * r || line[i]) m[i] = 1
  } else if (despeckle > 0) {
    m = line.slice()
  }
  if (despeckle > 0) {
    // remove tiny isolated line components (dust); fills flow under the dots anyway
    const seen = new Uint8Array(N)
    const stack: number[] = []
    for (let s = 0; s < N; s++) {
      if (!m[s] || seen[s]) continue
      stack.length = 0
      stack.push(s)
      seen[s] = 1
      const comp: number[] = [s]
      while (stack.length) {
        const p = stack.pop()!
        const x = p % W, y = (p / W) | 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx, qy = y + dy
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue
          const q = qy * W + qx
          if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); if (comp.length <= despeckle) comp.push(q) }
        }
      }
      if (comp.length <= despeckle) for (const p of comp) m[p] = 0
    }
  }
  return m
}

// Chamfer 3-4 distance transform. mask: 1 = obstacle (dist 0).
// Returned distances are in units of 3 ≈ 1 pixel.
export function distanceTransform(mask: Uint8Array, W: number, H: number): Int32Array {
  const INF = 1 << 29
  const d = new Int32Array(W * H)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      let v = d[i]
      if (v === 0) continue
      if (x > 0 && d[i - 1] + 3 < v) v = d[i - 1] + 3
      if (y > 0) {
        if (d[i - W] + 3 < v) v = d[i - W] + 3
        if (x > 0 && d[i - W - 1] + 4 < v) v = d[i - W - 1] + 4
        if (x < W - 1 && d[i - W + 1] + 4 < v) v = d[i - W + 1] + 4
      }
      d[i] = v
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x
      let v = d[i]
      if (v === 0) continue
      if (x < W - 1 && d[i + 1] + 3 < v) v = d[i + 1] + 3
      if (y < H - 1) {
        if (d[i + W] + 3 < v) v = d[i + W] + 3
        if (x < W - 1 && d[i + W + 1] + 4 < v) v = d[i + W + 1] + 4
        if (x > 0 && d[i + W - 1] + 4 < v) v = d[i + W - 1] + 4
      }
      d[i] = v
    }
  }
  return d
}
