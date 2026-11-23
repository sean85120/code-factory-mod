# Live checks

The test harness drives the dashboard and Vox through mocked engine calls. It cannot paint a pane, send a real pointer or run a real `/compact`. `CLAUDE.md` and the `CHANGELOG` mark the points below as unverified live. Run them once in a real session after a release that touches the dashboard, and report what differs.

Before any check: install or load the plugin (`claude --plugin-dir <path>`), approve a plan in a scratch repo that has at least one todo item, and open the pane with `/factory-dashboard`. Close it with its `[close]` button or `/factory-dashboard off`.

## 1. The Vox `Client` mounts in the pane

Added in 0.4.5. Module `hooks/vox-client.tsx`, key `vox-gaze`.

- Preconditions: terminal surface (not the desktop app), pane at least 70 columns wide, hacker look (the default), a UTF-8 locale, a hex-capable color terminal, `NO_COLOR` unset, `/factory-theme motion on`.
- Steps: open the pane and look at Vox. Leave the pointer outside the pane for a few seconds.
- Expected: the animated block-pixel face (30 by 12 cells) is drawn and keeps blinking and drifting. No error toast.
- If the engine faults the `Client`, it leaves it out and the blitted `Raster` face stays exactly as before. That is the fallback, so a face that still animates but never looks at the pointer is the sign of a `Client` that did not mount.
- Report: the terminal and version, the pane width, whether the face is drawn, and any toast or `ui.fault` text.

## 2. The `Client` overlay lines up with the `Raster` face

- Preconditions: as check 1.
- Steps: with the loop running or idle, look at the face. Then move the pointer slowly across it from the left edge to the right edge and from the top to the bottom.
- Expected: one face, not two. The `Client` rows sit exactly over the `Raster` rows with no doubled eyes, no one-cell offset and no blank gap above or below. The pane layout (the speech beside the face) does not shift.
- Report: a screenshot or description of the offset (columns and rows), and the pane width.

## 3. The pointer moves Vox's eyes, over the face area only

- Preconditions: as check 1, in a state with open eyes (running, reviewing or idle). Done, hold, blocked and budget states ignore the pointer on purpose.
- Steps: move the pointer over the face, toward each corner, then to the middle. Move it over the speech text beside the face. Move it out of the pane. Hold it still over the face for 6 seconds. Move it over the face and then straight out.
- Expected:
  - Over the face the pupils move toward the pointer: up to two half-pixel columns sideways and one half-pixel row up or down, with a dead zone near the center.
  - Over the speech beside the face nothing happens, because the plugin API reports a pointer only over a `Client` region (the 30 by 12 cell area).
  - On leave, or after 6 seconds without a pointer event (`GAZE_TIMEOUT_MS`), the gaze clears and the face returns to its drift and scan.
- Report: which of the three behaviors failed, the state Vox was in, and the terminal.

## 4. Sub-cell coordinates and terminal support

- Preconditions: as check 1. Repeat in each terminal you use.
- Steps: move the pointer within one cell of the face, in small steps.
- Expected: kitty, Ghostty, iTerm2, WezTerm and foot report pointer events, and with sub-cell (`fine`) coordinates the pupils move in steps smaller than a cell. tmux does not report them, so under tmux Vox keeps its normal animation and never looks at the pointer.
- Report: the terminal, whether pointer events arrive at all, and whether the movement is per cell or finer.

## 5. The surface module runs at the frame rate

- Preconditions: as check 1.
- Steps: watch the blink, the idle drift and the review scan for a minute, with the pointer outside the pane and then over the face.
- Expected: `surface.every` redraws the module at `VOX_FRAME_MS` in the surface module, without `atob` (the module uses `faceWords`). The face animates smoothly and a celebration or shake that starts while the pointer is over the face still plays.
- Report: stutter or frozen frames, and whether they appear only while the pointer is over the face.

## 6. The desktop surface

- Preconditions: the Claude desktop app, hacker look, `NO_COLOR` unset.
- Steps: open the pane. Hover a plan row. Switch the Claude theme between light and dark. Run `/factory-theme motion off`.
- Expected:
  - The pane forces the dark palette whatever the Claude theme is and fills its root with the console background.
  - A plan row gets the hover color.
  - Vox is drawn as an SVG face and the current item's stages as an SVG pipeline, both sized to fit the pane. The face animates, and the pipeline has a pulse. With motion off the face has no animation block and the pipeline's pulse is the only motion left.
  - Bordered sections are not drawn: the `borderStyle` strings are not enumerated.
- The test harness checks the fill, the two `Svg` elements and their alt text, but not the hover or the sizing.
- Report: which of fill, hover, face size or pipeline size is wrong, with a screenshot.

## 7. `/compact` during a review wait and the spend mark

- Preconditions: a budget set in `settings.json` or not, a loop running an item whose independent review is pending, and a spend ledger readable (`/factory-costs` prints figures).
- Steps: while the reviewer runs, type `/compact`. Wait for the review to finish. Run `/factory-costs` and `/factory-status`.
- Expected: the `/compact` turn's own spend is not charged to the item. If `/compact` produces a `turn.complete`, the open mark is rebased and the gap is not charged. If it does not, its spend lands on the open mark at the next settle and shows as a small over-charge, which is the accepted direction for a budget.
- Report: whether the item's cost jumped by about the size of the `/compact` turn, and the cost before and after.
