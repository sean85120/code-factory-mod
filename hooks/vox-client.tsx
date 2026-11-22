import type { ClientModule, ClientPointerEvent } from 'claude-code'

import { DEFAULT_COLOR, GAZE_TIMEOUT_MS, VOX_CELL_COLUMNS, VOX_CELL_ROWS, VOX_FRAME_MS, VOX_STATES, faceWords, gazeFrom, isHexColor, poseAt } from './lib'
import type { VoxGaze, VoxState } from './lib'

export type VoxClientProps = { state: VoxState; hex: string }

export type VoxClientState = { frame: number; gaze: VoxGaze | null; seen: number; vox: VoxState | null; entered: number }

export type VoxClientEvent =
  | { type: 'tick'; vox: VoxState }
  | { type: 'pointer'; event: Pick<ClientPointerEvent, 'type' | 'x' | 'y' | 'fine'>; box: { columns: number; rows: number } }

export const VOX_CLIENT_START: VoxClientState = { frame: 0, gaze: null, seen: 0, vox: null, entered: -1 }

export function reduceVox(s: VoxClientState, ev: VoxClientEvent): VoxClientState {
  if (ev.type === 'tick') {
    const frame = s.frame + 1
    const changed = ev.vox !== s.vox
    const gaze = s.gaze !== null && (frame - s.seen) * VOX_FRAME_MS >= GAZE_TIMEOUT_MS ? null : s.gaze
    return { frame, gaze, seen: s.seen, vox: ev.vox, entered: changed ? (s.vox === null ? -1 : frame) : s.entered }
  }
  if (ev.event.type === 'leave') return s.gaze === null ? s : { ...s, gaze: null }
  const gaze = gazeFrom(ev.event, ev.box)
  return gaze === null ? s : { ...s, gaze, seen: s.frame }
}

export type VoxSpan = { text: string; fg?: string; bg?: string }

const hex = (n: number): string | undefined => (n === DEFAULT_COLOR ? undefined : `#${(n & 0xffffff).toString(16).padStart(6, '0')}`)

export function voxRows(props: VoxClientProps, s: VoxClientState): VoxSpan[][] {
  const vox = props.state
  const since = s.entered < 0 ? Number.POSITIVE_INFINITY : (s.frame - s.entered) * VOX_FRAME_MS
  const words = faceWords(poseAt(vox, s.frame * VOX_FRAME_MS, since, s.gaze), props.hex)
  const rows: VoxSpan[][] = []
  for (let r = 0; r < VOX_CELL_ROWS; r++) {
    const row: VoxSpan[] = []
    for (let x = 0; x < VOX_CELL_COLUMNS; x++) {
      const i = (r * VOX_CELL_COLUMNS + x) * 3
      const glyph = String.fromCodePoint(words[i]!)
      const fg = hex(words[i + 1]!)
      const bg = hex(words[i + 2]!)
      const last = row[row.length - 1]
      if (last !== undefined && last.fg === fg && last.bg === bg) last.text += glyph
      else row.push({ text: glyph, fg, bg })
    }
    rows.push(row)
  }
  return rows
}

const live = new WeakMap<object, { vox: VoxState }>()

const VoxClient: ClientModule<VoxClientProps, VoxClientState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const valid = VOX_STATES.includes(props?.state) && isHexColor(props?.hex)
  const vox: VoxState = valid ? props.state : 'idle'
  const ref = live.get(surface)
  if (ref !== undefined) ref.vox = vox
  else {
    const mine = { vox }
    live.set(surface, mine)
    const now = (): VoxClientState => surface.state ?? VOX_CLIENT_START
    surface.every(VOX_FRAME_MS, () => surface.setState(reduceVox(now(), { type: 'tick', vox: mine.vox })))
    surface.onPointer(event => surface.setState(reduceVox(now(), { type: 'pointer', event, box: { columns: surface.columns || VOX_CELL_COLUMNS, rows: surface.rows || VOX_CELL_ROWS } })))
  }
  if (!valid) return <Text> </Text>
  const rows = voxRows(props, surface.state ?? VOX_CLIENT_START)
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => (
        <Box key={`r${r}`}>
          {row.map((sp, i) => (
            <Text key={`s${i}`} color={sp.fg} backgroundColor={sp.bg}>
              {sp.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export default VoxClient
