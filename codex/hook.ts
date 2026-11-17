// code-factory for Codex: one hook script for every event. Codex runs it once
// per event with the event's JSON on stdin and reads a JSON answer from stdout
// (see codex/hooks.json). The loop, commands and gates come from
// core/factory.ts; flags that must outlive one process are kept in the
// plugin's data directory.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFactory, patchPaths, PENDING_REVIEWER } from '../core/factory.ts'
import type { Host, Prompt, Reply } from '../core/factory.ts'
import { fileRuntime, nodeIo } from '../core/io.ts'
import { FACTORY_DIR, REVIEW_TAG } from '../hooks/lib.ts'

export const NOTES = {
  work: `Host notes (Codex): the "Agent tool" above is spawn_agent here. For the review, spawn one agent whose message is the review prompt, unchanged and with no other options, then wait for it to finish with the wait tool; the factory reads the FACTORY-REVIEW line from the reviewer's own final message. Ask the person nothing; the loop runs unattended. The person's commands are typed as $factory-start, $factory-stop and so on.`,
  design: `Host notes (Codex): ask the person your questions directly in your reply, one short round (1-4 questions) at a time, and end your turn to wait for the answers (use request_user_input instead when it is available). The person's commands are typed as $factory-approve and $factory-start.`,
  waitForReviewer: `CODE FACTORY: the review agent for the current item is still running. Wait for it to finish (call the wait tool on it); do not spawn a second reviewer and do not change the code meanwhile. Then continue the work item: open the PR if its verdict is clean, otherwise fix the findings and review again as step 6 says.`,
}

export type HookInput = {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  agent_id?: string | null
  prompt?: string
  last_assistant_message?: string | null
}

export type HookOutput = Record<string, unknown>

type Obj = Record<string, unknown>
const asObj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {})
const str = (x: unknown): string => (typeof x === 'string' ? x : '')

// `$factory-start`, `$factory-skip T-004 reason`, and the `[$factory-x](path)`
// form a composer may turn a skill mention into.
export function commandOf(prompt: string): { name: string; args: string } | null {
  const first = prompt.trimStart().split('\n', 1)[0] ?? ''
  const m = /^\[?[$/](factory-[a-z]+)\]?(?:\([^)]*\))?(?:\s+(.*))?$/.exec(first.trim())
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null
}

// The command text of a shell tool call: a string, or an argv such as ["bash", "-lc", "..."].
export function shellCommand(toolInput: unknown): string {
  const c = asObj(toolInput).command ?? asObj(toolInput).cmd
  if (typeof c === 'string') return c
  if (Array.isArray(c) && c.every(x => typeof x === 'string')) {
    const i = c.findIndex(x => x === '-c' || x === '-lc' || x === '-ic')
    return i >= 0 && i + 1 < c.length ? (c[i + 1] as string) : c.join(' ')
  }
  return ''
}

// Which argument of a spawn call carries the review prompt.
function reviewField(toolInput: Obj): string | null {
  for (const [k, v] of Object.entries(toolInput)) if (typeof v === 'string' && v.includes(REVIEW_TAG)) return k
  for (const [k, v] of Object.entries(toolInput)) {
    if (Array.isArray(v)) {
      const i = v.findIndex(x => typeof asObj(x).text === 'string' && str(asObj(x).text).includes(REVIEW_TAG))
      if (i >= 0) return `${k}.${i}`
    }
  }
  return null
}

function withPrompt(toolInput: Obj, field: string, prompt: string): Obj {
  const [k, i] = field.split('.')
  if (i === undefined) return { ...toolInput, [k!]: prompt }
  const list = [...(toolInput[k!] as unknown[])]
  list[Number(i)] = { ...asObj(list[Number(i)]), text: prompt }
  return { ...toolInput, [k!]: list }
}

// Only a field that names the agent's id is taken: SubagentStart/SubagentStop
// identify the reviewer by agent_id, and any other id (a call id, a thread id)
// would make its verdict unmatchable.
export function agentIdFrom(response: unknown): string | null {
  const r = asObj(typeof response === 'string' ? safeJson(response) : response)
  for (const k of ['agent_id', 'agentId']) if (/^[A-Za-z0-9_-]{4,}$/.test(str(r[k]))) return str(r[k])
  return null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function responseText(response: unknown): string {
  if (typeof response === 'string') return response
  const r = asObj(response)
  return [str(r.stdout), str(r.stderr), str(r.output), str(r.aggregated_output), str(r.formatted_output)].filter(Boolean).join('\n') || JSON.stringify(response ?? '')
}

function responseOk(response: unknown): boolean {
  const r = asObj(response)
  const code = r.exit_code ?? r.exitCode
  return typeof code === 'number' ? code === 0 : !/\bexit(?:ed with)? code:? [1-9]/i.test(responseText(response))
}

const deny = (reason: string): HookOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

export type Env = { PLUGIN_DATA?: string; CLAUDE_PLUGIN_DATA?: string; HOME?: string }

export async function handle(input: HookInput, env: Env = process.env): Promise<HookOutput> {
  const event = input.hook_event_name ?? ''
  const dir = input.cwd || process.cwd()
  const io = nodeIo(dir)
  const dataDir = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || join(env.HOME || homedir(), '.codex', 'code-factory')
  const store = fileRuntime(dataDir, dir)
  const notices: string[] = []
  const host: Host = {
    name: 'Codex',
    owner: `codex-${input.session_id ?? 'unknown'}`,
    commandPrefix: '$',
    notes: NOTES,
    ...io,
    now: () => Date.now(),
    notify: text => {
      notices.push(text)
    },
    loadRuntime: store.load,
    saveRuntime: store.save,
    newNonce: () => randomUUID().slice(0, 8),
  }
  const factory = createFactory(host)

  // A repo without .factory/ is not using the factory: nothing to do or guard.
  if (!(await io.exists(FACTORY_DIR)) && !(event === 'UserPromptSubmit' && commandOf(str(input.prompt)))) return {}
  await factory.touchLock()
  // The PR gate runs the build and the tests and the Stop step checks the base
  // branch, each for up to ten minutes: keep the lock fresh meanwhile.
  const beat = setInterval(() => void factory.touchLock(), 30000)
  beat.unref?.()
  try {
    return await dispatch(event, input, dir, dataDir, factory, notices)
  } finally {
    clearInterval(beat)
  }
}

// Reviewer stops that arrived before the review spawn reported the reviewer's id.
type EarlyStop = { agent: string; message: string; at: number }
const EARLY_MS = 3600000

function earlyFile(dataDir: string, dir: string): string {
  return join(dataDir, `early-stops-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.json`)
}

async function readEarly(dataDir: string, dir: string): Promise<EarlyStop[]> {
  try {
    const raw = JSON.parse(await readFile(earlyFile(dataDir, dir), 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as EarlyStop[]).filter(e => e && typeof e.agent === 'string' && typeof e.message === 'string' && Date.now() - Number(e.at) < EARLY_MS) : []
  } catch {
    return []
  }
}

async function writeEarly(dataDir: string, dir: string, list: EarlyStop[]): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(earlyFile(dataDir, dir), JSON.stringify(list.slice(-10)))
}

const MESSAGE_TOOLS = new Set(['send_input', 'send_message', 'SendMessage', 'resume_agent'])

// The review spawn may carry the prompt and nothing else that changes the
// agent (a model, a type, a forked context): an option left at null, false or
// empty is fine.
function onlyPrompt(toolInput: Obj, field: string): boolean {
  const key = field.split('.')[0]
  return Object.entries(toolInput).every(([k, v]) => k === key || v === null || v === undefined || v === false || v === '')
}

async function dispatch(event: string, input: HookInput, dir: string, dataDir: string, factory: ReturnType<typeof createFactory>, notices: string[]): Promise<HookOutput> {
  const withNotices = (out: HookOutput): HookOutput => (notices.length > 0 ? { ...out, systemMessage: notices.join('\n') } : out)

  // The full prompt goes in a file and the continuation points at it, because
  // Codex shortens continuation prompts longer than about 2,500 tokens.
  const promptFile = (nonce: string): string => join(dataDir, 'prompts', `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}-${nonce}.md`)
  const continuation = async (p: Prompt): Promise<string> => {
    const { nonce } = await factory.runtime()
    const file = promptFile(nonce)
    await mkdir(join(dataDir, 'prompts'), { recursive: true })
    await writeFile(file, p.text)
    return `${p.headline}\n\nThe factory's full instructions for this step are in ${file}. Read that whole file now and follow it exactly; it replaces any earlier work item.\n(code-factory turn ${nonce})`
  }

  switch (event) {
    case 'PreToolUse': {
      const tool = input.tool_name ?? ''
      const actor = input.agent_id || undefined
      const toolInput = asObj(input.tool_input)
      try {
        if (tool === 'Bash') {
          const reason = await factory.guardShell(shellCommand(toolInput), actor)
          return withNotices(reason ? deny(reason) : {})
        }
        if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
          const paths = [...patchPaths(shellCommand(toolInput) || str(toolInput.patch) || str(toolInput.input)), str(toolInput.file_path), str(toolInput.path)].filter(Boolean)
          const reason = await factory.guardWrite(paths, actor)
          return withNotices(reason ? deny(reason) : {})
        }
        if (MESSAGE_TOOLS.has(tool)) {
          const reason = await factory.guardAgentMessage(actor)
          return withNotices(reason ? deny(reason) : {})
        }
        if (tool === 'spawn_agent' || tool === 'Agent') {
          const field = reviewField(toolInput)
          if (!field) {
            const r = await factory.reviewSpawn('', actor, true)
            return withNotices(r && 'deny' in r ? deny(r.deny) : {})
          }
          const prompt = field.includes('.') ? str(asObj((toolInput[field.split('.')[0]!] as unknown[])[Number(field.split('.')[1])]).text) : str(toolInput[field])
          const r = await factory.reviewSpawn(prompt, actor, onlyPrompt(toolInput, field))
          if (r && 'deny' in r) return withNotices(deny(r.deny))
          if (r && 'prompt' in r) return withNotices({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: withPrompt(toolInput, field, r.prompt) } })
          return {}
        }
        return {}
      } catch (err) {
        // While the loop is live a broken gate must not let the call through.
        if (await factory.guardsLive().catch(() => true)) return deny(`code-factory: the gate failed (${String(err).slice(0, 200)}); the call is refused while the loop runs.`)
        return {}
      }
    }
    case 'PostToolUse': {
      const tool = input.tool_name ?? ''
      if (tool === 'Bash') {
        const note = await factory.afterShell(shellCommand(input.tool_input), responseText(input.tool_response), responseOk(input.tool_response))
        return withNotices(note ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } } : {})
      }
      // The reviewer is bound only to the id its own spawn returned, never to
      // whichever agent happens to start first.
      if ((tool === 'spawn_agent' || tool === 'Agent') && reviewField(asObj(input.tool_input))) {
        const id = agentIdFrom(input.tool_response)
        if (!id) {
          await factory.reviewLaunchFailed()
          notices.push('factory: the review agent was not started (no agent id in the spawn result); spawn it again')
        } else if (await factory.reviewLaunched(id)) {
          const early = await readEarly(dataDir, dir)
          const stop = early.find(e => e.agent === id)
          if (stop) {
            await writeEarly(dataDir, dir, early.filter(e => e !== stop))
            await factory.reviewFinished(id, stop.message)
          }
        }
      }
      return withNotices({})
    }
    case 'SubagentStop': {
      if (!input.agent_id) return {}
      if ((await factory.readState()).reviewAgentId === PENDING_REVIEWER) {
        await writeEarly(dataDir, dir, [...(await readEarly(dataDir, dir)), { agent: input.agent_id, message: input.last_assistant_message ?? '', at: Date.now() }])
        return {}
      }
      await factory.reviewFinished(input.agent_id, input.last_assistant_message ?? '')
      return withNotices({})
    }
    case 'UserPromptSubmit': {
      const prompt = str(input.prompt)
      const rt = await factory.runtime()
      if (rt.nonce && prompt.includes(`code-factory turn ${rt.nonce}`)) {
        let full = ''
        try {
          full = await readFile(promptFile(rt.nonce), 'utf8')
        } catch {
          full = ''
        }
        return full ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `The factory's full instructions for this step (the same as the file named in the prompt; no need to read it):\n\n${full}` } } : {}
      }
      const cmd = commandOf(prompt)
      if (cmd) {
        const reply: Reply = await factory.command(cmd.name, cmd.args)
        if (!reply.prompt) return withNotices({ decision: 'block', reason: reply.text })
        return withNotices({ systemMessage: reply.text, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${reply.text}\n\nThe code factory's instructions for this turn follow; they are what the person's command asked for.\n\n${reply.prompt.text}` } })
      }
      await factory.onPersonPrompt(prompt)
      return withNotices({})
    }
    case 'Stop': {
      const next = await factory.onTurnEnd('answer')
      return withNotices(next ? { decision: 'block', reason: await continuation(next) } : {})
    }
    case 'Interrupt': {
      await factory.onTurnEnd('aborted')
      return withNotices({})
    }
    default:
      return {}
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  let input: HookInput = {}
  try {
    input = JSON.parse(await readStdin()) as HookInput
  } catch {
    process.stdout.write('{}')
    return
  }
  try {
    process.stdout.write(JSON.stringify(await handle(input)))
  } catch (err) {
    process.stderr.write(`code-factory hook failed: ${String(err)}\n`)
    process.stdout.write(input.hook_event_name === 'PreToolUse' ? JSON.stringify(deny(`code-factory: the hook failed (${String(err).slice(0, 200)}).`)) : '{}')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
