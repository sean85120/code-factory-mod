import { expect, test } from 'claude-code/testing'

import { decisionsHash, parseSettings, parseTodo } from '../hooks/lib'

const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const SETTINGS = '{"testCmd":["npm","test"],"baseBranch":"main"}'
const TODO = `## T-001 [feature] Add thing
- status: todo
- how: Use the standard library only, because the person wants zero dependencies.
- accept: The thing works for the documented inputs.
- tests: Unit tests for each documented input.
`

function files(isRunning: boolean): Record<string, string> {
  const hash = decisionsHash(parseSettings(SETTINGS).settings, parseTodo(TODO))
  return {
    '.factory/settings.json': SETTINGS,
    '.factory/todo.md': TODO,
    '.factory/state.json': JSON.stringify({ approved: true, approvedHash: hash, autopilot: isRunning, current: 'T-001', review: { sha: SHA, danger: 0, medium: 0, security: 0 } }),
  }
}

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const find = (fs: Record<string, string>, path: string): string | undefined =>
  Object.keys(fs).find(k => path.endsWith(`/${k}`))

function mountFiles($: unknown, on: any, fs: Record<string, string>, pr: unknown, branch: string): void {
  void $
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: find(fs, e.path) !== undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: fs[find(fs, e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('git branch')) return { value: ok(`${branch}\n`) }
    if (cmd.startsWith('gh pr view')) return { value: ok(JSON.stringify(pr)) }
    return { value: ok('') }
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran', isError: false }))
}

test('merge is denied while CI is still running', async ($, on) => {
  mountFiles($, on, files(true), { state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'factory/t-001-add-thing', headRefOid: SHA, statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }, 'factory/t-001-add-thing')
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 3 --squash' })
  expect(JSON.stringify(r)).toContain('CI is not green')
})

test('merge goes through when CI is green', async ($, on) => {
  mountFiles($, on, files(true), { state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'factory/t-001-add-thing', headRefOid: SHA, statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }, 'factory/t-001-add-thing')
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 3 --squash' })
  expect(JSON.stringify(r)).not.toContain('code-factory')
})

test('commits on the base branch and force pushes are denied', async ($, on) => {
  mountFiles($, on, files(true), {}, 'main')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git commit -m x' }))).toContain('do not commit on main')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git push --force origin x' }))).toContain('force-push')
})

test('nothing is enforced while the factory is stopped', async ($, on) => {
  mountFiles($, on, files(false), {}, 'main')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git commit -m x' }))).not.toContain('code-factory')
})

const GREEN = { state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'factory/t-001-add-thing', headRefOid: SHA, statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
const said = async ($: any, command: string) => JSON.stringify(await $.tool.call({ tool: 'Bash', command }))

test('merge is denied when the PR head is not the reviewed commit', async ($, on) => {
  mountFiles($, on, files(true), { ...GREEN, headRefOid: 'fff1234def5678abc1234def5678abc1234def56' }, 'factory/t-001-add-thing')
  expect(await said($, 'gh pr merge 3 --squash')).toContain('not the commit the clean review covered')
})

test('--auto, --admin and -R merges are denied', async ($, on) => {
  mountFiles($, on, files(true), GREEN, 'factory/t-001-add-thing')
  expect(await said($, 'gh pr merge 3 --squash --auto')).toContain('--auto')
  expect(await said($, 'gh pr merge 3 --admin')).toContain('--admin')
  expect(await said($, 'gh pr merge 3 -R other/repo --squash')).toContain('-R/--repo')
})

test('gh api writes to pulls, refs or contents are denied, reads are not', async ($, on) => {
  mountFiles($, on, files(true), GREEN, 'factory/t-001-add-thing')
  expect(await said($, 'gh api -X PUT repos/o/r/pulls/3/merge')).toContain('gh api')
  expect(await said($, 'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=x')).toContain('gh api')
  expect(await said($, 'gh api repos/o/r/pulls/3')).not.toContain('code-factory')
})

test('shell tricks do not hide a push to or commit on the base branch', async ($, on) => {
  mountFiles($, on, files(true), GREEN, 'main')
  expect(await said($, 'git -C . commit -m x')).toContain('do not commit on main')
  expect(await said($, 'cd . && git push origin HEAD')).toContain('never push to main')
  expect(await said($, 'git push origin HEAD:refs/heads/main')).toContain('never push to main')
  expect(await said($, 'git checkout -b factory/t-001-x && git commit -m y')).not.toContain('do not commit')
})
