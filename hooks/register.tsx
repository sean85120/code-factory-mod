import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  BLOCKED_DIR,
  COST_KEY_PREFIX,
  designPushSteps,
  PLAN_KEY,
  addTokens,
  agentActions,
  appendEvent,
  cleanText,
  applyChanges,
  budgetPauseReason,
  budgetReached,
  budgetUnreadableReason,
  ciOutcome,
  commitMessage,
  costPhase,
  costSummaryForPrompt,
  costsReport,
  formatDuration,
  formatLog,
  formatUsd,
  liveSpend,
  mergeEvents,
  normalizeRepoCosts,
  oneLine,
  progressBar,
  checksLine,
  checksReport,
  controlsFor,
  isCompact,
  unsafeBaseNote,
  runControls,
  statusLine,
  noteItem,
  parseCostsArgs,
  parseItemArg,
  parsePrUrl,
  repoKey,
  safeLines,
  deny,
  rebaseMark,
  roadmapExpired,
  isSafeBranchName,
  isRoadmapDone,
  releasePending,
  roadmapPrompt,
  triagePrompt,
  parseShortstat,
  depthSection,
  triageFilter,
  guideReport,
  guideControls,
  journey,
  nextHint,
  sanitizeEvents,
  settleCost,
  shouldAskRoadmap,
  startRun,
  treeRun,
  stripControls,
  statusReport,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  DESIGN_PATH,
  DESIGN_PROMPT,
  FACTORY_DIR,
  LOCK_PATH,
  REVIEW_TAG,
  STAGES,
  SETTINGS_PATH,
  STATE_PATH,
  TODO_PATH,
  agentText,
  branchFor,
  buildView,
  checksVerdict,
  classifyBash,
  decisionsHash,
  evaluateProtection,
  hasTestChanges,
  inScope,
  isBillingProblem,
  isLockedByOther,
  declinedLines,
  declinedSection,
  decideReviewAnswer,
  mergeDeclined,
  sanitizeDeclined,
  designFileSame,
  isReviewClean,
  markClean,
  noteReview,
  markCounts,
  markDetail,
  rereviewSection,
  isReviewPending,
  reviewWindow,
  loopEventForBash,
  nudgePrompt,
  normalizePath,
  normalizeText,
  parseLock,
  agentLaunchId,
  parseReviewMarker,
  parseSettings,
  parseTodo,
  pickNext,
  promoteProposed,
  releasePrompt,
  reviewAgentPrompt,
  stageAfter,
  summarize,
  testWeakening,
  todoHeadingProblems,
  validateItems,
  workPrompt,
} from './lib'
import type { AgentRow, Control, DoctorCheck, Drive, EventKind, FactoryEvent, FactoryState, FactoryView, Item, LoopEvent, Mark, RepoCosts, ReviewMark, Settings, Stage, Step, Usage } from './lib'

type Dollar = EngineInterface

// ---- module state (a reload only costs one /factory-start) ----------------

// A turn the factory started is running. The guards stay armed for it even if
// the loop gets paused halfway, until the turn ends or the person takes over.
let isFactoryTurn = false
let factoryTurnAt = -1
let reviewInFlight = false
const FACTORY_TURN_TTL_MS = 3 * 3600000
let isArmed = false
let costFailed = false
let isAdvancing = false
let handsOff = false
let rearms = 0
const MAX_REARMS = 3
let roadmapPending = false
let personSlash = false
let slashTurnId: string | null = null
let slashGen = 0
const SLASH_TURN_WAIT_MS = 5000
let unreadableToasted = false

// One session runs the loop per repo. The lock lives in .factory/lock.json, is
// refreshed every 30 s and counts as free after two minutes without a beat.
const ME = `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
type Timer = { cancel: () => void }
let beatTimer: Timer | null = null
let watchTimer: Timer | null = null
let lastLockToast = 0

type Run = { exitCode: number; stdout: string; stderr: string }

async function run($: Dollar, argv: string[], timeoutMs = 60000): Promise<Run> {
  try {
    const r = await $.process.run(argv, { timeoutMs, env: { CI: '1' }, stdin: '' })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: `could not run ${argv.slice(0, 3).join(' ')} (not installed, or it ran past ${Math.round(timeoutMs / 1000)}s): ${String(err)}` }
  }
}

async function verifyBase($: Dollar, settings: Settings, live: () => Promise<boolean>): Promise<string | null> {
  const base = settings.baseBranch
  await run($, ['git', 'fetch', '--', 'origin', base])
  const here = await run($, ['git', 'rev-parse', 'HEAD'])
  const there = await run($, ['git', 'rev-parse', `origin/${base}`])
  if (here.exitCode !== 0 || there.exitCode !== 0 || here.stdout.trim() !== there.stdout.trim()) return null
  if (!(await live())) return null
  if (settings.buildCmd.length > 0) {
    const built = await run($, settings.buildCmd, settings.testTimeoutMs)
    if (built.exitCode !== 0) return `the build fails (${settings.buildCmd.join(' ')}, exit ${built.exitCode})`
    if (!(await live())) return null
  }
  const tests = await run($, settings.testCmd, settings.testTimeoutMs)
  return tests.exitCode === 0 ? null : `the test suite fails (${settings.testCmd.join(' ')}, exit ${tests.exitCode})`
}

async function readText($: Dollar, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return await $.fs.read(path)
  } catch {
    return null
  }
}

const STATE_UNREADABLE = `${STATE_PATH} cannot be read or is not valid JSON; the guards stay on and nothing writes it. Fix or delete it, then /factory-approve`
const STATE_READS = 3

async function readStateOnce($: Dollar): Promise<FactoryState | 'absent' | null> {
  let text: string
  try {
    if (!(await $.fs.exists(STATE_PATH))) return 'absent'
    text = await $.fs.read(STATE_PATH)
  } catch {
    return null
  }
  try {
    const raw = JSON.parse(text) as Partial<FactoryState>
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    return { ...DEFAULT_STATE, ...raw, events: sanitizeEvents(raw.events), reviewDeclined: sanitizeDeclined(raw.reviewDeclined), reviewOpen: sanitizeDeclined(raw.reviewOpen), roadmapAsked: raw.roadmapAsked === true, unreadable: undefined }
  } catch {
    return null
  }
}

async function readState($: Dollar): Promise<FactoryState> {
  for (let i = 0; i < STATE_READS; i++) {
    const got = await readStateOnce($)
    if (got === 'absent') return { ...DEFAULT_STATE }
    if (got) return got
  }
  return { ...DEFAULT_STATE, approved: true, autopilot: true, pausedReason: STATE_UNREADABLE, unreadable: true }
}

async function writeState($: Dollar, state: FactoryState): Promise<void> {
  if (state.unreadable) return
  let events = state.events ?? []
  const disk = await readText($, STATE_PATH)
  if (disk) {
    try {
      events = mergeEvents(sanitizeEvents((JSON.parse(disk) as { events?: unknown }).events), events)
    } catch {
      events = state.events ?? []
    }
  }
  await $.fs.write(STATE_PATH, `${JSON.stringify({ ...state, events }, null, 2)}\n`)
}

let stateChain: Promise<unknown> = Promise.resolve()

function patchState($: Dollar, fn: (s: FactoryState) => FactoryState | null | Promise<FactoryState | null>): Promise<FactoryState | null> {
  const job = stateChain
    .then(async () => {
      const next = await fn(await readState($))
      if (next === null) return null
      await writeState($, next)
      return next
    })
    .catch(() => null)
  stateChain = job
  return job
}

async function stamp($: Dollar): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

function pressControl($: Dollar, c: Control): void {
  const submits = c.command === 'factory-design' || c.command === 'factory-triage' || c.command === 'factory-roadmap'
  if (((c.command === 'factory-start' || c.command === 'factory-approve') && mainTurnOpen && !isFactoryTurn) || (submits && mainTurnOpen)) {
    toast($, `factory: a turn is still running; press again after it finishes, or type /${c.command}`)
    return
  }
  const args = c.args ?? ''
  const out =
    c.command === 'factory-start' ? startCmd($) : c.command === 'factory-pause' ? pauseCmd($) : c.command === 'factory-stop' ? stopCmd($) : c.command === 'factory-skip' ? skipCmd($, args) : c.command === 'factory-doctor' ? doctorCmd($) : c.command === 'factory-retry' ? retryCmd($, args) : c.command === 'factory-design' ? designCmd($, args) : c.command === 'factory-approve' ? approveCmd($) : c.command === 'factory-triage' ? triageCmd($, args) : c.command === 'factory-roadmap' ? interviewCmd($, ROADMAP_INTERVIEW) : Promise.resolve({ text: `factory: unknown control ${c.command}` })
  void out.then(r => toast($, c.command === 'factory-approve' && r.text.startsWith('Not approved') ? 'factory: not approved yet; type /factory-approve to see what to fix' : oneLine(r.text, 120))).catch(() => toast($, `factory: ${c.label} failed`))
}

function toast($: Dollar, text: string, options?: Parameters<Dollar['ui']['toast']>[1]): void {
  $.ui.toast(stripControls(text), options)
}

function status($: Dollar, text: string | undefined): void {
  $.ui.status(text === undefined ? undefined : stripControls(text))
}

type NewEvent = { itemId: string | null; kind: EventKind; detail: string; pr?: number; url?: string }

function withEvent(state: FactoryState, ts: number, ev: NewEvent): FactoryState {
  return { ...state, events: appendEvent(state.events ?? [], { ts, ...ev }) }
}

async function logEvent($: Dollar, ev: NewEvent): Promise<void> {
  const ts = await stamp($)
  await patchState($, s => withEvent(s, ts, ev))
}

let repoKeyMemo: string | null = null
let treeMemo: string | null = null
let markOwner: string | null = null
let costChain: Promise<unknown> = Promise.resolve()

async function costRepo($: Dollar): Promise<string> {
  if (repoKeyMemo) return repoKeyMemo
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], 15000)
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  repoKeyMemo = repoKey(remote.exitCode === 0 ? remote.stdout : '', cwd)
  return repoKeyMemo
}

async function costTree($: Dollar): Promise<string> {
  if (treeMemo) return treeMemo
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  treeMemo = typeof cwd === 'string' && cwd ? cwd.replace(/\/+$/, '') || '/' : `session:${await sessionOwner($)}`
  return treeMemo
}

async function sessionUsd($: Dollar): Promise<number | null> {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return typeof usd === 'number' && Number.isFinite(usd) ? usd : null
  } catch {
    return null
  }
}

async function sessionOwner($: Dollar): Promise<string> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' && id ? id : ME
  } catch {
    return ME
  }
}

type CostCtx = { now: number; usd: number | null; owner: string; from: string; tree: string }

function editCosts<T>($: Dollar, fn: (rc: RepoCosts, c: CostCtx) => { costs: RepoCosts; value: T }): Promise<T | null> {
  const job = costChain
    .then(async () => {
      const repo = await costRepo($)
      const key = `${COST_KEY_PREFIX}${repo}`
      const owner = await sessionOwner($)
      const c: CostCtx = { now: await stamp($), usd: await sessionUsd($), owner, from: markOwner ?? owner, tree: await costTree($) }
      const before = normalizeRepoCosts(await $.store.get(key), repo)
      const r = fn(before, c)
      if (JSON.stringify(r.costs) !== JSON.stringify(before)) await $.store.set(key, r.costs)
      costFailed = false
      return r.value
    })
    .catch(() => {
      costFailed = true
      return null
    })
  costChain = job
  return job
}

const lastRunUsd = (rc: RepoCosts, tree: string): number => treeRun(rc, tree)?.usd ?? 0

async function drive($: Dollar, d: Drive, attempt = false): Promise<void> {
  await editCosts($, (rc, c) => {
    let costs = settleCost(rc, { from: c.from, to: c.owner, tree: c.tree, nowUsd: c.usd, now: c.now, next: d }).costs
    if (attempt) costs = noteItem(costs, d.key, d.title, c.now, { attempt: true })
    markOwner = c.owner
    return { costs, value: null }
  })
}

async function settle($: Dollar, keep: boolean, extra?: (rc: RepoCosts, now: number, tree: string) => RepoCosts): Promise<number | null> {
  return editCosts($, (rc, c) => {
    let { costs } = settleCost(rc, { from: c.from, to: c.owner, tree: c.tree, nowUsd: c.usd, now: c.now, next: keep ? 'keep' : null })
    if (extra) costs = extra(costs, c.now, c.tree)
    markOwner = costs.marks[c.owner] ? c.owner : null
    return { costs, value: lastRunUsd(costs, c.tree) }
  })
}

async function rebaseOpenMark($: Dollar): Promise<void> {
  await editCosts($, (rc, c) => ({ costs: rebaseMark(rc, c.from, c.usd, c.now), value: null }))
}

async function readCosts($: Dollar): Promise<{ rc: RepoCosts; owner: string; tree: string; usd: number | null } | null> {
  try {
    const repo = await costRepo($)
    const owner = await sessionOwner($)
    return { rc: normalizeRepoCosts(await $.store.get(`${COST_KEY_PREFIX}${repo}`), repo), owner: markOwner ?? owner, tree: await costTree($), usd: await sessionUsd($) }
  } catch {
    return null
  }
}

async function currentSpend($: Dollar, current: string | null): Promise<{ runUsd: number; itemUsd: number } | null> {
  if (costFailed) return null
  const r = await readCosts($)
  return r && r.usd !== null ? liveSpend(r.rc, r.owner, r.tree, r.usd, current) : null
}

async function viewStage($: Dollar): Promise<Stage | null> {
  try {
    return (await read($, view))?.stage ?? null
  } catch {
    return null
  }
}

async function blockedIds($: Dollar): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    if (!(await $.fs.exists(BLOCKED_DIR))) return ids
    for (const entry of await $.fs.list(BLOCKED_DIR)) {
      const m = /^([A-Za-z]+-\d+)\.md$/.exec(entry.name)
      if (m) ids.add(m[1]!.toUpperCase())
    }
  } catch {
    // an unreadable folder means nothing is blocked yet
  }
  return ids
}

async function blockedNotes($: Dollar, ids: ReadonlySet<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of [...ids].sort()) {
    const text = (await readText($, `${BLOCKED_DIR}/${id}.md`)) ?? (await readText($, `${BLOCKED_DIR}/${id.toLowerCase()}.md`)) ?? ''
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    out.set(id, cleanText(lines.find(l => !l.startsWith('#')) ?? lines[0] ?? ''))
  }
  return out
}

type Snapshot = {
  state: FactoryState
  settings: Settings
  settingsProblems: string[]
  items: Item[] // as written in todo.md
  blocked: Set<string>
}

async function load($: Dollar): Promise<Snapshot> {
  const parsed = parseSettings(await readText($, SETTINGS_PATH))
  const todo = await readText($, TODO_PATH)
  return {
    state: await readState($),
    settings: parsed.settings,
    settingsProblems: parsed.problems,
    items: todo === null ? [] : parseTodo(todo),
    blocked: await blockedIds($),
  }
}

// `done` in todo.md only counts when the person approved it as done or the
// factory verified its merged PR; the item in progress keeps what the branch says.
function effectiveItems(snap: Snapshot): Item[] {
  const trusted = new Set([...snap.state.approvedDone, ...snap.state.mergedIds])
  return snap.items.map(i => (i.status === 'done' && !trusted.has(i.id) && i.id !== snap.state.current ? { ...i, status: 'todo' as const } : i))
}

// ---- lock -------------------------------------------------------------------

async function readLock($: Dollar) {
  let text = await readText($, LOCK_PATH)
  if (text !== null) {
    try {
      JSON.parse(text)
    } catch {
      text = await readText($, LOCK_PATH) // a write may have been caught half-way
    }
  }
  return parseLock(text)
}

async function lockedByOther($: Dollar): Promise<boolean> {
  const lock = await readLock($)
  if (lock.owner === null || lock.owner === ME) return false
  return isLockedByOther(lock, ME, await $.clock.now())
}

async function acquireLock($: Dollar): Promise<boolean> {
  if (await lockedByOther($)) return false
  await $.fs.write(LOCK_PATH, JSON.stringify({ owner: ME, heartbeat: await $.clock.now() }))
  if ((await readLock($)).owner !== ME) return false
  if (!beatTimer) {
    beatTimer = $.clock.every(30000, () => {
      void (async () => {
        if ((await readLock($)).owner !== ME) {
          beatTimer?.cancel()
          beatTimer = null
          return
        }
        const running = await readState($)
        if (!running.unreadable && !running.autopilot) {
          await releaseLock($)
          return
        }
        await $.fs.write(LOCK_PATH, JSON.stringify({ owner: ME, heartbeat: await $.clock.now() }))
      })()
    })
  }
  return true
}

async function releaseLock($: Dollar): Promise<void> {
  beatTimer?.cancel()
  beatTimer = null
  try {
    if ((await readLock($)).owner === ME) {
      await $.fs.write(LOCK_PATH, JSON.stringify({ owner: null, heartbeat: 0 }))
    }
  } catch {
    // a lock that cannot be released goes stale by itself
  }
}

// ---- small helpers ------------------------------------------------------------

async function branchNow($: Dollar): Promise<string> {
  const r = await run($, ['git', 'branch', '--show-current'], 15000)
  return r.stdout.trim()
}

async function headSha($: Dollar): Promise<string> {
  const r = await run($, ['git', 'rev-parse', 'HEAD'], 15000)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

async function refreshStatus($: Dollar): Promise<void> {
  await refreshView($)
}

let loopEpoch = 0
type LoopGuard = { epoch: number }

async function loopLive($: Dollar, guard: LoopGuard, fresh?: FactoryState): Promise<boolean> {
  if (guard.epoch !== loopEpoch) return false
  const s = fresh ?? (await readState($))
  if (!s.autopilot || s.unreadable) return false
  const owned = (await readLock($)).owner === ME
  return owned && guard.epoch === loopEpoch
}

async function pause($: Dollar, state: FactoryState, rawReason: string, byPerson = false, override: Partial<FactoryState> = {}, guard?: LoopGuard): Promise<boolean> {
  if (!guard) loopEpoch++
  const reason = cleanText(rawReason)
  const ts = await stamp($)
  const saved = await patchState($, async fresh => {
    if (guard && !(await loopLive($, guard, fresh))) return null
    return {
      ...applyChanges(fresh, state, withEvent(state, ts, { itemId: fresh.current, kind: 'paused', detail: reason })),
      ...override,
      autopilot: false,
      pausedReason: reason,
    }
  })
  if (guard && !saved) return false
  await settle($, !byPerson && (isFactoryTurn || launchedHere !== null || expectReport))
  await releaseLock($)
  toast($, `factory paused: ${reason}`, { timeoutMs: 8000 })
  await refreshStatus($)
  return true
}

type Instructions = { text: string; isDesign: boolean; roadmapAt: number | null; lastAt: number; turns: number }
let instructions: Instructions | null = null
let launchedHere: string | null = null
let expectReport = false

const reviewWaiting = (state: FactoryState, settings: Settings, now: number): boolean =>
  state.reviewAgentId !== null && state.reviewAgentId === launchedHere && isReviewPending(state, now, reviewWindow(state, settings))

function submit($: Dollar, full: string, label?: string, isDesign = false, guarded = false, roadmapAt: number | null = null): void {
  personSlash = false
  slashTurnId = null
  isFactoryTurn = true
  factoryTurnAt = -1
  isArmed = !isDesign || guarded
  expectReport = false
  instructions = { text: full, isDesign, roadmapAt, lastAt: roadmapAt ?? 0, turns: 0 }
  const headline = stripControls(label ?? full.split('\n', 1)[0]!).slice(0, 200)
  $.prompt.submit({ text: `${headline}\n(The full instructions are the "code-factory:instructions" section of your system prompt; follow them.)` }).catch(() => {
    instructions = null
    isFactoryTurn = false
    isArmed = false
  })
}

function dropRoadmap(): void {
  if (instructions && instructions.roadmapAt !== null) instructions = null
}

async function integrityProblem(snap: Snapshot): Promise<string | null> {
  if (snap.state.unreadable) return STATE_UNREADABLE
  if (!snap.state.approved) return 'design not approved'
  if (snap.settingsProblems.length > 0) return snap.settingsProblems[0]!
  if (decisionsHash(snap.settings, snap.items) !== snap.state.approvedHash) {
    return 'settings or decisions changed since approval; review them and run /factory-approve'
  }
  return null
}

// Looks through the failed check runs of HEAD's commit for GitHub's billing
// messages (jobs that never start because payment failed or a limit was hit).
async function ciBillingProblem($: Dollar): Promise<string | null> {
  const sha = await headSha($)
  if (!sha) return null
  const list = await run($, [
    'gh', 'api', `repos/{owner}/{repo}/commits/${sha}/check-runs`, '--jq',
    '[.check_runs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="action_required" or .conclusion=="startup_failure") | {id: .id, text: ([.output.title, .output.summary, .output.text] | map(select(. != null)) | join("\n"))}]',
  ])
  if (list.exitCode !== 0) return null
  let rows: { id: number; text: string }[] = []
  try {
    rows = JSON.parse(list.stdout) as { id: number; text: string }[]
  } catch {
    return null
  }
  for (const row of rows.slice(0, 6)) {
    if (isBillingProblem(row.text)) return row.text.trim().slice(0, 200)
    const ann = await run($, ['gh', 'api', `repos/{owner}/{repo}/check-runs/${row.id}/annotations`, '--jq', '.[].message'])
    if (ann.exitCode === 0 && isBillingProblem(ann.stdout)) return ann.stdout.trim().slice(0, 200)
  }
  return null
}

async function pauseForBilling($: Dollar, detail: string, guard?: LoopGuard): Promise<boolean> {
  const state = await readState($)
  return pause($, state, `GitHub Actions billing problem (${detail.replace(/\s+/g, ' ').slice(0, 100)}). Fix billing, then /factory-start`, false, {}, guard)
}

async function resetContext($: Dollar, settings: Settings): Promise<void> {
  if (settings.contextReset === 'none') return
  try {
    await $.command.run({
      command: settings.contextReset,
      ...(settings.contextReset === 'compact'
        ? { args: 'Keep only what the code factory loop needs; everything else is in .factory/ files and git.' }
        : {}),
    })
  } catch {
    toast($, `factory: /${settings.contextReset} failed, continuing without it`)
  }
}

const view = atom({ plugin: 'code-factory', key: 'view' } as const, null)
const openAgent = atom({ plugin: 'code-factory', key: 'openAgent' } as const, null)
const skipTarget = atom({ plugin: 'code-factory', key: 'skipTarget' } as const, null)
const checksAtom = atom({ plugin: 'code-factory', key: 'checks' } as const, null)
let mainTurnOpen = false
const GLYPH: Record<Mark, string> = { done: '✓', doing: '▶', todo: '○', blocked: '✗', proposed: '·' }
const COLOR: Record<Mark, string | undefined> = { done: 'green', doing: 'yellow', todo: undefined, blocked: 'red', proposed: undefined }
const PANE = 'factory'
let viewTimer: Timer | null = null
let lastStatusText: string | undefined | null = null

const agentCache = new Map<string, { row: AgentRow; at: number }>()
const ACTIVE_AGENT = new Set(['running', 'waiting', 'pending'])
const AGENT_READ_MS = 6000

async function recentActions($: Dollar, agentId?: string): Promise<string[]> {
  try {
    const m = agentId === undefined ? await $.session.messages() : await $.session.messages({ agentId })
    if ('deny' in m) return []
    return agentActions(m.slice(-40), 5)
  } catch {
    return []
  }
}

async function collectAgents($: Dollar, mainBusy: boolean, current: string | null, now: number): Promise<AgentRow[]> {
  const rows: AgentRow[] = []
  try {
    if (mainBusy) {
      const cached = agentCache.get('main')
      if (cached && now - cached.at < AGENT_READ_MS && cached.row.label.startsWith(current ?? 'main loop')) rows.push(cached.row)
      else {
        const recent = await recentActions($)
        const row: AgentRow = { id: 'main', label: current ? `${current} (main loop)` : 'main loop', kind: 'main', status: 'running', summary: recent.at(-1) ?? 'working…', recent, parent: null }
        agentCache.set('main', { row, at: now })
        rows.push(row)
      }
    } else agentCache.delete('main')
    const list = await $.agent.list()
    const seen = new Set(['main'])
    for (const a of list.slice(-12)) {
      seen.add(a.id)
      const cached = agentCache.get(a.id)
      const fresh = cached !== undefined && cached.row.status === a.status && (!ACTIVE_AGENT.has(a.status) || now - cached.at < AGENT_READ_MS)
      if (cached && fresh) {
        rows.push(cached.row)
        continue
      }
      const recent = await recentActions($, a.id)
      const row: AgentRow = {
        id: a.id,
        label: oneLine(a.description || a.type, 48),
        kind: oneLine(a.type, 24),
        status: a.status,
        summary: recent.at(-1) ?? (ACTIVE_AGENT.has(a.status) ? 'starting…' : a.status),
        recent,
        parent: a.parentId ?? null,
      }
      agentCache.set(a.id, { row, at: now })
      rows.push(row)
    }
    for (const id of [...agentCache.keys()]) if (!seen.has(id)) agentCache.delete(id)
  } catch {
    return rows
  }
  return [...rows.filter(r => ACTIVE_AGENT.has(r.status)), ...rows.filter(r => !ACTIVE_AGENT.has(r.status)).slice(-2)]
}

async function refreshOnce($: Dollar): Promise<void> {
  try {
    const snap = await load($)
    const items = effectiveItems(snap)
    const spent = snap.state.approved ? await currentSpend($, snap.state.current) : null
    const spend = { runUsd: spent?.runUsd ?? null, itemUsd: spent?.itemUsd ?? null, budgetUsd: snap.settings.budgetUsd }
    const running = snap.state.autopilot && !snap.state.unreadable
    const now = await stamp($)
    const agents = snap.state.approved ? await collectAgents($, running && isFactoryTurn, snap.state.current, now) : []
    const extra = { maxAttempts: snap.settings.maxAttempts, maxReviewRounds: snap.settings.maxReviewRounds, agents, now, notes: await blockedNotes($, snap.blocked) }
    const build = (prev: FactoryView | null): FactoryView => buildView(items, snap.state, snap.blocked, snap.settings.stopAfterVersion, prev, spend, extra)
    const before = await read($, view)
    let shown = build(before)
    if (JSON.stringify(before) !== JSON.stringify(shown)) {
      await update($, view, prev => {
        const next = build(prev)
        shown = next
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      })
    }
    const text = snap.state.approved ? statusLine(shown) : snap.items.length > 0 ? 'factory: design drafted · /factory-approve when it is pushed · /factory for help' : undefined
    if (text !== lastStatusText) {
      lastStatusText = text
      status($, text)
    }
  } catch {
    return
  }
}

let viewJobs = 0
let viewChain: Promise<void> = Promise.resolve()

function refreshView($: Dollar): Promise<void> {
  if (viewJobs >= 2) return viewChain
  viewJobs++
  viewChain = viewChain.then(() => refreshOnce($)).finally(() => {
    viewJobs--
  })
  return viewChain
}

async function markStage($: Dollar, ev: LoopEvent): Promise<void> {
  try {
    await update($, view, v => {
      if (!v || !v.running || !v.current) return v
      const stage = stageAfter(ev)
      const at = STAGES.indexOf(stage)
      return { ...v, stage, steps: v.steps?.map((st, i): Step => ({ ...st, state: i < at ? 'done' : i === at ? 'doing' : 'todo' })) }
    })
  } catch {
    return
  }
}

async function startView($: Dollar): Promise<void> {
  viewTimer?.cancel()
  viewTimer = $.clock.every(2000, () => {
    void refreshView($)
  })
  await refreshView($)
}

// ---- the loop -----------------------------------------------------------------

// One step of the loop: look at where the current item stands and hand the
// model the next prompt, or finish.
async function turnBusy($: Dollar): Promise<boolean> {
  if (!isFactoryTurn) return false
  const now = await $.clock.now()
  if (factoryTurnAt < 0) factoryTurnAt = now
  if (now - factoryTurnAt < FACTORY_TURN_TTL_MS) return true
  isFactoryTurn = false
  isArmed = false
  return false
}

async function advance($: Dollar): Promise<void> {
  if (isAdvancing || handsOff) return
  if (await turnBusy($)) return
  isAdvancing = true
  let aborted = false
  let acquired = false
  const guard: LoopGuard = { epoch: loopEpoch }
  try {
    const snap = await load($)
    let { state } = snap
    if (state.unreadable) {
      if (!unreadableToasted) {
        unreadableToasted = true
        toast($, `factory paused: ${STATE_UNREADABLE}`, { timeoutMs: 10000 })
      }
      await releaseLock($)
      await refreshStatus($)
      return
    }
    unreadableToasted = false
    if (!state.autopilot) return
    if (!(await acquireLock($))) {
      const now = await $.clock.now()
      if (now - lastLockToast > 600000) {
        lastLockToast = now
        toast($, 'factory: another session is running the loop here; this one stays hands-off', { timeoutMs: 8000 })
      }
      return
    }
    acquired = true
    const halt = async (reason: string, override: Partial<FactoryState> = {}): Promise<void> => {
      if (!(await pause($, state, reason, false, override, guard))) aborted = true
    }
    const live = async (): Promise<boolean> => {
      const ok = await loopLive($, guard)
      if (!ok) aborted = true
      return ok
    }
    const write = async (next: FactoryState): Promise<boolean> => {
      const saved = await patchState($, async fresh => ((await loopLive($, guard, fresh)) ? applyChanges(fresh, snap.state, next) : null))
      if (!saved) aborted = true
      return saved !== null
    }
    const handOut = async (d: Drive, attempt: boolean, prompt: () => void): Promise<void> => {
      if (!(await live()) || guard.epoch !== loopEpoch) return
      await drive($, d, attempt)
      if (!(await live()) || guard.epoch !== loopEpoch) {
        aborted = true
        await settle($, false)
        return
      }
      prompt()
    }
    if (!(await live())) return
    const problem = await integrityProblem(snap)
    if (problem) return await halt(problem)

    const { settings, blocked } = snap
    const overBudget = await budgetProblem($, settings, state.current)
    if (overBudget) return await halt(overBudget)
    const items = effectiveItems(snap)
    const base = settings.baseBranch
    let hasMerged = false
    let now = await stamp($)

    if (state.current && state.reviewAgentId) {
      if (reviewWaiting(state, settings, await $.clock.now())) return
      const isExpired = state.reviewAgentId === launchedHere
      launchedHere = null
      state = { ...state, reviewAgentId: null, reviewAgentAt: 0 }
      if (isExpired) {
        const rounds = state.reviewRounds + 1
        const capped = rounds >= settings.maxReviewRounds
        await halt(
          capped ? `the review agent gave no verdict ${rounds} times; ${state.current} is blocked` : `the review agent did not report within ${Math.round(reviewWindow(state, settings) / 60000)} min; /factory-start retries`,
          { reviewAgentId: null, reviewAgentAt: 0, reviewRounds: rounds },
        )
        if (capped && !aborted && state.current) {
          try {
            await $.fs.write(`${BLOCKED_DIR}/${state.current}.md`, `The review agent gave no verdict ${rounds} times.\n`)
            await logEvent($, { itemId: state.current, kind: 'blocked', detail: `review agent gave no verdict ${rounds} times` })
          } catch {
            return
          }
        }
        return
      }
    }
    if (state.current) {
      const item = snap.items.find(i => i.id === state.current)
      if (!item || blocked.has(item.id)) {
        state = { ...state, current: null, attempts: 0 }
      } else {
        const branch = await branchNow($)
        let why = ''
        if (item.status !== 'done') why = `${item.id} is not marked done in todo.md.`
        else if (branch !== base) why = `The current branch is "${branch}", not ${base}.`
        else {
          const merged = await run($, ['gh', 'pr', 'list', '--state', 'merged', '--search', `head:${branchFor(item)}`, '--json', 'number,headRefName', '--limit', '20'])
          if (merged.exitCode !== 0) return await halt(`gh failed: ${merged.stderr.trim().slice(0, 120)}`)
          let isMerged = false
          try {
            const rows = JSON.parse(merged.stdout) as { headRefName: string }[]
            isMerged = rows.some(r => r.headRefName.startsWith(`factory/${item.id.toLowerCase()}-`))
          } catch {
            // treated as not merged
          }
          if (isMerged) {
            state = {
              ...withEvent(state, now, { itemId: item.id, kind: 'done', detail: 'merged PR verified' }),
              current: null,
              attempts: 0,
              doneThisRun: state.doneThisRun + 1,
              mergedIds: [...new Set([...state.mergedIds, item.id])],
            }
            if (!(await write(state))) return
            await settle($, true, (rc, t, tree) => noteItem(rc, item.id, item.title, t, { outcome: 'merged', runItemTree: tree }))
            // Make the in-memory view agree, so the next pick sees it as done.
            items.forEach(i => {
              if (i.id === item.id) i.status = 'done'
            })
            hasMerged = true
            toast($, `factory: ${item.id} merged`)
            const red = (await live()) ? await verifyBase($, settings, live) : null
            if (red) return await halt(`${base} is red after ${item.id} merged: ${red}; fix ${base}, then /factory-start`)
            now = await stamp($)
          } else why = `${item.id} is marked done but no merged PR from a factory/${item.id.toLowerCase()}-* branch exists.`
        }
        if (why) {
          if (branch.startsWith('factory/')) {
            const billing = await ciBillingProblem($)
            if (billing) {
              if (!(await pauseForBilling($, billing, guard))) aborted = true
              return
            }
          }
          const attempts = state.attempts + 1
          if (attempts > settings.maxAttempts) {
            state = { ...withEvent(state, now, { itemId: item.id, kind: 'blocked', detail: `after ${settings.maxAttempts} attempts: ${why}` }), current: null, attempts: 0 }
            if (!(await write(state))) return
            let noted = true
            try {
              await $.fs.write(`${BLOCKED_DIR}/${item.id}.md`, `Blocked by the factory after ${settings.maxAttempts} attempts. Last problem: ${why}\n`)
            } catch {
              noted = false
            }
            toast($, `factory: ${item.id} blocked after ${settings.maxAttempts} attempts`, { timeoutMs: 8000 })
            await settle($, true, (rc, t) => noteItem(rc, item.id, item.title, t, { outcome: 'blocked' }))
            blocked.add(item.id)
            if (!noted) return await halt(`${item.id} ran out of attempts but .factory/blocked/${item.id}.md could not be written; fix that folder, then /factory-skip ${item.id} or /factory-start`)
          } else {
            if (!(await write({ ...withEvent(state, now, { itemId: item.id, kind: 'nudge', detail: why }), attempts }))) return
            await refreshStatus($)
            return await handOut({ key: item.id, kind: 'item', title: item.title }, true, () => submit($, nudgePrompt(item, settings, why), `CODE FACTORY: ${item.id} retry: ${why}`))
          }
        }
      }
    }

    if (settings.maxItemsPerRun > 0 && state.doneThisRun >= settings.maxItemsPerRun) {
      if (!(await write(state))) return
      return await halt(`run limit of ${settings.maxItemsPerRun} items reached`)
    }
    const version = settings.stopAfterVersion
    const next = pickNext(items, blocked, version)
    if (!next) {
      const scope = version ? items.filter(i => inScope(i, version)) : []
      const isScopeDone = version !== null && scope.length > 0 && scope.every(i => i.status === 'done')
      let finished = version && isScopeDone ? `version ${version} is complete` : 'nothing left to do'
      if (version && isScopeDone && settings.tagRelease && state.releasedVersion !== version) {
        const rel = await run($, ['gh', 'release', 'view', `v${version}`], 30000)
        if (rel.exitCode === 0) {
          state = { ...state, releasedVersion: version, releaseAttempts: 0 }
          finished = `version ${version} is complete and released`
        } else {
          if (state.releaseAttempts >= 3) {
            state = { ...state, current: null }
            if (!(await write(state))) return
            return await halt(`release v${version} was not created after 3 tries`)
          }
          if (!(await write({ ...withEvent(state, now, { itemId: null, kind: 'release', detail: `v${version}` }), current: null, releaseAttempts: state.releaseAttempts + 1 }))) return
          await refreshStatus($)
          if (hasMerged && (await live())) await resetContext($, settings)
          return await handOut({ key: PLAN_KEY, kind: 'release', title: `release v${version}` }, false, () => submit($, releasePrompt(version, settings), `CODE FACTORY: release v${version}`))
        }
      }
      const ask = shouldAskRoadmap(settings, state, items)
      const wrote = await write({
        ...withEvent(state, now, { itemId: null, kind: 'paused', detail: finished }),
        autopilot: false,
        current: null,
        pausedReason: finished,
        roadmapAsked: state.roadmapAsked || ask,
      })
      if (!wrote) return
      const epoch = guard.epoch
      await settle($, false)
      await releaseLock($)
      toast($, `factory finished: ${finished} (${summarize(items, blocked)})`, { timeoutMs: 10000 })
      await refreshStatus($)
      if (ask && epoch === loopEpoch && !(await lockedByOther($))) {
        if (hasMerged) await resetContext($, settings)
        await startInterview($, ROADMAP_INTERVIEW, items, state.mergedIds, settings, epoch)
      }
      return
    }
    state = { ...withEvent(state, now, { itemId: next.id, kind: 'started', detail: next.title }), current: next.id, attempts: 0, pausedReason: null, review: null, reviewRounds: 0, reviewDeclined: [], reviewOpen: [] }
    if (!(await write(state))) return
    await refreshStatus($)
    if (hasMerged && (await live())) await resetContext($, settings)
    await handOut({ key: next.id, kind: 'item', title: next.title }, true, () => submit($, workPrompt(next, settings, null)))
  } finally {
    isAdvancing = false
    if (acquired && aborted) {
      const fresh = await readState($)
      if (!fresh.autopilot || fresh.unreadable) await releaseLock($)
    }
    if (!aborted) rearms = 0
    else if (rearms < MAX_REARMS) {
      rearms++
      $.clock.after(300, () => {
        void advance($)
      })
    }
  }
}

async function startInterview($: Dollar, iv: Interview, items: readonly Item[], mergedIds: readonly string[], settings: Settings, epoch: number): Promise<void> {
  if (epoch !== loopEpoch) return
  const costs = await readCosts($)
  if (epoch !== loopEpoch) return
  if (iv.markAsked) await patchState($, s => ({ ...s, roadmapAsked: true }))
  if (epoch !== loopEpoch) return
  await drive($, { key: PLAN_KEY, kind: 'roadmap', title: iv.title })
  const at = await $.clock.now()
  if (epoch !== loopEpoch) {
    await settle($, false)
    return
  }
  submit($, iv.prompt(items, mergedIds, settings, costSummaryForPrompt(costs?.rc ?? null)), iv.label, true, true, at)
  void logEvent($, { itemId: null, kind: 'roadmap', detail: iv.title })
}

// If a turn-complete never arrived (a failed advance, a swallowed error) the
// loop would sit idle forever. Every few minutes: nothing running and the loop
// is on, so take the next step.
function startWatchdog($: Dollar): void {
  if (watchTimer) return
  watchTimer = $.clock.every(300000, () => {
    if (isAdvancing) return
    void (async () => {
      if (await turnBusy($)) return
      const state = await readState($)
      if (state.autopilot) await advance($)
    })()
  })
}

async function branchProtectionWarnings($: Dollar, base: string): Promise<string[]> {
  const prot = await run($, ['gh', 'api', `repos/{owner}/{repo}/branches/${base}/protection`], 30000)
  const rules = await run($, ['gh', 'api', `repos/{owner}/{repo}/rules/branches/${base}`], 30000)
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
    if (/Branch not protected|Not Found|404/i.test(err) && !/Upgrade|403/i.test(err)) {
      return evaluateProtection(null, [], cleanText(base).slice(0, 60))
    }
    return [`could not read ${cleanText(base).slice(0, 60)}'s protection (${cleanText(err).slice(0, 100)}); a private repo on a free plan cannot have it.`]
  }
  return evaluateProtection(parse(prot), parse(rules), cleanText(base).slice(0, 60))
}

async function missingOnBase($: Dollar, base: string): Promise<string[]> {
  const shown = cleanText(base).slice(0, 60)
  const fetched = await run($, ['git', 'fetch', '--', 'origin', base], 30000)
  if (fetched.exitCode !== 0) return [`could not fetch origin/${shown} (${cleanText(fetched.stderr).slice(0, 100)}); it is needed to check that the design files are pushed.`]
  const missing: string[] = []
  const changed: string[] = []
  for (const path of [SETTINGS_PATH, TODO_PATH, DESIGN_PATH]) {
    const there = await run($, ['git', 'show', `origin/${base}:./${path}`], 15000)
    if (there.exitCode !== 0) {
      missing.push(path)
      continue
    }
    const local = (await readText($, path)) ?? ''
    if (!designFileSame(there.stdout, local, path === TODO_PATH)) changed.push(path)
  }
  const out: string[] = []
  if (missing.length > 0) out.push(`${missing.join(', ')} not on origin/${shown}: the design files must be on ${shown} (the loop returns to it between items and they would vanish).`)
  if (changed.length > 0) out.push(`${changed.join(', ')} differ from origin/${shown}.`)
  if (out.length > 0) out.push(designPushSteps(base, await branchNow($)))
  return out
}

async function preflight($: Dollar): Promise<string[]> {
  const problems: string[] = []
  const auth = await run($, ['gh', 'auth', 'status'], 20000)
  if (auth.exitCode !== 0) problems.push('`gh` is missing or not logged in (run `gh auth login`).')
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], 15000)
  if (remote.exitCode !== 0) problems.push('git has no `origin` remote to push PRs to.')
  return problems
}

const SKELETON_TODO = `# Todo

<!-- Format, one block per item, in priority order:
## T-001 [feature] Short title
- status: proposed
- how: chosen tool/algorithm/workaround and why
- accept: checkable acceptance criteria
- tests: what the tests cover
-->
`

const IGNORED = ['state.json', 'lock.json', 'blocked/', 'evidence/']

async function ensureGitignore($: Dollar): Promise<void> {
  try {
    await writeGitignore($)
  } catch {}
}

async function writeGitignore($: Dollar): Promise<void> {
  const path = `${FACTORY_DIR}/.gitignore`
  const have = (await readText($, path)) ?? ''
  const lines = have.split(/\r?\n/).map(l => l.trim())
  const missing = IGNORED.filter(l => !lines.includes(l))
  if (missing.length > 0 || have === '') {
    const base = have === '' || have.endsWith('\n') ? have : `${have}\n`
    await $.fs.write(path, `${base}${missing.join('\n')}${missing.length > 0 ? '\n' : ''}`)
  }
}

const REVIEW_BUSY_DENY = 'code-factory: the review agent is still running; do not change the code until its verdict arrives (only the review agent may edit, commit or push now).'
const FACTORY_FILE_DENY = deny('code-factory: .factory/state.json and .factory/lock.json are controlled by the person through /factory-* commands.')
const isFactoryControlFile = (p: string): boolean => /(^|\/)\.factory\/(?:state|lock)\.json$/i.test(normalizePath(p))

async function guardWrite($: Dollar, path: string, agentId: string | undefined): Promise<{ deny: string } | null> {
  if (isFactoryControlFile(path)) return FACTORY_FILE_DENY
  const state = await readState($)
  const live = state.approved && (state.autopilot || isArmed) && !(await lockedByOther($))
  if (!live) return null
  if (/(^|\/)\.claude\/(?:(?:agents|commands|skills)\/|settings[^/]*\.json$)/i.test(normalizePath(path))) {
    return deny('code-factory: agent, command, skill and settings files under .claude cannot be changed while the factory loop is live.')
  }
  if (state.reviewAgentId !== null && agentId !== state.reviewAgentId && !/(^|\/)\.factory\//.test(normalizePath(path))) {
    const { settings } = await load($)
    if (reviewWaiting(state, settings, await $.clock.now())) return deny(REVIEW_BUSY_DENY)
  }
  return null
}

async function recordReview($: Dollar, itemId: string, mark: ReviewMark, maxRounds: number, declined: string[], open: string[]): Promise<void> {
  const isClean = markClean(mark)
  await markStage($, isClean ? 'reviewed' : 'commit')
  const ts = await stamp($)
  const saved = await patchState($, fresh => ({
    ...withEvent(fresh, ts, { itemId, kind: 'review-verdict', detail: markDetail(mark) }),
    review: mark,
    reviewDeclined: mergeDeclined(fresh.reviewDeclined, declined),
    reviewOpen: isClean ? [] : mergeDeclined([], open),
    reviewRounds: isClean ? 0 : fresh.reviewRounds + 1,
    reviewAgentId: null,
    reviewAgentAt: 0,
  }))
  await editCosts($, (rc, c) => ({ costs: noteReview(rc, itemId, c.now, mark), value: null }))
  const rounds = saved?.reviewRounds ?? 0
  if (!isClean && rounds >= maxRounds) {
    await $.fs.write(`${BLOCKED_DIR}/${itemId}.md`, `Review still found danger=${mark.danger} medium=${mark.medium} security=${mark.security ?? 'unreported'} after ${rounds} rounds.\n`)
    toast($, `factory: ${itemId} blocked, review never came back clean`, { timeoutMs: 8000 })
    await logEvent($, { itemId, kind: 'blocked', detail: `review not clean after ${rounds} rounds` })
  }
}

async function reviewerTurn($: Dollar, agentId: string, answer: string, final: boolean): Promise<void> {
  try {
    for (let i = 0; i < 25 && reviewInFlight; i++) await new Promise<void>(resolve => $.clock.after(200, () => resolve()))
    if ((await readState($)).reviewAgentId !== agentId || launchedHere !== agentId) return
    const snap = await load($)
    if (!reviewWaiting(snap.state, snap.settings, await $.clock.now())) return
    const item = snap.items.find(i => i.id === snap.state.current)
    const act = decideReviewAnswer(answer, agentId, snap.state, item !== undefined, final)
    if (act.action === 'ignore' || !item || (await lockedByOther($))) return
    launchedHere = null
    if (act.action === 'unavailable') {
      expectReport = true
      await pause($, snap.state, `${snap.settings.reviewCommand} is not available to the review agent`, false, { reviewAgentId: null, reviewAgentAt: 0 })
      return
    }
    if (act.action === 'record') await recordReview($, item.id, act.mark, snap.settings.maxReviewRounds, act.declined, act.open)
    else {
      const ts = await stamp($)
      const saved = await patchState($, fresh => ({
        ...withEvent(fresh, ts, { itemId: item.id, kind: 'review-verdict', detail: 'ended without a verdict' }),
        reviewRounds: fresh.reviewRounds + 1,
        reviewAgentId: null,
        reviewAgentAt: 0,
      }))
      const rounds = saved?.reviewRounds ?? snap.state.reviewRounds + 1
      if (rounds >= snap.settings.maxReviewRounds) {
        await $.fs.write(`${BLOCKED_DIR}/${item.id}.md`, `The review agent ended ${rounds} times without a verdict.\n`)
        toast($, `factory: ${item.id} blocked, the review agent never gave a verdict`, { timeoutMs: 8000 })
        await logEvent($, { itemId: item.id, kind: 'blocked', detail: `review agent gave no verdict ${rounds} times` })
      }
    }
    expectReport = true
  } catch {
    return
  }
}

async function turnCost($: Dollar, e: { agentId?: string; usage?: Usage }): Promise<number | null> {
  const state = await readState($)
  const isReviewer = e.agentId !== undefined && (e.agentId === launchedHere || e.agentId === state.reviewAgentId)
  if (!isReviewer && !isFactoryTurn) return null
  const stage = await viewStage($)
  const keep = e.agentId === undefined ? state.autopilot || launchedHere !== null || expectReport : !isReviewer || state.autopilot || expectReport || isFactoryTurn
  return editCosts($, (rc, c) => {
    let costs = rc
    const mark = rc.marks[c.from]
    const key = isReviewer ? (state.current ?? mark?.key) : mark?.key
    if (e.usage && key) costs = addTokens(costs, key, '', costPhase(isReviewer ? 'item' : (mark?.kind ?? 'item'), stage, isReviewer), e.usage, c.now)
    const r = settleCost(costs, { from: c.from, to: c.owner, tree: c.tree, nowUsd: c.usd, now: c.now, next: keep ? 'keep' : null })
    markOwner = r.costs.marks[c.owner] ? c.owner : null
    return { costs: r.costs, value: lastRunUsd(r.costs, c.tree) }
  })
}

let unreadableMisses = 0

async function budgetProblem($: Dollar, settings: Settings, current: string | null, tolerateOneMiss = false): Promise<string | null> {
  if (settings.budgetUsd <= 0) return null
  const spend = await currentSpend($, current)
  if (!spend) {
    unreadableMisses++
    return tolerateOneMiss && unreadableMisses < 2 ? null : budgetUnreadableReason(settings.budgetUsd)
  }
  unreadableMisses = 0
  return budgetReached(settings.budgetUsd, spend.runUsd) ? budgetPauseReason(settings.budgetUsd, spend.runUsd) : null
}

async function stopForBudget($: Dollar): Promise<boolean> {
  const snap = await load($)
  if (!snap.state.autopilot) return false
  const problem = await budgetProblem($, snap.settings, snap.state.current, true)
  if (!problem) return false
  await pause($, snap.state, problem)
  return true
}

async function logBashEvent($: Dollar, itemId: string, ev: LoopEvent, command: string, text: string): Promise<void> {
  if (ev === 'commit') return logEvent($, { itemId, kind: 'commit', detail: commitMessage(command) })
  if (ev === 'pr') {
    const pr = parsePrUrl(text)
    return logEvent($, pr ? { itemId, kind: 'pr-opened', detail: '', ...pr } : { itemId, kind: 'pr-opened', detail: 'gh pr create' })
  }
  if (ev === 'merge') return logEvent($, { itemId, kind: 'merged', detail: `gh pr merge ${classifyBash(command, 'main').prSelector ?? ''}`.trim() })
}

async function pauseCmd($: Dollar): Promise<{ text: string }> {
  dropRoadmap()
  loopEpoch++
  const state = await readState($)
  if (!state.autopilot) return { text: safeLines(`Factory is not running (${state.pausedReason ?? 'stopped'}). /factory-start resumes it.`) }
  await pause($, state, 'paused by you; /factory-start resumes')
  return { text: `Factory paused. The current turn finishes${state.reviewAgentId ? ' and the pending review still reports' : ''}; nothing new starts. ${state.current ? `${state.current}, its attempts and review rounds are kept; ` : ''}/factory-start resumes where it left off.` }
}

async function retryCmd($: Dollar, args: string): Promise<{ text: string }> {
  const { id } = parseItemArg(args)
  if (!id) return { text: 'Usage: /factory-retry <ID>, for example /factory-retry T-004.' }
  if (await lockedByOther($)) return { text: 'Cannot retry: another session is running the factory in this repo (its lock was refreshed in the last two minutes).' }
  const snap = await load($)
  const problem = await integrityProblem(snap)
  if (problem) return { text: safeLines(`Cannot retry: ${problem}.`) }
  const raw = snap.items.find(i => i.id === id)
  const item = effectiveItems(snap).find(i => i.id === id)
  if (!raw || !item) return { text: `Cannot retry: ${id} is not an item in ${TODO_PATH}.` }
  if (raw.status === 'proposed') return { text: `Cannot retry: ${id} is still proposed; /factory-approve promotes it first.` }
  if (item.status === 'done') return { text: `Cannot retry: ${id} is already done.` }
  const isCurrent = snap.state.current === id
  if (!snap.blocked.has(id) && !isCurrent) return { text: `${id} is not blocked; it is picked up in order.` }
  if (snap.blocked.has(id)) {
    for (const name of [`${id}.md`, `${id.toLowerCase()}.md`]) await run($, ['rm', '-f', '--', `${BLOCKED_DIR}/${name}`], 15000)
    if ((await blockedIds($)).has(id)) return { text: `Cannot retry: could not remove the note in ${BLOCKED_DIR}/; delete it by hand.` }
  }
  const ts = await stamp($)
  await patchState($, s => ({
    ...withEvent(s, ts, { itemId: id, kind: 'retry', detail: 'unblocked by you' }),
    ...(s.current === id ? { attempts: 0, reviewRounds: 0 } : {}),
  }))
  await refreshStatus($)
  return { text: `${id} is eligible again${isCurrent ? ' with its attempts and review rounds reset' : ''}. ${snap.state.autopilot ? 'The running loop picks it up in order.' : '/factory-start runs it.'}` }
}

async function startCmd($: Dollar): Promise<{ text: string }> {
  dropRoadmap()
  const snap = await load($)
  const problem = await integrityProblem(snap)
  if (problem) return { text: safeLines(`Cannot start: ${problem}.`) }
  const startItems = effectiveItems(snap)
  if (!pickNext(startItems, snap.blocked, snap.settings.stopAfterVersion) && !snap.state.current && !releasePending(snap.settings, snap.state, startItems) && !shouldAskRoadmap(snap.settings, snap.state, startItems)) {
    return { text: `Nothing to do: ${summarize(effectiveItems(snap), snap.blocked)}. /factory-roadmap plans the next phase; /factory-retry <ID> unblocks an item.` }
  }
  loopEpoch++
  if (!(await acquireLock($))) return { text: 'Cannot start: another session is running the factory in this repo (its lock was refreshed in the last two minutes).' }
  handsOff = false
  await ensureGitignore($)
  const startedAt = await stamp($)
  await editCosts($, (rc, c) => ({ costs: startRun(rc, startedAt, c.tree), value: null }))
  const detail = snap.settings.budgetUsd > 0 ? `new run, budget ${formatUsd(snap.settings.budgetUsd)}` : 'new run'
  await patchState($, fresh => ({ ...withEvent(fresh, startedAt, { itemId: fresh.current, kind: 'resumed', detail }), autopilot: true, pausedReason: null, doneThisRun: 0, releaseAttempts: 0, attempts: fresh.current ? fresh.attempts : 0 }))
  startWatchdog($)
  await refreshStatus($)
  $.clock.after(300, () => {
    void advance($)
  })
  await openDashboard($)
  return { text: 'Factory running; the dashboard is open (/factory-dashboard off or its [close] button closes it). Esc or typing your own prompt pauses the loop; /factory-stop stops it; new sessions in this repo resume it.' }
}

async function openDashboard($: Dollar): Promise<void> {
  try {
    await refreshView($)
    const opened = await $.ui.open({ id: PANE, title: 'Code factory' })
    if (!opened.isPlaced) toast($, `factory: dashboard waits undrawn (${cleanText(opened.reason)}); /factory-dashboard shows it`)
  } catch {
    return
  }
}

async function stopCmd($: Dollar): Promise<{ text: string }> {
  dropRoadmap()
  expectReport = false
  loopEpoch++
  await settle($, isFactoryTurn || launchedHere !== null)
  const ts = await stamp($)
  await patchState($, fresh => ({ ...withEvent(fresh, ts, { itemId: fresh.current, kind: 'paused', detail: 'stopped by you' }), autopilot: false, pausedReason: 'stopped by you' }))
  await releaseLock($)
  await refreshStatus($)
  return { text: 'Factory paused. The current turn finishes; nothing new starts. /factory-start resumes.' }
}

async function skipCmd($: Dollar, args: string): Promise<{ text: string }> {
  const { id, note } = parseItemArg(args)
  if (!id) return { text: 'Usage: /factory-skip <ID> [reason], for example /factory-skip T-004 needs a product decision.' }
  if (await lockedByOther($)) return { text: 'Cannot skip: another session is running the factory in this repo (its lock was refreshed in the last two minutes).' }
  const snap = await load($)
  const item = effectiveItems(snap).find(i => i.id === id)
  if (!item) return { text: `Cannot skip: ${id} is not an item in ${TODO_PATH}.` }
  if (item.status === 'done') return { text: `Cannot skip: ${id} is already done.` }
  if (snap.blocked.has(id)) return { text: `${id} is already blocked (${BLOCKED_DIR}/${id}.md); /factory-retry ${id} unblocks it.` }
  await $.fs.write(`${BLOCKED_DIR}/${id}.md`, `Skipped by you${note ? `: ${note}` : '.'} /factory-retry ${id} makes it eligible again.\n`)
  await logEvent($, { itemId: id, kind: 'skip', detail: note || 'skipped by you' })
  await editCosts($, (rc, c) => ({ costs: noteItem(rc, id, item.title, c.now, { outcome: 'skipped' }), value: null }))
  await refreshStatus($)
  const isCurrent = snap.state.current === id
  return { text: `${id} skipped; the note is in ${BLOCKED_DIR}/${id}.md.${isCurrent && snap.state.autopilot ? ' It is the current item: the turn in progress finishes, then the loop moves on to the next item.' : ''}` }
}

async function doctorChecks($: Dollar): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  const add = (name: string, status: DoctorCheck['status'], detail = ''): void => {
    out.push({ name, status, detail })
  }
  const snap = await load($)
  if (snap.settingsProblems.length > 0) add('settings.json', 'fail', snap.settingsProblems[0]!)
  else add('settings.json', 'ok')
  const todoText = (await readText($, TODO_PATH)) ?? ''
  const headingProblems = todoHeadingProblems(todoText)
  if (snap.items.length === 0) add('todo.md', 'fail', 'no items; run /factory-design')
  else if (headingProblems.length > 0) add('todo.md', 'fail', headingProblems[0]!)
  else add('todo.md', 'ok', `${snap.items.length} items`)
  const problem = await integrityProblem(snap)
  if (problem) add('approval', 'fail', problem)
  else add('approval', 'ok', 'design approved and unchanged')
  const auth = await run($, ['gh', 'auth', 'status'], 20000)
  add('gh login', auth.exitCode === 0 ? 'ok' : 'fail', auth.exitCode === 0 ? '' : 'run `gh auth login`')
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], 15000)
  add('origin remote', remote.exitCode === 0 ? 'ok' : 'fail', remote.exitCode === 0 ? '' : 'git has no origin to push PRs to')
  if (!isSafeBranchName(snap.settings.baseBranch)) add('base branch', 'fail', unsafeBaseNote())
  else if (remote.exitCode === 0) {
    const gone = await missingOnBase($, snap.settings.baseBranch)
    if (gone.length > 0) add('design on base', 'fail', gone[0]!)
    else add('design on base', 'ok', `pushed to ${cleanText(snap.settings.baseBranch)}`)
  }
  const tree = await run($, ['git', '--no-optional-locks', 'status', '--porcelain'], 15000)
  const dirty = tree.stdout.split('\n').filter(l => l.trim() && !l.includes(' .factory/')).length
  add('working tree', tree.exitCode !== 0 ? 'warn' : dirty > 0 ? 'warn' : 'ok', tree.exitCode !== 0 ? 'git status failed' : dirty > 0 ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : 'clean')
  if (await lockedByOther($)) add('loop lock', 'warn', 'another session is running the loop here')
  else add('loop lock', 'ok')
  if (snap.settings.budgetUsd > 0) {
    const spent = await currentSpend($, snap.state.current)
    add('budget', spent === null ? 'warn' : 'ok', spent === null ? 'spend cannot be read, so the budget would pause the loop' : `${formatUsd(spent.runUsd)} of ${formatUsd(snap.settings.budgetUsd)}`)
  }
  return out
}

async function designCmd($: Dollar, args: string): Promise<{ text: string }> {
  const running = await readState($)
  if (running.autopilot) await pause($, running, 'design being amended; /factory-approve then /factory-start resumes')
  await ensureGitignore($)
  if ((await readText($, SETTINGS_PATH)) === null) {
    await $.fs.write(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`)
  }
  if ((await readText($, TODO_PATH)) === null) await $.fs.write(TODO_PATH, SKELETON_TODO)
  if ((await readText($, DESIGN_PATH)) === null) await $.fs.write(DESIGN_PATH, '# Design\n\n## Decisions\n')
  const topic = (args ?? '').trim()
  await drive($, { key: PLAN_KEY, kind: 'design', title: 'design interview' })
  $.clock.after(300, () => submit($, topic ? `${DESIGN_PROMPT}\n\nThe person wants to focus on: ${topic}` : DESIGN_PROMPT, topic ? `Code factory: design interview (${topic})` : 'Code factory: design interview', true))
  return { text: 'Code factory: design interview starting. Answer the questions; run /factory-approve when the design is complete.' }
}

async function approveCmd($: Dollar): Promise<{ text: string }> {
  await ensureGitignore($)
  const snap = await load($)
  const raw = await readText($, TODO_PATH)
  const designText = await readText($, DESIGN_PATH)
  const baseOk = isSafeBranchName(snap.settings.baseBranch)
  const protection = baseOk ? await branchProtectionWarnings($, snap.settings.baseBranch) : []
  const problems = [
    ...snap.settingsProblems,
    ...(snap.settings.requireBranchProtection ? protection : []),
    ...(raw === null ? [] : todoHeadingProblems(raw)),
    ...validateItems(snap.items, snap.settings.stopAfterVersion),
    ...(designText === null || !/^##\s+Decisions/im.test(designText) ? [`${DESIGN_PATH} needs a "## Decisions" section.`] : []),
    ...(await preflight($)),
    ...(baseOk ? await missingOnBase($, snap.settings.baseBranch) : [designPushSteps(snap.settings.baseBranch)]),
    ...(snap.state.unreadable ? [STATE_UNREADABLE] : []),
  ]
  if (problems.length > 0) return { text: safeLines(`Not approved. Fix these first (/factory-design continues the interview):\n- ${problems.join('\n- ')}`) }
  let promotedCount = 0
  if (raw !== null) {
    const { text, ids } = promoteProposed(raw)
    promotedCount = ids.length
    if (ids.length > 0) await $.fs.write(TODO_PATH, text)
  }
  loopEpoch++
  const after = await load($)
  const hash = decisionsHash(after.settings, after.items)
  await writeState($, {
    ...after.state,
    approved: true,
    approvedHash: hash,
    approvedDone: after.items.filter(i => i.status === 'done').map(i => i.id),
    pausedReason: after.state.autopilot ? null : 'approved, not started',
    roadmapAsked: false,
  })
  if (instructions?.isDesign) instructions = null
  await refreshStatus($)
  const lines = after.items.filter(i => i.status === 'todo').map(i => `- ${i.id} [${i.type}] ${i.title}`)
  const warn = !snap.settings.requireBranchProtection && protection.length > 0
    ? `\nWarnings (set requireBranchProtection to make them blocking):\n- ${protection.join('\n- ')}\n`
    : ''
  const head = `Approved. ${warn}${promotedCount > 0 ? `${promotedCount} proposed item(s) promoted to todo.\n` : ''}Queue (in order):\n${lines.join('\n') || '(empty)'}\n`
  if (after.state.autopilot || lines.length === 0) return { text: safeLines(`${head}${after.state.autopilot ? 'The loop is already running.' : 'Run /factory-start when items are ready.'}`) }
  const started = await startCmd($)
  return { text: safeLines(`${head}${started.text}`) }
}

type Interview = { what: string; noun: string; label: string; title: string; needsIdle: boolean; markAsked: boolean; prompt: (items: readonly Item[], mergedIds: readonly string[], settings: Settings, costSummary: string) => string }

const ROADMAP_INTERVIEW: Interview = {
  what: 'plan the next phase',
  noun: 'next-phase interview',
  label: 'Code factory: the plan is done; next-phase interview',
  title: 'next-phase interview',
  needsIdle: true,
  markAsked: true,
  prompt: (items, mergedIds, settings, costSummary) => roadmapPrompt(items, mergedIds, costSummary, settings),
}

// Both interviews share one launch path: approved plan, no other session, no
// factory turn in flight, the loop paused first, then one armed turn.
async function interviewCmd($: Dollar, iv: Interview): Promise<{ text: string }> {
  const snap = await load($)
  if (!snap.state.approved) return { text: `Cannot ${iv.what}: the design is not approved. /factory-design ${iv.needsIdle ? 'amends' : 'writes'} it${iv.needsIdle ? '' : ' first (the factory needs to know how this repo is built and tested), then /factory-approve'}.` }
  if (await lockedByOther($)) return { text: `Cannot ${iv.what}: another session is running the factory in this repo (its lock was refreshed in the last two minutes).` }
  if (launchedHere !== null) return { text: `Cannot ${iv.what} now: this session's review agent is still reporting. Let it finish, then try again.` }
  if (roadmapPending || isAdvancing || (await turnBusy($))) {
    return { text: `Cannot ${iv.what} now: a factory turn is still running or an interview is already starting. Let it finish (or /factory-stop it), then try again.` }
  }
  const items = effectiveItems(snap)
  if (iv.needsIdle && (snap.state.current || pickNext(items, snap.blocked, snap.settings.stopAfterVersion))) {
    return { text: `The plan still has runnable work (${summarize(items, snap.blocked)}${snap.state.current ? `, ${snap.state.current} in progress` : ''}). /factory-start runs it; /factory-design amends the plan.` }
  }
  roadmapPending = true
  try {
    if (snap.state.autopilot) await pause($, snap.state, `${iv.title} in progress; /factory-approve then /factory-start resumes`)
  } catch (err) {
    roadmapPending = false
    throw err
  }
  const epoch = loopEpoch
  $.clock.after(300, () => {
    void startInterview($, iv, items, snap.state.mergedIds, snap.settings, epoch).finally(() => {
      roadmapPending = false
    })
  })
  return { text: `Code factory: ${iv.noun} starting. Answer the questions; run /factory-approve when the new items are pushed (it starts the loop).` }
}

async function triageCmd($: Dollar, args: string): Promise<{ text: string }> {
  const filter = triageFilter(args ?? '')
  return interviewCmd($, {
    what: 'triage issues',
    noun: 'issue triage',
    label: filter ? `Code factory: issue triage (${filter})` : 'Code factory: issue triage',
    title: 'issue triage',
    needsIdle: false,
    markAsked: false,
    prompt: (items, _merged, settings) => triagePrompt(items, settings, filter),
  })
}

async function guideCmd($: Dollar): Promise<{ text: string }> {
  await refreshView($)
  return { text: guideReport(await read($, view)) }
}

async function doctorCmd($: Dollar): Promise<{ text: string }> {
  const checks = await doctorChecks($)
  await update($, checksAtom, () => checks)
  return { text: safeLines(checksReport(checks)) }
}

export const register: Register = (on, _options) => {
  on('session.start', async ($, e, next) => {
    for (const [name, description, argumentHint, immediate] of [
      ['factory', 'Code factory: where am I, what is the next step, and the commands', undefined, true],
      ['factory-triage', 'Code factory: read the open GitHub issues with me and turn the ones worth doing into proposed items', '[search]', false],
      ['factory-design', 'Code factory: interview me and record the design, decisions and todo list', '[topic]', false],
      ['factory-approve', 'Code factory: validate the design and todo list, then unlock the build loop', undefined, false],
      ['factory-start', 'Code factory: run the build loop on the todo list', undefined, false],
      ['factory-stop', 'Code factory: pause the build loop', undefined, false],
      ['factory-pause', 'Code factory: stop advancing after the current turn, keeping the item, attempts and pending review', undefined, true],
      ['factory-status', 'Code factory: show progress, the current item, spend and blocked items', undefined, false],
      ['factory-log', 'Code factory: show the event timeline, for one item or all', '[ID]', true],
      ['factory-skip', 'Code factory: mark an item blocked so the loop moves on', '<ID> [reason]', false],
      ['factory-retry', 'Code factory: unblock an item and reset its attempts', '<ID>', false],
      ['factory-costs', 'Code factory: show spend per repo and per item', '[repo|all] | reset <repo>', true],
      ['factory-dashboard', 'Code factory: open the dashboard (control panel) with every step, agent and check; off closes it', '[off]', true],
      ['factory-doctor', 'Code factory: check that gh, git, the design files and settings are ready to run', undefined, false],
      ['factory-roadmap', 'Code factory: interview me about the next phase once nothing is left to run', undefined, false],
    ] as const) {
      await $.command.register({ name, description, ...(argumentHint ? { argumentHint } : {}), ...(immediate ? { immediate: true as const } : {}) })
    }

    lastStatusText = null
    startWatchdog($)
    await startView($)
    // A new session resumes the loop by itself when the repo is approved and running.
    const snap = await load($)
    if (snap.state.approved && snap.state.autopilot && e.isInteractive) {
      if (!snap.state.unreadable) toast($, 'factory resuming the todo list (/factory-stop to pause)', { timeoutMs: 8000 })
      $.clock.after(3000, () => {
        void advance($)
      })
    }
    await refreshStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && instructions?.isDesign) instructions = null
    if (e.reason !== 'clear') {
      await settle($, false)
      repoKeyMemo = null
      treeMemo = null
      instructions = null
      launchedHere = null
      expectReport = false
      reviewInFlight = false
      viewTimer?.cancel()
      viewTimer = null
      watchTimer?.cancel()
      watchTimer = null
      isFactoryTurn = false
      isArmed = false
      personSlash = false
      slashTurnId = null
      await releaseLock($)
    }
    return next(e)
  })

  // ---- commands --------------------------------------------------------

  on('command.run', { command: 'factory' }, async $ => guideCmd($))

  on('command.run', { command: 'factory-design' }, async ($, e) => designCmd($, e.args))

  on('command.run', { command: 'factory-approve' }, async $ => approveCmd($))

  on('command.run', { command: 'factory-roadmap' }, async $ => interviewCmd($, ROADMAP_INTERVIEW))

  on('command.run', { command: 'factory-triage' }, async ($, e) => triageCmd($, e.args))

  on('command.run', { command: 'factory-start' }, async $ => startCmd($))

  on('command.run', { command: 'factory-stop' }, async $ => stopCmd($))

  on('command.run', { command: 'factory-pause' }, async $ => pauseCmd($))

  on('command.run', { command: 'factory-status' }, async $ => {
    await refreshView($)
    const snap = await load($)
    const spend = await currentSpend($, snap.state.current)
    return {
      text: statusReport({
        state: snap.state,
        settings: snap.settings,
        items: effectiveItems(snap),
        blocked: await blockedNotes($, snap.blocked),
        stage: snap.state.current ? await viewStage($) : null,
        now: await stamp($),
        runUsd: spend?.runUsd ?? null,
        itemUsd: spend && snap.state.current ? spend.itemUsd : null,
      }),
    }
  })

  on('command.run', { command: 'factory-log' }, async ($, e) => {
    const { id } = parseItemArg(e.args)
    if (e.args.trim() && !id) return { text: 'Usage: /factory-log [ID], for example /factory-log T-003.' }
    return { text: formatLog((await readState($)).events, id) }
  })

  on('command.run', { command: 'factory-skip' }, async ($, e) => skipCmd($, e.args))

  on('command.run', { command: 'factory-retry' }, async ($, e) => retryCmd($, e.args))

  on('command.run', { command: 'factory-doctor' }, async $ => doctorCmd($))

  on('command.run', { command: 'factory-dashboard' }, async ($, e) => {
    if (/^\s*(off|close)\s*$/i.test(e.args ?? '')) {
      await $.ui.close({ id: PANE })
      return { text: 'Factory dashboard closed; /factory-dashboard opens it again.' }
    }
    await refreshView($)
    await $.ui.open({ id: PANE, title: 'Code factory' })
    return { text: 'Factory dashboard opened. Press an agent to see what it is doing; /factory-dashboard off closes it.' }
  })

  on('command.run', { command: 'factory-costs' }, async ($, e) => {
    const { reset, filter } = parseCostsArgs(e.args)
    let keys: string[]
    try {
      keys = (await $.store.keys()).filter(k => k.startsWith(COST_KEY_PREFIX))
    } catch {
      return { text: 'The cost ledger is not available in this session.' }
    }
    if (reset !== null) {
      const known = keys.map(k => k.slice(COST_KEY_PREFIX.length))
      if (!reset || !known.includes(reset)) {
        return { text: safeLines(`Usage: /factory-costs reset <repo>, with the exact repo key${known.length > 0 ? `: ${known.join(', ')}` : ' (nothing is recorded yet)'}.`) }
      }
      let target: RepoCosts
      let here: string | null = null
      try {
        target = normalizeRepoCosts(await $.store.get(`${COST_KEY_PREFIX}${reset}`), reset)
        here = await costRepo($)
      } catch {
        return { text: 'The cost ledger is not available in this session.' }
      }
      const st = await readState($)
      const live = Object.keys(target.marks).length > 0 || (reset === here && (st.autopilot || isFactoryTurn || launchedHere !== null || (await lockedByOther($))))
      if (live) return { text: safeLines(`Cannot reset ${reset}: a factory run is live or a turn is still being charged there, and resetting would wipe the run the budget counts. /factory-stop (or /factory-pause) and let the turn finish first.`) }
      const cleared = costChain.then(() => $.store.delete(`${COST_KEY_PREFIX}${reset}`)).catch(() => null)
      costChain = cleared
      await cleared
      if (reset === repoKeyMemo) markOwner = null
      return { text: safeLines(`Cost ledger for ${reset} deleted.`) }
    }
    const all: RepoCosts[] = []
    for (const k of keys) {
      try {
        all.push(normalizeRepoCosts(await $.store.get(k), k.slice(COST_KEY_PREFIX.length)))
      } catch {
        continue
      }
    }
    let current: string | null = null
    try {
      current = await costRepo($)
    } catch {
      current = null
    }
    return { text: costsReport(all, filter, current) }
  })

  // ---- the loop --------------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) mainTurnOpen = false
    if (e.agentId && e.agentId === launchedHere) expectReport = true
    const out = await next(e)
    await turnCost($, e)
    if (!e.agentId && instructions && instructions.roadmapAt !== null) {
      if (e.reason === 'answer' && isRoadmapDone(e.answer)) instructions = null
      else {
        instructions.turns++
        instructions.lastAt = await $.clock.now()
      }
    }
    if (!e.agentId && personSlash && slashTurnId !== null && e.turnId !== slashTurnId && !isFactoryTurn && markOwner !== null) await settle($, true)
    else if (!e.agentId && personSlash && (slashTurnId === null || e.turnId === slashTurnId)) {
      const isSlashTurn = slashTurnId !== null && !isFactoryTurn
      personSlash = false
      slashTurnId = null
      if (isSlashTurn && markOwner !== null) await rebaseOpenMark($)
    }
    await refreshView($)
    if (e.agentId) {
      const wasReviewer = (await readState($)).reviewAgentId === e.agentId
      await reviewerTurn($, e.agentId, e.reason === 'answer' ? e.answer : '', e.reason !== 'answer')
      if (wasReviewer) await stopForBudget($)
      return out
    }
    if (!isFactoryTurn) return out
    isFactoryTurn = false
    const state = await readState($)
    if (!state.autopilot) {
      isArmed = false
      return out
    }
    if (e.reason !== 'answer') {
      isArmed = false
      await pause($, state, e.reason === 'aborted' ? 'you interrupted it' : `turn ended with ${e.reason}`)
      return out
    }
    if (await stopForBudget($)) {
      isArmed = false
      return out
    }
    $.clock.after(800, () => {
      void advance($)
    })
    return out
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!instructions) return out
    if (instructions.roadmapAt !== null && roadmapExpired(instructions.roadmapAt, instructions.lastAt, instructions.turns, await $.clock.now())) {
      instructions = null
      return out
    }
    if (!instructions.isDesign) {
      const state = await readState($)
      if (!(state.approved && (state.autopilot || isArmed))) return out
    }
    const text = `These are the code factory loop's instructions for the main session. If you are a subagent (any task launched through the Agent tool, including one whose prompt starts with ${REVIEW_TAG}), ignore this whole section.\n\n${instructions.text}`
    return { ...out, sections: [...out.sections, { id: 'code-factory:instructions', text, scope: 'session' as const }] }
  })

  // The person taking the wheel pauses the loop and takes the guards off.
  on('prompt.submit', async ($, e, next) => {
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind) && instructions && instructions.roadmapAt !== null) instructions.lastAt = await $.clock.now()
    if ((e.origin.kind === 'peer' || e.origin.kind === 'task-notification') && (expectReport || launchedHere !== null)) {
      const state = await readState($)
      if (expectReport || state.autopilot) {
        expectReport = false
        if (state.approved) {
          isFactoryTurn = true
          factoryTurnAt = -1
          isArmed = true
        }
      }
    }
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind) && !e.text.trimStart().startsWith('/')) {
      const state = await readState($)
      if (state.autopilot && (await lockedByOther($))) {
        handsOff = true
        toast($, 'factory: another session holds this repo\'s loop; this session stays out of it (/factory-start takes it over)', { timeoutMs: 8000 })
        await settle($, false)
      } else if (state.autopilot) await pause($, state, 'you sent a prompt; /factory-start resumes', true)
      else await settle($, false)
      isFactoryTurn = false
      isArmed = false
      expectReport = false
    }
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind) && e.text.trimStart().startsWith('/') && !/^\/factory(-|\s|$)/.test(e.text.trimStart()) && markOwner !== null) {
      await settle($, true)
      personSlash = true
      slashTurnId = null
      const gen = ++slashGen
      $.clock.after(SLASH_TURN_WAIT_MS, () => {
        if (gen === slashGen && slashTurnId === null) personSlash = false
      })
    } else if (!['composer', 'bridge', 'sdk'].includes(e.origin.kind) && personSlash && slashTurnId === null) {
      personSlash = false
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    mainTurnOpen = true
    if (personSlash && slashTurnId === null) slashTurnId = e.turnId
    return next(e)
  })

  // ---- guards ----------------------------------------------------------

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const out = await next(e)
    if (!e.agentId && instructions && instructions.roadmapAt !== null) instructions.lastAt = await $.clock.now()
    return out
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => (await guardWrite($, e.file_path, e.agentId)) ?? next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => (await guardWrite($, e.file_path, e.agentId)) ?? next(e))

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.agentId !== undefined && e.agentId === (await readState($)).reviewAgentId) return next(e)
    const state = await readState($)
    if ((state.reviewAgentId !== null || reviewInFlight) && state.approved && (state.autopilot || isArmed)) {
      return deny('code-factory: send no messages while the review agent runs; its report is read as it finishes.')
    }
    return next(e)
  })

  // The review agent's verdict is read from its answer and kept in the factory's
  // state, but only for the exact prompt the factory handed the model, spawned
  // by the main loop.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!e.prompt.includes(REVIEW_TAG)) return next(e)
    if (reviewInFlight) return deny('code-factory: a review agent is already starting; wait for it.')
    reviewInFlight = true
    try {
      const snap = await load($)
      const isLive = snap.state.approved && !(await lockedByOther($)) && (snap.state.autopilot || isArmed)
      if (!isLive) return next(e)
      const item = snap.items.find(i => i.id === snap.state.current)
      if (e.agentId !== undefined || !item) {
        return deny('code-factory: the review agent is started once, by the main loop, for the current item.')
      }
      if (normalizeText(e.prompt) !== normalizeText(reviewAgentPrompt(snap.settings, branchFor(item)))) {
        return deny('code-factory: pass the review prompt from the work item exactly as written, without changes.')
      }
      if ((e.subagent_type !== undefined && e.subagent_type !== 'general-purpose') || e.model !== undefined || e.name !== undefined || e.isolation !== undefined || e.mode !== undefined || e.team_name !== undefined) {
        return deny('code-factory: start the review agent as a plain general-purpose agent, without a custom type, model, name, mode, team or isolation.')
      }
      if (snap.state.reviewRounds >= snap.settings.maxReviewRounds) {
        return deny(`code-factory: ${snap.settings.maxReviewRounds} review rounds are used up for ${item.id}; write .factory/blocked/${item.id}.md and stop.`)
      }
      if (reviewWaiting(snap.state, snap.settings, await $.clock.now())) {
        return deny(`code-factory: the review agent for ${item.id} is still running; its verdict arrives as a hand-back message. End your turn and wait for it.`)
      }
      await markStage($, 'review')
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      const text = agentText(ran.result) || (typeof ran.text === 'string' ? ran.text : '')
      const agentId = agentLaunchId(ran.result, text)
      if (agentId) {
        launchedHere = agentId
        const at = await $.clock.now()
        await patchState($, fresh => ({
          ...withEvent(fresh, at, { itemId: item.id, kind: 'review-launched', detail: `agent ${agentId}, round ${fresh.reviewRounds + 1}/${snap.settings.maxReviewRounds}` }),
          reviewAgentId: agentId,
          reviewAgentAt: at,
          reviewWaitMs: snap.settings.reviewTimeoutMs,
        }))
        return ran
      }
      const mark = parseReviewMarker(text)
      if (mark) {
        await recordReview($, item.id, mark, snap.settings.maxReviewRounds, declinedLines(text), declinedLines(text, 'OPEN'))
        return ran
      }
      if (/FACTORY-REVIEW:\s*unavailable/i.test(text)) {
        await pause($, await readState($), `${snap.settings.reviewCommand} is not available to the review agent`)
      }
      return ran
    } finally {
      reviewInFlight = false
    }
  })

  on('agent.spawn', async ($, e, next) => {
    if (!e.prompt.includes(REVIEW_TAG)) return next(e)
    const st = await readState($)
    let stat: { files: number; lines: number } | null = null
    try {
      const base = parseSettings(await readText($, SETTINGS_PATH)).settings.baseBranch
      if (isSafeBranchName(base)) {
        const r = await run($, ['git', 'diff', '--shortstat', `origin/${base}...HEAD`], 20000)
        if (r.exitCode === 0) stat = parseShortstat(r.stdout)
      }
    } catch {
      stat = null
    }
    const extra = `${declinedSection(st.reviewDeclined)}${rereviewSection(st.review, st.reviewRounds, st.reviewOpen)}${depthSection(stat)}`
    return next(extra ? { ...e, prompt: `${e.prompt}${extra}` } : e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, nextRaw) => {
    const stageEvent = loopEventForBash(classifyBash(e.command, 'main'))
    let liveItem: string | null = null
    const next: typeof nextRaw = Object.assign(async (x: Parameters<typeof nextRaw>[0]) => {
      const r = await nextRaw(x)
      if (stageEvent && r.deny === undefined && !r.isError) {
        await markStage($, stageEvent)
        if (liveItem) await logBashEvent($, liveItem, stageEvent, e.command, typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? ''))
      }
      return r
    }, nextRaw)
    const snap = await load($)
    const base = snap.settings.baseBranch
    const branch = await branchNow($)
    const f = classifyBash(e.command, base, branch)
    if (f.touchesFactoryState) {
      return deny('code-factory: the factory state file is controlled by the person through /factory-* commands.')
    }
    const isLive = snap.state.approved && !(await lockedByOther($)) && (snap.state.autopilot || isArmed)
    if (!isLive) return next(e)
    liveItem = snap.state.current

    if ((f.isCommit || f.isPush) && snap.state.reviewAgentId !== null && e.agentId !== snap.state.reviewAgentId) {
      if (reviewWaiting(snap.state, snap.settings, await $.clock.now())) return deny(REVIEW_BUSY_DENY)
    }

    if (f.apiPrWrite) {
      return deny('code-factory: do not change branches, PRs or contents through `gh api`; use git and `gh pr create` / `gh pr merge` so the checks run.')
    }

    // CI look-ups: a billing failure stops the whole loop.
    if (f.isCiLookup && !(f.isPush || f.isCommit || f.isPrCreate || f.isPrMerge)) {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      const out = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
      if (liveItem && /\bpr\s+checks\b/.test(e.command)) {
        const outcome = ciOutcome(out)
        if (outcome) await logEvent($, { itemId: liveItem, kind: outcome === 'passed' ? 'ci-passed' : 'ci-failed', detail: outcome === 'passed' ? 'gh pr checks: all green' : 'gh pr checks: failing' })
      }
      let detail: string | null = isBillingProblem(out) ? out : null
      if (!detail && /fail|cancel|startup_failure|action_required|✗/i.test(out)) detail = await ciBillingProblem($)
      if (!detail) return ran
      await pauseForBilling($, detail)
      return { ...ran, context: [...(ran.context ?? []), 'code-factory: CI failed for a GitHub billing/spending-limit reason. The factory loop is paused. Stop working on this item and end your turn.'] }
    }

    if (!(f.isPush || f.isCommit || f.isPrCreate || f.isPrMerge)) return next(e)

    const problem = await integrityProblem(snap)
    if (problem) {
      await pause($, snap.state, problem)
      return deny(`code-factory: paused, ${problem}.`)
    }
    const { settings } = snap
    const tail = (r: Run) => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n')
    const names = (r: Run) => r.stdout.split('\n').filter(Boolean)

    if (f.isForcePush) return deny('code-factory: force-push is not allowed.')
    if (f.isPush && (f.pushNamesBase || f.pushesBase || branch === base)) {
      return deny(`code-factory: never push to ${base}; push the factory/* branch and open a PR.`)
    }
    if (f.isCommit && f.commitsOnBase) {
      const item = snap.items.find(i => i.id === snap.state.current)
      return deny(`code-factory: do not commit on ${base}. Create the branch first${item ? `: git checkout -b ${branchFor(item)}` : ''}.`)
    }
    if ((f.isPrCreate || f.isPrMerge) && f.repoFlag) {
      return deny('code-factory: do not target another repository with -R/--repo.')
    }

    if (f.isPrCreate) {
      if (!branch.startsWith('factory/')) return deny(`code-factory: open PRs from a factory/* branch (current: "${branch}").`)
      const item = snap.items.find(i => i.id === snap.state.current)

      // Cheap checks first, then the expensive ones.
      if (settings.requireTestChanges && item?.type !== 'docs' && item?.type !== 'chore') {
        let diff = await run($, ['git', 'diff', '--name-only', `origin/${base}...HEAD`])
        if (diff.exitCode !== 0) diff = await run($, ['git', 'diff', '--name-only', `${base}...HEAD`])
        if (diff.exitCode === 0 && !hasTestChanges(names(diff))) {
          return deny('code-factory: this branch changes no test files. Add tests for the new behavior or the regression test for the bug.')
        }
      }
      if (!settings.allowTestRemoval) {
        let full = await run($, ['git', 'diff', '-U0', '--no-color', `origin/${base}...HEAD`])
        if (full.exitCode !== 0) full = await run($, ['git', 'diff', '-U0', '--no-color', `${base}...HEAD`])
        const weak = full.exitCode === 0 ? testWeakening(full.stdout) : []
        if (weak.length > 0) {
          return deny(`code-factory: this branch weakens the tests (${weak.join('; ')}). Restore them; settings.allowTestRemoval needs the person's approval.`)
        }
      }
      if (settings.requireReview) {
        const head = await headSha($)
        if (!isReviewClean(snap.state.review, head)) {
          const last = snap.state.review
          return deny(`code-factory: no clean independent review for HEAD ${head.slice(0, 7)}${last ? ` (last review: ${markCounts(last)} at ${last.sha.slice(0, 7)})` : ''}. Run step 6: spawn the fresh review agent with the exact prompt from the work item and do not commit after it.`)
        }
      }
      if (settings.buildCmd.length > 0) {
        const built = await run($, settings.buildCmd, settings.testTimeoutMs)
        if (built.exitCode !== 0) return deny(`code-factory: the build fails (${settings.buildCmd.join(' ')}, exit ${built.exitCode}). Fix it first.\n${tail(built)}`)
      }
      const tests = await run($, settings.testCmd, settings.testTimeoutMs)
      if (tests.exitCode !== 0) {
        return deny(`code-factory: the test suite fails (${settings.testCmd.join(' ')}, exit ${tests.exitCode}). Fix it before opening the PR.\n${tail(tests)}`)
      }
      if (settings.e2eCmd.length > 0 && settings.e2eFor.includes(item?.type ?? 'feature')) {
        const e2e = await run($, settings.e2eCmd, settings.testTimeoutMs)
        if (e2e.exitCode !== 0) return deny(`code-factory: the end-to-end tests fail (${settings.e2eCmd.join(' ')}, exit ${e2e.exitCode}). The change does not work yet.\n${tail(e2e)}`)
      }
    }

    if (f.isPrMerge) {
      if (f.hasAdmin) return deny('code-factory: --admin merges are not allowed.')
      if (f.hasAuto) return deny('code-factory: --auto merges skip the check this mod makes; wait for CI with `gh pr checks --watch`, then merge.')
      const sel = f.prSelector ? [f.prSelector] : []
      const prView = await run($, ['gh', 'pr', 'view', ...sel, '--json', 'state,mergeable,headRefName,headRefOid,statusCheckRollup'])
      if (prView.exitCode !== 0) return deny(`code-factory: could not read the PR (${prView.stderr.trim().slice(0, 160)}).`)
      let pr: { state: string; mergeable: string; headRefName: string; headRefOid: string; statusCheckRollup: unknown[] }
      try {
        pr = JSON.parse(prView.stdout) as typeof pr
      } catch {
        return deny('code-factory: could not parse the PR status.')
      }
      if (!pr.headRefName.startsWith('factory/')) return deny('code-factory: it only merges factory/* PRs.')
      if (pr.state !== 'OPEN') return deny(`code-factory: the PR is ${pr.state}.`)
      if (pr.mergeable === 'CONFLICTING') return deny('code-factory: the PR has merge conflicts; rebase or merge the base branch and push.')
      const verdict = checksVerdict((pr.statusCheckRollup ?? []) as Parameters<typeof checksVerdict>[0], settings.allowNoCI)
      if (verdict.ok) await logEvent($, { itemId: liveItem, kind: 'ci-passed', detail: verdict.reason })
      else if (/FAILURE|CANCELLED|STARTUP|ACTION_REQUIRED|TIMED_OUT/.test(verdict.reason)) await logEvent($, { itemId: liveItem, kind: 'ci-failed', detail: verdict.reason })
      if (!verdict.ok) {
        if (/FAILURE|CANCELLED|STARTUP|ACTION_REQUIRED/.test(verdict.reason)) {
          const billing = await ciBillingProblem($)
          if (billing) {
            await pauseForBilling($, billing)
            return deny('code-factory: CI failed for a GitHub billing/spending-limit reason; the loop is paused. Stop and end your turn.')
          }
        }
        return deny(`code-factory: ${verdict.reason}. Wait with \`gh pr checks --watch\` and fix failures.`)
      }
      // What gets merged must be exactly what was reviewed and what CI ran on.
      if (settings.requireReview && !isReviewClean(snap.state.review, pr.headRefOid ?? '')) {
        return deny(`code-factory: the PR head ${(pr.headRefOid ?? '').slice(0, 7)} is not the commit the clean review covered (${snap.state.review ? snap.state.review.sha.slice(0, 7) : 'none'}). Re-run the review agent on the final commit.`)
      }
      if (!settings.allowTestRemoval) {
        const diff = await run($, ['gh', 'pr', 'diff', ...sel, '--color', 'never'], 60000)
        if (diff.exitCode === 0) {
          const weak = testWeakening(diff.stdout)
          if (weak.length > 0) return deny(`code-factory: the PR weakens the tests (${weak.join('; ')}).`)
        }
      }
    }
    return next(e)
  })

  const AGENT_GLYPH: Record<string, string> = { running: '●', waiting: '◐', pending: '○', idle: '◌', completed: '✓', failed: '✗', killed: '✗' }
  const STEP_GLYPH = { done: '✓', doing: '●', todo: '○' } as const
  const STEP_COLOR = { done: 'green', doing: 'yellow', todo: undefined } as const
  const budgetColor = (v: FactoryView): string | undefined =>
    v.runUsd == null || v.budgetUsd <= 0 ? undefined : v.runUsd >= v.budgetUsd ? 'red' : v.runUsd >= v.budgetUsd * 0.8 ? 'yellow' : undefined
  const agentLine = (a: AgentRow): string => oneLine(`${AGENT_GLYPH[a.status] ?? '·'} ${a.label} · ${a.status} · ${a.summary}`, 110)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v || (!v.approved && Object.keys(v.marks).length === 0)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const compact = isCompact(e.props.bodyColumns)
    if (!v.approved) {
      return (
        <Box gap={1} paddingX={1}>
          <Text bold>factory ✎ design drafted</Text>
          {!compact && (
            <Text dimColor wrap="truncate-end">
              next: push the design files, then /factory-approve
            </Text>
          )}
          <Button plain dimColor key="details" onPress={() => void $.ui.open({ id: PANE, title: 'Code factory', focus: true })}>
            [panel]
          </Button>
        </Box>
      )
    }
    const total = v.total ?? v.doneCount + v.rows.length + v.more
    const agents = v.agents ?? []
    const steps = v.steps ?? []
    const openPane = (): void => {
      void $.ui.open({ id: PANE, title: 'Code factory', focus: true })
    }
    const pick = (id: string): void => {
      void update($, openAgent, () => id)
      openPane()
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Text bold color={v.running ? 'green' : undefined} dimColor={!v.running} wrap="truncate-end">
            {v.running ? `factory ▶ ${v.current ?? 'picking next'}` : `factory ⏸ ${oneLine(v.pausedReason ?? 'stopped', compact ? 24 : 60)}`}
          </Text>
          <Text dimColor>{`${v.doneCount}/${total} done ${progressBar(v.doneCount, total, compact ? 4 : 8)}${(v.blockedCount ?? 0) > 0 ? ` · ${v.blockedCount} blocked` : ''}`}</Text>
          {!compact && v.runUsd != null && (
            <Text dimColor={budgetColor(v) === undefined} color={budgetColor(v)}>
              {`${v.budgetUsd > 0 ? `${formatUsd(v.runUsd)}/${formatUsd(v.budgetUsd)} ${progressBar(v.runUsd, v.budgetUsd, 6)}` : `${formatUsd(v.runUsd)} run`}${v.current !== null && v.itemUsd != null ? ` · item ${formatUsd(v.itemUsd)}` : ''}`}
            </Text>
          )}
          {!compact && v.running && v.elapsedMs != null && v.current !== null && <Text dimColor>{formatDuration(v.elapsedMs)}</Text>}
          <Button plain dimColor key="details" onPress={openPane}>
            [panel]
          </Button>
          {(compact ? runControls(v) : controlsFor(v)).map(c => (
            <Button plain key={c.key} onPress={() => pressControl($, c)}>
              [{c.label}]
            </Button>
          ))}
        </Box>
        {!compact && v.running && steps.length > 0 && (
          <Box gap={1}>
            {steps.map(st => (
              <Text key={st.label} bold={st.state === 'doing'} color={STEP_COLOR[st.state]} dimColor={st.state === 'todo'}>
                {STEP_GLYPH[st.state]} {st.label}
                {st.state === 'doing' ? ` (${st.detail})` : ''}
              </Text>
            ))}
          </Box>
        )}
        {v.rows.slice(0, compact ? 2 : v.rows.length).map(r => (
          <Box key={r.id} gap={1}>
            <Text color={COLOR[r.mark]} bold={r.mark === 'doing'} dimColor={r.mark === 'proposed'}>
              {GLYPH[r.mark]} {r.id}
            </Text>
            <Text dimColor={r.mark !== 'doing'} wrap="truncate-end">
              [{r.type}] {r.title}
            </Text>
          </Box>
        ))}
        {(v.doneCount > 0 || v.more > 0) && (
          <Text dimColor>
            {v.doneCount > 0 ? `✓ ${v.doneCount} done` : ''}
            {v.doneCount > 0 && v.more > 0 ? ' · ' : ''}
            {v.more > 0 ? `+${v.more} more` : ''}
          </Text>
        )}
        {agents.slice(0, compact ? 2 : 4).map(a => (
          <Button plain dimColor={!ACTIVE_AGENT.has(a.status)} key={`agent-${a.id}`} onPress={() => pick(a.id)}>
            {oneLine(agentLine(a), compact ? 60 : 110)}
          </Button>
        ))}
        {!compact && v.changes.length > 0 && <Text dimColor>Δ {v.changes.join(' · ')}</Text>}
        {!compact && (v.events?.length ?? 0) > 0 && (
          <Text dimColor wrap="truncate-end">
            ⋯ {v.events.join(' · ')}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null
    const v = await read($, view)
    const open = await read($, openAgent)
    const skipping = await read($, skipTarget)
    const checks = await read($, checksAtom)
    const guide = journey(v)
    const guideRows = guide.map((st, i) => (
      <Box key={`guide-${st.label}`} gap={1}>
        <Text color={STEP_COLOR[st.state]} bold={st.state === 'doing'} dimColor={st.state === 'todo'}>
          {STEP_GLYPH[st.state]} {i + 1} {st.label}
        </Text>
        <Text dimColor wrap="truncate-end">
          {st.detail}
        </Text>
      </Box>
    ))
    const guideButtons = guideControls(v).map(c => (
      <Button plain key={`guide-${c.key}`} onPress={() => pressControl($, c)}>
        [{c.label}]
      </Button>
    ))
    if (!v || !v.approved) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Code factory · getting started</Text>
          <Text dimColor>Design once; then it builds, reviews, merges and keeps going.</Text>
          <Text> </Text>
          {guideRows}
          <Text> </Text>
          <Text wrap="wrap">➜ {nextHint(v)}</Text>
          <Box gap={1}>
            {guideButtons}
            <Button plain key="doctor" onPress={() => pressControl($, { key: 'doctor', label: '✔ check', command: 'factory-doctor' })}>
              [✔ check setup]
            </Button>
          </Box>
          {(checks ?? []).map((c, i) => (
            <Text key={`chk-${i}`} color={c.status === 'fail' ? 'red' : c.status === 'warn' ? 'yellow' : 'green'} wrap="truncate-end">
              {checksLine(c)}
            </Text>
          ))}
        </Box>
      )
    }
    const total = v.total ?? v.doneCount + v.rows.length + v.more
    const steps = v.steps ?? []
    const agents = v.agents ?? []
    const blocked = v.blocked ?? []

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={v.running ? 'green' : undefined}>
          {statusLine(v)}
        </Text>
        <Box gap={1}>
          {runControls(v).map(c => (
            <Button plain key={c.key} onPress={() => pressControl($, c)}>
              [{c.label}]
            </Button>
          ))}
          {guideButtons}
          <Button plain key="doctor" onPress={() => pressControl($, { key: 'doctor', label: '✔ check', command: 'factory-doctor' })}>
            [✔ check setup]
          </Button>
        </Box>
        <Text dimColor wrap="wrap">
          ➜ {nextHint(v)}
        </Text>
        <Box gap={1}>
          {guide.map((st, i) => (
            <Text key={`guide-${st.label}`} color={STEP_COLOR[st.state]} bold={st.state === 'doing'} dimColor={st.state === 'todo'}>
              {STEP_GLYPH[st.state]} {i + 1} {st.label}
            </Text>
          ))}
        </Box>
        <Text> </Text>
        <Text bold>Plan {progressBar(v.doneCount, total, 20)} {v.doneCount}/{total}</Text>
        {v.rows.map(r => (
          <Box key={r.id} gap={1}>
            <Text color={COLOR[r.mark]} bold={r.mark === 'doing'} dimColor={r.mark === 'proposed'}>
              {GLYPH[r.mark]} {r.id}
            </Text>
            <Text dimColor={r.mark !== 'doing'} wrap="truncate-end">
              [{r.type}] {r.title}
            </Text>
            {(r.mark === 'todo' || r.mark === 'doing') && (
              <Button plain dimColor key={`skip-${r.id}`} onPress={() => (Input === null ? pressControl($, { key: 'skip', label: `skip ${r.id}`, command: 'factory-skip', args: r.id }) : void update($, skipTarget, () => r.id))}>
                [skip]
              </Button>
            )}
          </Box>
        ))}
        {v.more > 0 && <Text dimColor>+{v.more} more</Text>}
        {skipping !== null && Input !== null && (
          <Box gap={1}>
            <Input
              key="skip-reason"
              label={`skip ${skipping} · why?`}
              placeholder="reason (optional), Enter to skip"
              autoFocus
              onSubmit={(text: string) => {
                void update($, skipTarget, () => null)
                pressControl($, { key: 'skip', label: `skip ${skipping}`, command: 'factory-skip', args: `${skipping} ${text}`.trim() })
              }}
            />
            <Button plain dimColor key="skip-cancel" onPress={() => void update($, skipTarget, () => null)}>
              [cancel]
            </Button>
          </Box>
        )}
        {blocked.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold color="red">
              Blocked · {v.blockedCount ?? blocked.length}
            </Text>
            {blocked.map(b => (
              <Box key={`blocked-${b.id}`} flexDirection="column">
                <Box gap={1}>
                  <Text color="red">✗ {b.id}</Text>
                  <Text dimColor wrap="truncate-end">
                    {b.title}
                  </Text>
                  <Button plain key={`retry-${b.id}`} onPress={() => pressControl($, { key: `retry-${b.id}`, label: `↻ retry ${b.id}`, command: 'factory-retry', args: b.id })}>
                    [↻ retry]
                  </Button>
                </Box>
                {b.reason !== '' && (
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {b.reason}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
        {v.current !== null && steps.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>
              {v.current} {progressBar(steps.filter(s => s.state === 'done').length + (steps.some(s => s.state === 'doing') ? 0.5 : 0), steps.length, 20)}
              {v.running && v.elapsedMs != null ? ` · ${formatDuration(v.elapsedMs)}` : ''}
              {v.runUsd != null && v.itemUsd != null ? ` · ${formatUsd(v.itemUsd)}` : ''}
            </Text>
            {steps.map(st => (
              <Box key={st.label} gap={1}>
                <Text color={STEP_COLOR[st.state]} bold={st.state === 'doing'} dimColor={st.state === 'todo'}>
                  {STEP_GLYPH[st.state]} {st.label}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {st.detail}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {v.runUsd != null && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold color={budgetColor(v)}>
              Spend {v.budgetUsd > 0 ? `${formatUsd(v.runUsd)} of ${formatUsd(v.budgetUsd)} ${progressBar(v.runUsd, v.budgetUsd, 20)}` : `${formatUsd(v.runUsd)} this run (no budget set)`}
            </Text>
          </Box>
        )}
        <Text> </Text>
        <Text bold>Agents{agents.length === 0 ? ' · none running' : ` · ${agents.length}`}</Text>
        {agents.map(a => (
          <Box key={a.id} flexDirection="column">
            <Button plain dimColor={!ACTIVE_AGENT.has(a.status)} key={`agent-${a.id}`} onPress={() => void update($, openAgent, cur => (cur === a.id ? null : a.id))}>
              {`${open === a.id ? '▾' : '▸'} ${agentLine(a)}`}
            </Button>
            {open === a.id && (
              <Box flexDirection="column" paddingLeft={3}>
                <Text dimColor>
                  {a.kind}
                  {a.parent ? ` · spawned by ${a.parent}` : ''}
                </Text>
                {a.recent.length === 0 && <Text dimColor>No activity read yet.</Text>}
                {a.recent.map((line, i) => (
                  <Text key={`${a.id}-${i}`} dimColor={i < a.recent.length - 1} wrap="truncate-end">
                    {i === a.recent.length - 1 ? '→' : '·'} {line}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        ))}
        {checks !== null && checks.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>Checks</Text>
            {checks.map((c, i) => (
              <Text key={`chk-${i}`} color={c.status === 'fail' ? 'red' : c.status === 'warn' ? 'yellow' : 'green'} wrap="truncate-end">
                {checksLine(c)}
              </Text>
            ))}
          </Box>
        )}
        {(v.events?.length ?? 0) > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>Recent</Text>
            {v.events.map((ev, i) => (
              <Text key={`ev-${i}`} dimColor wrap="truncate-end">
                {ev}
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Button plain dimColor key="close" onPress={() => void $.ui.close({ id: PANE })}>
          [close]
        </Button>
      </Box>
    )
  })
}
