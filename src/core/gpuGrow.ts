// WebGPU-accelerated multi-source label growth: iterative chamfer relaxation
// (parallel Bellman-Ford, ping-pong buffers). Exact on convergence — same
// path costs as the CPU Dijkstra in expand.ts; equidistant ties may resolve
// differently, which is an equally valid watershed. Callers must be prepared
// for null (no adapter) and for grow() to reject (device lost) — fall back
// to the CPU path.
const WGSL = /* wgsl */ `
struct Dims { w: u32, h: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> distIn: array<u32>;
@group(0) @binding(1) var<storage, read_write> distOut: array<u32>;
@group(0) @binding(2) var<storage, read> labIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> labOut: array<u32>;
@group(0) @binding(4) var<storage, read> aux: array<u32>; // bit31 blocked, low bits extra step cost
@group(0) @binding(5) var<storage, read_write> changed: atomic<u32>;
@group(0) @binding(6) var<uniform> dims: Dims;

const INF: u32 = 0xffffffffu;
const BLK: u32 = 0x80000000u;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y;
  if (x >= dims.w || y >= dims.h) { return; }
  let i = y * dims.w + x;
  let a = aux[i];
  var bd = distIn[i];
  var bl = labIn[i];
  if ((a & BLK) == 0u) {
    let extra = a & 0xffu;
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      let ny = i32(y) + dy;
      if (ny < 0 || ny >= i32(dims.h)) { continue; }
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        if (dx == 0 && dy == 0) { continue; }
        let nx = i32(x) + dx;
        if (nx < 0 || nx >= i32(dims.w)) { continue; }
        // don't slip diagonally between two blocked pixels
        if (dx != 0 && dy != 0 &&
            (aux[y * dims.w + u32(nx)] & BLK) != 0u &&
            (aux[u32(ny) * dims.w + x] & BLK) != 0u) { continue; }
        let j = u32(ny) * dims.w + u32(nx);
        let nd = distIn[j];
        if (nd == INF) { continue; }
        var w: u32 = 3u;
        if (dx != 0 && dy != 0) { w = 4u; }
        let cand = nd + w + extra;
        if (cand < bd) { bd = cand; bl = labIn[j]; }
      }
    }
  }
  if (bd < distIn[i]) { atomicStore(&changed, 1u); }
  distOut[i] = bd;
  labOut[i] = bl;
}
`

export class GpuGrower {
  private device: any = null

  static async create(): Promise<GpuGrower | null> {
    try {
      const gpu = (globalThis.navigator as any)?.gpu
      if (!gpu) return null
      const adapter = await gpu.requestAdapter()
      if (!adapter) return null
      const g = new GpuGrower()
      g.device = await adapter.requestDevice()
      return g.device ? g : null
    } catch {
      return null
    }
  }

  async grow(labels: Int32Array, blocked: Uint8Array | null, cost: Uint8Array | null, W: number, H: number): Promise<Int32Array> {
    const dev = this.device
    const N = W * H
    const aux = new Uint32Array(N)
    if (cost) for (let i = 0; i < N; i++) aux[i] = (cost[i] * 3) >> 5
    if (blocked) for (let i = 0; i < N; i++) if (blocked[i]) aux[i] |= 0x80000000
    const dist = new Uint32Array(N)
    for (let i = 0; i < N; i++) dist[i] = labels[i] ? 0 : 0xffffffff

    const mk = (usage: number, size = N * 4) => dev.createBuffer({ size, usage })
    const ST = 0x0080 /* STORAGE */, CD = 0x0008 /* COPY_DST */, CS = 0x0004 /* COPY_SRC */
    const distA = mk(ST | CD), distB = mk(ST | CD | CS)
    const labA = mk(ST | CD), labB = mk(ST | CD | CS)
    const auxB = mk(ST | CD)
    const chg = mk(ST | CD | CS, 4)
    const uni = dev.createBuffer({ size: 16, usage: 0x0040 /* UNIFORM */ | CD })
    const stagingChg = dev.createBuffer({ size: 4, usage: 0x0001 /* MAP_READ */ | CD })
    const stagingLab = dev.createBuffer({ size: N * 4, usage: 0x0001 | CD })

    dev.queue.writeBuffer(distA, 0, dist)
    dev.queue.writeBuffer(labA, 0, new Uint32Array(labels.buffer, labels.byteOffset, N))
    dev.queue.writeBuffer(auxB, 0, aux)
    dev.queue.writeBuffer(uni, 0, new Uint32Array([W, H, 0, 0]))

    const module = dev.createShaderModule({ code: WGSL })
    const pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const bind = (di: any, dO: any, li: any, lo: any) => dev.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: di } }, { binding: 1, resource: { buffer: dO } },
        { binding: 2, resource: { buffer: li } }, { binding: 3, resource: { buffer: lo } },
        { binding: 4, resource: { buffer: auxB } }, { binding: 5, resource: { buffer: chg } },
        { binding: 6, resource: { buffer: uni } },
      ],
    })
    const bgAB = bind(distA, distB, labA, labB)
    const bgBA = bind(distB, distA, labB, labA)

    const wx = Math.ceil(W / 16), wy = Math.ceil(H / 16)
    const BATCH = 24
    let flip = false
    for (let iter = 0; iter < 4096; iter += BATCH) {
      dev.queue.writeBuffer(chg, 0, new Uint32Array([0]))
      const enc = dev.createCommandEncoder()
      for (let k = 0; k < BATCH; k++) {
        const pass = enc.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, flip ? bgBA : bgAB)
        pass.dispatchWorkgroups(wx, wy)
        pass.end()
        flip = !flip
      }
      enc.copyBufferToBuffer(chg, 0, stagingChg, 0, 4)
      dev.queue.submit([enc.finish()])
      await stagingChg.mapAsync(1 /* READ */)
      const done = new Uint32Array(stagingChg.getMappedRange())[0] === 0
      stagingChg.unmap()
      if (done) break
    }

    const enc = dev.createCommandEncoder()
    // after an even number of passes per batch, "flip" tells us the last-written side
    enc.copyBufferToBuffer(flip ? labB : labA, 0, stagingLab, 0, N * 4)
    dev.queue.submit([enc.finish()])
    await stagingLab.mapAsync(1)
    const out = new Int32Array(stagingLab.getMappedRange().slice(0))
    stagingLab.unmap()
    for (const b of [distA, distB, labA, labB, auxB, chg, uni, stagingChg, stagingLab]) b.destroy()
    return out
  }
}
