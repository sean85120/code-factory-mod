type Scene = { name: string; component: 'AbovePrompt' | 'Pane'; surface: 'terminal' | 'desktop'; columns: number; look: 'hacker' | 'classic'; press?: string }

const DEMO_LOG = [
  { role: 'user', text: 'Review the branch for T-002: streaks must not grow when an old puzzle is replayed', toolUses: [] },
  { role: 'assistant', text: 'Reading the diff against main first', toolUses: [{ tool: 'Bash', input: { command: 'git diff origin/main...HEAD --stat' }, text: '4 files changed, 118 insertions(+), 9 deletions(-)' }] },
  { role: 'assistant', text: 'The streak is computed in one place, checking the replay path', toolUses: [{ tool: 'Read', input: { file_path: 'src/streak.ts' }, text: 'export function streak(days: Day[]): number {' }] },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'bun test tests/streak.test.ts' }, text: '12 pass, 0 fail' }] },
]

const SCENES: Scene[] = [
  { name: 'band-hacker', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'hacker' },
  { name: 'band-classic', component: 'AbovePrompt', surface: 'terminal', columns: 130, look: 'classic' },
  { name: 'pane-hacker', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker' },
  { name: 'pane-classic', component: 'Pane', surface: 'terminal', columns: 110, look: 'classic' },
  { name: 'pane-agent', component: 'Pane', surface: 'terminal', columns: 110, look: 'hacker', press: 'agent-rev1' },
  { name: 'pane-desktop', component: 'Pane', surface: 'desktop', columns: 110, look: 'hacker' },
]

for (const s of SCENES) {
  test(`capture ${s.name}`, async ($, on) => {
    fixture($, on, { blocked: ['T-003'], agents: [REVIEWER], messages: { rev1: DEMO_LOG }, store: { 'ui/theme': { name: s.look } }, claudeTheme: 'dark' })
    await $.command.run({ command: 'factory-status' } as never)
    await $.command.run({ command: 'factory-theme' } as never)
    const ui = await $.ui.mount({ plugin: 'code-factory', surface: s.surface, component: s.component, ...(s.component === 'Pane' ? { requestId: 'factory' } : {}), props: { hasSurvey: false, bodyColumns: s.columns } } as never)
    if (s.press) await ui.press({ key: s.press })
    const root = await ui.find({ type: 'Box' })
    await ui.unmount()
    expect(false, `DEMO-SCENE ${JSON.stringify({ ...s, root })}`).toBe(true)
  })
}
