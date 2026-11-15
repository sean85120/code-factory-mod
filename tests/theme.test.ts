import { expect, test } from 'claude-code/testing'

import { CLASSIC_THEME, DEFAULT_THEME_CAPS, hackerTheme, loopBadge, HACKER_BACKGROUND, HACKER_PALETTE, budgetColor, checkColor, contrastRatio, decisionsHash, parseSettings, parseThemeArg, parseThemePrefs, parseTodo, progressBar, theme, themeCaps, themeReport } from '../hooks/lib'

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
  expect(themeCaps('', 'dark')).toEqual({ ...DEFAULT_THEME_CAPS })
  expect(themeCaps('1', 'light')).toEqual({ ...DEFAULT_THEME_CAPS, noColor: true, scheme: 'light' })
  expect(themeCaps(undefined, 'light-ansi')).toEqual({ ...DEFAULT_THEME_CAPS, ansi: true, scheme: 'light' })
  expect(themeCaps(undefined, 'Dark-ANSI')).toEqual({ ...DEFAULT_THEME_CAPS, ansi: true })
})

test('the hacker theme picks its palette by caps and drops every color under NO_COLOR', () => {
  const hacker = { name: 'hacker', glyphs: 'auto' } as const
  expect(theme(hacker, DEFAULT_THEME_CAPS).mark.done.color).toBe('#3DF58A')
  expect(theme(hacker, { ...DEFAULT_THEME_CAPS, scheme: 'light' }).mark.done.color).toBe('#0B7A3B')
  expect(theme(hacker, { ...DEFAULT_THEME_CAPS, ansi: true }).mark.done.color).toBe('green')
  const none = theme(hacker, { ...DEFAULT_THEME_CAPS, noColor: true, ansi: true, scheme: 'light' })
  const colors = [...Object.values(none.mark), ...Object.values(none.step)].map(g => g.color)
  expect([...colors, none.running, none.ok, none.warn, none.error, none.accent, none.agent, none.dim].every(c => c === undefined)).toBe(true)
  expect(theme({ name: 'classic', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, noColor: true })).toBe(CLASSIC_THEME)
})

test('stored prefs fall back to classic on junk and the command arguments are checked', () => {
  for (const junk of [undefined, null, 5, 'hacker', [], {}, { name: 'neon' }, { name: 7 }]) expect(parseThemePrefs(junk)).toEqual({ name: 'classic', glyphs: 'auto' })
  expect(parseThemePrefs({ name: 'hacker' })).toEqual({ name: 'hacker', glyphs: 'auto' })
  expect(parseThemeArg('')).toEqual({})
  expect(parseThemeArg('  HACKER ')).toEqual({ prefs: { name: 'hacker' } })
  expect(parseThemeArg('classic')).toEqual({ prefs: { name: 'classic' } })
  for (const bad of ['neon', 'hacker classic', '--help', '../x']) expect(parseThemeArg(bad).problem).toContain('Usage: /factory-theme')
})

test('the theme report names the look and its tier', () => {
  expect(themeReport({ name: 'classic', glyphs: 'auto' }, DEFAULT_THEME_CAPS)).toContain('Look: classic.')
  expect(themeReport({ name: 'hacker', glyphs: 'auto' }, DEFAULT_THEME_CAPS)).toContain('Look: hacker (dark)')
  expect(themeReport({ name: 'hacker', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, scheme: 'light' })).toContain('(light)')
  expect(themeReport({ name: 'hacker', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, ansi: true })).toContain('(16 colors)')
  expect(themeReport({ name: 'hacker', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, noColor: true })).toContain('NO_COLOR')
})

test('the approval hash does not depend on the look', () => {
  const settings = parseSettings(JSON.stringify({ testCmd: ['unit'], baseBranch: 'main' })).settings
  const items = parseTodo('## T-001 [feature] First\n- status: todo\n- how: Use the standard library only, because zero dependencies.\n- accept: The thing works for documented inputs.\n- tests: Unit tests for each input.\n')
  expect(decisionsHash(settings, items)).toBe(decisionsHash({ ...settings }, items))
  expect(Object.keys(settings)).not.toContain('theme')
})

const ASCII = /^[\x20-\x7E]*$/
const STATUSES = ['running', 'waiting', 'pending', 'idle', 'completed', 'failed', 'killed', 'odd']

test('the classic theme keeps the header, labels, rules, marks and fold glyphs exactly', () => {
  const t = theme()
  expect([t.head('RUN'), t.head('HOLD'), t.head('DONE'), t.head('FAIL')]).toEqual(['factory ▶', 'factory ⏸', 'factory ⏸', 'factory ⏸'])
  expect(['⏸ pause', '▶ start', '↻ retry T-003', 'skip T-002'].map(t.label)).toEqual(['⏸ pause', '▶ start', '↻ retry T-003', 'skip T-002'])
  expect(t.rule('Plan', 40)).toBe('Plan')
  expect([t.eventMark, t.changeMark, t.arrow, t.fold.open, t.fold.closed]).toEqual(['⋯', 'Δ', '➜', '▾', '▸'])
})

test('the hacker theme draws the sigil, badges, bars and swapped control glyphs', () => {
  const t = hackerTheme(DEFAULT_THEME_CAPS)
  expect(t.name).toBe('hacker')
  expect((['RUN', 'HOLD', 'DONE', 'FAIL'] as const).map(t.head)).toEqual(['❯ factory [RUN]', '❯ factory [HOLD]', '❯ factory [DONE]', '❯ factory [FAIL]'])
  expect(t.bar(2, 4, 4)).toBe('▰▰▱▱')
  expect(['⏸ pause', '▶ start', '■ stop', '↻ retry T-003', '✔ approve', 'skip T-002', 'plain'].map(t.label)).toEqual(['‖ pause', '▸ start', '■ stop', '↻ retry T-003', '✔ approve', 'skip T-002', 'plain'])
  expect(Object.values(t.mark).map(g => g.glyph)).toEqual(['◆', '▸', '◇', '✖', '·'])
})

test('a rule fills the width exactly, never exceeds it, and is the bare label when the width is unknown', () => {
  for (const t of [hackerTheme(DEFAULT_THEME_CAPS), hackerTheme(DEFAULT_THEME_CAPS, true)]) {
    for (const cols of [0, 1, 3, 6, 7, 8, 20, 80]) expect([cols, t.rule('Plan 1/3', cols).length <= cols]).toEqual([cols, true])
    expect(t.rule('Plan', 40)).toHaveLength(40)
    expect(t.rule('x'.repeat(100), 20)).toHaveLength(20)
  }
  expect(hackerTheme(DEFAULT_THEME_CAPS).rule('Plan', undefined)).toBe('── Plan')
  expect(hackerTheme(DEFAULT_THEME_CAPS, true).rule('Plan', undefined)).toBe('-- Plan')
})

test('every glyph of the ascii tier is printable ASCII, and the unicode tier has none of the emoji-width glyphs', () => {
  const a = hackerTheme(DEFAULT_THEME_CAPS, true)
  const glyphs = [
    ...Object.values(a.mark).map(g => g.glyph),
    ...Object.values(a.step).map(g => g.glyph),
    ...STATUSES.map(a.agentGlyph),
    ...(['RUN', 'HOLD', 'DONE', 'FAIL'] as const).map(a.head),
    a.bar(1, 3, 6),
    a.rule('Plan', 30),
    a.eventMark,
    a.changeMark,
    a.arrow,
    a.fold.open,
    a.fold.closed,
    ...['⏸ pause', '▶ start', '■ stop', '↻ retry T-003', '✔ check setup'].map(a.label),
  ]
  for (const g of glyphs) expect([g, ASCII.test(g)]).toEqual([g, true])
  const u = hackerTheme(DEFAULT_THEME_CAPS)
  const all = [...Object.values(u.mark).map(g => g.glyph), ...Object.values(u.step).map(g => g.glyph), ...STATUSES.map(u.agentGlyph), u.head('HOLD'), u.label('⏸ pause'), u.label('▶ start')].join('')
  expect(all).not.toMatch(/[⏸▶✔]/)
})

test('theme() picks the ascii tier when asked or when the locale is not UTF-8, and never for classic', () => {
  expect(theme({ name: 'hacker', glyphs: 'auto' }, DEFAULT_THEME_CAPS).ascii).toBe(false)
  expect(theme({ name: 'hacker', glyphs: 'ascii' }, DEFAULT_THEME_CAPS).ascii).toBe(true)
  expect(theme({ name: 'hacker', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, utf8: false }).ascii).toBe(true)
  expect(theme({ name: 'classic', glyphs: 'ascii' }, { ...DEFAULT_THEME_CAPS, utf8: false })).toBe(CLASSIC_THEME)
})

test('capabilities read UTF-8 from the locale and a dumb terminal; an unset locale counts as UTF-8', () => {
  expect(themeCaps(undefined, undefined, 'en_US.UTF-8', 'xterm-256color').utf8).toBe(true)
  expect(themeCaps(undefined, undefined, 'en_US.utf8').utf8).toBe(true)
  expect(themeCaps(undefined, undefined, undefined, undefined).utf8).toBe(true)
  for (const locale of ['C', 'POSIX', 'en_US.ISO-8859-1']) expect([locale, themeCaps(undefined, undefined, locale).utf8]).toEqual([locale, false])
  for (const term of ['dumb', 'linux']) expect([term, themeCaps(undefined, undefined, 'en_US.UTF-8', term).utf8]).toEqual([term, false])
})

test('the glyph preference parses, merges and is refused when repeated or unknown', () => {
  expect(parseThemePrefs({ name: 'hacker', glyphs: 'ascii' })).toEqual({ name: 'hacker', glyphs: 'ascii' })
  expect(parseThemePrefs({ name: 'hacker', glyphs: 'braille' })).toEqual({ name: 'hacker', glyphs: 'auto' })
  expect(parseThemeArg('ascii')).toEqual({ prefs: { glyphs: 'ascii' } })
  expect(parseThemeArg('Hacker ASCII')).toEqual({ prefs: { name: 'hacker', glyphs: 'ascii' } })
  expect(parseThemeArg('auto classic')).toEqual({ prefs: { name: 'classic', glyphs: 'auto' } })
  for (const bad of ['ascii auto', 'hacker hacker', 'ascii ascii', 'ascii neon']) expect(parseThemeArg(bad).problem).toContain('Usage: /factory-theme')
  expect(themeReport({ name: 'hacker', glyphs: 'ascii' }, DEFAULT_THEME_CAPS)).toContain('ascii glyphs')
  expect(themeReport({ name: 'hacker', glyphs: 'auto' }, { ...DEFAULT_THEME_CAPS, utf8: false })).toContain('the locale is not UTF-8')
  expect(themeReport({ name: 'classic', glyphs: 'ascii' }, DEFAULT_THEME_CAPS)).not.toContain('ascii')
})

test('the loop badge tells running, held, done and failed apart', () => {
  const base = { running: false, current: null, rows: [], more: 0, blockedCount: 0, doneCount: 0, total: 0 }
  const row = (mark: string) => ({ id: 'T-001', type: 'feature', title: 'x', version: '', mark }) as never
  expect(loopBadge({ ...base, running: true })).toBe('RUN')
  expect(loopBadge({ ...base, rows: [row('todo')] })).toBe('HOLD')
  expect(loopBadge({ ...base, current: 'T-001' })).toBe('HOLD')
  expect(loopBadge({ ...base, more: 2 })).toBe('HOLD')
  expect(loopBadge({ ...base })).toBe('HOLD')
  expect(loopBadge({ ...base, doneCount: 3, total: 3 })).toBe('DONE')
  expect(loopBadge({ ...base, rows: [row('blocked')], blockedCount: 1, doneCount: 2, total: 3 })).toBe('FAIL')
  expect(loopBadge({ ...base, rows: [row('blocked'), row('todo')], blockedCount: 1, doneCount: 1, total: 3 })).toBe('HOLD')
})
