import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_SETTINGS,
  compareVersions,
  declinedLines,
  isBillingProblem,
  isReviewClean,
  markDetail,
  parseReviewMarker,
  parseSettings,
  parseTodo,
  pickNext,
  DESIGN_PROMPT,
  reviewAgentPrompt,
  rereviewSection,
  validateItems,
} from '../hooks/lib'

const TODO = `## T-001 [feature] First
- status: todo
- version: 0.1.0
- how: Use the standard library only, because the person wants zero dependencies.
- accept: The first thing works for the documented inputs.
- tests: Unit tests for each documented input.

## T-002 [feature] Second
- status: todo
- version: 0.2
- how: Use the standard library only, because the person wants zero dependencies.
- accept: The second thing works for the documented inputs.
- tests: Unit tests for each documented input.

## T-003 [feature] Third
- status: todo
- version: 1.0.0
- how: Use the standard library only, because the person wants zero dependencies.
- accept: The third thing works for the documented inputs.
- tests: Unit tests for each documented input.
`

test('versions compare numerically', () => {
  expect(compareVersions('0.2', '0.10.0')).toBe(-1)
  expect(compareVersions('1.0.0', 'v1')).toBe(0)
  expect(compareVersions('2.0', '1.9.9')).toBe(1)
})

test('the loop only picks items up to the stop version', () => {
  const items = parseTodo(TODO)
  expect(pickNext(items, new Set(), '0.2.0')?.id).toBe('T-001')
  const afterFirst = items.map(i => (i.id === 'T-001' ? { ...i, status: 'done' as const } : i))
  expect(pickNext(afterFirst, new Set(), '0.2.0')?.id).toBe('T-002')
  const afterSecond = afterFirst.map(i => (i.id === 'T-002' ? { ...i, status: 'done' as const } : i))
  expect(pickNext(afterSecond, new Set(), '0.2.0')).toBeUndefined()
  expect(pickNext(afterSecond, new Set(), null)?.id).toBe('T-003')
})

test('a stop version makes every open item need a version', () => {
  const items = parseTodo(TODO.replace('- version: 1.0.0\n', ''))
  expect(validateItems(items, null).join()).not.toContain('version')
  expect(validateItems(items, '1.0.0').join()).toContain('T-003: needs a `version:`')
  expect(validateItems(parseTodo(TODO.replace('0.2\n', 'soon\n')), null).join()).toContain('not like 0.2')
})

test('settings carry the new fields and reject a bad stop version', () => {
  const ok = parseSettings('{"testCmd":["t"],"buildCmd":["b"],"e2eCmd":["e"],"stopAfterVersion":"v0.3","contextReset":"compact","tagRelease":true}')
  expect(ok.problems.length).toBe(0)
  expect(ok.settings.buildCmd).toEqual(['b'])
  expect(ok.settings.e2eCmd).toEqual(['e'])
  expect(ok.settings.stopAfterVersion).toBe('0.3')
  expect(ok.settings.contextReset).toBe('compact')
  expect(ok.settings.requireReview).toBe(true)
  expect(parseSettings('{"testCmd":["t"],"stopAfterVersion":"later"}').problems.length).toBe(1)
})

test('a present but malformed buildCmd, e2eCmd or e2eFor is a settings problem, not a silently dropped gate', () => {
  const bad = (extra: string) => parseSettings(`{"testCmd":["t"],${extra}}`).problems.join(' ')
  expect(bad('"buildCmd":"npm run build"')).toContain('buildCmd')
  expect(bad('"e2eCmd":"npx playwright test"')).toContain('e2eCmd')
  expect(bad('"e2eCmd":["a",1]')).toContain('e2eCmd')
  expect(bad('"e2eFor":["features"]')).toContain('e2eFor')
  expect(bad('"e2eFor":"feature"')).toContain('e2eFor')
  expect(bad('"buildCmd":[],"e2eCmd":null,"e2eFor":["feature","bug"]')).toBe('')
})

test('billing failures are recognised, ordinary failures are not', () => {
  expect(isBillingProblem('The job was not started because recent account payments have failed or your spending limit needs to be increased.')).toBe(true)
  expect(isBillingProblem("Please check the 'Billing & plans' section in your settings")).toBe(true)
  expect(isBillingProblem('You have exceeded the included usage of free Actions minutes this month')).toBe(true)
  expect(isBillingProblem('FAIL src/a.test.ts: expected 1 received 2')).toBe(false)
  expect(isBillingProblem('Process completed with exit code 1.')).toBe(false)
})

test('the review marker must be clean and for the current HEAD', () => {
  const text = 'Review done.\nFACTORY-REVIEW: danger=1 medium=2 sha=abc1234\nmore\nFACTORY-REVIEW: danger=0 medium=0 security=0 sha=ABC1234def'
  const mark = parseReviewMarker(text)
  expect(mark).toEqual({ danger: 0, medium: 0, security: 0, sha: 'abc1234def' })
  expect(isReviewClean(mark, 'abc1234def5678')).toBe(true)
  expect(isReviewClean(mark, 'ffff000011112222')).toBe(false)
  expect(isReviewClean({ danger: 0, medium: 1, sha: 'abc1234def' }, 'abc1234def')).toBe(false)
  expect(isReviewClean(null, 'abc1234def')).toBe(false)
  expect(parseReviewMarker('FACTORY-REVIEW: danger=<n> medium=<n> sha=<HEAD sha>')).toBeNull()
})

test('a marker without the security count or with an open security finding is not clean', () => {
  const legacy = parseReviewMarker('FACTORY-REVIEW: danger=0 medium=0 sha=abc1234def')
  expect(legacy).toEqual({ danger: 0, medium: 0, sha: 'abc1234def' })
  expect(isReviewClean(legacy, 'abc1234def')).toBe(false)
  const open = parseReviewMarker('FACTORY-REVIEW: danger=0 medium=0 security=2 sha=abc1234def')
  expect(open?.security).toBe(2)
  expect(isReviewClean(open, 'abc1234def')).toBe(false)
  expect(markDetail(open!)).toBe('danger=0 medium=0 security=2 sha=abc1234')
})

test('diff-only re-review section needs round 2, a valid sha and the open findings', () => {
  const last = { danger: 0, medium: 1, security: 0, sha: 'abc1234def' }
  const open = ['foo.ts:10 missing validation']
  expect(rereviewSection(last, 1, open)).toBe('')
  expect(rereviewSection(null, 3, open)).toBe('')
  expect(rereviewSection({ ...last, sha: 'x; rm -rf' }, 3, open)).toBe('')
  expect(rereviewSection(last, 3, [])).toBe('')
  const s = rereviewSection(last, 2, open)
  expect(s).toContain('git diff abc1234def..HEAD')
  expect(s).toContain('- foo.ts:10 missing validation')
  expect(s).toContain('Pre-existing')
})

test('FACTORY-OPEN lines are read from the answer', () => {
  expect(declinedLines('x\nFACTORY-OPEN: a.ts:1 bad\n FACTORY-DECLINED: b.ts:2 ok', 'OPEN')).toEqual(['a.ts:1 bad'])
})

test('the reviewer prompt carries the review-fix severity rubric, conditional security pass and circuit breaker', () => {
  const p = reviewAgentPrompt({ ...DEFAULT_SETTINGS, maxReviewRounds: 3 }, 'factory/t-001-x')
  for (const needle of ['whether or not /review-fix exists', 'do the review and the fixes yourself', 'Critical/High, counted as danger', 'a finding with no severity or no scenario is Low', 'unverified', 'declined by default', 'only when the diff touches auth, privacy, deletion, payment, CI workflows or installers', 'report security=0', 'larger than about 50 lines', 'more than about 150 lines', 'Circuit breaker: after 3 passes', 'two consecutive passes']) expect(p).toContain(needle)
  expect(DESIGN_PROMPT).toContain('"maxReviewRounds":3')
})

test('the reviewer prompt asks for the security count, verifier votes, tags and REVIEW.md', () => {
  const p = reviewAgentPrompt(DEFAULT_SETTINGS, 'factory/t-001-x')
  for (const needle of ['REVIEW.md', 'verifier', 'Pre-existing', '/security-review', 'FACTORY-REVIEW: danger=<n> medium=<n> security=<n> sha=']) expect(p).toContain(needle)
})
