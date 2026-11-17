// code-factory for OpenCode (V2 server plugin). The loop, commands and gates
// come from core/factory.ts; this file wires them to OpenCode's commands,
// tool hooks and session events.

import { randomUUID } from 'node:crypto'

import type { Plugin } from '@opencode/plugin'

import { createFactory, gateCommand, lastAssistantText, patchPaths } from '../core/factory.ts'
import type { Host, Prompt, Runtime } from '../core/factory.ts'
import { EMPTY_RUNTIME, GIT_ELSEWHERE_DENY, gitElsewhere, nodeIo } from '../core/io.ts'
import { REVIEW_TAG } from '../hooks/lib.ts'

export const NOTES = {
  work: `Host notes (OpenCode): the "Agent tool" above is the \`subagent\` tool here. For the review, call it with agent "general", a short description and the review prompt as its prompt, unchanged and with no other options. It runs in the background: after launching it, end your turn without polling; its report wakes you, and the factory reads the FACTORY-REVIEW line from the reviewer's own final message. Ask the person nothing; the loop runs unattended.`,
  design: `Host notes (OpenCode): the AskUserQuestion tool above is the \`question\` tool here. The person's commands are /factory-approve and /factory-start.`,
}

const MAX_NOTES = 10

type Input = Record<string, unknown>

const asInput = (x: unknown): Input => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Input) : {})
const str = (x: unknown): string => (typeof x === 'string' ? x : '')

// Every path a file tool call names: `path`/`filePath` fields and the file
// headers of a patch.
export function toolPaths(input: Input): string[] {
  const out = [str(input.path), str(input.filePath), str(input.file_path)].filter(Boolean)
  for (const v of Object.values(input)) if (typeof v === 'string' && v.includes('*** ')) out.push(...patchPaths(v))
  return [...new Set(out)]
}

// Background work that wakes this session when it ends. Work a child session
// owns wakes the child, not this session, so waiting for it would wait forever.
export const ownBackground = (e: { sessionID: string; background: readonly { sessionID: string }[] }): boolean => e.background.some(b => b.sessionID === e.sessionID)

const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch'])

// The text a finished tool call returned, for the timeline and CI checks.
function resultText(result: unknown): string {
  const r = asInput(result)
  const content = Array.isArray(r.content) ? r.content.map(c => str(asInput(c).text)).join('\n') : ''
  const output = asInput(r.output)
  return [content, str(output.output), str(r.output)].filter(Boolean).join('\n')
}

// The child session a `subagent` call started, from the call's own result only.
export function childSessionId(result: unknown, caller: string): string | null {
  const id = str(asInput(asInput(result).output).sessionID)
  return /^ses_[A-Za-z0-9]+$/.test(id) && id !== caller ? id : null
}

// The review spawn carries the agent, a description and the prompt, nothing
// that changes the agent or resumes an existing session.
const REVIEW_KEYS = new Set(['agent', 'subagent_type', 'description', 'prompt'])
export const plainReviewCall = (input: Input): boolean =>
  (input.agent === 'general' || input.subagent_type === 'general') && Object.entries(input).every(([k, v]) => REVIEW_KEYS.has(k) || v === undefined || v === null || v === false || v === '')

const plugin: Plugin.Plugin = {
  id: 'code-factory',
  async setup(ctx) {
    const dir = ctx.location.directory
    const io = nodeIo(dir)
    let runtime: Runtime = { ...EMPTY_RUNTIME }
    // The session the person runs the factory from (the last one a factory
    // command was typed in), and the subagent sessions started under any session.
    let loopSession: string | null = null
    const children = new Set<string>()
    const notes: string[] = []

    const host: Host = {
      name: 'OpenCode',
      owner: `opencode-${randomUUID()}`,
      commandPrefix: '/',
      notes: NOTES,
      ...io,
      now: () => Date.now(),
      notify: text => {
        notes.push(`${new Date().toISOString().slice(11, 19)} ${text}`)
        if (notes.length > MAX_NOTES) notes.shift()
        console.log(`[code-factory] ${text}`)
      },
      loadRuntime: async () => runtime,
      saveRuntime: async r => {
        runtime = r
      },
      newNonce: () => randomUUID(),
      resetContext: async () => {
        if (loopSession) await ctx.session.compact({ sessionID: loopSession as never, delivery: 'queue' })
      },
    }
    const factory = createFactory(host)

    const tell = async (sessionID: string, text: string): Promise<void> => {
      try {
        await ctx.session.synthetic({ sessionID: sessionID as never, text: `[code-factory, for the person; no reply needed]\n${text}`, resume: false })
      } catch (err) {
        console.log(`[code-factory] ${text} (${String(err)})`)
      }
    }

    const submit = async (sessionID: string, p: Prompt): Promise<void> => {
      try {
        await ctx.session.prompt({ sessionID: sessionID as never, text: p.text, metadata: { codeFactory: p.kind } })
      } catch (err) {
        runtime = { ...runtime, turn: null }
        host.notify(`could not submit "${p.headline}": ${String(err).slice(0, 200)}`)
      }
    }

    await ctx.command.transform(editor => {
      for (const [name, c] of Object.entries(factory.commands)) {
        editor.add({
          name,
          description: `code-factory: ${c.description}`,
          execute: async ({ sessionID, prompt }) => {
            const reply = await factory.command(name, prompt.text ?? '')
            // Only a command that hands out work makes this the factory's session;
            // /factory-status typed elsewhere must not take the loop over.
            if (reply.prompt) loopSession = sessionID
            const recent = name === 'factory-status' && notes.length > 0 ? `\n\nRecent notices:\n${notes.join('\n')}` : ''
            await tell(sessionID, `${reply.text}${recent}`)
            if (reply.prompt) await submit(sessionID, reply.prompt)
          },
        })
      }
    })

    // A prompt the person types in the factory's session pauses the loop.
    await ctx.session.hook('prompt', async e => {
      if (e.metadata && (e.metadata as Input).codeFactory) return
      if (loopSession === null || e.sessionID !== loopSession) return
      await factory.onPersonPrompt(e.prompt.text ?? '')
    })

    // The session finished its work: the reviewer's verdict, or the next step of the loop.
    await ctx.session.hook('experimental.idle', async e => {
      const state = await factory.readState()
      if (state.reviewAgentId !== null && e.sessionID === state.reviewAgentId) {
        // The reviewer waiting for its own verifier agents has not finished.
        if (ownBackground(e)) return
        const messages = await ctx.session.context({ sessionID: e.sessionID })
        await factory.reviewFinished(e.sessionID, lastAssistantText(messages as readonly unknown[]))
        return
      }
      if (loopSession === null || e.sessionID !== loopSession || ownBackground(e)) return
      const next = await factory.onTurnEnd('answer')
      if (next) await submit(e.sessionID, next)
    })

    const actor = (sessionID: string): string | undefined => (children.has(sessionID) ? sessionID : undefined)

    // The gates. A hook that throws stops the call, and the model sees the message.
    await ctx.tool.hook('execute.before', async e => {
      const input = asInput(e.input)
      if (e.tool === 'shell' || e.tool === 'bash') {
        const callDir = str(input.workdir) || str(input.cwd) || null
        if (gitElsewhere(str(input.command), dir, callDir) && (await factory.guardsLive())) throw new Error(GIT_ELSEWHERE_DENY)
        const deny = await factory.guardShell(gateCommand(str(input.command), dir, callDir), actor(e.sessionID))
        if (deny) throw new Error(deny)
        return
      }
      if (FILE_TOOLS.has(e.tool)) {
        const deny = await factory.guardWrite(toolPaths(input), actor(e.sessionID))
        if (deny) throw new Error(deny)
        return
      }
      if (e.tool === 'subagent' || e.tool === 'task') {
        // Resuming an existing child session is a message to a running agent.
        if (str(input.sessionID) || str(input.task_id)) {
          const deny = await factory.guardAgentMessage(actor(e.sessionID))
          if (deny) throw new Error(deny)
        }
        const r = await factory.reviewSpawn(str(input.prompt), actor(e.sessionID), plainReviewCall(input))
        if (r && 'deny' in r) throw new Error(r.deny)
        if (r && 'prompt' in r) e.input = { ...input, prompt: r.prompt }
      }
    })

    await ctx.tool.hook('execute.after', async e => {
      const input = asInput(e.input)
      if ((e.tool === 'subagent' || e.tool === 'task') && str(input.prompt).includes(REVIEW_TAG)) {
        const id = e.status === 'completed' ? childSessionId(e.result, e.sessionID) : null
        if (id) {
          children.add(id)
          await factory.reviewLaunched(id)
        } else await factory.reviewLaunchFailed()
        return
      }
      if (e.tool !== 'shell' && e.tool !== 'bash') return
      const ok = e.status === 'completed' && asInput(asInput(e.result).output).exitCode !== undefined ? asInput(asInput(e.result).output).exitCode === 0 : e.status === 'completed'
      const note = await factory.afterShell(str(input.command), e.status === 'completed' ? resultText(e.result) : '', ok)
      if (note && e.status === 'completed') {
        const r = asInput(e.result)
        const content = Array.isArray(r.content) ? r.content : []
        e.result = { ...r, content: [...content, { type: 'text', text: note }] } as typeof e.result
      }
    })

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal, types: ['session.created', 'session.execution.interrupted', 'session.execution.failed'] })) {
          const data = asInput((ev as { data?: unknown }).data)
          const sessionID = str(data.sessionID)
          if (ev.type === 'session.created') {
            if (str(data.parentID)) children.add(sessionID)
            continue
          }
          if (sessionID !== loopSession) continue
          if (ev.type === 'session.execution.interrupted' && data.reason === 'superseded') continue
          await factory.onTurnEnd(ev.type === 'session.execution.failed' ? 'error' : 'aborted')
        }
      } catch {
        // the stream ends when the plugin unloads
      }
    })()

    const beat = setInterval(() => void factory.touchLock(), 30000)
    beat.unref?.()
    return () => {
      clearInterval(beat)
      abort.abort()
    }
  },
}

export default plugin
