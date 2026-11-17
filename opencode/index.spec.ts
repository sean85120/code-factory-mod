import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { branchFor, decisionsHash, DEFAULT_STATE, parseSettings, parseTodo, reviewAgentPrompt } from '../hooks/lib.ts'
import plugin, { toolPaths } from './index.ts'

const TODO = `# Todo

## T-001 [feature] Add login
- status: todo
- how: a server-rendered form posting to /login, checked with bcrypt
- accept: a valid user lands on the dashboard; a wrong password shows an error
- tests: unit tests for the handler and an e2e test of the form
`
const SETTINGS = JSON.stringify({ baseBranch: 'main', testCmd: ['true'] })

function repo(state: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-oc-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  mkdirSync(join(dir, '.factory'))
  writeFileSync(join(dir, '.factory/settings.json'), SETTINGS)
  writeFileSync(join(dir, '.factory/todo.md'), TODO)
  writeFileSync(join(dir, '.factory/design.md'), '# Design\n\n## Decisions\n')
  const approvedHash = decisionsHash(parseSettings(SETTINGS).settings, parseTodo(TODO))
  writeFileSync(join(dir, '.factory/state.json'), JSON.stringify({ ...DEFAULT_STATE, approved: true, approvedHash, ...state }))
  return dir
}

type Fn = (e: any) => Promise<void> | void

async function load(dir: string) {
  const hooks = new Map<string, Fn>()
  const commands = new Map<string, { execute: Fn }>()
  const prompts: { sessionID: string; text: string; metadata?: unknown }[] = []
  const said: string[] = []
  let transcript: unknown[] = []
  const reg = { dispose: async () => {} }
  const ctx = {
    location: { directory: dir },
    command: { transform: async (cb: (e: unknown) => void) => (cb({ add: (d: { name: string; execute: Fn }) => commands.set(d.name, d) }), reg) },
    session: {
      hook: async (name: string, cb: Fn) => (hooks.set(`session.${name}`, cb), reg),
      prompt: async (x: { sessionID: string; text: string; metadata?: unknown }) => {
        prompts.push(x)
        return {}
      },
      synthetic: async (x: { text: string }) => {
        said.push(x.text)
        return {}
      },
      context: async () => transcript,
      compact: async () => ({}),
    },
    tool: { hook: async (name: string, cb: Fn) => (hooks.set(`tool.${name}`, cb), reg) },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
  }
  const cleanup = await plugin.setup(ctx as never)
  return {
    hooks,
    commands,
    prompts,
    said,
    setTranscript: (t: unknown[]) => {
      transcript = t
    },
    cleanup: typeof cleanup === 'function' ? cleanup : () => {},
  }
}

const stateOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.factory/state.json'), 'utf8')) as Record<string, unknown>

test('file tool paths include patch headers', () => {
  assert.deepEqual(toolPaths({ path: 'a.ts' }), ['a.ts'])
  assert.deepEqual(toolPaths({ patchText: '*** Begin Patch\n*** Update File: .opencode/opencode.json\n*** End Patch' }), ['.opencode/opencode.json'])
})

test('every factory command is registered', async () => {
  const p = await load(repo({ autopilot: false }))
  assert.deepEqual([...p.commands.keys()].sort(), ['factory-approve', 'factory-design', 'factory-doctor', 'factory-log', 'factory-pause', 'factory-retry', 'factory-skip', 'factory-start', 'factory-status', 'factory-stop'])
  p.cleanup()
})

test('the start command submits the work item, the idle hook the next step, and a person\'s prompt pauses', async () => {
  const dir = repo({ autopilot: false })
  const p = await load(dir)
  await p.commands.get('factory-start')!.execute({ sessionID: 'ses_main', prompt: { text: '' }, delivery: 'steer' })
  assert.match(p.said[0] ?? '', /Factory running/)
  assert.match(p.prompts[0]?.text ?? '', /CODE FACTORY: work item T-001[\s\S]*Host notes \(OpenCode\)/)
  assert.deepEqual(p.prompts[0]?.metadata, { codeFactory: 'work' })

  // A factory prompt passing the prompt hook is not the person's.
  await p.hooks.get('session.prompt')!({ sessionID: 'ses_main', prompt: { text: p.prompts[0]!.text }, metadata: { codeFactory: 'work' } })
  assert.equal(stateOf(dir).autopilot, true)

  // While a subagent still runs, the idle hook waits.
  await p.hooks.get('session.experimental.idle')!({ sessionID: 'ses_main', background: [{ kind: 'subagent' }] })
  assert.equal(p.prompts.length, 1)
  await p.hooks.get('session.experimental.idle')!({ sessionID: 'ses_main', background: [] })
  assert.match(p.prompts[1]?.text ?? '', /T-001 is not marked done/)

  await p.hooks.get('session.prompt')!({ sessionID: 'ses_main', prompt: { text: 'hold on' } })
  assert.equal(stateOf(dir).autopilot, false)
  p.cleanup()
})

test('the gates throw, which stops the tool call', async () => {
  const dir = repo({ autopilot: true, current: 'T-001' })
  const p = await load(dir)
  const before = p.hooks.get('tool.execute.before')!
  await assert.rejects(async () => before({ tool: 'shell', sessionID: 'ses_main', input: { command: 'git push origin main' } }), /never push to main/)
  await assert.rejects(async () => before({ tool: 'write', sessionID: 'ses_main', input: { path: '.factory/state.json', content: '{}' } }), /controlled by the person/)
  await assert.rejects(async () => before({ tool: 'edit', sessionID: 'ses_main', input: { path: 'opencode.json', oldString: 'a', newString: 'b' } }), /cannot be changed/)
  await before({ tool: 'shell', sessionID: 'ses_main', input: { command: 'git status' } })
  p.cleanup()
})

test('the reviewer: exact prompt, its child session id, and the verdict from its last message', async () => {
  const dir = repo({ autopilot: true, current: 'T-001' })
  const p = await load(dir)
  const exact = reviewAgentPrompt(parseSettings(SETTINGS).settings, branchFor({ id: 'T-001', title: 'Add login' }))
  const before = p.hooks.get('tool.execute.before')!
  await assert.rejects(async () => before({ tool: 'subagent', sessionID: 'ses_main', input: { agent: 'explore', prompt: exact } }), /plain general-purpose agent/)
  const call = { tool: 'subagent', sessionID: 'ses_main', input: { agent: 'general', description: 'review', prompt: exact } as Record<string, unknown> }
  await before(call)
  assert.ok(String(call.input.prompt).startsWith(exact))
  await p.hooks.get('tool.execute.after')!({ tool: 'subagent', sessionID: 'ses_main', input: call.input, status: 'completed', result: { output: { sessionID: 'ses_child1', status: 'running' } } })
  assert.equal(stateOf(dir).reviewAgentId, 'ses_child1')
  p.setTranscript([{ type: 'assistant', content: [{ type: 'text', text: 'FACTORY-REVIEW: danger=0 medium=0 security=0 sha=abcdef0' }] }])
  await p.hooks.get('session.experimental.idle')!({ sessionID: 'ses_child1', background: [] })
  assert.deepEqual(stateOf(dir).review, { danger: 0, medium: 0, security: 0, sha: 'abcdef0' })
  p.cleanup()
})
