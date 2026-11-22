type Scene = { name: string; component: 'AbovePrompt' | 'Pane'; surface: 'terminal' | 'desktop'; columns: number; look: 'hacker' | 'classic'; mode: 'run' | 'stuck' | 'hold'; press?: string }

const DEMO_LOG = [
  { role: 'user', text: 'Review the branch for T-002: streaks must not grow when an old puzzle is replayed', toolUses: [] },
  { role: 'assistant', text: 'Reading the diff against main first', toolUses: [{ tool: 'Bash', input: { command: 'git diff origin/main...HEAD --stat' }, text: '4 files changed, 118 insertions(+), 9 deletions(-)' }] },
  { role: 'assistant', text: 'The streak is computed in one place, checking the replay path', toolUses: [{ tool: 'Read', input: { file_path: 'src/streak.ts' }, text: 'export function streak(days: Day[]): number {' }] },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'bun test tests/streak.test.ts' }, text: '12 pass, 0 fail' }] },
]

const DEMO_MAIN = [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'bun test tests/streak.test.ts' }, text: '12 pass, 0 fail' }] }]

const SCENES: Scene[] = [
  { name: 'band-hacker', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'hacker', mode: 'run' },
  { name: 'band-classic', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'classic', mode: 'run' },
  { name: 'band-hold', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'hacker', mode: 'hold' },
  { name: 'band-stuck', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'hacker', mode: 'stuck' },
  { name: 'pane-hacker', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker', mode: 'run' },
  { name: 'pane-classic', component: 'Pane', surface: 'terminal', columns: 110, look: 'classic', mode: 'run' },
  { name: 'pane-agent', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker', mode: 'run', press: 'agent-rev1' },
  { name: 'pane-desktop', component: 'Pane', surface: 'desktop', columns: 110, look: 'hacker', mode: 'run' },
  { name: 'pane-hold', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker', mode: 'hold' },
  { name: 'pane-stuck', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker', mode: 'stuck' },
]

const NOW = /Building T-002, attempt 1\/\d+/
const LAST = /Last action: Bash: bun test tests\/streak\.test\.ts/
const STUCK = /no progress for 5 min: wait, or \/factory-pause/
const HOLD = [/1 item blocked: T-003/, /\/factory-retry T-003/]

function expected(s: Scene): RegExp[] {
  if (s.mode === 'hold') return HOLD
  const pane = s.component === 'Pane' && !s.press
  if (s.mode === 'stuck') return pane ? [NOW, LAST, STUCK] : [NOW, STUCK]
  return pane ? [NOW, LAST] : [NOW]
}

for (const s of SCENES) {
  test(`capture ${s.name}`, async ($, on) => {
    const running = s.mode !== 'hold'
    const clock = fixture($, on, { blocked: ['T-003'], agents: [REVIEWER], messages: { rev1: DEMO_LOG, main: DEMO_MAIN }, store: { 'ui/theme': { name: s.look } }, claudeTheme: 'dark', autopilot: false, persist: true })
    on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
    on('prompt.compose', () => ({ sections: [] }))
    on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
    on('tool.call', () => ({ result: 'ran', text: 'ran' }))
    await $.command.run({ command: 'factory-theme' } as never)
    if (running) {
      await $.command.run({ command: 'factory-start' } as never)
      await clock.advance(1000)
      await $.turn.start({ turnId: 't1', text: 'CODE FACTORY: work item' } as never)
      await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
      if (s.mode === 'stuck') await clock.advance(5 * 60000 + 2000)
    }
    await $.command.run({ command: 'factory-status' } as never)
    const ui = await $.ui.mount({ plugin: 'code-factory', surface: s.surface, component: s.component, ...(s.component === 'Pane' ? { requestId: 'factory' } : {}), props: { hasSurvey: false, bodyColumns: s.columns } } as never)
    if (s.press) await ui.press({ key: s.press })
    for (const re of expected(s)) {
      expect(await ui.find({ text: re }), `${s.name} lacks ${re}`).toBeDefined()
    }
    const root = await ui.find({ type: 'Box' })
    await ui.unmount()
    expect(false, `DEMO-SCENE ${JSON.stringify({ ...s, root })}`).toBe(true)
  })
}
