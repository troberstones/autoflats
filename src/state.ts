export interface Region {
  id: number
  color: [number, number, number]
  name: string
  visible: boolean
  parent: number // region-level merge (union-find); parent === id when root
  area: number
  isBg: boolean
  deleted?: boolean // removed by the user: not rendered, not exported
  group?: number    // Group.id, or 0/undefined when ungrouped
  swatch?: number   // palette slot this colour came from; undefined when it did not
}

// A user-drawn grouping. Stored as the drawn PATH, not a list of region ids:
// a re-flat renumbers every region, so membership is recomputed from the
// geometry each time (see assignGroups in main.ts). That is what makes groups
// survive re-flatting.
export interface Group { id: number; name: string; path: number[] }

// Draw-merge and delete-fill, kept for the same reason a Group keeps its lasso:
// stored as WHERE THE USER DREW rather than as which region ids it affected, so
// a re-flat can replay the intent against the renumbered regions instead of
// losing it. All three are replayed together by replayEdits() in main.ts.
export interface MergeStroke { id: number; pts: number[] }
export interface DeleteMark { id: number; x: number; y: number }
// The two-click merge tool, remembered the same way: the two points that were
// clicked, not the two region ids they resolved to at the time.
export interface MergePair { id: number; ax: number; ay: number; bx: number; by: number }
// A fill the user drew by hand rather than one the segmenter found. Kept as the
// polygon, so it is re-stamped after every re-flat exactly like the other edits
// -- and it wins over whatever the segmenter put there, because it was drawn on
// purpose.
export interface ShapeFill { id: number; pts: number[]; color: [number, number, number]; name: string }
// A colour the user chose for a fill, remembered the same way: as a point in
// the drawing rather than as a region id, so a re-flat can find the area again
// and put the colour back. `slot` is the palette swatch it came from, and the
// link is live in both directions -- adjust that swatch and every fill painted
// from it follows. Null when the colour came from the well rather than the
// palette, or when the swatch it came from has since been emptied.
export interface Recolor { id: number; x: number; y: number; slot: number | null; color: [number, number, number] }

export interface Stroke { pts: number[]; mode: 'draw' | 'erase' }

export class Doc {
  W = 0
  H = 0
  name = 'untitled'
  src: HTMLCanvasElement | null = null
  ink: Uint8Array | null = null
  core: Int32Array | null = null
  labels: Int32Array | null = null
  regions: Region[] = [] // indexed by id (0 unused)
  strokes: Stroke[] = []
  barrierMask: Uint8Array | null = null
  sag: Uint8Array | null = null // rubber-sheet height, 0..255 (see worker sagView)
  sagMax = 0                    // what 255 means, in px
  // gaps the segmenter sealed by itself, [x1,y1,x2,y2,...]. Display only: they
  // are re-derived from the line mask on every flat, never edited, never saved.
  closures: number[] = []
  groups: Group[] = []
  nextGroup = 1
  mergeStrokes: MergeStroke[] = []
  mergePairs: MergePair[] = []
  shapeFills: ShapeFill[] = []
  recolors: Recolor[] = []
  // Fixed-length grid with holes: a null is an empty slot, not a missing one.
  // Position is meaning in a palette -- skin in the top row, cloth in the next
  // -- so clearing a swatch must leave a gap rather than shuffle everything up.
  palette: (string | null)[] = []
  deleteMarks: DeleteMark[] = []
  nextEdit = 1

  root(id: number): number {
    while (this.regions[id] && this.regions[id].parent !== id) id = this.regions[id].parent
    return id
  }

  rootLut(): Int32Array {
    const lut = new Int32Array(this.regions.length)
    for (let i = 1; i < this.regions.length; i++) if (this.regions[i]) lut[i] = this.root(i)
    return lut
  }

  roots(): Region[] {
    const out: Region[] = []
    for (let i = 1; i < this.regions.length; i++) {
      const r = this.regions[i]
      if (r && r.parent === i) out.push(r)
    }
    return out.sort((a, b) => b.area - a.area)
  }
}

export interface UndoOp { label: string; heavy?: boolean; undo(): void }

// The automatic colour of a fill, derived from a point inside it rather than
// from its id. Ids are handed out by the segmenter and are reshuffled by any
// change to the settings, so an id-derived palette repainted the whole drawing
// every time a slider moved and made it impossible to see what had actually
// changed. Keyed on a place, a fill that came out the same comes out the same
// colour, and only the fills that really moved change.
//
// The point is the fill's anchor -- a pixel inside it -- and NOT its centroid,
// for two reasons. A ring and the hole inside it share a centroid, so they
// would come out identically coloured and read as one shape. And because
// anchors are pixels inside disjoint regions, no two fills can ever be handed
// the same colour by accident.
export function anchorColor(x: number, y: number): [number, number, number] {
  return hslToRgb(hash01(x, y, 1) * 360, 0.45 + 0.2 * hash01(x, y, 2), 0.68 + 0.12 * hash01(x, y, 3))
}
function hash01(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function paletteColor(i: number): [number, number, number] {
  const h = (i * 137.508) % 360
  const s = 0.45 + 0.2 * ((i * 7) % 3) / 2
  const l = 0.68 + 0.12 * ((i * 5) % 2)
  return hslToRgb(h, s, l)
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// h in 0..360, s and l in 0..1 -- the inverse of hslToRgb above. Grey comes
// back with hue 0, which is the usual convention: there is no hue to recover.
export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
  if (h < 0) h += 360
  return [h, s, l]
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

export function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
