import { expect, test } from 'claude-code/testing'

import { CLASSIC_THEME, DEFAULT_THEME_CAPS, VOX_CELL_COLUMNS, VOX_CELL_ROWS, faceCells, isHexColor, poseAt, unpackCells, VOX_STATES, VOX_WIDTH, hackerTheme, loopBadge, voxArt, voxFace, voxSpeech, voxState, HACKER_BACKGROUND, HACKER_PALETTE, budgetColor, checkColor, contrastRatio, decisionsHash, parseSettings, parseThemeArg, parseThemePrefs, parseTodo, progressBar, theme, themeCaps, themeReport } from '../hooks/lib'

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

const vv = (o: Record<string, unknown> = {}) => ({ approved: true, running: false, stage: null, current: null, rows: [], more: 0, blockedCount: 0, doneCount: 0, total: 0, pausedReason: null, runUsd: null, budgetUsd: 0, reviewRound: null, maxReviewRounds: null, ...o }) as never
const vrow = (id: string, mark: string, title = 'x') => ({ id, type: 'feature', title, version: '', mark })

test('the mascot state follows the loop: blocked, budget, held, done, reviewing, running and idle', () => {
  expect(voxState(vv({ approved: false }))).toBe('idle')
  expect(voxState(vv({ running: true, current: 'T-002', stage: 'build' }))).toBe('run')
  expect(voxState(vv({ running: true, current: 'T-002', stage: 'review' }))).toBe('review')
  expect(voxState(vv({ running: true, current: null, stage: 'review' }))).toBe('run')
  expect(voxState(vv({ rows: [vrow('T-002', 'todo')] }))).toBe('hold')
  expect(voxState(vv({ rows: [vrow('T-002', 'todo')], pausedReason: 'budget reached: $5.00 of $5.00' }))).toBe('budget')
  expect(voxState(vv({ doneCount: 3, total: 3 }))).toBe('done')
  expect(voxState(vv({ rows: [vrow('T-003', 'blocked')], blockedCount: 1, doneCount: 2, total: 3, pausedReason: 'budget reached' }))).toBe('blocked')
})

test('every mascot face is 9 rows of 17 printable ASCII columns and no two states look alike', () => {
  const seen = new Set<string>()
  for (const s of VOX_STATES) {
    const art = voxArt(s)
    expect([s, art.length]).toEqual([s, 9])
    for (const row of art) expect([s, row.length, ASCII.test(row)]).toEqual([s, VOX_WIDTH, true])
    seen.add(art.join('\n'))
  }
  expect(seen.size).toBe(VOX_STATES.length)
  expect(voxArt('run')[4]).toBe('|   (o)   (o)   |')
  expect(voxArt('hold')[4]).toBe('|   (-)   (-)   |')
  expect(voxArt('blocked')[6]).toBe(' \\    /---\\    / ')
})

test('the one-line faces are ASCII and the classic theme draws no mascot at all', () => {
  expect(VOX_STATES.map(voxFace)).toEqual(['(o_o)', '(o_O)', '(^_^)', '(-_-)', '(x_x)', '($_$)', '(o_o)'])
  for (const s of VOX_STATES) {
    expect(ASCII.test(voxFace(s))).toBe(true)
    expect(theme().face(s)).toBe('')
    expect(theme().vox[s]).toBeUndefined()
    expect(hackerTheme(DEFAULT_THEME_CAPS).face(s)).toBe(voxFace(s))
  }
  expect(Object.values(hackerTheme({ ...DEFAULT_THEME_CAPS, noColor: true }).vox).every(c => c === undefined)).toBe(true)
  expect(hackerTheme(DEFAULT_THEME_CAPS).vox.blocked).toBe('#FF4D6D')
})

test('the mascot speaks only fixed words, ids and numbers: no title, reason or other repo text reaches it', () => {
  const evil = '<script>SECRET\u001b[31m'
  const base = { running: true, current: 'T-002', stage: 'build', rows: [vrow('T-002', 'doing', evil), vrow('T-003', 'todo', evil), vrow('T-004', 'blocked', evil)], blockedCount: 1, pausedReason: evil }
  const said = [
    voxSpeech(vv(base)),
    voxSpeech(vv({ ...base, running: false })),
    voxSpeech(vv({ ...base, stage: 'review', reviewRound: 2, maxReviewRounds: 3 })),
    voxSpeech(vv({ approved: false })),
    voxSpeech(vv({ doneCount: 3, total: 3 })),
    voxSpeech(vv({ rows: [vrow('T-004', 'blocked', evil)], blockedCount: 1, doneCount: 2, total: 3 })),
    voxSpeech(vv({ pausedReason: evil })),
    voxSpeech(vv({ rows: [vrow('T-002', 'todo')], pausedReason: 'budget reached', runUsd: 5, budgetUsd: 5 })),
  ].flat()
  expect(said).toContain('working on T-002')
  expect(said).toContain('next: T-003')
  expect(said).toContain('round 2/3')
  expect(said).toContain('T-004 needs you')
  expect(said).toContain('$5.00 of $5.00')
  for (const line of said) expect([line, line.length <= 40, /SECRET|script|\u001b/.test(line)]).toEqual([line, true, false])
})

test('poses are a pure function of the clock: same input same pose, blinks come on a cadence, the look drifts', () => {
  for (const s of VOX_STATES) expect(poseAt(s, 1234, 500)).toEqual(poseAt(s, 1234, 500))
  expect([1500, 1600, 1700, 5000, 5100].map(t => poseAt('run', t, Number.POSITIVE_INFINITY).eyes)).toEqual(['closed', 'closed', 'open', 'closed', 'closed'])
  const closed = Array.from({ length: 175 }, (_, i) => poseAt('run', i * 40, Number.POSITIVE_INFINITY).eyes === 'closed').filter(Boolean).length
  expect(closed).toBeGreaterThan(2)
  expect(closed).toBeLessThan(14)
  expect(new Set([0, 1200, 2400, 3600].map(t => poseAt('run', t, 0).look))).toEqual(new Set([0, 1, -1]))
  expect(poseAt('review', 0, 0).brow).toBe('raised')
  expect(poseAt('review', 600, 0).glint).not.toBeNull()
})

test('done celebrates only on an observed transition, then settles; blocked shakes then stops; the coin spins then stills', () => {
  const lifts = [0, 200, 500, 700, 800, 1700].map(s => poseAt('done', 9000, s).lift)
  expect(lifts).toEqual([1, 2, 1, 0, 1, 0])
  expect(poseAt('done', 9000, 100).sparkle).not.toBeNull()
  expect(poseAt('done', 9000, 3500)).toMatchObject({ lift: 0, sparkle: null, glow: 0.9 })
  const settled = poseAt('done', 9000, Number.POSITIVE_INFINITY)
  expect([settled.lift, settled.sparkle]).toEqual([0, null])
  expect([30, 100, 900].map(s => poseAt('blocked', 9000, s).shake)).toEqual([-1, 1, 0])
  expect(poseAt('blocked', 9000, Number.POSITIVE_INFINITY).shake).toBe(0)
  expect([50, 150, 250, 2500].map(s => poseAt('budget', 0, s).coin)).toEqual([0, 1, 2, 0])
  expect(new Set([0, 500, 1000, 1500, 2000, 2500].map(t => poseAt('hold', t, 0).z)).size).toBe(6)
  expect(poseAt('hold', 0, 0).eyes).toBe('closed')
})

test('a face is a decodable grid of width-1 half-block cells that changes with the pose, the tone and the glow', () => {
  const still = poseAt('run', 0, Number.POSITIVE_INFINITY)
  const f = faceCells(still, '#3DF58A')
  expect([f.columns, f.rows]).toEqual([VOX_CELL_COLUMNS, VOX_CELL_ROWS])
  const words = unpackCells(f.cells)
  expect(words).toHaveLength(VOX_CELL_COLUMNS * VOX_CELL_ROWS * 3)
  const glyphs = new Set<number>()
  for (let i = 0; i < words.length; i += 3) glyphs.add(words[i]!)
  expect([...glyphs].every(g => g === 0x20 || g === 0x2580 || g === 0x2584)).toBe(true)
  expect(glyphs.has(0x2580)).toBe(true)
  expect(faceCells(still, '#3DF58A').cells).toBe(f.cells)
  expect(faceCells(still, '#FF4D6D').cells).not.toBe(f.cells)
  expect(faceCells({ ...still, eyes: 'closed' }, '#3DF58A').cells).not.toBe(f.cells)
  expect(faceCells({ ...still, lift: 2 }, '#3DF58A').cells).not.toBe(f.cells)
  expect(faceCells({ ...still, glow: 0.2 }, '#3DF58A').cells).not.toBe(f.cells)
  const states = VOX_STATES.map(s => faceCells(poseAt(s, 0, Number.POSITIVE_INFINITY), '#3DF58A').cells)
  expect(new Set(states).size).toBe(VOX_STATES.length)
  for (const s of VOX_STATES) for (const t of [0, 333, 1111, 2777]) for (const since of [0, 250, 5000]) expect(unpackCells(faceCells(poseAt(s, t, since), '#3DF58A').cells)).toHaveLength(VOX_CELL_COLUMNS * VOX_CELL_ROWS * 3)
})

test('only a six-digit hex color can paint the face, and the motion preference parses, reports and reaches the theme', () => {
  expect(['#3DF58A', '#0b7a3b'].map(isHexColor)).toEqual([true, true])
  for (const bad of [undefined, 'green', '#3DF58', '#3DF58AA', '3DF58A', '#GGGGGG']) expect(isHexColor(bad)).toBe(false)
  expect(hackerTheme(DEFAULT_THEME_CAPS).motion).toBe(true)
  expect(hackerTheme(DEFAULT_THEME_CAPS, false, false).motion).toBe(false)
  expect(theme({ name: 'hacker', glyphs: 'auto', motion: 'off' }, DEFAULT_THEME_CAPS).motion).toBe(false)
  expect(theme({ name: 'hacker', glyphs: 'auto' }, DEFAULT_THEME_CAPS).motion).toBe(true)
  expect(theme().motion).toBe(false)
  expect(parseThemePrefs({ name: 'hacker', motion: 'off' })).toEqual({ name: 'hacker', glyphs: 'auto', motion: 'off' })
  expect(parseThemePrefs({ name: 'hacker', motion: 'fast' })).toEqual({ name: 'hacker', glyphs: 'auto' })
  expect(parseThemeArg('motion off')).toEqual({ prefs: { motion: 'off' } })
  expect(parseThemeArg('hacker motion off ascii')).toEqual({ prefs: { name: 'hacker', glyphs: 'ascii', motion: 'off' } })
  expect(parseThemeArg('motion on').prefs).toHaveProperty('motion', undefined)
  for (const bad of ['motion', 'motion maybe', 'motion off motion on', 'off']) expect(parseThemeArg(bad).problem).toContain('Usage: /factory-theme')
  expect(themeReport({ name: 'hacker', glyphs: 'auto', motion: 'off' }, DEFAULT_THEME_CAPS)).toContain('motion off')
})
