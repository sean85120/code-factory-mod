import type { EngineInterface, Register } from 'claude-code'

import {
  BLOCKED_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  DESIGN_PATH,
  DESIGN_PROMPT,
  FACTORY_DIR,
  LOCK_PATH,
  REVIEW_TAG,
  SETTINGS_PATH,
  STATE_PATH,
  TODO_PATH,
  agentText,
  branchFor,
  checksVerdict,
  classifyBash,
  decisionsHash,
  evaluateProtection,
  hasTestChanges,
  inScope,
  isBillingProblem,
  isLockedByOther,
  isReviewClean,
  nudgePrompt,
  normalizePath,
  normalizeText,
  parseLock,
  parseReviewMarker,
  parseSettings,
  parseTodo,
  pickNext,
  promoteProposed,
  releasePrompt,
  reviewAgentPrompt,
  summarize,
  testWeakening,
  todoHeadingProblems,
  validateItems,
  workPrompt,
} from './lib'
import type { FactoryState, Item, Settings } from './lib'

type Dollar = EngineInterface

// ---- module state (a reload only costs one /factory-start) ----------------

// A turn the factory started is running. The guards stay armed for it even if
// the loop gets paused halfway, until the turn ends or the person takes over.
let isFactoryTurn = false
let isArmed = false
let isAdvancing = false

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

async function readText($: Dollar, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function readState($: Dollar): Promise<FactoryState> {
  const text = await readText($, STATE_PATH)
  if (text === null) return { ...DEFAULT_STATE }
  try {
    return { ...DEFAULT_STATE, ...(JSON.parse(text) as Partial<FactoryState>) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

async function writeState($: Dollar, state: FactoryState): Promise<void> {
  await $.fs.write(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
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
  const snap = await load($)
  const { state, blocked } = snap
  if (!state.approved) {
    $.ui.status(snap.items.length > 0 ? 'factory: design not approved' : undefined)
    return
  }
  const sum = summarize(effectiveItems(snap), blocked)
  if (state.autopilot) $.ui.status(`factory ▶ ${state.current ?? 'picking next'} · ${sum}`)
  else $.ui.status(`factory ⏸ ${state.pausedReason ?? 'stopped'} · ${sum}`)
}

async function pause($: Dollar, state: FactoryState, reason: string): Promise<void> {
  await writeState($, { ...state, autopilot: false, pausedReason: reason })
  await releaseLock($)
  $.ui.toast(`factory paused: ${reason}`, { timeoutMs: 8000 })
  await refreshStatus($)
}

function submit($: Dollar, text: string): void {
  isFactoryTurn = true
  isArmed = true
  $.prompt.submit({ text }).catch(() => {
    isFactoryTurn = false
    isArmed = false
  })
}

async function integrityProblem(snap: Snapshot): Promise<string | null> {
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

async function pauseForBilling($: Dollar, detail: string): Promise<void> {
  const state = await readState($)
  await pause($, state, `GitHub Actions billing problem (${detail.replace(/\s+/g, ' ').slice(0, 100)}). Fix billing, then /factory-start`)
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
    $.ui.toast(`factory: /${settings.contextReset} failed, continuing without it`)
  }
}

// ---- the loop -----------------------------------------------------------------

// One step of the loop: look at where the current item stands and hand the
// model the next prompt, or finish.
async function advance($: Dollar): Promise<void> {
  if (isAdvancing) return
  isAdvancing = true
  try {
    const snap = await load($)
    let { state } = snap
    if (!state.autopilot) return
    if (!(await acquireLock($))) {
      const now = await $.clock.now()
      if (now - lastLockToast > 600000) {
        lastLockToast = now
        $.ui.toast('factory: another session is running the loop here; this one stays hands-off', { timeoutMs: 8000 })
      }
      return
    }
    const problem = await integrityProblem(snap)
    if (problem) return await pause($, state, problem)

    const { settings, blocked } = snap
    const items = effectiveItems(snap)
    const base = settings.baseBranch
    let hasMerged = false

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
          if (merged.exitCode !== 0) return await pause($, state, `gh failed: ${merged.stderr.trim().slice(0, 120)}`)
          let isMerged = false
          try {
            const rows = JSON.parse(merged.stdout) as { headRefName: string }[]
            isMerged = rows.some(r => r.headRefName.startsWith(`factory/${item.id.toLowerCase()}-`))
          } catch {
            // treated as not merged
          }
          if (isMerged) {
            state = {
              ...state,
              current: null,
              attempts: 0,
              doneThisRun: state.doneThisRun + 1,
              mergedIds: [...new Set([...state.mergedIds, item.id])],
            }
            // Make the in-memory view agree, so the next pick sees it as done.
            items.forEach(i => {
              if (i.id === item.id) i.status = 'done'
            })
            hasMerged = true
            $.ui.toast(`factory: ${item.id} merged`)
          } else why = `${item.id} is marked done but no merged PR from a factory/${item.id.toLowerCase()}-* branch exists.`
        }
        if (why) {
          if (branch.startsWith('factory/')) {
            const billing = await ciBillingProblem($)
            if (billing) return await pauseForBilling($, billing)
          }
          const attempts = state.attempts + 1
          if (attempts > settings.maxAttempts) {
            await $.fs.write(`${BLOCKED_DIR}/${item.id}.md`, `Blocked by the factory after ${settings.maxAttempts} attempts. Last problem: ${why}\n`)
            $.ui.toast(`factory: ${item.id} blocked after ${settings.maxAttempts} attempts`, { timeoutMs: 8000 })
            state = { ...state, current: null, attempts: 0 }
            blocked.add(item.id)
          } else {
            await writeState($, { ...state, attempts })
            await refreshStatus($)
            return submit($, nudgePrompt(item, settings, why))
          }
        }
      }
    }

    if (settings.maxItemsPerRun > 0 && state.doneThisRun >= settings.maxItemsPerRun) {
      await writeState($, state)
      return await pause($, state, `run limit of ${settings.maxItemsPerRun} items reached`)
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
            await writeState($, { ...state, current: null })
            return await pause($, state, `release v${version} was not created after 3 tries`)
          }
          await writeState($, { ...state, current: null, releaseAttempts: state.releaseAttempts + 1 })
          await refreshStatus($)
          if (hasMerged) await resetContext($, settings)
          return submit($, releasePrompt(version, settings))
        }
      }
      await writeState($, { ...state, autopilot: false, current: null, pausedReason: finished })
      await releaseLock($)
      $.ui.toast(`factory finished: ${finished} (${summarize(items, blocked)})`, { timeoutMs: 10000 })
      return await refreshStatus($)
    }
    state = { ...state, current: next.id, attempts: 0, pausedReason: null, review: null, reviewRounds: 0 }
    await writeState($, state)
    await refreshStatus($)
    if (hasMerged) await resetContext($, settings)
    submit($, workPrompt(next, settings, null))
  } finally {
    isAdvancing = false
  }
}

// If a turn-complete never arrived (a failed advance, a swallowed error) the
// loop would sit idle forever. Every few minutes: nothing running and the loop
// is on, so take the next step.
function startWatchdog($: Dollar): void {
  if (watchTimer) return
  watchTimer = $.clock.every(300000, () => {
    if (isFactoryTurn || isAdvancing) return
    void (async () => {
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
      return evaluateProtection(null, [], base)
    }
    return [`could not read ${base}'s protection (${err.trim().slice(0, 100)}); a private repo on a free plan cannot have it.`]
  }
  return evaluateProtection(parse(prot), parse(rules), base)
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
  const path = `${FACTORY_DIR}/.gitignore`
  const have = (await readText($, path)) ?? ''
  const lines = have.split(/\r?\n/).map(l => l.trim())
  const missing = IGNORED.filter(l => !lines.includes(l))
  if (missing.length > 0 || have === '') {
    const base = have === '' || have.endsWith('\n') ? have : `${have}\n`
    await $.fs.write(path, `${base}${missing.join('\n')}${missing.length > 0 ? '\n' : ''}`)
  }
}

const FACTORY_FILE_DENY = { deny: 'code-factory: .factory/state.json and .factory/lock.json are controlled by the person through /factory-* commands.' }
const isFactoryControlFile = (p: string): boolean => /(^|\/)\.factory\/(?:state|lock)\.json$/i.test(normalizePath(p))

export const register: Register = (on, _options) => {
  on('session.start', async ($, e, next) => {
    for (const [name, description, argumentHint] of [
      ['factory-design', 'Code factory: interview me and record the design, decisions and todo list', '[topic]'],
      ['factory-approve', 'Code factory: validate the design and todo list, then unlock the build loop', undefined],
      ['factory-start', 'Code factory: run the build loop on the todo list', undefined],
      ['factory-stop', 'Code factory: pause the build loop', undefined],
      ['factory-status', 'Code factory: show progress', undefined],
    ] as const) {
      await $.command.register({ name, description, ...(argumentHint ? { argumentHint } : {}) })
    }

    startWatchdog($)
    // A new session resumes the loop by itself when the repo is approved and running.
    const snap = await load($)
    if (snap.state.approved && snap.state.autopilot && e.isInteractive) {
      $.ui.toast('factory resuming the todo list (/factory-stop to pause)', { timeoutMs: 8000 })
      $.clock.after(3000, () => {
        void advance($)
      })
    }
    await refreshStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      watchTimer?.cancel()
      watchTimer = null
      isFactoryTurn = false
      isArmed = false
      await releaseLock($)
    }
    return next(e)
  })

  // ---- commands --------------------------------------------------------

  on('command.run', { command: 'factory-design' }, async ($, e) => {
    await ensureGitignore($)
    if ((await readText($, SETTINGS_PATH)) === null) {
      await $.fs.write(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`)
    }
    if ((await readText($, TODO_PATH)) === null) await $.fs.write(TODO_PATH, SKELETON_TODO)
    if ((await readText($, DESIGN_PATH)) === null) await $.fs.write(DESIGN_PATH, '# Design\n\n## Decisions\n')
    const topic = e.args.trim()
    $.clock.after(300, () => submit($, topic ? `${DESIGN_PROMPT}\n\nThe person wants to focus on: ${topic}` : DESIGN_PROMPT))
    return { text: 'Code factory: design interview starting. Answer the questions; run /factory-approve when the design is complete.' }
  })

  on('command.run', { command: 'factory-approve' }, async $ => {
    const snap = await load($)
    const raw = await readText($, TODO_PATH)
    const designText = await readText($, DESIGN_PATH)
    const protection = await branchProtectionWarnings($, snap.settings.baseBranch)
    const problems = [
      ...snap.settingsProblems,
      ...(snap.settings.requireBranchProtection ? protection : []),
      ...(raw === null ? [] : todoHeadingProblems(raw)),
      ...validateItems(snap.items, snap.settings.stopAfterVersion),
      ...(designText === null || !/^##\s+Decisions/im.test(designText) ? [`${DESIGN_PATH} needs a "## Decisions" section.`] : []),
      ...(await preflight($)),
    ]
    if (problems.length > 0) {
      return { text: `Not approved. Fix these first (/factory-design continues the interview):\n- ${problems.join('\n- ')}` }
    }
    let promotedCount = 0
    if (raw !== null) {
      const { text, ids } = promoteProposed(raw)
      promotedCount = ids.length
      if (ids.length > 0) await $.fs.write(TODO_PATH, text)
    }
    const after = await load($)
    const hash = decisionsHash(after.settings, after.items)
    await writeState($, {
      ...after.state,
      approved: true,
      approvedHash: hash,
      approvedDone: after.items.filter(i => i.status === 'done').map(i => i.id),
      pausedReason: after.state.autopilot ? null : 'approved, not started',
    })
    await refreshStatus($)
    const lines = after.items.filter(i => i.status === 'todo').map(i => `- ${i.id} [${i.type}] ${i.title}`)
    const warn = !snap.settings.requireBranchProtection && protection.length > 0
      ? `\nWarnings (set requireBranchProtection to make them blocking):\n- ${protection.join('\n- ')}\n`
      : ''
    return {
      text: `Approved. ${warn}${promotedCount > 0 ? `${promotedCount} proposed item(s) promoted to todo.\n` : ''}Queue (in order):\n${lines.join('\n') || '(empty)'}\nRun /factory-start to begin.`,
    }
  })

  on('command.run', { command: 'factory-start' }, async $ => {
    const snap = await load($)
    const problem = await integrityProblem(snap)
    if (problem) return { text: `Cannot start: ${problem}.` }
    if (!pickNext(effectiveItems(snap), snap.blocked, snap.settings.stopAfterVersion) && !snap.state.current) {
      return { text: `Nothing to do: ${summarize(effectiveItems(snap), snap.blocked)}.` }
    }
    if (!(await acquireLock($))) return { text: 'Cannot start: another session is running the factory in this repo (its lock was refreshed in the last two minutes).' }
    await writeState($, { ...snap.state, autopilot: true, pausedReason: null, doneThisRun: 0, releaseAttempts: 0, attempts: snap.state.current ? snap.state.attempts : 0 })
    startWatchdog($)
    await refreshStatus($)
    $.clock.after(300, () => {
      void advance($)
    })
    return { text: 'Factory running. Esc or typing your own prompt pauses it; /factory-stop stops it; new sessions in this repo resume it.' }
  })

  on('command.run', { command: 'factory-stop' }, async $ => {
    const state = await readState($)
    await writeState($, { ...state, autopilot: false, pausedReason: 'stopped by you' })
    await releaseLock($)
    await refreshStatus($)
    return { text: 'Factory paused. The current turn finishes; nothing new starts. /factory-start resumes.' }
  })

  on('command.run', { command: 'factory-status' }, async $ => {
    const snap = await load($)
    const items = effectiveItems(snap)
    const rows = items.map(i => {
      const tag = snap.blocked.has(i.id) ? 'blocked' : i.status
      const v = i.version ? ` v${i.version}` : ''
      const out = inScope(i, snap.settings.stopAfterVersion) ? '' : ' (after stop version)'
      return `- ${i.id} [${i.type}]${v} ${tag}${snap.state.current === i.id ? ' (current)' : ''}${out}: ${i.title}`
    })
    const s = snap.state
    return {
      text: `Factory: ${s.approved ? (s.autopilot ? 'running' : `paused (${s.pausedReason ?? 'stopped'})`) : 'design not approved'}${snap.settings.stopAfterVersion ? `; stops after version ${snap.settings.stopAfterVersion}` : ''}\n${summarize(items, snap.blocked)}\n${rows.join('\n')}${snap.blocked.size > 0 ? `\nBlocked items have notes in ${BLOCKED_DIR}/; delete a note to unblock.` : ''}`,
    }
  })

  // ---- the loop --------------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !isFactoryTurn) return out
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
    $.clock.after(800, () => {
      void advance($)
    })
    return out
  })

  // The person taking the wheel pauses the loop and takes the guards off.
  on('prompt.submit', async ($, e, next) => {
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind) && !e.text.trimStart().startsWith('/')) {
      const state = await readState($)
      if (state.autopilot) await pause($, state, 'you sent a prompt; /factory-start resumes')
      isFactoryTurn = false
      isArmed = false
    }
    return next(e)
  })

  // ---- guards ----------------------------------------------------------

  on('tool.call', { tool: 'Edit' }, ($, e, next) => (isFactoryControlFile(e.file_path) ? FACTORY_FILE_DENY : next(e)))
  on('tool.call', { tool: 'Write' }, ($, e, next) => (isFactoryControlFile(e.file_path) ? FACTORY_FILE_DENY : next(e)))

  // The review agent's verdict is read from its answer and kept in the factory's
  // state, but only for the exact prompt the factory handed the model, spawned
  // by the main loop.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!e.prompt.includes(REVIEW_TAG)) return next(e)
    const snap = await load($)
    const isLive = snap.state.approved && !(await lockedByOther($)) && (snap.state.autopilot || isArmed)
    if (!isLive) return next(e)
    const item = snap.items.find(i => i.id === snap.state.current)
    if (e.agentId !== undefined || !item) {
      return { deny: 'code-factory: the review agent is started once, by the main loop, for the current item.' }
    }
    if (normalizeText(e.prompt) !== normalizeText(reviewAgentPrompt(snap.settings, branchFor(item)))) {
      return { deny: 'code-factory: pass the review prompt from the work item exactly as written, without changes.' }
    }
    if (snap.state.reviewRounds >= snap.settings.maxReviewRounds) {
      return { deny: `code-factory: ${snap.settings.maxReviewRounds} review rounds are used up for ${item.id}; write .factory/blocked/${item.id}.md and stop.` }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const text = agentText(ran.result) || (typeof ran.text === 'string' ? ran.text : '')
    if (/FACTORY-REVIEW:\s*unavailable/i.test(text)) {
      await pause($, await readState($), `${snap.settings.reviewCommand} is not available to the review agent`)
      return ran
    }
    const mark = parseReviewMarker(text)
    if (!mark) return ran
    const fresh = await readState($)
    const isClean = mark.danger === 0 && mark.medium === 0
    const rounds = isClean ? 0 : fresh.reviewRounds + 1
    await writeState($, { ...fresh, review: mark, reviewRounds: rounds })
    if (!isClean && rounds >= snap.settings.maxReviewRounds) {
      await $.fs.write(`${BLOCKED_DIR}/${item.id}.md`, `Review still found danger=${mark.danger} medium=${mark.medium} after ${rounds} rounds.\n`)
      $.ui.toast(`factory: ${item.id} blocked, review never came back clean`, { timeoutMs: 8000 })
    }
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const snap = await load($)
    const base = snap.settings.baseBranch
    const branch = await branchNow($)
    const f = classifyBash(e.command, base, branch)
    if (f.touchesFactoryState) {
      return { deny: 'code-factory: the factory state file is controlled by the person through /factory-* commands.' }
    }
    const isLive = snap.state.approved && !(await lockedByOther($)) && (snap.state.autopilot || isArmed)
    if (!isLive) return next(e)

    if (f.apiPrWrite) {
      return { deny: 'code-factory: do not change branches, PRs or contents through `gh api`; use git and `gh pr create` / `gh pr merge` so the checks run.' }
    }

    // CI look-ups: a billing failure stops the whole loop.
    if (f.isCiLookup) {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      const out = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
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
      return { deny: `code-factory: paused, ${problem}.` }
    }
    const { settings } = snap
    const tail = (r: Run) => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n')
    const names = (r: Run) => r.stdout.split('\n').filter(Boolean)

    if (f.isForcePush) return { deny: 'code-factory: force-push is not allowed.' }
    if (f.isPush && (f.pushNamesBase || f.pushesBase || branch === base)) {
      return { deny: `code-factory: never push to ${base}; push the factory/* branch and open a PR.` }
    }
    if (f.isCommit && f.commitsOnBase) {
      const item = snap.items.find(i => i.id === snap.state.current)
      return { deny: `code-factory: do not commit on ${base}. Create the branch first${item ? `: git checkout -b ${branchFor(item)}` : ''}.` }
    }
    if ((f.isPrCreate || f.isPrMerge) && /(?:^|\s)(?:-R|--repo)(?:\s|=)/.test(e.command)) {
      return { deny: 'code-factory: do not target another repository with -R/--repo.' }
    }

    if (f.isPrCreate) {
      if (!branch.startsWith('factory/')) return { deny: `code-factory: open PRs from a factory/* branch (current: "${branch}").` }
      const item = snap.items.find(i => i.id === snap.state.current)

      // Cheap checks first, then the expensive ones.
      if (settings.requireTestChanges && item?.type !== 'docs' && item?.type !== 'chore') {
        let diff = await run($, ['git', 'diff', '--name-only', `origin/${base}...HEAD`])
        if (diff.exitCode !== 0) diff = await run($, ['git', 'diff', '--name-only', `${base}...HEAD`])
        if (diff.exitCode === 0 && !hasTestChanges(names(diff))) {
          return { deny: 'code-factory: this branch changes no test files. Add tests for the new behavior or the regression test for the bug.' }
        }
      }
      if (!settings.allowTestRemoval) {
        let full = await run($, ['git', 'diff', '-U0', '--no-color', `origin/${base}...HEAD`])
        if (full.exitCode !== 0) full = await run($, ['git', 'diff', '-U0', '--no-color', `${base}...HEAD`])
        const weak = full.exitCode === 0 ? testWeakening(full.stdout) : []
        if (weak.length > 0) {
          return { deny: `code-factory: this branch weakens the tests (${weak.join('; ')}). Restore them; settings.allowTestRemoval needs the person's approval.` }
        }
      }
      if (settings.requireReview) {
        const head = await headSha($)
        if (!isReviewClean(snap.state.review, head)) {
          const last = snap.state.review
          return {
            deny: `code-factory: no clean independent review for HEAD ${head.slice(0, 7)}${last ? ` (last review: danger=${last.danger} medium=${last.medium} at ${last.sha.slice(0, 7)})` : ''}. Run step 6: spawn the fresh review agent with the exact prompt from the work item and do not commit after it.`,
          }
        }
      }
      if (settings.buildCmd.length > 0) {
        const built = await run($, settings.buildCmd, settings.testTimeoutMs)
        if (built.exitCode !== 0) return { deny: `code-factory: the build fails (${settings.buildCmd.join(' ')}, exit ${built.exitCode}). Fix it first.\n${tail(built)}` }
      }
      const tests = await run($, settings.testCmd, settings.testTimeoutMs)
      if (tests.exitCode !== 0) {
        return { deny: `code-factory: the test suite fails (${settings.testCmd.join(' ')}, exit ${tests.exitCode}). Fix it before opening the PR.\n${tail(tests)}` }
      }
      if (settings.e2eCmd.length > 0 && settings.e2eFor.includes(item?.type ?? 'feature')) {
        const e2e = await run($, settings.e2eCmd, settings.testTimeoutMs)
        if (e2e.exitCode !== 0) return { deny: `code-factory: the end-to-end tests fail (${settings.e2eCmd.join(' ')}, exit ${e2e.exitCode}). The change does not work yet.\n${tail(e2e)}` }
      }
    }

    if (f.isPrMerge) {
      if (f.hasAdmin) return { deny: 'code-factory: --admin merges are not allowed.' }
      if (f.hasAuto) return { deny: 'code-factory: --auto merges skip the check this mod makes; wait for CI with `gh pr checks --watch`, then merge.' }
      const sel = f.prSelector ? [f.prSelector] : []
      const view = await run($, ['gh', 'pr', 'view', ...sel, '--json', 'state,mergeable,headRefName,headRefOid,statusCheckRollup'])
      if (view.exitCode !== 0) return { deny: `code-factory: could not read the PR (${view.stderr.trim().slice(0, 160)}).` }
      let pr: { state: string; mergeable: string; headRefName: string; headRefOid: string; statusCheckRollup: unknown[] }
      try {
        pr = JSON.parse(view.stdout) as typeof pr
      } catch {
        return { deny: 'code-factory: could not parse the PR status.' }
      }
      if (!pr.headRefName.startsWith('factory/')) return { deny: 'code-factory: it only merges factory/* PRs.' }
      if (pr.state !== 'OPEN') return { deny: `code-factory: the PR is ${pr.state}.` }
      if (pr.mergeable === 'CONFLICTING') return { deny: 'code-factory: the PR has merge conflicts; rebase or merge the base branch and push.' }
      const verdict = checksVerdict((pr.statusCheckRollup ?? []) as Parameters<typeof checksVerdict>[0], settings.allowNoCI)
      if (!verdict.ok) {
        if (/FAILURE|CANCELLED|STARTUP|ACTION_REQUIRED/.test(verdict.reason)) {
          const billing = await ciBillingProblem($)
          if (billing) {
            await pauseForBilling($, billing)
            return { deny: 'code-factory: CI failed for a GitHub billing/spending-limit reason; the loop is paused. Stop and end your turn.' }
          }
        }
        return { deny: `code-factory: ${verdict.reason}. Wait with \`gh pr checks --watch\` and fix failures.` }
      }
      // What gets merged must be exactly what was reviewed and what CI ran on.
      if (settings.requireReview && !isReviewClean(snap.state.review, pr.headRefOid ?? '')) {
        return { deny: `code-factory: the PR head ${(pr.headRefOid ?? '').slice(0, 7)} is not the commit the clean review covered (${snap.state.review ? snap.state.review.sha.slice(0, 7) : 'none'}). Re-run the review agent on the final commit.` }
      }
      if (!settings.allowTestRemoval) {
        const diff = await run($, ['gh', 'pr', 'diff', ...sel, '--color', 'never'], 60000)
        if (diff.exitCode === 0) {
          const weak = testWeakening(diff.stdout)
          if (weak.length > 0) return { deny: `code-factory: the PR weakens the tests (${weak.join('; ')}).` }
        }
      }
    }
    return next(e)
  })
}
