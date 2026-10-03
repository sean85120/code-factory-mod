import { expect, mock, test } from 'claude-code/testing'

import { REVIEW_TAG, decisionsHash, evaluateProtection, isLockedByOther, parseLock, parseSettings, parseTodo, testWeakening } from '../hooks/lib'

void REVIEW_TAG

const DELETED = `diff --git a/tests/old.test.ts b/tests/old.test.ts
deleted file mode 100644
index 111..000
--- a/tests/old.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-test('x', () => {})
`
const LOST_ASSERTS = `diff --git a/src/a.test.ts b/src/a.test.ts
index 1..2 100644
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -3,2 +3,0 @@
-  expect(add(1, 2)).toBe(3)
-  expect(add(2, 2)).toBe(4)
@@ -9,0 +7,1 @@
+  expect(add(0, 0)).toBe(0)
`
const SKIPPED = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -3,0 +4,1 @@
+  it.skip('flaky', () => { expect(1).toBe(1) })
`
const FINE = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -3,1 +3,2 @@
-  const x = 1
+  const x = 2
+  expect(add(x, 1)).toBe(3)
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,0 @@
-  expect(thing)
-  assert(thing)
`

test('testWeakening catches deleted, skipped and thinned-out tests only', () => {
  expect(testWeakening(DELETED).join()).toContain('deleted test files: tests/old.test.ts')
  expect(testWeakening(LOST_ASSERTS).join()).toContain('1 more assertion/test lines removed than added')
  expect(testWeakening(SKIPPED).join()).toContain('skipped/only/todo')
  expect(testWeakening(FINE)).toEqual([])
})

test('lock ownership and staleness', () => {
  expect(parseLock(null)).toEqual({ owner: null, heartbeat: 0 })
  expect(parseLock('not json')).toEqual({ owner: null, heartbeat: 0 })
  expect(isLockedByOther({ owner: 'a', heartbeat: 1000 }, 'me', 50000)).toBe(true)
  expect(isLockedByOther({ owner: 'me', heartbeat: 1000 }, 'me', 50000)).toBe(false)
  expect(isLockedByOther({ owner: 'a', heartbeat: 1000 }, 'me', 500000)).toBe(false)
  expect(isLockedByOther({ owner: null, heartbeat: 0 }, 'me', 1)).toBe(false)
})

test('branch protection is judged from classic protection and rulesets', () => {
  expect(evaluateProtection(null, [], 'main')[0]).toContain('no branch protection')
  const solid = {
    required_pull_request_reviews: { required_approving_review_count: 0 },
    required_status_checks: { contexts: ['ci'], checks: [] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
  }
  expect(evaluateProtection(solid, [], 'main')).toEqual([])
  const weak = { ...solid, required_status_checks: { contexts: [], checks: [] }, enforce_admins: { enabled: false }, allow_force_pushes: { enabled: true } }
  const w = evaluateProtection(weak, [], 'main').join('\n')
  expect(w).toContain('status checks')
  expect(w).toContain('force-pushes')
  expect(w).toContain('admins')
  expect(evaluateProtection(null, [{ type: 'pull_request' }, { type: 'required_status_checks' }, { type: 'non_fast_forward' }], 'main')).toEqual([])
})

// ---------------------------------------------------------------- integration

const TODO = `## T-001 [feature] Add thing
- status: todo
- how: Use the standard library only, because the person wants zero dependencies.
- accept: The thing works for the documented inputs.
- tests: Unit tests for each documented input.
`
const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const ok = (stdout: string, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

type Fx = { settings?: Record<string, unknown>; lock?: unknown; branch?: string; fullDiff?: string; protectionExit?: number }

function setup($: any, on: any, fx: Fx): Record<string, string> {
  const settingsText = JSON.stringify({ testCmd: ['unit'], baseBranch: 'main', ...fx.settings })
  const hash = decisionsHash(parseSettings(settingsText).settings, parseTodo(TODO))
  const files: Record<string, string> = {
    '.factory/settings.json': settingsText,
    '.factory/todo.md': TODO,
    '.factory/design.md': '# Design\n\n## Decisions\n- chose x\n',
    '.factory/state.json': JSON.stringify({ approved: true, approvedHash: hash, autopilot: true, current: 'T-001', review: { sha: SHA, danger: 0, medium: 0 } }),
  }
  if (fx.lock !== undefined) files['.factory/lock.json'] = JSON.stringify(fx.lock)
  const writes: Record<string, string> = {}
  const key = (path: string) => Object.keys(files).find(k => path.endsWith(`/${k}`))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: key(e.path) !== undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[key(e.path) ?? ''] ?? '' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    writes[e.path.replace(/^.*\/\.factory\//, '.factory/')] = e.text
    const k = key(e.path)
    files[k ?? e.path.replace(/^.*\/\.factory\//, '.factory/')] = e.text
    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const cmd = e.argv.join(' ')
    if (cmd.startsWith('git branch')) return { value: ok(`${fx.branch ?? 'factory/t-001-add-thing'}\n`) }
    if (cmd.startsWith('git rev-parse')) return { value: ok(`${SHA}\n`) }
    if (cmd.includes('git diff -U0')) return { value: ok(fx.fullDiff ?? '') }
    if (cmd.startsWith('git diff')) return { value: ok('src/a.ts\nsrc/a.test.ts\n') }
    if (cmd.includes('/protection')) return { value: ok('', fx.protectionExit ?? 1, 'gh: Branch not protected (HTTP 404)') }
    if (cmd.includes('/rules/branches')) return { value: ok('[]') }
    return { value: ok('') }
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran', isError: false }))
  return writes
}

const text = (r: unknown) => JSON.stringify(r)

test('a PR that weakens tests is refused unless the person allowed it', async ($, on) => {
  setup($, on, { fullDiff: LOST_ASSERTS })
  expect(text(await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' }))).toContain('weakens the tests')
})

test('allowTestRemoval lets it through', async ($, on) => {
  setup($, on, { fullDiff: LOST_ASSERTS, settings: { allowTestRemoval: true } })
  expect(text(await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x' }))).not.toContain('code-factory')
})

test('guards stand down while another live session holds the lock', async ($, on) => {
  const clock = mock.clock(on, { now: 1_030_000 })
  void clock
  setup($, on, { branch: 'main', lock: { owner: 'someone-else', heartbeat: 1_000_000 } })
  expect(text(await $.tool.call({ tool: 'Bash', command: 'git commit -m x' }))).not.toContain('code-factory')
})

test('a stale lock does not switch the guards off', async ($, on) => {
  mock.clock(on, { now: 9_000_000 })
  setup($, on, { branch: 'main', lock: { owner: 'someone-else', heartbeat: 1_000_000 } })
  expect(text(await $.tool.call({ tool: 'Bash', command: 'git commit -m x' }))).toContain('do not commit on main')
})

test('the model cannot write the lock file', async ($, on) => {
  setup($, on, {})
  expect(text(await $.tool.call({ tool: 'Bash', command: 'echo {} > .factory/lock.json' }))).toContain('controlled by the person')
  expect(text(await $.tool.call({ tool: 'Write', file_path: '/repo/.factory/lock.json', content: '{}' }))).toContain('controlled by the person')
})

test('/factory-start refuses while another session holds the lock', async ($, on) => {
  mock.clock(on, { now: 1_030_000 })
  setup($, on, { lock: { owner: 'someone-else', heartbeat: 1_000_000 } })
  const r = await $.command.run({ command: 'factory-start' } as never)
  expect(r.text).toContain('another session')
})

test('/factory-approve warns about missing branch protection, or blocks when required', async ($, on) => {
  setup($, on, {})
  const r = await $.command.run({ command: 'factory-approve' } as never)
  expect(r.text).toContain('Approved')
  expect(r.text).toContain('no branch protection')
})

test('/factory-approve blocks on missing protection when required', async ($, on) => {
  setup($, on, { settings: { requireBranchProtection: true } })
  const r = await $.command.run({ command: 'factory-approve' } as never)
  expect(r.text).toContain('Not approved')
  expect(r.text).toContain('no branch protection')
})
