import { expect, test } from 'claude-code/testing'

import { CLASSIC_THEME, DEFAULT_THEME_CAPS, HACKER_BACKGROUND, HACKER_PALETTE, budgetColor, checkColor, contrastRatio, decisionsHash, parseSettings, parseThemeArg, parseThemePrefs, parseTodo, progressBar, theme, themeCaps, themeReport } from '../hooks/lib'

test('the classic theme reproduces the marks, step glyphs, agent glyphs and colors the band always drew', () => {
  const t = theme()
  expect(t).toBe(CLASSIC_THEME)
  expect(t.name).toBe('classic')
  expect(Object.fromEntries(Object.entries(t.mark).map(([k, g]) => [k, [g.glyph, g.color]]))).toEqual({
    done: ['✓', 'green'],
    doing: ['▶', 'yellow'],
    todo: ['○', undefined],
    blocked: ['✗', 'red'],
    proposed: ['·', undefined],
  })
  expect(Object.fromEntries(Object.entries(t.step).map(([k, g]) => [k, [g.glyph, g.color]]))).toEqual({ done: ['✓', 'green'], doing: ['●', 'yellow'], todo: ['○', undefined] })
  expect(['running', 'waiting', 'pending', 'idle', 'completed', 'failed', 'killed', 'odd'].map(t.agentGlyph)).toEqual(['●', '◐', '○', '◌', '✓', '✗', '✗', '·'])
  expect([t.running, t.ok, t.warn, t.error]).toEqual(['green', 'green', 'yellow', 'red'])
})

test('the classic bar is the plain progress bar', () => {
  for (const [d, n, w] of [[0, 0, 4], [1, 3, 8], [3, 3, 8], [7, 3, 6], [1, 2, undefined]] as const) expect(theme().bar(d, n, w)).toBe(progressBar(d, n, w))
})

test('budget and check colors follow the theme roles', () => {
  const t = theme()
  expect(budgetColor(t, { runUsd: null, budgetUsd: 5 })).toBeUndefined()
  expect(budgetColor(t, { runUsd: 3, budgetUsd: 0 })).toBeUndefined()
  expect(budgetColor(t, { runUsd: 3, budgetUsd: 5 })).toBeUndefined()
  expect(budgetColor(t, { runUsd: 4, budgetUsd: 5 })).toBe('yellow')
  expect(budgetColor(t, { runUsd: 5, budgetUsd: 5 })).toBe('red')
  expect(['fail', 'warn', 'ok'].map(s => checkColor(t, s))).toEqual(['red', 'yellow', 'green'])
})

test('every hacker text role reaches 4.5:1 on its background and the dim role 3:1', () => {
  for (const scheme of ['dark', 'light'] as const) {
    const { dim, ...text } = HACKER_PALETTE[scheme]
    for (const [role, hex] of Object.entries(text)) expect([role, contrastRatio(hex, HACKER_BACKGROUND[scheme]) >= 4.5]).toEqual([role, true])
    expect(contrastRatio(dim, HACKER_BACKGROUND[scheme])).toBeGreaterThanOrEqual(3)
  }
  expect(Math.round(contrastRatio('#000000', '#FFFFFF'))).toBe(21)
})

test('caps come from NO_COLOR and the Claude theme name: ansi wins over light, junk is dark', () => {
  expect(themeCaps(undefined, undefined)).toEqual(DEFAULT_THEME_CAPS)
  expect(themeCaps('', 'dark')).toEqual({ noColor: false, ansi: false, scheme: 'dark' })
  expect(themeCaps('1', 'light')).toEqual({ noColor: true, ansi: false, scheme: 'light' })
  expect(themeCaps(undefined, 'light-ansi')).toEqual({ noColor: false, ansi: true, scheme: 'light' })
  expect(themeCaps(undefined, 'Dark-ANSI')).toEqual({ noColor: false, ansi: true, scheme: 'dark' })
})

test('the hacker theme picks its palette by caps and drops every color under NO_COLOR', () => {
  const hacker = { name: 'hacker' } as const
  expect(theme(hacker, DEFAULT_THEME_CAPS).mark.done.color).toBe('#3DF58A')
  expect(theme(hacker, { noColor: false, ansi: false, scheme: 'light' }).mark.done.color).toBe('#0B7A3B')
  expect(theme(hacker, { noColor: false, ansi: true, scheme: 'dark' }).mark.done.color).toBe('green')
  const none = theme(hacker, { noColor: true, ansi: true, scheme: 'light' })
  const colors = [...Object.values(none.mark), ...Object.values(none.step)].map(g => g.color)
  expect([...colors, none.running, none.ok, none.warn, none.error, none.accent, none.agent, none.dim].every(c => c === undefined)).toBe(true)
  expect(theme({ name: 'classic' }, { noColor: true, ansi: false, scheme: 'dark' })).toBe(CLASSIC_THEME)
})

test('stored prefs fall back to classic on junk and the command arguments are checked', () => {
  for (const junk of [undefined, null, 5, 'hacker', [], {}, { name: 'neon' }, { name: 7 }]) expect(parseThemePrefs(junk)).toEqual({ name: 'classic' })
  expect(parseThemePrefs({ name: 'hacker' })).toEqual({ name: 'hacker' })
  expect(parseThemeArg('')).toEqual({})
  expect(parseThemeArg('  HACKER ')).toEqual({ prefs: { name: 'hacker' } })
  expect(parseThemeArg('classic')).toEqual({ prefs: { name: 'classic' } })
  for (const bad of ['neon', 'hacker classic', '--help', '../x']) expect(parseThemeArg(bad).problem).toContain('Usage: /factory-theme')
})

test('the theme report names the look and its tier', () => {
  expect(themeReport({ name: 'classic' }, DEFAULT_THEME_CAPS)).toContain('Look: classic.')
  expect(themeReport({ name: 'hacker' }, DEFAULT_THEME_CAPS)).toContain('Look: hacker (dark)')
  expect(themeReport({ name: 'hacker' }, { noColor: false, ansi: false, scheme: 'light' })).toContain('(light)')
  expect(themeReport({ name: 'hacker' }, { noColor: false, ansi: true, scheme: 'dark' })).toContain('(16 colors)')
  expect(themeReport({ name: 'hacker' }, { noColor: true, ansi: false, scheme: 'dark' })).toContain('NO_COLOR')
})

test('the approval hash does not depend on the look', () => {
  const settings = parseSettings(JSON.stringify({ testCmd: ['unit'], baseBranch: 'main' })).settings
  const items = parseTodo('## T-001 [feature] First\n- status: todo\n- how: Use the standard library only, because zero dependencies.\n- accept: The thing works for documented inputs.\n- tests: Unit tests for each input.\n')
  expect(decisionsHash(settings, items)).toBe(decisionsHash({ ...settings }, items))
  expect(Object.keys(settings)).not.toContain('theme')
})
