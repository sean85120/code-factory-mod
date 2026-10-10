import { expect, test } from 'claude-code/testing'

import {
  agentText,
  classifyBash,
  DEFAULT_SETTINGS,
  isBillingProblem,
  normalizePath,
  parseTodo,
  promoteProposed,
  splitCommands,
  testWeakening,
  todoHeadingProblems,
  validateItems,
  workPrompt,
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

test('a double-quoted heredoc commit message does not hide the commands after it', () => {
  const cmd = ['git add -A && git commit -m "$(cat <<\'EOF\'', 'T-001: msg', 'EOF', ')" && git push -u origin HEAD && gh pr create --base main --title "x" --body "y"'].join('\n')
  const f = classifyBash(cmd, 'main', 'factory/t-001-x')
  expect(f.isCommit).toBe(true)
  expect(f.isPush).toBe(true)
  expect(f.isPrCreate).toBe(true)
  const merge = classifyBash(['echo "a', 'b" && gh pr merge 5 --admin --squash'].join('\n'), 'main', 'factory/t-001-x')
  expect(merge.isPrMerge).toBe(true)
  expect(merge.hasAdmin).toBe(true)
  expect(classifyBash(['git commit -m "$(cat <<\'EOF\'', 'x', 'EOF', ')" && git push origin HEAD:main'].join('\n'), 'main', 'factory/t-001-x').pushNamesBase).toBe(true)
})

const lines = (...l: string[]) => l.join('\n')
const facts = (cmd: string) => classifyBash(cmd, 'main', 'factory/t-001-x')

test('an apostrophe or quote in a comment line does not swallow the commands after it', () => {
  expect(facts(lines("# Let's commit", 'git commit -m x', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines("# don't forget", 'gh pr create --fill')).isPrCreate).toBe(true)
  expect(facts(lines('# say "hi', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts('git push origin main # it\'s fine').pushNamesBase).toBe(true)
  expect(splitCommands('echo a#b')).toEqual([['echo', 'a#b']])
})

test('escaped quotes inside a double-quoted message do not desynchronise the next lines', () => {
  expect(facts(lines('git commit -m "Rename \\"foo\\" to \\"bar\\""', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('git commit -m "say \\"hi\\""', 'gh pr create --fill')).isPrCreate).toBe(true)
  expect(facts('git commit -m "say \\"hi\\"" && git push origin main').pushNamesBase).toBe(true)
})

test('backslash-newline joins the continuation line into one command', () => {
  expect(facts(lines('git push origin \\', '+main')).isForcePush).toBe(true)
  expect(facts(lines('git push \\', 'origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('gh pr merge 5 \\', '--admin')).hasAdmin).toBe(true)
})

test('heredoc detection ignores << in quoted text and here-strings, and reads the whole delimiter', () => {
  expect(facts(lines('git commit -m "shift x << y"', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('cat <<< EOF', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('cat <<END-OF', 'body', 'END-OF', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('cat <<\\EOF', "it's body", 'EOF', 'git push origin main')).pushNamesBase).toBe(true)
  expect(splitCommands(lines('cat <<A <<B', 'one', 'A', 'two', 'B', 'ls')).map(c => c[0])).toEqual(['cat', 'ls'])
})

test('an unterminated quote falls back to line-by-line reading so later gated commands are still seen', () => {
  expect(facts(lines('echo "never closed', 'git push origin main')).pushNamesBase).toBe(true)
})

test('${#var}, brace words and arithmetic shifts do not hide the commands after them', () => {
  expect(facts('echo ${#x}; git push origin main').pushNamesBase).toBe(true)
  expect(facts('n=${#files} && git push origin main').pushNamesBase).toBe(true)
  expect(facts('echo {#; git push origin main').pushNamesBase).toBe(true)
  expect(facts(lines('x=$((1<<2))', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('x=$((a<<b))', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts('ls ;# note\ngit push origin main').pushNamesBase).toBe(true)
  expect(facts('git status # git push origin main').isPush).toBe(false)
})

test('a heredoc that never terminates is read again without skipping so gated commands are still seen', () => {
  expect(facts(lines('cat <<EOF', 'body', 'git push origin main')).pushNamesBase).toBe(true)
})

test('a comment ending in a backslash does not join the next line', () => {
  expect(facts(lines('# note: run it \\', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('echo hi # c:\\', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('echo a', '# x \\', '# y \\', 'git push origin main')).pushNamesBase).toBe(true)
  expect(facts(lines('git push origin ma\\', 'in')).pushNamesBase).toBe(true)
})

test('control keywords before a gated command do not hide it', () => {
  for (const c of ['if git push origin main; then echo ok; fi', 'if true; then git push origin main; fi', 'for x in a b; do git push origin main; done', 'until git push origin main; do sleep 1; done', 'while ! git push origin main; do sleep 1; done', '! git push origin main']) {
    expect(facts(c).pushNamesBase).toBe(true)
  }
  expect(facts('if true; then gh pr merge 5 --admin; fi').hasAdmin).toBe(true)
})

test('command substitutions in double quotes and backticks are classified, single-quoted ones are not', () => {
  expect(facts('out="$(git push origin main 2>&1)"').pushNamesBase).toBe(true)
  expect(facts('echo "$(git commit -m x)"').isCommit).toBe(true)
  expect(facts('x="$(gh pr merge 5 --auto)"').hasAuto).toBe(true)
  expect(facts('out=`git push origin main`').pushNamesBase).toBe(true)
  expect(facts('echo `gh pr merge 5 --admin`').hasAdmin).toBe(true)
  expect(facts("git commit -m 'Fix `git push origin main` handling'").isPush).toBe(false)
  expect(facts("gh pr create --body 'runs $(git push origin main)'").isPush).toBe(false)
  expect(facts('git commit -m "fix $(git rev-parse HEAD)"').isPush).toBe(false)
})

test('escaped backticks and \$( in a double-quoted message are literal text, nested substitutions are scanned whole', () => {
  expect(facts('git commit -m "use \\`git push origin main\\` carefully"').isPush).toBe(false)
  expect(facts('gh pr create --title t --body "run \\`gh pr merge 5\\` after"').isPrMerge).toBe(false)
  expect(facts('git commit -m "literal \\$(git push origin main) text"').isPush).toBe(false)
  expect(facts('out="$(git -C "$(git rev-parse --show-toplevel)" push origin main)"').pushNamesBase).toBe(true)
  expect(facts('out="$(cd "$(mktemp -d)" && git push origin main)"').pushNamesBase).toBe(true)
  expect(facts('echo "$(git push origin main; (cd x))"').pushNamesBase).toBe(true)
  expect(facts('echo "$(git push origin main || echo \'fail (x)\')"').pushNamesBase).toBe(true)
})

test('a backslash inside single quotes within a double-quoted $( ) is literal', () => {
  expect(facts('x="$(echo \'a\\\')" && git push origin main').pushNamesBase).toBe(true)
  expect(facts('x="$(echo \'a\\\' \'b\')" ; git push origin main').pushNamesBase).toBe(true)
})

test('a comment with an apostrophe inside a multi-line double-quoted $( ) does not hide what follows', () => {
  expect(facts(lines('echo "$(echo a # it\'s', ')" && git push origin main')).pushNamesBase).toBe(true)
})

test('deeply nested substitutions stay cheap', () => {
  const n = 300
  const open = 'git commit -m "' + '$(echo "'.repeat(n)
  const start = Date.now()
  splitCommands(open)
  splitCommands(open + 'x' + '")'.repeat(n) + '"')
  expect(Date.now() - start).toBeLessThan(2000)
})

test('quoted substitutions nested several levels deep are still classified', () => {
  expect(facts('echo "$(echo "$(echo "$(echo "$(git push origin main)")")")"').pushNamesBase).toBe(true)
  expect(facts('echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(git push origin main)")")")")")")"').pushNamesBase).toBe(true)
})

test('gh api writes are seen through a query string and glued flags', () => {
  expect(classifyBash("gh api -X PUT 'repos/o/r/pulls/3/merge?merge_method=squash'", 'main').apiPrWrite).toBe(true)
  expect(classifyBash("gh api -X PUT 'repos/o/r/merges?x=1'", 'main').apiPrWrite).toBe(true)
  expect(classifyBash('gh api -XPUT repos/o/r/pulls/3/merge', 'main').apiPrWrite).toBe(true)
  expect(classifyBash('gh api repos/o/r/pulls/3/merge -fmerge_method=squash', 'main').apiPrWrite).toBe(true)
  expect(classifyBash('gh api repos/o/r/pulls/3/merge --field=merge_method=squash', 'main').apiPrWrite).toBe(true)
  expect(classifyBash('gh api repos/o/r/pulls/3', 'main').apiPrWrite).toBe(false)
  expect(classifyBash("gh api 'repos/o/r/pulls?state=open'", 'main').apiPrWrite).toBe(false)
})

test('gh api short-flag clusters and -X=PUT hide neither the method nor the body flag', () => {
  for (const c of ['gh api -X=PUT repos/o/r/pulls/3/merge', 'gh api -iXPUT repos/o/r/pulls/3/merge', 'gh api -iX PUT repos/o/r/pulls/3/merge', 'gh api -if k=v repos/o/r/pulls/3/merge -X PUT', 'gh api -ifk=v repos/o/r/pulls']) {
    expect(classifyBash(c, 'main').apiPrWrite).toBe(true)
  }
  expect(classifyBash('gh api -i repos/o/r/pulls/3', 'main').apiPrWrite).toBe(false)
  expect(classifyBash('gh api -H Accept:x repos/o/r/pulls', 'main').apiPrWrite).toBe(false)
})

test('the repository flag is read from tokens, glued or clustered, not from prose', () => {
  const repo = (c: string) => classifyBash(c, 'main').repoFlag
  for (const c of ['gh pr merge 3 -Rother/repo', 'gh pr merge 3 -sRo/r', 'gh pr create -dRo/r', 'gh pr merge 3 "-R" o/r', 'gh pr merge 3 --repo=o/r', 'gh -R o/r pr merge 3']) expect(repo(c)).toBe(true)
  for (const c of ['gh pr create --title x --body "use --reporter flag"', 'gh pr create --title "Add -Recursive"', 'gh pr merge 3 --squash', 'gh pr create --fill']) expect(repo(c)).toBe(false)
})

test('gh persistent flags between pr and the action do not hide the command', () => {
  expect(classifyBash('gh pr -R o/r merge 5 --admin', 'main').hasAdmin).toBe(true)
  expect(classifyBash('gh pr -R o/r merge 5', 'main').isPrMerge).toBe(true)
  expect(classifyBash('gh pr --repo o/r create', 'main').isPrCreate).toBe(true)
  expect(classifyBash('gh pr --repo o/r create', 'main').repoFlag).toBe(true)
})

test('quote-split and mid-token quoted flag values are unquoted', () => {
  for (const c of ['gh api repos/o/r/pulls/5/merge -X"PUT"', 'gh api repos/o/r/pulls/5/merge -iX"PUT"', "gh api repos/o/r/pulls/5/merge -X PU'T'", 'gh api repos/o/r/pulls/5/merge -X "P""UT"']) {
    expect(classifyBash(c, 'main').apiPrWrite).toBe(true)
  }
  expect(splitCommands('git commit -m "a && b" -s')).toEqual([['git', 'commit', '-m', 'a && b', '-s']])
  expect(splitCommands('echo a"b c"d')).toEqual([['echo', 'ab cd']])
})

test('repoFlag ignores the values of other flags', () => {
  const repo = (c: string) => classifyBash(c, 'main').repoFlag
  for (const c of ['gh pr create --title "-Revert foo"', 'gh pr create --body "-Rx"', 'gh pr create --title -Rfoo', 'gh pr create -tRefactor', 'gh pr create -lRelease', 'gh pr merge 5 --subject "-R x"']) expect(repo(c)).toBe(false)
  expect(repo('gh pr create --title x -R o/r')).toBe(true)
})

test('--admin=true and --auto=true count as --admin and --auto', () => {
  expect(classifyBash('gh pr merge 5 --admin=true', 'main').hasAdmin).toBe(true)
  expect(classifyBash('gh pr merge --admin=1 5', 'main').hasAdmin).toBe(true)
  expect(classifyBash('gh pr merge 5 --auto=true', 'main').hasAuto).toBe(true)
  expect(classifyBash('gh pr merge 5 --squash', 'main').hasAdmin).toBe(false)
})

test('several gh pr merge commands or selectors in one command leave no single checked PR', () => {
  expect(classifyBash('gh pr merge 5 --squash; gh pr merge 6 --squash', 'main').prSelector).not.toBe('5')
  expect(classifyBash('gh pr merge 5 6 --squash', 'main').prSelector).not.toBe('5')
  expect(classifyBash('gh pr merge --squash && gh pr merge 6', 'main').prSelector).not.toBeNull()
  expect(classifyBash('gh pr merge 5 --squash', 'main').prSelector).toBe('5')
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

test('work prompt asks for the Reviewed-clean line at PR creation and after a CI fix', () => {
  const it = parseTodo(item('T-001', 'todo'))[0]!
  const p = workPrompt(it, DEFAULT_SETTINGS, null)
  expect(p).toContain('Reviewed-clean: <output of git rev-parse HEAD>')
  expect(p).toContain('gh pr edit <n> --body')
})
