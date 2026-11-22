// The code factory's loop, commands and guards for hosts other than Claude Code
// (OpenCode, Codex). It is a port of the core of hooks/register.tsx: the same
// files under .factory/, the same approval hash and the same gates, all built
// from hooks/lib.ts, with the engine calls behind a small Host interface. What
// Claude Code's runtime offers and these hosts do not (the band, the
// dashboard, the dollar ledger, the issue watcher and the interviews after the
// plan is done) is left out.

import {
  applyChanges,
  appendEvent,
  BLOCKED_DIR,
  branchFor,
  checksVerdict,
  ciOutcome,
  classifyBash,
  cleanText,
  commitMessage,
  decideReviewAnswer,
  declinedLines,
  declinedSection,
  decisionsHash,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  depthSection,
  DESIGN_PATH,
  DESIGN_PROMPT,
  designFileSame,
  designPushSteps,
  evaluateProtection,
  FACTORY_DIR,
  formatLog,
  hasTestChanges,
  inScope,
  isBillingProblem,
  isDocsOnly,
  isLockedByOther,
  isReviewClean,
  isReviewPending,
  isSafeBranchName,
  LOCK_PATH,
  loopEventForBash,
  markClean,
  markCounts,
  markDetail,
  mergeDeclined,
  mergeEvents,
  normalizePath,
  normalizeText,
  nudgePrompt,
  parseItemArg,
  parsePrUrl,
  parseLock,
  parseSettings,
  parseShortstat,
  parseTodo,
  pickNext,
  promoteProposed,
  publishDesignWith,
  releasePending,
  releasePrompt,
  REVIEW_TAG,
  reviewAgentPrompt,
  reviewWindow,
  rereviewSection,
  safeLines,
  sanitizeDeclined,
  sanitizeEvents,
  SETTINGS_PATH,
  STATE_PATH,
  statusReport,
  stripControls,
  summarize,
  testWeakening,
  TODO_PATH,
  todoHeadingProblems,
  unsafeBaseNote,
  validateItems,
  workPrompt,
} from '../hooks/lib.ts'
import type { EventKind, FactoryState, Item, LoopEvent, ReviewMark, Settings } from '../hooks/lib.ts'
import { isAbsolute, relative, resolve } from 'node:path'

export type Run = { exitCode: number; stdout: string; stderr: string }

// A prompt the factory wants the model to run next. The host submits it as the
// next user turn (OpenCode) or as the continuation of the turn that just ended
// (Codex).
export type Prompt = { headline: string; text: string; kind: 'work' | 'design' }

// A command's answer to the person, and optionally the prompt it starts.
export type Reply = { text: string; prompt?: Prompt }

// Flags that live as long as a session. `turn` is set while a turn the factory
// submitted runs, and belongs to the session (`owner`) that runs it: Codex keeps
// these flags per repository, so another session in the same repo must neither
// end nor arm it. The guards stay armed for a work turn even if the loop gets
// paused halfway. `epoch` is bumped by every pause, stop or start the person
// makes, so a loop step that started before one never writes after it.
// `nonce` marks the prompt the factory handed out last (Codex echoes it back
// through UserPromptSubmit).
export type Runtime = { epoch: number; turn: { kind: 'work' | 'design'; at: number; owner: string } | null; nonce: string }

export interface Host {
  readonly name: string
  // Lock owner for this session; another owner holding a fresh lock keeps this
  // session hands-off.
  readonly owner: string
  // How the person types the factory's commands: '/' (OpenCode) or '$' (Codex).
  readonly commandPrefix: '/' | '$'
  // Host-specific lines appended to the work and design prompts (tool names),
  // and, for a host that does not wake the session when a subagent finishes,
  // the prompt that tells the model to wait for the reviewer.
  readonly notes: { work: string; design: string; waitForReviewer?: string }
  run(argv: string[], timeoutMs?: number, init?: { env?: Record<string, string>; stdin?: string }): Promise<Run>
  read(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  write(path: string, text: string): Promise<void>
  list(dir: string): Promise<string[]>
  remove(path: string): Promise<void>
  now(): number
  notify(text: string): void
  loadRuntime(): Promise<Runtime>
  saveRuntime(r: Runtime): Promise<void>
  newNonce(): string
  // Optional: shrink the context between items (OpenCode compacts the session).
  resetContext?(): Promise<void>
}

export type Snapshot = { state: FactoryState; settings: Settings; settingsProblems: string[]; items: Item[]; blocked: Set<string> }

export const FACTORY_TURN_TTL_MS = 3 * 3600000
export const PENDING_REVIEWER = 'pending'
const STATE_READS = 3
const STATE_UNREADABLE = `${STATE_PATH} cannot be read or is not valid JSON; the guards stay on and nothing writes it. Fix or delete it, then /factory-approve`
// `*.tmp`: the temp files of atomic writes (core/io.ts writeAtomic).
const IGNORED = ['state.json', 'lock.json', 'blocked/', 'evidence/', '*.tmp']
const REVIEW_BUSY_DENY = 'code-factory: the review agent is still running; do not change the code until its verdict arrives (only the review agent may edit, commit or push now).'
const FACTORY_FILE_DENY = 'code-factory: .factory/state.json and .factory/lock.json are controlled by the person through the factory commands.'
const SKELETON_TODO = `# Todo

<!-- Format, one block per item, in priority order:
## T-001 [feature] Short title
- status: proposed
- how: chosen tool/algorithm/workaround and why
- accept: checkable acceptance criteria
- tests: what the tests cover
-->
`

const isFactoryControlFile = (p: string): boolean => /(^|\/)\.factory\/(?:state|lock)\.json$/i.test(normalizePath(p))

// Files that could switch the guards off or change what the agents are told.
// The Claude Code version protects its own .claude/ files; here the hosts'
// configuration is protected too.
export function isAgentConfigPath(p: string): boolean {
  const n = normalizePath(p)
  return (
    /(^|\/)\.claude\/(?:(?:agents|commands|skills)\/|settings[^/]*\.json$)/i.test(n) ||
    /(^|\/)\.(?:opencode|codex|agents|codex-plugin)\//i.test(n) ||
    /(^|\/)opencode\.jsonc?$/i.test(n)
  )
}

// The person's commands are written /factory-x in lib.ts; Codex reads them as $factory-x.
export function forHost(text: string, prefix: '/' | '$'): string {
  return prefix === '/' ? text : text.replace(/(^|[\s(`'"])\/factory(?=[-\s.,;:)`'"]|$)/gm, `$1${prefix}factory`)
}

export type ShellOutcome = { note: string | null }

export function createFactory(host: Host) {
  const say = (text: string): string => forHost(safeLines(text), host.commandPrefix)
  const notify = (text: string): void => host.notify(forHost(stripControls(text), host.commandPrefix))

  // ---- runtime flags ------------------------------------------------------

  async function rt(): Promise<Runtime> {
    try {
      return await host.loadRuntime()
    } catch {
      return { epoch: 0, turn: null, nonce: '' }
    }
  }

  async function setRt(fn: (r: Runtime) => Runtime): Promise<Runtime> {
    const next = fn(await rt())
    await host.saveRuntime(next)
    return next
  }

  const bumpEpoch = (): Promise<Runtime> => setRt(r => ({ ...r, epoch: r.epoch + 1 }))

  const ownTurn = (r: Runtime): boolean => r.turn !== null && r.turn.owner === host.owner

  async function turnBusy(): Promise<boolean> {
    const r = await rt()
    if (!ownTurn(r)) return false
    if (host.now() - r.turn!.at < FACTORY_TURN_TTL_MS) return true
    await setRt(x => (ownTurn(x) ? { ...x, turn: null } : x))
    return false
  }

  async function armed(): Promise<boolean> {
    const r = await rt()
    return ownTurn(r) && r.turn!.kind === 'work' && host.now() - r.turn!.at < FACTORY_TURN_TTL_MS
  }

  // ---- state --------------------------------------------------------------

  async function readStateOnce(): Promise<FactoryState | 'absent' | null> {
    if (!(await host.exists(STATE_PATH))) return 'absent'
    const text = await host.read(STATE_PATH)
    if (text === null) return null
    try {
      const raw = JSON.parse(text) as Partial<FactoryState>
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      return { ...DEFAULT_STATE, ...raw, events: sanitizeEvents(raw.events), reviewDeclined: sanitizeDeclined(raw.reviewDeclined), reviewOpen: sanitizeDeclined(raw.reviewOpen), roadmapAsked: raw.roadmapAsked === true, unreadable: undefined }
    } catch {
      return null
    }
  }

  async function readState(): Promise<FactoryState> {
    for (let i = 0; i < STATE_READS; i++) {
      const got = await readStateOnce()
      if (got === 'absent') return { ...DEFAULT_STATE }
      if (got) return got
    }
    return { ...DEFAULT_STATE, approved: true, autopilot: true, pausedReason: STATE_UNREADABLE, unreadable: true }
  }

  async function writeState(state: FactoryState): Promise<void> {
    if (state.unreadable) return
    let events = state.events ?? []
    const disk = await host.read(STATE_PATH)
    if (disk) {
      try {
        events = mergeEvents(sanitizeEvents((JSON.parse(disk) as { events?: unknown }).events), events)
      } catch {
        events = state.events ?? []
      }
    }
    await host.write(STATE_PATH, `${JSON.stringify({ ...state, events }, null, 2)}\n`)
  }

  let stateChain: Promise<unknown> = Promise.resolve()

  function patchState(fn: (s: FactoryState) => FactoryState | null | Promise<FactoryState | null>): Promise<FactoryState | null> {
    const job = stateChain
      .then(async () => {
        const next = await fn(await readState())
        if (next === null) return null
        await writeState(next)
        return next
      })
      .catch(() => null)
    stateChain = job
    return job
  }

  type NewEvent = { itemId: string | null; kind: EventKind; detail: string; pr?: number; url?: string }

  const withEvent = (state: FactoryState, ts: number, ev: NewEvent): FactoryState => ({ ...state, events: appendEvent(state.events ?? [], { ts, ...ev }) })

  async function logEvent(ev: NewEvent): Promise<void> {
    const ts = host.now()
    await patchState(s => withEvent(s, ts, ev))
  }

  async function blockedIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const name of await host.list(BLOCKED_DIR)) {
      const m = /^([A-Za-z]+-\d+)\.md$/.exec(name)
      if (m) ids.add(m[1]!.toUpperCase())
    }
    return ids
  }

  async function blockedNotes(ids: ReadonlySet<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const id of [...ids].sort()) {
      const text = (await host.read(`${BLOCKED_DIR}/${id}.md`)) ?? (await host.read(`${BLOCKED_DIR}/${id.toLowerCase()}.md`)) ?? ''
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      out.set(id, cleanText(lines.find(l => !l.startsWith('#')) ?? lines[0] ?? ''))
    }
    return out
  }

  async function load(): Promise<Snapshot> {
    const parsed = parseSettings(await host.read(SETTINGS_PATH))
    const todo = await host.read(TODO_PATH)
    return { state: await readState(), settings: parsed.settings, settingsProblems: parsed.problems, items: todo === null ? [] : parseTodo(todo), blocked: await blockedIds() }
  }

  function effectiveItems(snap: Snapshot): Item[] {
    const trusted = new Set([...snap.state.approvedDone, ...snap.state.mergedIds])
    return snap.items.map(i => (i.status === 'done' && !trusted.has(i.id) && i.id !== snap.state.current ? { ...i, status: 'todo' as const } : i))
  }

  // Settings this host cannot honour stop the loop instead of being ignored.
  function hostProblem(settings: Settings): string | null {
    if (settings.budgetUsd > 0) return `settings.json budgetUsd is ${settings.budgetUsd}, but ${host.name} gives the factory no dollar figure to enforce it; set it to 0, or run the loop in Claude Code`
    return null
  }

  async function integrityProblem(snap: Snapshot): Promise<string | null> {
    if (snap.state.unreadable) return STATE_UNREADABLE
    if (!snap.state.approved) return 'design not approved'
    if (snap.settingsProblems.length > 0) return snap.settingsProblems[0]!
    if (decisionsHash(snap.settings, snap.items) !== snap.state.approvedHash) return 'settings or decisions changed since approval; review them and run /factory-approve'
    return hostProblem(snap.settings)
  }

  // ---- lock ---------------------------------------------------------------

  async function readLock() {
    let text = await host.read(LOCK_PATH)
    if (text !== null) {
      try {
        JSON.parse(text)
      } catch {
        text = await host.read(LOCK_PATH)
      }
    }
    return parseLock(text)
  }

  async function lockedByOther(): Promise<boolean> {
    const lock = await readLock()
    if (lock.owner === null || lock.owner === host.owner) return false
    return isLockedByOther(lock, host.owner, host.now())
  }

  async function acquireLock(): Promise<boolean> {
    if (await lockedByOther()) return false
    await host.write(LOCK_PATH, JSON.stringify({ owner: host.owner, heartbeat: host.now() }))
    return (await readLock()).owner === host.owner
  }

  async function releaseLock(): Promise<void> {
    try {
      if ((await readLock()).owner === host.owner) await host.write(LOCK_PATH, JSON.stringify({ owner: null, heartbeat: 0 }))
    } catch {
      // a lock that cannot be released goes stale by itself
    }
  }

  // The heartbeat: hosts call it on a timer (OpenCode) or on every hook (Codex).
  async function touchLock(): Promise<void> {
    try {
      if ((await readLock()).owner !== host.owner) return
      const s = await readState()
      if (!s.unreadable && !s.autopilot) return releaseLock()
      await host.write(LOCK_PATH, JSON.stringify({ owner: host.owner, heartbeat: host.now() }))
    } catch {
      // a missed beat only shortens the lock's life
    }
  }

  // ---- helpers ------------------------------------------------------------

  async function branchNow(): Promise<string> {
    return (await host.run(['git', 'branch', '--show-current'], 15000)).stdout.trim()
  }

  async function headSha(): Promise<string> {
    const r = await host.run(['git', 'rev-parse', 'HEAD'], 15000)
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }

  async function ensureGitignore(): Promise<void> {
    try {
      const path = `${FACTORY_DIR}/.gitignore`
      const have = (await host.read(path)) ?? ''
      const lines = have.split(/\r?\n/).map(l => l.trim())
      const missing = IGNORED.filter(l => !lines.includes(l))
      if (missing.length > 0 || have === '') {
        const base = have === '' || have.endsWith('\n') ? have : `${have}\n`
        await host.write(path, `${base}${missing.join('\n')}${missing.length > 0 ? '\n' : ''}`)
      }
    } catch {
      // the runtime files only show up in git status
    }
  }

  type LoopGuard = { epoch: number }

  async function loopLive(guard: LoopGuard, fresh?: FactoryState): Promise<boolean> {
    if ((await rt()).epoch !== guard.epoch) return false
    const s = fresh ?? (await readState())
    if (!s.autopilot || s.unreadable) return false
    return (await readLock()).owner === host.owner && (await rt()).epoch === guard.epoch
  }

  async function pause(state: FactoryState, rawReason: string, opts: { override?: Partial<FactoryState>; guard?: LoopGuard } = {}): Promise<boolean> {
    if (!opts.guard) await bumpEpoch()
    const reason = cleanText(rawReason)
    const ts = host.now()
    const saved = await patchState(async fresh => {
      if (opts.guard && !(await loopLive(opts.guard, fresh))) return null
      return { ...applyChanges(fresh, state, withEvent(state, ts, { itemId: fresh.current, kind: 'paused', detail: reason })), ...opts.override, autopilot: false, pausedReason: reason }
    })
    if (opts.guard && !saved) return false
    await releaseLock()
    notify(`factory paused: ${reason}`)
    return true
  }

  async function beginTurn(kind: 'work' | 'design'): Promise<string> {
    const nonce = host.newNonce()
    await setRt(r => ({ ...r, turn: { kind, at: host.now(), owner: host.owner }, nonce }))
    return nonce
  }

  async function handOut(kind: 'work' | 'design', headline: string, text: string): Promise<Prompt> {
    await beginTurn(kind)
    const note = kind === 'work' ? host.notes.work : host.notes.design
    return { kind, headline: stripControls(headline).slice(0, 200), text: forHost(note ? `${text}\n\n${note}` : text, host.commandPrefix) }
  }

  const reviewPending = (state: FactoryState, settings: Settings): boolean => isReviewPending(state, host.now(), reviewWindow(state, settings))

  async function ciBillingProblem(): Promise<string | null> {
    const sha = await headSha()
    if (!sha) return null
    const list = await host.run(['gh', 'api', `repos/{owner}/{repo}/commits/${sha}/check-runs`, '--jq', '[.check_runs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="action_required" or .conclusion=="startup_failure") | {id: .id, text: ([.output.title, .output.summary, .output.text] | map(select(. != null)) | join("\\n"))}]'])
    if (list.exitCode !== 0) return null
    let rows: { id: number; text: string }[] = []
    try {
      rows = JSON.parse(list.stdout) as { id: number; text: string }[]
    } catch {
      return null
    }
    for (const row of rows.slice(0, 6)) {
      if (isBillingProblem(row.text)) return row.text.trim().slice(0, 200)
      const ann = await host.run(['gh', 'api', `repos/{owner}/{repo}/check-runs/${row.id}/annotations`, '--jq', '.[].message'])
      if (ann.exitCode === 0 && isBillingProblem(ann.stdout)) return ann.stdout.trim().slice(0, 200)
    }
    return null
  }

  async function pauseForBilling(detail: string, guard?: LoopGuard): Promise<boolean> {
    return pause(await readState(), `GitHub Actions billing problem (${detail.replace(/\s+/g, ' ').slice(0, 100)}). Fix billing, then /factory-start`, { guard })
  }

  async function verifyBase(settings: Settings, live: () => Promise<boolean>): Promise<string | null> {
    const base = settings.baseBranch
    await host.run(['git', 'fetch', '--', 'origin', base])
    const here = await host.run(['git', 'rev-parse', 'HEAD'])
    const there = await host.run(['git', 'rev-parse', `origin/${base}`])
    if (here.exitCode !== 0 || there.exitCode !== 0 || here.stdout.trim() !== there.stdout.trim()) return null
    if (!(await live())) return null
    if (settings.buildCmd.length > 0) {
      const built = await host.run(settings.buildCmd, settings.testTimeoutMs)
      if (built.exitCode !== 0) return `the build fails (${settings.buildCmd.join(' ')}, exit ${built.exitCode})`
      if (!(await live())) return null
    }
    const tests = await host.run(settings.testCmd, settings.testTimeoutMs)
    return tests.exitCode === 0 ? null : `the test suite fails (${settings.testCmd.join(' ')}, exit ${tests.exitCode})`
  }

  // ---- the loop -----------------------------------------------------------

  // One step: verify the current item, then hand out the next prompt. Returns
  // the prompt the host must submit, or null when there is nothing to submit.
  async function advance(): Promise<Prompt | null> {
    const next = await advanceStep()
    // A step that ended without a prompt (a pause, a stop that landed meanwhile,
    // the plan finished) must not leave this session holding the lock.
    if (next === null) {
      const s = await readState()
      if (!s.autopilot || s.unreadable) await releaseLock()
    }
    return next
  }

  async function advanceStep(): Promise<Prompt | null> {
    if (await turnBusy()) return null
    const guard: LoopGuard = { epoch: (await rt()).epoch }
    const snap = await load()
    let { state } = snap
    if (state.unreadable) {
      await releaseLock()
      notify(`factory paused: ${STATE_UNREADABLE}`)
      return null
    }
    if (!state.autopilot) return null
    if (!(await acquireLock())) {
      notify('factory: another session is running the loop here; this one stays hands-off')
      return null
    }
    const halt = async (reason: string, override: Partial<FactoryState> = {}): Promise<null> => {
      await pause(state, reason, { override, guard })
      return null
    }
    const live = (): Promise<boolean> => loopLive(guard)
    const write = async (next: FactoryState): Promise<boolean> => (await patchState(async fresh => ((await loopLive(guard, fresh)) ? applyChanges(fresh, snap.state, next) : null))) !== null
    const give = async (kind: 'work' | 'design', headline: string, text: string): Promise<Prompt | null> => ((await live()) ? handOut(kind, headline, text) : null)

    if (!(await live())) return null
    const problem = await integrityProblem(snap)
    if (problem) return halt(problem)
    const { settings, blocked } = snap
    const items = effectiveItems(snap)
    const base = settings.baseBranch
    let hasMerged = false

    if (state.current && state.reviewAgentId) {
      if (reviewPending(state, settings)) return null
      const rounds = state.reviewRounds + 1
      const capped = rounds >= settings.maxReviewRounds
      const paused = await pause(state, capped ? `the review agent gave no verdict ${rounds} times; ${state.current} is blocked` : `the review agent did not report within ${Math.round(reviewWindow(state, settings) / 60000)} min; /factory-start retries`, { override: { reviewAgentId: null, reviewAgentAt: 0, reviewRounds: rounds }, guard })
      // A step voided by a stop or another session's start blocks nothing.
      if (capped && paused) {
        await host.write(`${BLOCKED_DIR}/${state.current}.md`, `The review agent gave no verdict ${rounds} times.\n`)
        await logEvent({ itemId: state.current, kind: 'blocked', detail: `review agent gave no verdict ${rounds} times` })
      }
      return null
    }

    if (state.current) {
      const item = snap.items.find(i => i.id === state.current)
      if (!item || blocked.has(item.id)) state = { ...state, current: null, attempts: 0 }
      else {
        const branch = await branchNow()
        let why = ''
        if (item.status !== 'done') why = `${item.id} is not marked done in todo.md.`
        else if (branch !== base) why = `The current branch is "${branch}", not ${base}.`
        else {
          const merged = await host.run(['gh', 'pr', 'list', '--state', 'merged', '--head', branchFor(item), '--json', 'number,headRefName', '--limit', '20'])
          if (merged.exitCode !== 0) return halt(`gh failed: ${merged.stderr.trim().slice(0, 120)}`)
          let isMerged = false
          try {
            isMerged = (JSON.parse(merged.stdout) as { headRefName: string }[]).some(r => r.headRefName.startsWith(`factory/${item.id.toLowerCase()}-`))
          } catch {
            isMerged = false
          }
          if (isMerged) {
            state = { ...withEvent(state, host.now(), { itemId: item.id, kind: 'done', detail: 'merged PR verified' }), current: null, attempts: 0, doneThisRun: state.doneThisRun + 1, mergedIds: [...new Set([...state.mergedIds, item.id])] }
            if (!(await write(state))) return null
            items.forEach(i => {
              if (i.id === item.id) i.status = 'done'
            })
            hasMerged = true
            notify(`factory: ${item.id} merged`)
            const red = (await live()) ? await verifyBase(settings, live) : null
            if (red) return halt(`${base} is red after ${item.id} merged: ${red}; fix ${base}, then /factory-start`)
          } else why = `${item.id} is marked done but no merged PR from a factory/${item.id.toLowerCase()}-* branch exists.`
        }
        if (why) {
          if (branch.startsWith('factory/')) {
            const billing = await ciBillingProblem()
            if (billing) {
              await pauseForBilling(billing, guard)
              return null
            }
          }
          const attempts = state.attempts + 1
          if (attempts > settings.maxAttempts) {
            state = { ...withEvent(state, host.now(), { itemId: item.id, kind: 'blocked', detail: `after ${settings.maxAttempts} attempts: ${why}` }), current: null, attempts: 0 }
            if (!(await write(state))) return null
            let noted = true
            try {
              await host.write(`${BLOCKED_DIR}/${item.id}.md`, `Blocked by the factory after ${settings.maxAttempts} attempts. Last problem: ${why}\n`)
            } catch {
              noted = false
            }
            notify(`factory: ${item.id} blocked after ${settings.maxAttempts} attempts`)
            blocked.add(item.id)
            if (!noted) return halt(`${item.id} ran out of attempts but .factory/blocked/${item.id}.md could not be written; fix that folder, then /factory-skip ${item.id} or /factory-start`)
          } else {
            if (!(await write({ ...withEvent(state, host.now(), { itemId: item.id, kind: 'nudge', detail: why }), attempts }))) return null
            return give('work', `CODE FACTORY: ${item.id} retry: ${why}`, nudgePrompt(item, settings, why))
          }
        }
      }
    }

    if (settings.maxItemsPerRun > 0 && state.doneThisRun >= settings.maxItemsPerRun) {
      if (!(await write(state))) return null
      return halt(`run limit of ${settings.maxItemsPerRun} items reached`)
    }
    const version = settings.stopAfterVersion
    const next = pickNext(items, blocked, version)
    if (!next) {
      const scope = version ? items.filter(i => inScope(i, version)) : []
      const isScopeDone = version !== null && scope.length > 0 && scope.every(i => i.status === 'done')
      let finished = version && isScopeDone ? `version ${version} is complete` : 'nothing left to do'
      if (version && isScopeDone && settings.tagRelease && state.releasedVersion !== version) {
        const rel = await host.run(['gh', 'release', 'view', `v${version}`], 30000)
        if (rel.exitCode === 0) {
          state = { ...state, releasedVersion: version, releaseAttempts: 0 }
          finished = `version ${version} is complete and released`
        } else {
          if (state.releaseAttempts >= 3) {
            state = { ...state, current: null }
            if (!(await write(state))) return null
            return halt(`release v${version} was not created after 3 tries`)
          }
          if (!(await write({ ...withEvent(state, host.now(), { itemId: null, kind: 'release', detail: `v${version}` }), current: null, releaseAttempts: state.releaseAttempts + 1 }))) return null
          if (hasMerged && settings.contextReset !== 'none' && (await live())) await host.resetContext?.()
          return give('work', `CODE FACTORY: release v${version}`, releasePrompt(version, settings))
        }
      }
      if (!(await write({ ...withEvent(state, host.now(), { itemId: null, kind: 'paused', detail: finished }), autopilot: false, current: null, pausedReason: finished }))) return null
      await releaseLock()
      notify(`factory finished: ${finished} (${summarize(items, blocked)}). /factory-design plans the next phase.`)
      return null
    }
    state = { ...withEvent(state, host.now(), { itemId: next.id, kind: 'started', detail: next.title }), current: next.id, attempts: 0, pausedReason: null, review: null, reviewRounds: 0, reviewDeclined: [], reviewOpen: [] }
    if (!(await write(state))) return null
    if (hasMerged && settings.contextReset !== 'none' && (await live())) await host.resetContext?.()
    return give('work', `CODE FACTORY: work item ${next.id} [${next.type}] ${next.title}`, workPrompt(next, settings, null))
  }

  // A turn ended. Returns the next prompt when the loop goes on.
  async function onTurnEnd(outcome: 'answer' | 'aborted' | 'error'): Promise<Prompt | null> {
    const r = await rt()
    if (!ownTurn(r)) return null
    let state = await readState()
    // A review spawn that was allowed but never reported an agent (it failed,
    // and Codex runs no PostToolUse for a failed call) has not started: by the
    // end of the turn a successful spawn has always reported.
    if (state.reviewAgentId === PENDING_REVIEWER) {
      await reviewLaunchFailed()
      notify('factory: the review agent never started; the next step spawns it again')
      state = await readState()
    }
    if (outcome === 'answer' && state.autopilot && state.current && state.reviewAgentId !== null) {
      const { settings } = await load()
      // The reviewer is still working: the turn stays the factory's (and armed)
      // until its verdict arrives. A host that does not wake the session by
      // itself when a subagent finishes asks the model to wait for it.
      if (reviewPending(state, settings)) {
        if (!host.notes.waitForReviewer) return null
        await beginTurn('work')
        return { kind: 'work', headline: 'CODE FACTORY: waiting for the review agent', text: forHost(host.notes.waitForReviewer, host.commandPrefix) }
      }
    }
    await setRt(x => (ownTurn(x) ? { ...x, turn: null } : x))
    if (!state.autopilot) return null
    if (outcome !== 'answer') {
      await pause(state, outcome === 'aborted' ? 'you interrupted it' : 'the turn ended with an error')
      return null
    }
    return advance()
  }

  // The person typed a prompt of their own: the loop pauses and the guards
  // come off until they start it again.
  async function onPersonPrompt(text: string): Promise<void> {
    if (/^\s*[/$]factory(?:-|\s|$)/.test(text)) return
    const state = await readState()
    if (state.autopilot && !(await lockedByOther())) await pause(state, 'you sent a prompt; /factory-start resumes')
    await setRt(r => (ownTurn(r) ? { ...r, turn: null } : r))
  }

  // ---- commands -----------------------------------------------------------

  async function startCmd(): Promise<Reply> {
    const snap = await load()
    const problem = await integrityProblem(snap)
    if (problem) return { text: say(`Cannot start: ${problem}.`) }
    const startItems = effectiveItems(snap)
    if (!pickNext(startItems, snap.blocked, snap.settings.stopAfterVersion) && !snap.state.current && !releasePending(snap.settings, snap.state, startItems)) {
      return { text: say(`Nothing to do: ${summarize(startItems, snap.blocked)}. /factory-design plans the next phase; /factory-retry <ID> unblocks an item.`) }
    }
    if (!(await acquireLock())) return { text: say('Cannot start: another session is running the factory in this repo (its lock was refreshed in the last two minutes).') }
    await bumpEpoch()
    await ensureGitignore()
    const ts = host.now()
    await patchState(fresh => ({ ...withEvent(fresh, ts, { itemId: fresh.current, kind: 'resumed', detail: 'new run' }), autopilot: true, pausedReason: null, doneThisRun: 0, releaseAttempts: 0, attempts: fresh.current ? fresh.attempts : 0 }))
    // A factory turn of this session still running carries the loop on when it
    // ends; handing out another step now would run two at once.
    if (await turnBusy()) return { text: say('Factory running. A factory turn is still in progress; the loop continues when it ends. /factory-stop stops it; /factory-status shows where it is.') }
    const prompt = await advance()
    const text = say(`Factory running. Typing your own prompt or interrupting a turn pauses the loop; /factory-stop stops it; /factory-status shows where it is.${prompt ? '' : ` Nothing was handed out: ${(await readState()).pausedReason ?? 'see /factory-status'}.`}`)
    return prompt ? { text, prompt } : { text }
  }

  async function stopCmd(): Promise<Reply> {
    await bumpEpoch()
    const ts = host.now()
    await patchState(fresh => ({ ...withEvent(fresh, ts, { itemId: fresh.current, kind: 'paused', detail: 'stopped by you' }), autopilot: false, pausedReason: 'stopped by you' }))
    await releaseLock()
    return { text: say('Factory stopped. The current turn finishes; nothing new starts. /factory-start resumes.') }
  }

  async function pauseCmd(): Promise<Reply> {
    await bumpEpoch()
    const state = await readState()
    if (!state.autopilot) return { text: say(`Factory is not running (${state.pausedReason ?? 'stopped'}). /factory-start resumes it.`) }
    await pause(state, 'paused by you; /factory-start resumes')
    return { text: say(`Factory paused. The current turn finishes; nothing new starts. ${state.current ? `${state.current}, its attempts and review rounds are kept; ` : ''}/factory-start resumes where it left off.`) }
  }

  async function statusCmd(): Promise<Reply> {
    const snap = await load()
    const text = statusReport({ state: snap.state, settings: snap.settings, items: effectiveItems(snap), blocked: await blockedNotes(snap.blocked), stage: null, now: host.now(), runUsd: null, itemUsd: null })
    const problem = hostProblem(snap.settings)
    return { text: say(problem ? `${text}\n${problem}.` : text) }
  }

  async function logCmd(args: string): Promise<Reply> {
    const { id } = parseItemArg(args)
    if (args.trim() && !id) return { text: say('Usage: /factory-log [ID], for example /factory-log T-003.') }
    return { text: say(formatLog((await readState()).events, id)) }
  }

  async function skipCmd(args: string): Promise<Reply> {
    const { id, note } = parseItemArg(args)
    if (!id) return { text: say('Usage: /factory-skip <ID> [reason], for example /factory-skip T-004 needs a product decision.') }
    if (await lockedByOther()) return { text: say('Cannot skip: another session is running the factory in this repo (its lock was refreshed in the last two minutes).') }
    const snap = await load()
    const item = effectiveItems(snap).find(i => i.id === id)
    if (!item) return { text: say(`Cannot skip: ${id} is not an item in ${TODO_PATH}.`) }
    if (item.status === 'done') return { text: say(`Cannot skip: ${id} is already done.`) }
    if (snap.blocked.has(id)) return { text: say(`${id} is already blocked (${BLOCKED_DIR}/${id}.md); /factory-retry ${id} unblocks it.`) }
    await host.write(`${BLOCKED_DIR}/${id}.md`, `Skipped by you${note ? `: ${note}` : '.'} /factory-retry ${id} makes it eligible again.\n`)
    await logEvent({ itemId: id, kind: 'skip', detail: note || 'skipped by you' })
    const isCurrent = snap.state.current === id
    return { text: say(`${id} skipped; the note is in ${BLOCKED_DIR}/${id}.md.${isCurrent && snap.state.autopilot ? ' It is the current item: the turn in progress finishes, then the loop moves on to the next item.' : ''}`) }
  }

  async function retryCmd(args: string): Promise<Reply> {
    const { id } = parseItemArg(args)
    if (!id) return { text: say('Usage: /factory-retry <ID>, for example /factory-retry T-004.') }
    if (await lockedByOther()) return { text: say('Cannot retry: another session is running the factory in this repo (its lock was refreshed in the last two minutes).') }
    const snap = await load()
    const problem = await integrityProblem(snap)
    if (problem) return { text: say(`Cannot retry: ${problem}.`) }
    const raw = snap.items.find(i => i.id === id)
    const item = effectiveItems(snap).find(i => i.id === id)
    if (!raw || !item) return { text: say(`Cannot retry: ${id} is not an item in ${TODO_PATH}.`) }
    if (raw.status === 'proposed') return { text: say(`Cannot retry: ${id} is still proposed; /factory-approve promotes it first.`) }
    if (item.status === 'done') return { text: say(`Cannot retry: ${id} is already done.`) }
    const isCurrent = snap.state.current === id
    if (!snap.blocked.has(id) && !isCurrent) return { text: say(`${id} is not blocked; it is picked up in order.`) }
    if (snap.blocked.has(id)) {
      for (const name of [`${id}.md`, `${id.toLowerCase()}.md`]) await host.remove(`${BLOCKED_DIR}/${name}`)
      if ((await blockedIds()).has(id)) return { text: say(`Cannot retry: could not remove the note in ${BLOCKED_DIR}/; delete it by hand.`) }
    }
    const ts = host.now()
    await patchState(s => ({ ...withEvent(s, ts, { itemId: id, kind: 'retry', detail: 'unblocked by you' }), ...(s.current === id ? { attempts: 0, reviewRounds: 0 } : {}) }))
    return { text: say(`${id} is eligible again${isCurrent ? ' with its attempts and review rounds reset' : ''}. ${snap.state.autopilot ? 'The running loop picks it up in order.' : '/factory-start runs it.'}`) }
  }

  async function designCmd(args: string): Promise<Reply> {
    const running = await readState()
    if (running.autopilot) await pause(running, 'design being amended; /factory-approve then /factory-start resumes')
    await ensureGitignore()
    if ((await host.read(SETTINGS_PATH)) === null) await host.write(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`)
    if ((await host.read(TODO_PATH)) === null) await host.write(TODO_PATH, SKELETON_TODO)
    if ((await host.read(DESIGN_PATH)) === null) await host.write(DESIGN_PATH, '# Design\n\n## Decisions\n')
    const topic = cleanText(args ?? '').slice(0, 500)
    const prompt = await handOut('design', topic ? `Code factory: design interview (${topic})` : 'Code factory: design interview', topic ? `${DESIGN_PROMPT}\n\nThe person wants to focus on: ${topic}` : DESIGN_PROMPT)
    return { text: say('Code factory: design interview starting. Answer the questions; run /factory-approve when the design is complete.'), prompt }
  }

  async function branchProtectionWarnings(base: string): Promise<string[]> {
    const prot = await host.run(['gh', 'api', `repos/{owner}/{repo}/branches/${base}/protection`], 30000)
    const rules = await host.run(['gh', 'api', `repos/{owner}/{repo}/rules/branches/${base}`], 30000)
    const parse = (r: Run): unknown => {
      if (r.exitCode !== 0) return null
      try {
        return JSON.parse(r.stdout)
      } catch {
        return null
      }
    }
    if (prot.exitCode !== 0 && rules.exitCode !== 0) {
      const err = `${prot.stderr}${rules.stderr}`
      if (/Branch not protected|Not Found|404/i.test(err) && !/Upgrade|403/i.test(err)) return evaluateProtection(null, [], cleanText(base).slice(0, 60))
      return [`could not read ${cleanText(base).slice(0, 60)}'s protection (${cleanText(err).slice(0, 100)}); a private repo on a free plan cannot have it.`]
    }
    return evaluateProtection(parse(prot), parse(rules), cleanText(base).slice(0, 60))
  }

  type Drift = { error: string | null; missing: string[]; changed: string[] }

  async function designDrift(base: string): Promise<Drift> {
    const shown = cleanText(base).slice(0, 60)
    const fetched = await host.run(['git', 'fetch', '--', 'origin', base], 30000)
    if (fetched.exitCode !== 0) return { error: `could not fetch origin/${shown} (${cleanText(fetched.stderr).slice(0, 100)}); it is needed to check that the design files are pushed.`, missing: [], changed: [] }
    const missing: string[] = []
    const changed: string[] = []
    for (const path of [SETTINGS_PATH, TODO_PATH, DESIGN_PATH]) {
      const there = await host.run(['git', 'show', `origin/${base}:./${path}`], 15000)
      if (there.exitCode !== 0) {
        missing.push(path)
        continue
      }
      if (!designFileSame(there.stdout, (await host.read(path)) ?? '', path === TODO_PATH)) changed.push(path)
    }
    return { error: null, missing, changed }
  }

  async function driftProblems(base: string, drift: Drift): Promise<string[]> {
    if (drift.error !== null) return [drift.error]
    const shown = cleanText(base).slice(0, 60)
    const out: string[] = []
    if (drift.missing.length > 0) out.push(`${drift.missing.join(', ')} not on origin/${shown}: the design files must be on ${shown} (the loop returns to it between items and they would vanish).`)
    if (drift.changed.length > 0) out.push(`${drift.changed.join(', ')} differ from origin/${shown}.`)
    if (out.length > 0) out.push(designPushSteps(base, await branchNow()))
    return out
  }

  async function missingOnBase(base: string): Promise<string[]> {
    return driftProblems(base, await designDrift(base))
  }

  async function preflight(): Promise<string[]> {
    const problems: string[] = []
    if ((await host.run(['gh', 'auth', 'status'], 20000)).exitCode !== 0) problems.push('`gh` is missing or not logged in (run `gh auth login`).')
    if ((await host.run(['git', 'remote', 'get-url', 'origin'], 15000)).exitCode !== 0) problems.push('git has no `origin` remote to push PRs to.')
    return problems
  }

  async function approveCmd(): Promise<Reply> {
    await ensureGitignore()
    const snap = await load()
    const raw = await host.read(TODO_PATH)
    const designText = await host.read(DESIGN_PATH)
    const baseOk = isSafeBranchName(snap.settings.baseBranch)
    const protection = baseOk ? await branchProtectionWarnings(snap.settings.baseBranch) : []
    const hostIssue = hostProblem(snap.settings)
    const others = [
      ...snap.settingsProblems,
      ...(hostIssue ? [`${hostIssue}.`] : []),
      ...(snap.settings.requireBranchProtection ? protection : []),
      ...(raw === null ? [] : todoHeadingProblems(raw)),
      ...validateItems(snap.items, snap.settings.stopAfterVersion),
      ...(designText === null || !/^##\s+Decisions/im.test(designText) ? [`${DESIGN_PATH} needs a "## Decisions" section.`] : []),
      ...(await preflight()),
      ...(snap.state.unreadable ? [STATE_UNREADABLE] : []),
    ]
    const promoted = raw === null ? null : promoteProposed(raw)
    let designProblems: string[] = [designPushSteps(snap.settings.baseBranch)]
    let publishedNote = ''
    if (baseOk) {
      const base = snap.settings.baseBranch
      const drift = await designDrift(base)
      designProblems = await driftProblems(base, drift)
      if (designProblems.length > 0 && drift.error === null && others.length === 0 && raw !== null && designText !== null) {
        const ignoreText = await host.read(`${FACTORY_DIR}/.gitignore`)
        const files = [
          { path: SETTINGS_PATH, text: (await host.read(SETTINGS_PATH)) ?? '' },
          { path: TODO_PATH, text: promoted!.text },
          { path: DESIGN_PATH, text: designText },
          ...(ignoreText === null ? [] : [{ path: `${FACTORY_DIR}/.gitignore`, text: ignoreText }]),
        ]
        const pub = await publishDesignWith((argv, init) => host.run(argv, init?.timeoutMs ?? 30000, init), base, files, drift.changed)
        if ('sha' in pub) {
          designProblems = []
          publishedNote = `Published the design files to origin/${cleanText(base).slice(0, 60)} (${pub.sha.slice(0, 7)}).\n`
        } else {
          designProblems = [`could not publish the design files for you: ${pub.error}.`, ...designProblems]
        }
      }
    }
    const problems = [...others, ...designProblems]
    if (problems.length > 0) return { text: say(`Not approved. Fix these first (/factory-design continues the interview):\n- ${problems.join('\n- ')}`) }
    let promotedCount = 0
    if (promoted !== null) {
      promotedCount = promoted.ids.length
      if (promoted.ids.length > 0) await host.write(TODO_PATH, promoted.text)
    }
    await bumpEpoch()
    const after = await load()
    await writeState({ ...after.state, approved: true, approvedHash: decisionsHash(after.settings, after.items), approvedDone: after.items.filter(i => i.status === 'done').map(i => i.id), pausedReason: after.state.autopilot ? null : 'approved, not started', roadmapAsked: false })
    await setRt(r => (ownTurn(r) && r.turn!.kind === 'design' ? { ...r, turn: null } : r))
    const lines = after.items.filter(i => i.status === 'todo').map(i => `- ${i.id} [${i.type}] ${i.title}`)
    const warn = !snap.settings.requireBranchProtection && protection.length > 0 ? `\nWarnings (set requireBranchProtection to make them blocking):\n- ${protection.join('\n- ')}\n` : ''
    const head = `Approved. ${publishedNote}${warn}${promotedCount > 0 ? `${promotedCount} proposed item(s) promoted to todo.\n` : ''}Queue (in order):\n${lines.join('\n') || '(empty)'}\n`
    if (after.state.autopilot || lines.length === 0) return { text: say(`${head}${after.state.autopilot ? 'The loop is already running.' : 'Run /factory-start when items are ready.'}`) }
    const started = await startCmd()
    return started.prompt ? { text: say(`${head}${started.text}`), prompt: started.prompt } : { text: say(`${head}${started.text}`) }
  }

  async function doctorCmd(): Promise<Reply> {
    const out: string[] = []
    const add = (name: string, status: 'ok' | 'warn' | 'fail', detail = ''): void => {
      out.push(`${status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗'} ${name}${detail ? `: ${detail}` : ''}`)
    }
    const snap = await load()
    if (snap.settingsProblems.length > 0) add('settings.json', 'fail', snap.settingsProblems[0]!)
    else add('settings.json', 'ok')
    const hostIssue = hostProblem(snap.settings)
    if (hostIssue) add(host.name, 'fail', hostIssue)
    const headingProblems = todoHeadingProblems((await host.read(TODO_PATH)) ?? '')
    if (snap.items.length === 0) add('todo.md', 'fail', 'no items; run /factory-design')
    else if (headingProblems.length > 0) add('todo.md', 'fail', headingProblems[0]!)
    else add('todo.md', 'ok', `${snap.items.length} items`)
    const problem = await integrityProblem(snap)
    add('approval', problem ? 'fail' : 'ok', problem ?? 'design approved and unchanged')
    const auth = await host.run(['gh', 'auth', 'status'], 20000)
    add('gh login', auth.exitCode === 0 ? 'ok' : 'fail', auth.exitCode === 0 ? '' : 'run `gh auth login`')
    const remote = await host.run(['git', 'remote', 'get-url', 'origin'], 15000)
    add('origin remote', remote.exitCode === 0 ? 'ok' : 'fail', remote.exitCode === 0 ? '' : 'git has no origin to push PRs to')
    if (!isSafeBranchName(snap.settings.baseBranch)) add('base branch', 'fail', unsafeBaseNote())
    else if (remote.exitCode === 0) {
      const gone = await missingOnBase(snap.settings.baseBranch)
      add('design on base', gone.length > 0 ? 'fail' : 'ok', gone[0] ?? `pushed to ${cleanText(snap.settings.baseBranch)}`)
    }
    if (await lockedByOther()) add('loop lock', 'warn', 'another session is running the loop here')
    else add('loop lock', 'ok')
    return { text: say(`Factory doctor (${host.name}):\n${out.join('\n')}`) }
  }

  const COMMANDS: Record<string, { description: string; run: (args: string) => Promise<Reply> }> = {
    'factory-design': { description: 'Interview you for the design, then write .factory/design.md, todo.md and settings.json', run: designCmd },
    'factory-approve': { description: 'Validate and approve the design, then start the loop', run: () => approveCmd() },
    'factory-start': { description: 'Start or resume the build loop', run: () => startCmd() },
    'factory-stop': { description: 'Stop the loop after the current turn', run: () => stopCmd() },
    'factory-pause': { description: 'Pause the loop, keeping the current item and its attempts', run: () => pauseCmd() },
    'factory-status': { description: 'Where the loop is: current item, queue, blocked items, recent events', run: () => statusCmd() },
    'factory-log': { description: 'The event timeline, optionally for one item: [ID]', run: logCmd },
    'factory-skip': { description: 'Mark an item blocked so the loop moves on: <ID> [reason]', run: skipCmd },
    'factory-retry': { description: 'Make a blocked item eligible again: <ID>', run: retryCmd },
    'factory-doctor': { description: 'Check that this repo is ready for the loop', run: () => doctorCmd() },
  }

  async function command(name: string, args: string): Promise<Reply> {
    const c = COMMANDS[name]
    if (!c) return { text: say(`Unknown command ${name}. Commands: ${Object.keys(COMMANDS).map(k => `/${k}`).join(', ')}.`) }
    try {
      return await c.run(args)
    } catch (err) {
      return { text: say(`code-factory: ${name} failed: ${cleanText(String(err)).slice(0, 300)}`) }
    }
  }

  // ---- guards -------------------------------------------------------------

  // A work turn this session armed keeps its gates even if another session has
  // since taken the lock (on Codex the lock is only refreshed when a hook runs,
  // so a long tool call can let it go stale); otherwise the loop must be on and
  // the lock not held elsewhere.
  async function isLive(state: FactoryState): Promise<boolean> {
    if (!state.approved) return false
    if (await armed()) return true
    return state.autopilot && !(await lockedByOther())
  }

  const MESSAGE_DENY = 'code-factory: send no messages to agents while the review agent runs; its report is read as it finishes.'

  // A message to a running agent, or a resumed one, while the review runs could
  // steer the reviewer; only the reviewer itself may send them.
  async function guardAgentMessage(actor?: string): Promise<string | null> {
    const snap = await load()
    if (!(await isLive(snap.state)) || snap.state.reviewAgentId === null || actor === snap.state.reviewAgentId) return null
    return reviewPending(snap.state, snap.settings) ? MESSAGE_DENY : null
  }

  // `actor` is the subagent or child session making the call, undefined for the main session.
  async function guardShell(command: string, actor?: string): Promise<string | null> {
    const snap = await load()
    const base = snap.settings.baseBranch
    const branch = await branchNow()
    const f = classifyBash(command, base, branch)
    if (f.touchesFactoryState) return say('code-factory: the factory state file is controlled by the person through the factory commands.')
    if (!(await isLive(snap.state))) return null
    if ((f.isCommit || f.isPush) && snap.state.reviewAgentId !== null && actor !== snap.state.reviewAgentId && reviewPending(snap.state, snap.settings)) return REVIEW_BUSY_DENY
    if (f.apiPrWrite) return 'code-factory: do not change branches, PRs or contents through `gh api`; use git and `gh pr create` / `gh pr merge` so the checks run.'
    if (!(f.isPush || f.isCommit || f.isPrCreate || f.isPrMerge)) return null

    const problem = await integrityProblem(snap)
    if (problem) {
      await pause(snap.state, problem)
      return say(`code-factory: paused, ${problem}.`)
    }
    const { settings } = snap
    const tail = (r: Run): string => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n')
    const names = (r: Run): string[] => r.stdout.split('\n').filter(Boolean)

    if (f.isForcePush) return 'code-factory: force-push is not allowed.'
    if (f.isPush && (f.pushNamesBase || f.pushesBase || branch === base)) return say(`code-factory: never push to ${base}; push the factory/* branch and open a PR.`)
    if (f.isCommit && f.commitsOnBase) {
      const item = snap.items.find(i => i.id === snap.state.current)
      return say(`code-factory: do not commit on ${base}. Create the branch first${item ? `: git checkout -b ${branchFor(item)}` : ''}.`)
    }
    if ((f.isPrCreate || f.isPrMerge) && f.repoFlag) return 'code-factory: do not target another repository with -R/--repo.'

    if (f.isPrCreate) {
      if (!branch.startsWith('factory/')) return say(`code-factory: open PRs from a factory/* branch (current: "${branch}").`)
      const item = snap.items.find(i => i.id === snap.state.current)
      if (settings.requireTestChanges && item?.type !== 'docs' && item?.type !== 'chore') {
        let diff = await host.run(['git', 'diff', '--name-only', '--no-renames', `origin/${base}...HEAD`])
        if (diff.exitCode !== 0) diff = await host.run(['git', 'diff', '--name-only', '--no-renames', `${base}...HEAD`])
        if (diff.exitCode === 0 && !hasTestChanges(names(diff)) && !isDocsOnly(names(diff))) return 'code-factory: this branch changes no test files. Add tests for the new behavior or the regression test for the bug.'
      }
      if (!settings.allowTestRemoval) {
        let full = await host.run(['git', 'diff', '-U0', '--no-color', `origin/${base}...HEAD`])
        if (full.exitCode !== 0) full = await host.run(['git', 'diff', '-U0', '--no-color', `${base}...HEAD`])
        const weak = full.exitCode === 0 ? testWeakening(full.stdout) : []
        if (weak.length > 0) return say(`code-factory: this branch weakens the tests (${weak.join('; ')}). Restore them; settings.allowTestRemoval needs the person's approval.`)
      }
      if (settings.requireReview) {
        const head = await headSha()
        if (!isReviewClean(snap.state.review, head)) {
          const last = snap.state.review
          return say(`code-factory: no clean independent review for HEAD ${head.slice(0, 7)}${last ? ` (last review: ${markCounts(last)} at ${last.sha.slice(0, 7)})` : ''}. Run step 6: spawn the fresh review agent with the exact prompt from the work item and do not commit after it.`)
        }
      }
      if (settings.buildCmd.length > 0) {
        const built = await host.run(settings.buildCmd, settings.testTimeoutMs)
        if (built.exitCode !== 0) return say(`code-factory: the build fails (${settings.buildCmd.join(' ')}, exit ${built.exitCode}). Fix it first.\n${tail(built)}`)
      }
      const tests = await host.run(settings.testCmd, settings.testTimeoutMs)
      if (tests.exitCode !== 0) return say(`code-factory: the test suite fails (${settings.testCmd.join(' ')}, exit ${tests.exitCode}). Fix it before opening the PR.\n${tail(tests)}`)
      if (settings.e2eCmd.length > 0 && settings.e2eFor.includes(item?.type ?? 'feature')) {
        const e2e = await host.run(settings.e2eCmd, settings.testTimeoutMs)
        if (e2e.exitCode !== 0) return say(`code-factory: the end-to-end tests fail (${settings.e2eCmd.join(' ')}, exit ${e2e.exitCode}). The change does not work yet.\n${tail(e2e)}`)
      }
    }

    if (f.isPrMerge) {
      if (f.hasAdmin) return 'code-factory: --admin merges are not allowed.'
      if (f.hasAuto) return 'code-factory: --auto merges skip the check this plugin makes; wait for CI with `gh pr checks --watch`, then merge.'
      const sel = f.prSelector ? [f.prSelector] : []
      const prView = await host.run(['gh', 'pr', 'view', ...sel, '--json', 'state,mergeable,headRefName,headRefOid,statusCheckRollup'])
      if (prView.exitCode !== 0) return say(`code-factory: could not read the PR (${prView.stderr.trim().slice(0, 160)}).`)
      let pr: { state: string; mergeable: string; headRefName: string; headRefOid: string; statusCheckRollup: unknown[] }
      try {
        pr = JSON.parse(prView.stdout) as typeof pr
      } catch {
        return 'code-factory: could not parse the PR status.'
      }
      if (!pr.headRefName.startsWith('factory/')) return 'code-factory: it only merges factory/* PRs.'
      if (pr.state !== 'OPEN') return say(`code-factory: the PR is ${pr.state}.`)
      if (pr.mergeable === 'CONFLICTING') return 'code-factory: the PR has merge conflicts; rebase or merge the base branch and push.'
      const liveItem = snap.state.current
      const verdict = checksVerdict((pr.statusCheckRollup ?? []) as Parameters<typeof checksVerdict>[0], settings.allowNoCI)
      if (verdict.ok) await logEvent({ itemId: liveItem, kind: 'ci-passed', detail: verdict.reason })
      else if (/FAILURE|CANCELLED|STARTUP|ACTION_REQUIRED|TIMED_OUT/.test(verdict.reason)) await logEvent({ itemId: liveItem, kind: 'ci-failed', detail: verdict.reason })
      if (!verdict.ok) {
        if (/FAILURE|CANCELLED|STARTUP|ACTION_REQUIRED/.test(verdict.reason)) {
          const billing = await ciBillingProblem()
          if (billing) {
            await pauseForBilling(billing)
            return 'code-factory: CI failed for a GitHub billing/spending-limit reason; the loop is paused. Stop and end your turn.'
          }
        }
        return say(`code-factory: ${verdict.reason}. Wait with \`gh pr checks --watch\` and fix failures.`)
      }
      if (settings.requireReview && !isReviewClean(snap.state.review, pr.headRefOid ?? '')) {
        return say(`code-factory: the PR head ${(pr.headRefOid ?? '').slice(0, 7)} is not the commit the clean review covered (${snap.state.review ? snap.state.review.sha.slice(0, 7) : 'none'}). Re-run the review agent on the final commit.`)
      }
      if (!settings.allowTestRemoval) {
        const diff = await host.run(['gh', 'pr', 'diff', ...sel, '--color', 'never'], 60000)
        if (diff.exitCode === 0) {
          const weak = testWeakening(diff.stdout)
          if (weak.length > 0) return say(`code-factory: the PR weakens the tests (${weak.join('; ')}).`)
        }
      }
    }
    return null
  }

  // After a shell command ran: the timeline, and a billing failure in CI output
  // stops the loop. Returns a note for the model, if any.
  async function afterShell(command: string, output: string, ok: boolean): Promise<string | null> {
    const state = await readState()
    if (!(await isLive(state))) return null
    const item = state.current
    const ev: LoopEvent | null = loopEventForBash(classifyBash(command, 'main'))
    if (ok && item && ev === 'commit') await logEvent({ itemId: item, kind: 'commit', detail: commitMessage(command) })
    if (ok && item && ev === 'pr') {
      const pr = parsePrUrl(output)
      await logEvent(pr ? { itemId: item, kind: 'pr-opened', detail: '', ...pr } : { itemId: item, kind: 'pr-opened', detail: 'gh pr create' })
    }
    if (ok && item && ev === 'merge') await logEvent({ itemId: item, kind: 'merged', detail: `gh pr merge ${classifyBash(command, 'main').prSelector ?? ''}`.trim() })
    const f = classifyBash(command, 'main')
    if (!f.isCiLookup || f.isPush || f.isCommit || f.isPrCreate || f.isPrMerge) return null
    if (item && /\bpr\s+checks\b/.test(command)) {
      const outcome = ciOutcome(output)
      if (outcome) await logEvent({ itemId: item, kind: outcome === 'passed' ? 'ci-passed' : 'ci-failed', detail: outcome === 'passed' ? 'gh pr checks: all green' : 'gh pr checks: failing' })
    }
    let detail: string | null = isBillingProblem(output) ? output : null
    if (!detail && /fail|cancel|startup_failure|action_required|✗/i.test(output)) detail = await ciBillingProblem()
    if (!detail) return null
    await pauseForBilling(detail)
    return 'code-factory: CI failed for a GitHub billing/spending-limit reason. The factory loop is paused. Stop working on this item and end your turn.'
  }

  async function guardWrite(paths: readonly string[], actor?: string): Promise<string | null> {
    if (paths.some(isFactoryControlFile)) return FACTORY_FILE_DENY
    const state = await readState()
    if (!(await isLive(state))) return null
    const config = paths.find(isAgentConfigPath)
    if (config) return 'code-factory: agent, command, skill, hook, plugin and settings files of the coding agents cannot be changed while the factory loop is live.'
    if (state.reviewAgentId !== null && actor !== state.reviewAgentId && paths.some(p => !/(^|\/)\.factory\//.test(normalizePath(p)))) {
      const { settings } = await load()
      if (reviewPending(state, settings)) return REVIEW_BUSY_DENY
    }
    return null
  }

  let reviewInFlight = false

  // The reviewer is spawned once per round by the main loop, with the exact
  // prompt from the work item. Returns a deny, the prompt to run (with the
  // factory's additions), or null to let a call that is not a review through.
  async function reviewSpawn(prompt: string, actor: string | undefined, plainAgent: boolean): Promise<{ deny: string } | { prompt: string } | null> {
    if (!prompt.includes(REVIEW_TAG)) {
      // While the reviewer starts or runs, the main session starts no other
      // agent, so nothing but the reviewer can be taken for it.
      if (actor !== undefined) return null
      const snap = await load()
      if (!(await isLive(snap.state)) || snap.state.reviewAgentId === null || !reviewPending(snap.state, snap.settings)) return null
      return { deny: 'code-factory: start no other agents while the review agent runs; wait for its verdict.' }
    }
    if (reviewInFlight) return { deny: 'code-factory: a review agent is already starting; wait for it.' }
    reviewInFlight = true
    try {
      const snap = await load()
      if (!(await isLive(snap.state))) return null
      const item = snap.items.find(i => i.id === snap.state.current)
      if (actor !== undefined || !item) return { deny: 'code-factory: the review agent is started once, by the main loop, for the current item.' }
      if (normalizeText(prompt) !== normalizeText(reviewAgentPrompt(snap.settings, branchFor(item)))) return { deny: 'code-factory: pass the review prompt from the work item exactly as written, without changes.' }
      if (!plainAgent) return { deny: 'code-factory: start the review agent as a plain general-purpose agent, without a custom type, model or other options.' }
      if (snap.state.reviewRounds >= snap.settings.maxReviewRounds) return { deny: say(`code-factory: ${snap.settings.maxReviewRounds} review rounds are used up for ${item.id}; write .factory/blocked/${item.id}.md and stop.`) }
      if (snap.state.reviewAgentId !== null && reviewPending(snap.state, snap.settings)) return { deny: say(`code-factory: the review agent for ${item.id} is still running; wait for its verdict.`) }
      let stat: { files: number; lines: number } | null = null
      if (isSafeBranchName(snap.settings.baseBranch)) {
        const r = await host.run(['git', 'diff', '--shortstat', `origin/${snap.settings.baseBranch}...HEAD`], 20000)
        if (r.exitCode === 0) stat = parseShortstat(r.stdout)
      }
      const at = host.now()
      await patchState(fresh => ({
        ...withEvent(fresh, at, { itemId: item.id, kind: 'review-launched', detail: `round ${fresh.reviewRounds + 1}/${snap.settings.maxReviewRounds}` }),
        reviewAgentId: PENDING_REVIEWER,
        reviewAgentAt: at,
        reviewWaitMs: snap.settings.reviewTimeoutMs,
      }))
      return { prompt: `${prompt}${declinedSection(snap.state.reviewDeclined)}${rereviewSection(snap.state.review, snap.state.reviewRounds, snap.state.reviewOpen)}${depthSection(stat)}` }
    } finally {
      reviewInFlight = false
    }
  }

  // The host learned the reviewer's id (child session or subagent id).
  async function reviewLaunched(agentId: string): Promise<boolean> {
    if (!agentId || agentId === PENDING_REVIEWER) return false
    const saved = await patchState(fresh => (fresh.reviewAgentId === PENDING_REVIEWER ? { ...fresh, reviewAgentId: agentId } : null))
    return saved !== null
  }

  // The spawn failed after it was allowed: the round does not count.
  async function reviewLaunchFailed(): Promise<void> {
    await patchState(fresh => (fresh.reviewAgentId === PENDING_REVIEWER ? { ...fresh, reviewAgentId: null, reviewAgentAt: 0 } : null))
  }

  async function recordReview(itemId: string, mark: ReviewMark, maxRounds: number, declined: string[], open: string[]): Promise<void> {
    const isClean = markClean(mark)
    const ts = host.now()
    const saved = await patchState(fresh => ({
      ...withEvent(fresh, ts, { itemId, kind: 'review-verdict', detail: markDetail(mark) }),
      review: mark,
      reviewDeclined: mergeDeclined(fresh.reviewDeclined, declined),
      reviewOpen: isClean ? [] : mergeDeclined([], open),
      reviewRounds: isClean ? 0 : fresh.reviewRounds + 1,
      reviewAgentId: null,
      reviewAgentAt: 0,
    }))
    const rounds = saved?.reviewRounds ?? 0
    if (!isClean && rounds >= maxRounds) {
      await host.write(`${BLOCKED_DIR}/${itemId}.md`, `Review still found danger=${mark.danger} medium=${mark.medium} security=${mark.security ?? 'unreported'} after ${rounds} rounds.\n`)
      notify(`factory: ${itemId} blocked, review never came back clean`)
      await logEvent({ itemId, kind: 'blocked', detail: `review not clean after ${rounds} rounds` })
    }
  }

  // The reviewer finished: its own final answer carries the verdict.
  async function reviewFinished(agentId: string, answer: string, final = true): Promise<void> {
    const snap = await load()
    if (!agentId || snap.state.reviewAgentId !== agentId) return
    const item = snap.items.find(i => i.id === snap.state.current)
    const act = decideReviewAnswer(answer, agentId, snap.state, item !== undefined, final)
    if (act.action === 'ignore' || !item) return
    if (act.action === 'unavailable') {
      await pause(snap.state, 'the review agent could not review the branch', { override: { reviewAgentId: null, reviewAgentAt: 0 } })
      return
    }
    if (act.action === 'record') return recordReview(item.id, act.mark, snap.settings.maxReviewRounds, act.declined, act.open)
    const ts = host.now()
    const saved = await patchState(fresh => ({ ...withEvent(fresh, ts, { itemId: item.id, kind: 'review-verdict', detail: 'ended without a verdict' }), reviewRounds: fresh.reviewRounds + 1, reviewAgentId: null, reviewAgentAt: 0 }))
    const rounds = saved?.reviewRounds ?? snap.state.reviewRounds + 1
    if (rounds >= snap.settings.maxReviewRounds) {
      await host.write(`${BLOCKED_DIR}/${item.id}.md`, `The review agent ended ${rounds} times without a verdict.\n`)
      notify(`factory: ${item.id} blocked, the review agent never gave a verdict`)
      await logEvent({ itemId: item.id, kind: 'blocked', detail: `review agent gave no verdict ${rounds} times` })
    }
  }

  return {
    commands: COMMANDS,
    command,
    advance,
    onTurnEnd,
    onPersonPrompt,
    guardShell,
    afterShell,
    guardWrite,
    reviewSpawn,
    reviewLaunched,
    reviewLaunchFailed,
    reviewFinished,
    guardAgentMessage,
    guardsLive: async (): Promise<boolean> => isLive(await readState()),
    touchLock,
    readState,
    runtime: rt,
    load,
  }
}

export type Factory = ReturnType<typeof createFactory>

// Paths an apply_patch-style patch touches (`*** Update File: x`, `*** Add File: x`,
// `*** Delete File: x`, `*** Move to: x`).
export function patchPaths(patch: string): string[] {
  const out: string[] = []
  // Codex trims each line before it reads a header, so indented headers count.
  for (const m of patch.matchAll(/^\s*\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+?)\s*$|^\s*\*\*\*\s+Move to:\s*(.+?)\s*$/gm)) {
    const p = (m[1] ?? m[2] ?? '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

// A shell call can run in its own working directory (Codex `workdir`, OpenCode
// `workdir`). The gates read paths from the command text, so a command run from
// inside .factory/ is checked as if it had changed into it first.
export function gateCommand(command: string, root: string, callDir: string | null): string {
  if (!callDir) return command
  const rel = relative(root, resolve(root, callDir))
  return rel === FACTORY_DIR || rel.startsWith(`${FACTORY_DIR}/`) || rel.startsWith(`${FACTORY_DIR}\\`) ? `cd ${rel.split('\\').join('/')} && ${command}` : command
}

// Every path a patch touches, as written and as resolved against the folder it
// is applied in (the call's working directory and a leading `cd <dir> &&`,
// which Codex honours), made relative to the repository when inside it.
export function patchTargets(command: string, root: string, callDir: string | null): string[] {
  const cd = /^\s*cd\s+('[^']*'|"[^"]*"|[^\s;&|]+)\s*&&/.exec(command)?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  const base = resolve(root, callDir ?? '.', cd)
  const out = new Set<string>()
  for (const p of patchPaths(command)) {
    out.add(p)
    const abs = resolve(base, p)
    const rel = relative(root, abs)
    out.add(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : abs)
  }
  return [...out]
}

// The text of the last assistant message in a transcript the host returns.
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: unknown; role?: unknown; content?: unknown; parts?: unknown } | null
    if (!m || (m.type !== 'assistant' && m.role !== 'assistant')) continue
    const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : []
    const text = parts
      .map(p => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
    if (typeof m.content === 'string' && m.content) return m.content
  }
  return ''
}
