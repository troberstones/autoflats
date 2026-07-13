# autoFlats

Auto flat-filling for line art. Load an image, get one flat color fill per region (each on its own layer), fix gaps interactively, export a layered PSD.

## Run

```
npm install
npm run dev     # open http://localhost:5173
```

## Use

1. **Open…** (or drag-drop) a line-art PNG. It auto-flats on load.
2. Fills extend to the middle of each stroke, so the line art overlays with no fringe. Toggle **Line opacity** to inspect.
3. Adjust and hit **Re-Flat** (keeps your colors, matched by overlap):
   - **Line threshold** — how dark a pixel must be to count as line (raise for faint sketch lines).
   - **Color reject** — saturation above this is ignored (drops colored underdrawings, e.g. red construction lines).
   - **Smoothing** — morphological closing of the line mask before segmentation; seals pinholes/texture in grainy strokes (exported line art is untouched).
   - **Gap size** — trapped-ball radius; gaps narrower than ~2× this won't leak.
   - **Min region** — smaller regions are absorbed into their biggest neighbor.
   - **Sliver width** — fills thinner than this *everywhere* (the space trapped between parallel/double strokes) merge into the area they open into. 0 disables.
   - **Auto-merge leaks** — fill fragments whose shared border crosses open space *against* the stroke flow are merged automatically.
4. **Gaps**: suggestions appear right after flatting (and via **Suggest Gaps**) — orange/white segments anchored where region collisions squeeze through actual line breaks, direction-checked against the stroke flow field. **Tab / Shift-Tab** cycles through them (view jumps to each), **Enter** or a click bridges the focused one, **Accept All Gaps** takes everything. Bridges are invisible barriers — they constrain fills but are never exported. The 🖊 barrier pen draws them by hand; 🧽 erases.
5. **Tools**: ✋ pan (Space) · 🪣 fill/recolor (click a fill = recolor with current color, or a random color if **Random** is checked; click background = carve a new fill; Alt-click = pick color) · ⧉ merge two regions (click-click) · 🖌 draw merge (D): stroke from a fill and everything the stroke crosses merges into it. ⌘Z undo.
6. **Export PSD** — white background, one layer per fill (tight bounds, layer names/visibility preserved), line art layer on top.

## How it works

- **Ink extraction** ([src/core/ink.ts](src/core/ink.ts)) — dark + desaturated = line; handles alpha-only PNGs and colored underdrawings.
- **Trapped-ball segmentation** ([src/core/trappedBall.ts](src/core/trappedBall.ts)) — a ball of radius r can't pass a gap narrower than 2r; descending radii fill large areas safely, then small details, so nothing floods the whole image.
- **Line-center expansion** ([src/core/expand.ts](src/core/expand.ts)) — regions grow into line pixels simultaneously and meet at the stroke's medial axis.
- **Gap suggestions** ([src/core/gaps.ts](src/core/gaps.ts), [src/core/fronts.ts](src/core/fronts.ts)) — region-collision fronts and skeleton endpoints propose bridges; each must match stroke widths, follow the flow field, and survive a virtual-bridge split test. Bridges are flow-curved Hermite paths ([src/core/curves.ts](src/core/curves.ts)), shaped by a parallel partner stroke when one spans the gap.
- **GPU (optional)** ([src/core/gpuGrow.ts](src/core/gpuGrow.ts)) — WebGPU iterative relaxation for the growth stages, automatic CPU fallback.
- Segmentation runs in a Web Worker; the only runtime dependency is [ag-psd](https://github.com/Agamnentzar/ag-psd) for PSD writing.
