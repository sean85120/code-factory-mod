import { expect, test } from 'claude-code/testing'

import {
  agentText,
  classifyBash,
  isBillingProblem,
  normalizePath,
  parseTodo,
  promoteProposed,
  splitCommands,
  testWeakening,
  todoHeadingProblems,
  validateItems,
} from '../hooks/lib'

const BODY = `- how: Use the standard library only, because zero dependencies.
- accept: The thing works for the documented inputs.
- tests: Unit tests for each documented input.
`
const item = (id: string, status: string, extra = '') => `## ${id} [feature] Thing ${id}\n- status: ${status}\n${BODY}${extra}`

test('the commented template skeleton yields no items; fenced code too', () => {
  const skeleton = '# Todo\n\n<!-- Format:\n## T-001 [feature] Short title\n- status: proposed\n- how: x\n-->\n\n```\n## T-002 [bug] Example\n```\n'
  expect(parseTodo(skeleton)).toEqual([])
  expect(todoHeadingProblems(skeleton)).toEqual([])
})

test('a malformed heading is reported instead of merging into the item above', () => {
  const text = `${item('T-001', 'todo')}\n## T-002 [feat] Typo in type\n${BODY}`
  expect(todoHeadingProblems(text).join()).toContain('T-002')
  expect(parseTodo(text)).toHaveLength(1)
})

test('headings are case-insensitive, status must be a known word', () => {
  const items = parseTodo(`## t-001 [Feature] Lower\n- status: Todo\n${BODY}`)
  expect(items[0]?.id).toBe('T-001')
  expect(validateItems(items).join()).toContain('must be proposed, todo or done')
  expect(validateItems(parseTodo(`## T-001 [feature] No status\n${BODY}`)).join()).toContain('missing a `- status:`')
})

test('dependency cycles and self-dependencies are rejected', () => {
  const text = `${item('T-001', 'todo', '- depends: T-002\n')}\n${item('T-002', 'todo', '- depends: T-001\n')}\n${item('T-003', 'todo', '- depends: T-003\n')}`
  const problems = validateItems(parseTodo(text)).join('\n')
  expect(problems).toContain('dependency cycle')
  expect(problems).toContain('T-003: depends on itself')
})

test('promoteProposed only touches live proposed lines, block by block', () => {
  const raw = `<!--\n## T-009 [feature] Ghost\n- status: proposed\n-->\n${item('T-001', 'proposed')}\n${item('T-002', 'done')}`
  const out = promoteProposed(raw)
  expect(out.ids).toEqual(['T-001'])
  expect(out.text).toContain('## T-009 [feature] Ghost\n- status: proposed')
  expect(parseTodo(out.text).map(i => i.status)).toEqual(['todo', 'done'])
})

test('shell splitting follows quotes and heredocs', () => {
  expect(splitCommands('cd x && git commit -m "a && b"; echo hi')).toEqual([['cd', 'x'], ['git', 'commit', '-m', 'a && b'], ['echo', 'hi']])
  const heredoc = splitCommands("cat <<'EOF'\ngit push origin main\nEOF\nls")
  expect(heredoc.map(c => c[0])).toEqual(['cat', 'ls'])
})

test('classifyBash sees through -C, env prefixes, branch switches and -R', () => {
  expect(classifyBash('git -C sub commit -m x', 'main', 'main').commitsOnBase).toBe(true)
  expect(classifyBash('FOO=1 sudo git push origin HEAD', 'main', 'main').pushesBase).toBe(true)
  expect(classifyBash('git switch -c factory/t-1-x && git commit -m y', 'main', 'main').commitsOnBase).toBe(false)
  expect(classifyBash('git checkout main && git commit -m y', 'main', 'factory/t-1-x').commitsOnBase).toBe(true)
  expect(classifyBash('git push origin :main', 'main', 'x').isForcePush).toBe(true)
  const m = classifyBash('gh -R o/r pr merge --squash https://github.com/o/r/pull/3 --auto', 'main')
  expect(m.isPrMerge).toBe(true)
  expect(m.hasAuto).toBe(true)
  expect(m.prSelector).toBe('https://github.com/o/r/pull/3')
  expect(classifyBash('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x', 'main').apiPrWrite).toBe(true)
  expect(classifyBash('gh api repos/o/r/pulls/3', 'main').apiPrWrite).toBe(false)
  expect(classifyBash('gh pr checks 3 --watch', 'main').isCiLookup).toBe(true)
})

test('writing the state file through a script or redirect is caught, reading it is not', () => {
  expect(classifyBash("python3 -c \"open('.factory/state.json','w').write('{}')\"", 'main').touchesFactoryState).toBe(true)
  expect(classifyBash('sed -i s/a/b/ .factory/lock.json', 'main').touchesFactoryState).toBe(true)
  expect(classifyBash('git commit -m "update state.json docs"', 'main').touchesFactoryState).toBe(false)
  expect(classifyBash('cat .factory/state.json', 'main').touchesFactoryState).toBe(false)
})

test('normalizePath resolves dots so ../ cannot dodge the file guard', () => {
  expect(normalizePath('/repo/sub/../.factory/./state.json')).toBe('/repo/.factory/state.json')
  expect(normalizePath('.factory/state.json')).toBe('.factory/state.json')
})

test('billing detection is narrow: test output about payments is not billing', () => {
  expect(isBillingProblem('FAIL billing.test.ts  payment failed for card 4242')).toBe(false)
  expect(isBillingProblem('expected invoice to exceed the free plan')).toBe(false)
  expect(isBillingProblem('The job was not started because recent account payments have failed')).toBe(true)
  expect(isBillingProblem("Check 'Billing & plans' to fix your spending limit")).toBe(true)
})

test('agentText reads content blocks only', () => {
  expect(agentText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], prompt: 'FACTORY-REVIEW: danger=0' })).toBe('a\nb')
  expect(agentText('plain')).toBe('plain')
  expect(agentText(undefined)).toBe('')
})

test('testWeakening notices a test file renamed out of the tests', () => {
  const diff = 'diff --git a/tests/a.test.ts b/src/a.ts\nsimilarity index 90%\nrename from tests/a.test.ts\nrename to src/a.ts\n'
  expect(testWeakening(diff).join()).toContain('moved out of the tests')
})
