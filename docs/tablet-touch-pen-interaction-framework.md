# Tablet Touch & Pen Interaction Framework — Plan

Status: proposal
Scope: a framework-agnostic input layer, designed against ArtMachine, applicable to autoflats and any future canvas/editor project.

## 1. Why this is needed

ArtMachine's canvas input today is handled the way most drawing prototypes start: a pile of raw DOM listeners wired directly into app logic, added incrementally as bugs came up. That got a working prototype on screen, but it doesn't hold up on tablets:

- `js/jsPaper.js:39-43` — the main drawing canvas listens for `pointermove`/`pointerdown`/`pointerup`, but only inside `if (window.PointerEvent)`, with no fallback and no branching on `event.pointerType`. Mouse, touch, and pen are all funneled through the same code path with identical assumptions.
- `js/palette.js:48-53` and `js/rangeslider.js:11-14` register **`pointerdown` + `touchstart` + `mousedown`** on the same element. On any browser that supports Pointer Events (i.e. all current tablet browsers), a single touch or pen tap fires `pointerdown` *and* `touchstart`, double-invoking `pickColor()` / the slider handler. This is a live bug, not a hypothetical one.
- No code anywhere reads `event.pressure`, `event.tiltX/tiltY`, or `event.pointerType`. The one place pressure was ever wired up — `engine.js:158`, `size = brushSize * pressure` — is dead legacy code not loaded by the live app.
- There is no multi-touch handling at all. `todo.txt` lists "pan canvas" as an open item; `engine.js:24` checks `maxTouchPoints > 1` and does nothing with it. Pinch-zoom, two-finger pan, and rotate are all greenfield.
- The viewport meta tag sets `user-scalable=no`, which kills the browser's native pinch-zoom — a reasonable move for a drawing app — but nothing was built to replace it, so tablet users currently have **no way to zoom** into `index.html`.
- No palm rejection: a `touch-action: none` canvas with a stylus in use will happily accept a palm's accidental touch as a second drawing input.
- Zero automated tests cover any of this.

autoflats (`src/ui/canvasView.ts`) is in better shape — it already uses `PointerEvent` uniformly (no mouse/touch duplication) and has `touch-action: none` on `#view` — but it's built around desktop interaction idioms (Space-to-pan, Alt-click, Shift-click, keyboard modifiers) with no multi-touch or pen-pressure support either.

Both apps need the same underlying thing: a single, well-tested module that turns raw pointer/touch input into the handful of events an editor actually cares about — draw-stroke, pan, zoom, rotate, tap, long-press — correctly across mouse, touch, and pen, with palm rejection and pressure/tilt where available. Building it once as a **dependency-free, framework-agnostic module** means it drops into ArtMachine's `<script>`-tag vanilla JS and into autoflats' TS/Vite build without modification.

## 2. Design principles

1. **Pointer Events only, no fallback branch.** Every browser that runs on a tablet today (Safari/iOS, Chrome/Android, Edge/Windows, Chrome/ChromeOS) supports the Pointer Events spec. Don't maintain a parallel `touchstart`/`mousedown` path "just in case" — that's the exact duplication bug already in `palette.js`. Drop `mousedown`/`touchstart`/`click` listeners wherever `pointerdown`/`pointerup` already cover them.
2. **One `pointerId`, one stream.** Track each active pointer independently by `event.pointerId`. Never assume "the" pointer — a session may have a pen pointer and a palm-touch pointer alive at the same instant.
3. **Classify before you act.** Every pointer event carries `pointerType` (`"mouse" | "touch" | "pen"`). Decide policy per type up front (see §4) instead of writing one code path and hoping it behaves for all three.
4. **Gestures are derived, not primary.** App code should not read raw `pointermove` deltas to detect a pinch. A gesture-recognition layer sits between the DOM and the app, and emits semantic events (`pan`, `zoom`, `rotate`, `stroke`) that the app subscribes to.
5. **Degrade pressure/tilt gracefully.** `event.pressure` is `0.5` for any device that doesn't report real pressure (mouse, most touch). Treat `0.5` as "no data" and fall back to a fixed brush size, not `brushSize * 0.5`.
6. **CSS and JS agree on gesture ownership.** `touch-action` on an element must match what the JS layer intends to handle itself vs. hand to the browser. Getting this wrong is why scroll-hijacking and dead pinch-zoom bugs happen.
7. **No dependency.** HammerJS/interactjs are unmaintained or overkill for this scope (~500 lines gets you pointer tracking + tap/drag/pinch/rotate/long-press/palm-rejection). A hand-rolled module is easier to reason about, test, and tune per-app than adopting and fighting a third-party gesture library.

## 3. Architecture — three layers

```
DOM (pointerdown/move/up/cancel, wheel)
        │
        ▼
┌───────────────────────┐
│   PointerTracker       │  owns Map<pointerId, PointerState>
│   - normalizes coords  │  (position, pressure, tilt, pointerType,
│   - dpr-correct coords │   timestamp, isPrimary)
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│  GestureRecognizer     │  consumes PointerTracker state,
│  - tap / long-press    │  emits semantic gesture events
│  - drag / stroke       │
│  - pinch / rotate      │
│  - two-finger pan      │
│  - palm rejection      │
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│  InteractionController │  app-facing API: on('stroke:start', ...),
│  - policy per          │  on('canvas:pan', ...), on('canvas:zoom', ...)
│    pointerType          │  translates gestures into app actions
│  - mode routing         │  (brush stroke vs. selection vs. pan)
└───────────────────────┘
            ▼
      App code (jsPaper.js tools / autoflats canvasView.ts)
```

Each layer is independently testable and independently reusable — an app that only needs pinch-zoom (no drawing) can use `PointerTracker` + `GestureRecognizer` without `InteractionController`.

## 4. Pointer-type policy (the core decision table)

This is the part that's currently missing entirely from both apps. Every interaction needs an explicit answer per pointer type:

| Concern | `mouse` | `touch` | `pen` |
|---|---|---|---|
| Primary action (single pointer) | draw/select per active tool | draw/select per active tool | draw/select per active tool, modulated by pressure |
| Secondary button / right-click | tool-specific (e.g. eyedropper) | n/a | barrel button (`event.button === 5` on some stacks) → same as mouse secondary |
| Two simultaneous pointers | n/a (mouse is single-pointer) | pinch-zoom / two-finger pan | pen + accidental touch → **palm rejection**, ignore the touch pointer entirely |
| Pressure (`event.pressure`) | ignored (always 0.5) | ignored (always 0.5, unstable on some Android) | drives brush size/opacity; treat exactly `0.5` as "unsupported," don't multiply |
| Tilt (`tiltX`/`tiltY`) | n/a | n/a | optional: brush angle/shape for calligraphy-style tools (v2, not MVP) |
| Hover (`pointermove` with `buttons === 0`) | cursor preview | not applicable (no hover on touch) | brush-size preview ring (Apple Pencil/Wacom report hover) |
| `touch-action` | `none` on canvas (mouse unaffected) | `none` on canvas, `manipulation` on scrollable chrome | `none` on canvas |

**Palm rejection rule:** once a `pen`-type pointer is active (`pointerdown` seen, no matching `pointerup`/`pointercancel` yet), any *new* `touch`-type pointer that begins is suppressed from drawing/gesture input — it may still be tracked (for a future "pen priority mode" toggle) but must not add a stroke or trigger a gesture. This single rule fixes the biggest tablet-with-stylus complaint: the side of the hand resting on the screen while inking.

## 5. Gesture recognition rules

- **Tap**: single pointer, `down → up` within ~10px movement and ~300ms, no intervening second pointer.
- **Long-press**: single pointer held stationary (within ~10px) for ~500ms without `up` — used for context actions (e.g. "pick color from canvas," "open tool options"), not for drawing.
- **Drag/stroke**: single pointer, movement exceeds a small threshold (~3-5px, tuned per device — touch needs a bit more slop than pen due to finger contact-area jitter) before being classified as a stroke, to avoid every tap starting a zero-length path.
- **Two-finger pan**: exactly two `touch` pointers active, moving together (similar vector) → translate the canvas.
- **Pinch-zoom**: exactly two `touch` pointers active, distance between them changing → scale the canvas view around the midpoint.
- **Rotate** (optional, v2): two `touch` pointers, angle between them changing beyond a threshold — many drawing apps intentionally omit canvas rotation-by-gesture because it's easy to trigger by accident during a pinch; if implemented, gate it behind a deliberately larger angle threshold than pinch/pan.
- **Mouse wheel / trackpad**: `wheel` event with `ctrlKey` (pinch-to-zoom on trackpads dispatches `wheel` + `ctrlKey: true`) → zoom; plain `wheel` → pan or zoom per app convention (autoflats already treats `wheel` as zoom in `canvasView.ts`; keep that convention, just route it through the same `canvas:zoom` event the touch pinch emits, so app code has one zoom handler, not two).

All coordinate math for pinch/pan (center point, scale delta, translate delta) is computed once in `GestureRecognizer`, in canvas-local coordinates already corrected for `devicePixelRatio` and element offset — app code never touches `clientX`/`clientY` directly.

## 6. Pressure & tilt handling

- Read `event.pressure` (0–1), `event.tiltX`/`event.tiltY` (-90–90°), `event.twist` where present, but only act on them when `pointerType === "pen"`.
- Treat `pressure === 0.5` from a non-pen pointer as "not reported" — use the tool's fixed base size.
- For brush size: `effectiveSize = baseSize * lerp(minPressureFactor, 1, pressure)` with a configurable `minPressureFactor` (e.g. 0.3) so a light touch never disappears to zero width — that's `engine.js`'s old formula (`size = brushSize * pressure`) with a floor added, since a hard 0-at-0-pressure feels broken to users.
- Use `event.getCoalescedEvents()` when present (pen input on a 120Hz+ display can report multiple samples between animation frames) to build smooth stroke paths instead of just the last event per frame — this directly improves stroke quality on iPad/Surface without any UI change.
- Surface hover events (`pointermove` with `buttons === 0` and `pointerType === "pen"`) as an optional "cursor preview ring" showing brush size before the pen touches down — supported by Apple Pencil (hover, iPadOS 17+) and most Wacom/EMR tablets.

## 7. CSS & viewport strategy

- Keep `touch-action: none` on all interactive canvases (already correct in both apps) — this is what lets `GestureRecognizer` own pinch/pan instead of the browser's native scroll/zoom fighting it.
- Use `touch-action: manipulation` (not `none`) on scrollable/tappable chrome outside the canvas (toolbars, panels) so those retain native tap responsiveness (no 300ms delay) without permitting page-level pinch-zoom.
- Replace `user-scalable=no` with `user-scalable=yes, maximum-scale=1` **only if** custom pinch-zoom (via `GestureRecognizer`) isn't fully wired up yet for a given canvas; once it is, `user-scalable=no` is fine again since the app now owns zoom directly. Don't ship a state where native zoom is disabled *and* custom zoom doesn't exist — that's ArtMachine's current state and it's a regression for tablet users.
- Add `-webkit-touch-callout: none` alongside the existing `-webkit-user-select: none` on canvases, to suppress the long-press "copy/save image" callout on iOS, which otherwise fires during a long-press gesture meant for the app.
- Keep `pointer-events: none` on purely visual overlay layers (already correct for `.paletteOverlay`).

## 8. Proposed module API

```ts
// interaction/pointer-tracker.ts (or .js — no build-step dependency)
interface PointerState {
  id: number;
  type: 'mouse' | 'touch' | 'pen';
  x: number; y: number;          // canvas-local, DPR-corrected
  pressure: number;               // 0.5 if unsupported
  tiltX: number; tiltY: number;   // 0 if unsupported
  isPrimary: boolean;
  startTime: number;
}

class PointerTracker {
  constructor(target: Element, opts?: { dprAware?: boolean });
  get active(): ReadonlyMap<number, PointerState>;
  on(type: 'pointeradd'|'pointerupdate'|'pointerremove', cb: (p: PointerState) => void): () => void;
}

// interaction/gesture-recognizer.ts
type GestureEvent =
  | { kind: 'tap'; x: number; y: number; pointerType: PointerState['type'] }
  | { kind: 'longpress'; x: number; y: number; pointerType: PointerState['type'] }
  | { kind: 'stroke:start'|'stroke:move'|'stroke:end'; x: number; y: number; pressure: number; tiltX: number; tiltY: number; pointerType: PointerState['type'] }
  | { kind: 'canvas:pan'; dx: number; dy: number }
  | { kind: 'canvas:zoom'; scale: number; centerX: number; centerY: number }
  | { kind: 'canvas:rotate'; deltaAngle: number; centerX: number; centerY: number };

class GestureRecognizer {
  constructor(tracker: PointerTracker, opts?: {
    tapSlopPx?: number; longPressMs?: number; dragThresholdPx?: number;
    palmRejection?: boolean; enableRotate?: boolean;
  });
  on(kind: GestureEvent['kind'], cb: (e: GestureEvent) => void): () => void;
}

// interaction/interaction-controller.ts — thin app-facing glue, optional
class InteractionController {
  constructor(canvas: Element, recognizer: GestureRecognizer);
  setMode(mode: string): void;               // "brush" | "select" | "pan" | ...
  on(event: string, cb: (...args: any[]) => void): () => void;
}
```

Ships as a single `interaction.js` (UMD-ish global for ArtMachine's `<script>` tags) that also has a matching `.d.ts` / is written in TS and compiled, so autoflats can `import` it directly. No bundler-specific syntax, no external deps.

## 9. Phased rollout

**Phase 0 — Quick wins in ArtMachine (no architecture change, do first, low risk)**
- Remove the redundant `touchstart`/`mousedown`/`click` listeners in `js/palette.js:48-53` and `js/rangeslider.js:11-14`, leaving only `pointerdown`/`pointermove`/`pointerup`. Fixes the double-fire bug immediately.
- Add `-webkit-touch-callout: none` to the existing canvas CSS block (`index.html` ~line 229).
- Delete or clearly mark `engine.js` / `oldIndex.html` / `index_old.html` / `paperIndex.html` as unused, so the dead pressure-handling code doesn't mislead future readers (or explicitly port its pressure idea into Phase 2 instead of leaving it dangling).

**Phase 1 — Build the shared module**
- Implement `PointerTracker` + `GestureRecognizer` as described in §8, in a new top-level `interaction/` directory, unit-testable in isolation (see §10). Build against ArtMachine first since it's the app with an actual freehand brush tool to validate pressure handling against.

**Phase 2 — Wire into ArtMachine's brush tool**
- Replace `jsPaper.js`'s direct `pointerdown`/`pointermove`/`pointerup` listeners with `InteractionController` subscriptions.
- `brush(event)` reads `pressure`/`tiltX`/`tiltY` from the gesture payload instead of raw `event`, using the floor-adjusted formula in §6.
- `getCursorPosition()` in `palette.js` is superseded by `PointerTracker`'s DPR-corrected coordinates (also fixes the latent scale bug if the canvas is ever styled to a different CSS size than its pixel dimensions).

**Phase 3 — Multi-touch pan/zoom on both apps**
- ArtMachine: replace `user-scalable=no` with the recognizer's `canvas:pan`/`canvas:zoom` gestures driving `paper.view.center`/`paper.view.zoom` — this finally closes the `todo.txt` "pan canvas" item and restores tablet zoom capability.
- autoflats: route `canvasView.ts`'s existing `wheel`-based zoom and its Space-to-pan/Alt-click desktop affordances through the same `canvas:pan`/`canvas:zoom` events the recognizer emits for touch, so touch users get pan/zoom parity with desktop without duplicating the view-transform math.

**Phase 4 — Palm rejection & pen-priority polish**
- Enable `palmRejection: true` by default whenever any `pen` pointer is active.
- Add a user-facing toggle if testing shows any device/browser combination needs it disabled (some Android tablets misreport `pointerType`).

**Phase 5 — Test harness**
- Neither app has any interaction tests today. Add a Playwright-based suite that dispatches synthetic `PointerEvent`s with specific `pointerType`/`pointerId`/`pressure` values against a test page embedding the module, asserting the emitted gesture stream — covers tap vs. drag threshold, two-pointer pinch math, and the palm-rejection rule without needing physical tablet hardware.

**Phase 6 — Device-specific tuning (ongoing)**
- Validate against real hardware once Phase 2–4 land: iPad + Apple Pencil (hover, tilt), Android tablet + S-Pen/generic capacitive stylus, Windows tablet + Surface Pen (barrel button), Wacom display tablet. Tune slop/threshold constants per what actually feels right — these are the numbers most likely to need empirical adjustment.

## 10. Testing strategy

- **Unit tests** for `PointerTracker`/`GestureRecognizer` logic: feed synthetic pointer event sequences (as plain objects, no real DOM needed for the pure state-machine parts) and assert gesture output — tap thresholds, drag classification, pinch scale math, palm-rejection suppression.
- **Integration tests** (Playwright) dispatching real `PointerEvent`s (`new PointerEvent('pointerdown', { pointerType: 'pen', pressure: 0.8, ... })`) against the live canvas in each app, asserting on resulting canvas state (e.g. a stroke was added with expected width).
- **Manual device pass** before considering Phase 3/4 "done" — gesture math can look correct in a synthetic test and still feel wrong on a real touchscreen (latency, coalesced-event smoothing, palm-rejection false positives).

## 11. Open questions / risks

- **Rotate gesture**: worth shipping at all, or intentionally omitted (many pro drawing apps skip canvas-rotate-by-gesture specifically because it's a common accidental trigger during pinch)? Recommend deferring to Phase 6+ based on user feedback rather than building it into the MVP.
- **`pointerType` misreporting**: some older Android WebViews report styluses as `touch`. Palm rejection depends on correct classification — Phase 6's device pass needs to specifically check this rather than assume spec compliance.
- **autoflats' existing keyboard-modifier interactions** (Space-to-pan, Alt-click, Shift-click) need a touch-equivalent or an explicit decision that those actions stay desktop-only — worth a short product decision before Phase 3 there, since a tablet user has no Alt key.
- **Coalesced events volume**: `getCoalescedEvents()` can return many samples per frame on high-refresh displays; simplify/decimate before feeding into Paper.js path construction to avoid excessive point counts in saved drawings.
