import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decisionsHash, DEFAULT_STATE, parseSettings, parseTodo } from '../hooks/lib.ts'
import { commandOf, handle, shellCommand } from './hook.ts'

const TODO = `# Todo

## T-001 [feature] Add login
- status: todo
- how: a server-rendered form posting to /login, checked with bcrypt
- accept: a valid user lands on the dashboard; a wrong password shows an error
- tests: unit tests for the handler and an e2e test of the form
`
const SETTINGS = JSON.stringify({ baseBranch: 'main', testCmd: ['true'] })

function repo(state: Record<string, unknown> | null): { dir: string; data: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-codex-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  mkdirSync(join(dir, '.factory'))
  writeFileSync(join(dir, '.factory/settings.json'), SETTINGS)
  writeFileSync(join(dir, '.factory/todo.md'), TODO)
  writeFileSync(join(dir, '.factory/design.md'), '# Design\n\n## Decisions\n')
  if (state) {
    const approvedHash = decisionsHash(parseSettings(SETTINGS).settings, parseTodo(TODO))
    writeFileSync(join(dir, '.factory/state.json'), JSON.stringify({ ...DEFAULT_STATE, approved: true, approvedHash, ...state }))
  }
  return { dir, data: mkdtempSync(join(tmpdir(), 'cf-codex-data-')) }
}

const stateOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.factory/state.json'), 'utf8')) as { autopilot: boolean; pausedReason: string | null }

test('commands are read from $factory-x prompts and composer mentions', () => {
  assert.deepEqual(commandOf('$factory-start'), { name: 'factory-start', args: '' })
  assert.deepEqual(commandOf('  $factory-skip T-004 needs a decision\nmore'), { name: 'factory-skip', args: 'T-004 needs a decision' })
  assert.deepEqual(commandOf('[$factory-status](/x/SKILL.md)'), { name: 'factory-status', args: '' })
  assert.equal(commandOf('please run $factory-start'), null)
  assert.equal(commandOf('factory-start'), null)
})

test('shell commands are read from a string or an argv', () => {
  assert.equal(shellCommand({ command: 'git push' }), 'git push')
  assert.equal(shellCommand({ command: ['bash', '-lc', 'git push origin main'] }), 'git push origin main')
  assert.equal(shellCommand({ command: ['git', 'status'] }), 'git status')
})

test('a repo without .factory/ is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-codex-'))
  assert.deepEqual(await handle({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { PLUGIN_DATA: dir }), {})
})

test('a live loop denies a push to the base branch and an edit of the hooks', async () => {
  const { dir, data } = repo({ autopilot: true, current: 'T-001' })
  const env = { PLUGIN_DATA: data }
  const push = await handle({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, env)
  assert.equal((push.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'deny')
  const patch = await handle({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .codex/hooks.json\n*** End Patch' } }, env)
  assert.match(JSON.stringify(patch), /cannot be changed while the factory loop is live/)
  assert.deepEqual(await handle({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'Bash', tool_input: { command: 'git status' } }, env), {})
})

test('a $factory command typed by the person is answered by the hook, not the model', async () => {
  const { dir, data } = repo({ autopilot: false, pausedReason: 'stopped by you' })
  const out = await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's', prompt: '$factory-status' }, { PLUGIN_DATA: data })
  assert.equal(out.decision, 'block')
  assert.match(String(out.reason), /Factory: paused \(stopped by you\)/)
})

test('$factory-start hands the work item to this turn, and Stop continues with the next step', async () => {
  const { dir, data } = repo({ autopilot: false })
  const env = { PLUGIN_DATA: data }
  const out = await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's', prompt: '$factory-start' }, env)
  const ctx = String((out.hookSpecificOutput as { additionalContext: string }).additionalContext)
  assert.match(ctx, /CODE FACTORY: work item T-001/)
  assert.match(ctx, /spawn_agent/)
  assert.match(ctx, /\$factory-/)
  assert.equal(stateOf(dir).autopilot, true)

  const stop = await handle({ hook_event_name: 'Stop', cwd: dir, session_id: 's', last_assistant_message: 'done' }, env)
  assert.equal(stop.decision, 'block')
  const reason = String(stop.reason)
  assert.match(reason, /T-001 retry/)
  const file = /instructions for this step are in (\S+\.md)\./.exec(reason)?.[1]
  assert.ok(file && readFileSync(file, 'utf8').includes('T-001 is not marked done'))

  // The continuation comes back through UserPromptSubmit: it is the factory's, not the person's.
  const echoed = await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's', prompt: reason }, env)
  assert.match(JSON.stringify(echoed), /full instructions for this step/)
  assert.equal(stateOf(dir).autopilot, true)

  const person = await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's', prompt: 'actually, stop and explain' }, env)
  assert.match(String(person.systemMessage), /factory paused: you sent a prompt; \$factory-start resumes/)
  assert.equal(stateOf(dir).autopilot, false)
  assert.deepEqual(await handle({ hook_event_name: 'Stop', cwd: dir, session_id: 's' }, env), {})
})

test('another Codex session does not take over a fresh lock', async () => {
  const { dir, data } = repo({ autopilot: false })
  await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 'one', prompt: '$factory-start' }, { PLUGIN_DATA: data })
  const other = await handle({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 'two', prompt: '$factory-start' }, { PLUGIN_DATA: data })
  assert.match(String(other.reason), /another session is running the factory/)
})

test('the hook script runs as Codex runs it and answers with JSON', () => {
  const { dir, data } = repo({ autopilot: true, current: 'T-001' })
  const hooks = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  const command = hooks.hooks.PreToolUse![0]!.hooks[0]!.command
  const root = fileURLToPath(new URL('..', import.meta.url))
  const r = spawnSync('sh', ['-c', command], {
    cwd: dir,
    env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push --force origin x' } }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /force-push/)
})
