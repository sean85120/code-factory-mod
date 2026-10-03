import { expect, test } from 'claude-code/testing'

import {
  branchFor,
  checksVerdict,
  classifyBash,
  decisionsHash,
  hasTestChanges,
  parseSettings,
  parseTodo,
  pickNext,
  validateItems,
} from '../hooks/lib'

const TODO = `# Todo

## T-001 [feature] Add login
- status: done
- how: Use passport-local with bcrypt because the user chose session cookies over JWT.
- accept: A user can sign in and out; bad passwords are rejected.
- tests: Unit tests for the verifier, one request-level test per route.

## T-002 [bug] Fix crash on empty cart
- status: todo
- how: Guard the reducer with an early return; no new dependency.
  The crash is the empty array reduce.
- accept: Checkout with an empty cart shows the empty state.
- tests: Regression test that renders checkout with no items.
- depends: T-001

## T-003 [feature] Export CSV
- status: todo
- how: TBD
- accept: short
- tests:
- depends: T-009
`

test('parseTodo reads items, fields and continuation lines', () => {
  const items = parseTodo(TODO)
  expect(items.length).toBe(3)
  expect(items[0]!.status).toBe('done')
  expect(items[1]!.how).toBe('Guard the reducer with an early return; no new dependency. The crash is the empty array reduce.')
  expect(items[1]!.depends).toEqual(['T-001'])
})

test('validateItems flags placeholders, short fields and unknown dependencies', () => {
  const problems = validateItems(parseTodo(TODO)).join('\n')
  expect(problems).toContain('T-003: `how:`')
  expect(problems).toContain('T-003: `accept:`')
  expect(problems).toContain('T-003: `tests:`')
  expect(problems).toContain('unknown item T-009')
  expect(problems).not.toContain('T-001')
  expect(problems).not.toContain('T-002')
})

test('pickNext respects order, dependencies and blocked items', () => {
  const items = parseTodo(TODO)
  expect(pickNext(items, new Set())?.id).toBe('T-002')
  expect(pickNext(items, new Set(['T-002']))).toBeUndefined()
})

test('decisionsHash ignores status but not decisions', () => {
  const s = parseSettings('{"testCmd":["npm","test"]}').settings
  const a = parseTodo(TODO)
  const b = parseTodo(TODO.replace('- status: todo', '- status: done'))
  expect(decisionsHash(s, a)).toBe(decisionsHash(s, b))
  const c = parseTodo(TODO.replace('passport-local', 'something else'))
  expect(decisionsHash(s, a) === decisionsHash(s, c)).toBe(false)
  expect(decisionsHash({ ...s, allowNoCI: true }, a) === decisionsHash(s, a)).toBe(false)
})

test('parseSettings requires a test command', () => {
  expect(parseSettings('{}').problems.length).toBe(1)
  expect(parseSettings('{"testCmd":["pytest"],"baseBranch":"develop"}').settings.baseBranch).toBe('develop')
  expect(parseSettings(null).problems.length).toBe(2)
})

test('branchFor builds a safe branch name', () => {
  expect(branchFor({ id: 'T-014', title: 'Fix: crash on "empty" cart!!' })).toBe('factory/t-014-fix-crash-on-empty-cart')
})

test('classifyBash spots pushes, force pushes, base pushes and merges', () => {
  expect(classifyBash('git push --force origin factory/t-1-x', 'main').isForcePush).toBe(true)
  expect(classifyBash('git push -u origin factory/t-1-x', 'main').isForcePush).toBe(false)
  expect(classifyBash('git push origin main', 'main').pushNamesBase).toBe(true)
  expect(classifyBash('git push origin HEAD:main', 'main').pushNamesBase).toBe(true)
  expect(classifyBash('git push origin factory/t-1-main-menu', 'main').pushNamesBase).toBe(false)
  const m = classifyBash('gh pr merge 12 --squash --delete-branch', 'main')
  expect(m.isPrMerge).toBe(true)
  expect(m.prSelector).toBe('12')
  expect(classifyBash('gh pr merge --admin 12', 'main').hasAdmin).toBe(true)
  expect(classifyBash('echo {} > .factory/state.json', 'main').touchesFactoryState).toBe(true)
  expect(classifyBash('cat .factory/state.json', 'main').touchesFactoryState).toBe(false)
})

test('hasTestChanges recognises common test file layouts', () => {
  expect(hasTestChanges(['src/a.ts', 'src/a.test.ts'])).toBe(true)
  expect(hasTestChanges(['tests/test_a.py'])).toBe(true)
  expect(hasTestChanges(['App/Sources/Foo.swift', 'AppTests/FooTests.swift'])).toBe(true)
  expect(hasTestChanges(['src/a.ts', 'README.md'])).toBe(false)
})

test('checksVerdict wants every check finished and green', () => {
  expect(checksVerdict([], false).ok).toBe(false)
  expect(checksVerdict([], true).ok).toBe(true)
  expect(checksVerdict([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], false).ok).toBe(true)
  expect(checksVerdict([{ name: 'ci', status: 'IN_PROGRESS' }], false).ok).toBe(false)
  expect(checksVerdict([{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }], false).reason).toContain('ci: FAILURE')
  expect(checksVerdict([{ __typename: 'StatusContext', context: 'x', state: 'PENDING' }], false).ok).toBe(false)
})
