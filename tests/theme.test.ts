import { expect, test } from 'claude-code/testing'

import { CLASSIC_THEME, budgetColor, checkColor, progressBar, theme } from '../hooks/lib'

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
