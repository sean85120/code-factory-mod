// Pure logic of the code factory: parsing, validation, guards and prompts.
// No engine calls here, so tests can exercise it directly.

import type { FactoryView, Mark, Stage, ViewRow } from '../types'

export type { FactoryView, Mark, Stage, ViewRow }

export type ItemType = 'feature' | 'bug' | 'chore' | 'docs'
export type ItemStatus = 'proposed' | 'todo' | 'done'

export type Item = {
  id: string
  type: ItemType
  title: string
  status: ItemStatus
  how: string
  accept: string
  tests: string
  depends: string[]
  version: string
  statusText: string
}

export type Settings = {
  baseBranch: string
  testCmd: string[]
  testTimeoutMs: number
  mergeMethod: 'squash' | 'merge' | 'rebase'
  maxAttempts: number
  maxItemsPerRun: number
  allowNoCI: boolean
  requireTestChanges: boolean
  buildCmd: string[]
  e2eCmd: string[]
  e2eFor: ItemType[]
  requireReview: boolean
  reviewCommand: string
  maxReviewRounds: number
  contextReset: 'clear' | 'compact' | 'none'
  stopAfterVersion: string | null
  tagRelease: boolean
  requireBranchProtection: boolean
  allowTestRemoval: boolean
  reviewTimeoutMs: number
  budgetUsd: number
  askNextPhase: boolean
}

export type ReviewMark = { sha: string; danger: number; medium: number }

export type FactoryState = {
  approved: boolean
  approvedHash: string
  autopilot: boolean
  current: string | null
  attempts: number
  doneThisRun: number
  pausedReason: string | null
  review: ReviewMark | null
  reviewRounds: number
  reviewAgentId: string | null
  reviewAgentAt: number
  reviewWaitMs: number
  releasedVersion: string | null
  releaseAttempts: number
  mergedIds: string[]
  approvedDone: string[]
  events: FactoryEvent[]
  roadmapAsked: boolean
  unreadable?: boolean
}

export const FACTORY_DIR = '.factory'
export const TODO_PATH = `${FACTORY_DIR}/todo.md`
export const DESIGN_PATH = `${FACTORY_DIR}/design.md`
export const SETTINGS_PATH = `${FACTORY_DIR}/settings.json`
export const STATE_PATH = `${FACTORY_DIR}/state.json`
export const BLOCKED_DIR = `${FACTORY_DIR}/blocked`
export const LOCK_PATH = `${FACTORY_DIR}/lock.json`
export const LOCK_TTL_MS = 120000

export const DEFAULT_SETTINGS: Settings = {
  baseBranch: 'main',
  testCmd: [],
  testTimeoutMs: 600000,
  mergeMethod: 'squash',
  maxAttempts: 4,
  maxItemsPerRun: 0,
  allowNoCI: false,
  requireTestChanges: true,
  buildCmd: [],
  e2eCmd: [],
  e2eFor: ['feature', 'bug'],
  requireReview: true,
  reviewCommand: '/review-fix',
  maxReviewRounds: 5,
  contextReset: 'clear',
  stopAfterVersion: null,
  tagRelease: false,
  requireBranchProtection: false,
  allowTestRemoval: false,
  reviewTimeoutMs: 1800000,
  budgetUsd: 0,
  askNextPhase: true,
}

export const DEFAULT_STATE: FactoryState = {
  approved: false,
  approvedHash: '',
  autopilot: false,
  current: null,
  attempts: 0,
  doneThisRun: 0,
  pausedReason: null,
  review: null,
  reviewRounds: 0,
  reviewAgentId: null,
  reviewAgentAt: 0,
  reviewWaitMs: 0,
  releasedVersion: null,
  releaseAttempts: 0,
  mergedIds: [],
  approvedDone: [],
  events: [],
  roadmapAsked: false,
}

// ---------------------------------------------------------------- todo.md

const HEADING = /^##\s+([A-Za-z]+-\d+)\s+\[(feature|bug|chore|docs)\]\s+(.+?)\s*$/i
const FIELD = /^-\s+(status|how|accept|tests|depends|version):\s*(.*)$/

// Lines with HTML comments and fenced code blanked out, so examples in a
// template are never read as items. The line count stays the same.
export function stripNoise(text: string): string[] {
  const out: string[] = []
  let inComment = false
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (inFence) {
      if (/^\s*```/.test(line)) inFence = false
      out.push('')
      continue
    }
    if (!inComment && /^\s*```/.test(line)) {
      inFence = true
      out.push('')
      continue
    }
    let res = ''
    let i = 0
    while (i < line.length) {
      if (inComment) {
        const j = line.indexOf('-->', i)
        if (j < 0) i = line.length
        else {
          inComment = false
          i = j + 3
        }
      } else {
        const j = line.indexOf('<!--', i)
        if (j < 0) {
          res += line.slice(i)
          i = line.length
        } else {
          res += line.slice(i, j)
          inComment = true
          i = j + 4
        }
      }
    }
    out.push(res)
  }
  return out
}

export function parseTodo(text: string): Item[] {
  const items: Item[] = []
  let cur: Item | null = null
  let lastField: 'how' | 'accept' | 'tests' | null = null

  for (const raw of stripNoise(text)) {
    if (/^##\s/.test(raw)) {
      const h = HEADING.exec(raw)
      cur = h
        ? {
            id: h[1]!.toUpperCase(),
            type: h[2]!.toLowerCase() as ItemType,
            title: h[3]!,
            status: 'proposed',
            how: '',
            accept: '',
            tests: '',
            depends: [],
            version: '',
            statusText: '',
          }
        : null
      if (cur) items.push(cur)
      lastField = null
      continue
    }
    if (!cur) continue
    const f = FIELD.exec(raw)
    if (f) {
      const key = f[1]!
      const val = f[2]!.trim()
      lastField = null
      if (key === 'status') {
        cur.statusText = val
        if (val === 'todo' || val === 'done' || val === 'proposed') cur.status = val
      } else if (key === 'version') {
        cur.version = val.replace(/^v/i, '')
      } else if (key === 'depends') {
        cur.depends = (val.match(/[A-Za-z]+-\d+/g) ?? []).map(x => x.toUpperCase())
      } else {
        cur[key as 'how' | 'accept' | 'tests'] = val
        lastField = key as 'how' | 'accept' | 'tests'
      }
      continue
    }
    if (lastField && /^\s{2,}\S/.test(raw)) {
      cur[lastField] = `${cur[lastField]} ${raw.trim()}`.trim()
    }
  }
  return items
}

// `##` lines that are not a valid item heading: they would otherwise be
// swallowed silently and their fields credited to the previous item.
export function todoHeadingProblems(text: string): string[] {
  const problems: string[] = []
  stripNoise(text).forEach((line, i) => {
    if (/^##\s/.test(line) && !HEADING.test(line)) {
      problems.push(`todo.md line ${i + 1}: "${line.trim().slice(0, 60)}" is not "## T-001 [feature|bug|chore|docs] Title".`)
    }
  })
  return problems
}

// Turns `proposed` into `todo`, block by block, in the raw text.
export function promoteProposed(raw: string): { text: string; ids: string[] } {
  const live = stripNoise(raw)
  const lines = raw.split(/\r?\n/)
  const ids: string[] = []
  let cur: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = live[i] ?? ''
    if (l.trim() === '') continue
    const h = HEADING.exec(l)
    if (/^##\s/.test(l)) cur = h ? h[1]!.toUpperCase() : null
    else if (cur) {
      const f = FIELD.exec(l)
      if (f && f[1] === 'status' && f[2]!.trim() === 'proposed') {
        lines[i] = lines[i]!.replace(/proposed/, 'todo')
        ids.push(cur)
      }
    }
  }
  return { text: lines.join('\n'), ids }
}

export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  return 0
}

const PLACEHOLDER = /^(tbd|todo|\?+|n\/a|none|\.\.\.|-)$/i

function isFilled(v: string, min: number): boolean {
  const t = v.trim()
  return t.length >= min && !PLACEHOLDER.test(t)
}

export function validateItems(items: Item[], stopAfterVersion: string | null = null): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  if (items.length === 0) problems.push('todo.md has no items (expected `## T-001 [feature] Title` headings).')
  for (const it of items) {
    if (ids.has(it.id)) problems.push(`${it.id}: duplicate id.`)
    ids.add(it.id)
  }
  for (const it of items) {
    if (!isFilled(it.how, 15)) {
      problems.push(`${it.id}: \`how:\` is missing or a placeholder (name the tool/algorithm/workaround and why).`)
    }
    if (!isFilled(it.accept, 15)) problems.push(`${it.id}: \`accept:\` (acceptance criteria) is missing or too short.`)
    if (it.type !== 'docs' && !isFilled(it.tests, 10)) {
      problems.push(`${it.id}: \`tests:\` is missing (how will it be verified?).`)
    }
    for (const d of it.depends) {
      if (!ids.has(d)) problems.push(`${it.id}: depends on unknown item ${d}.`)
    }
    if (it.statusText === '') problems.push(`${it.id}: missing a \`- status:\` line (proposed, todo or done).`)
    else if (!['proposed', 'todo', 'done'].includes(it.statusText)) {
      problems.push(`${it.id}: status "${it.statusText}" must be proposed, todo or done.`)
    }
    if (it.depends.includes(it.id)) problems.push(`${it.id}: depends on itself.`)
    if (it.version && !parseVersion(it.version)) problems.push(`${it.id}: \`version:\` "${it.version}" is not like 0.2 or 1.0.0.`)
    if (stopAfterVersion && it.status !== 'done' && !it.version) {
      problems.push(`${it.id}: needs a \`version:\` because settings.stopAfterVersion is ${stopAfterVersion}.`)
    }
  }
  const byId = new Map(items.map(i => [i.id, i]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      problems.push(`dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}.`)
      return
    }
    state.set(id, 1)
    for (const d of byId.get(id)?.depends ?? []) if (d !== id && byId.has(d)) visit(d, [...path, id])
    state.set(id, 2)
  }
  for (const it of items) visit(it.id, [])
  return problems
}

export function parseSettings(text: string | null): { settings: Settings; problems: string[] } {
  const problems: string[] = []
  let raw: Record<string, unknown> = {}
  if (text === null) {
    problems.push(`${SETTINGS_PATH} is missing. The design files must be committed to the base branch (they vanish when it is checked out while they exist only on a factory/* branch): restore them with \`git checkout <factory branch> -- .factory\`, commit and push to the base branch, or run /factory-design.`)
  } else {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
      else problems.push(`${SETTINGS_PATH} must be a JSON object.`)
    } catch {
      problems.push(`${SETTINGS_PATH} is not valid JSON.`)
    }
  }
  const s: Settings = { ...DEFAULT_SETTINGS }
  if (typeof raw.baseBranch === 'string' && raw.baseBranch.trim()) s.baseBranch = raw.baseBranch.trim()
  if (!isSafeBranchName(s.baseBranch)) problems.push(`settings.json \`baseBranch\` "${cleanText(s.baseBranch).slice(0, 60)}" is not a plain branch name (no whitespace, control or invisible characters, quotes, backtick, backslash, $, ~ ^ : ? * [, .., @{ or //; not starting with - + . or /, not ending with / . or .lock).`)
  if (Array.isArray(raw.testCmd) && raw.testCmd.every(x => typeof x === 'string')) {
    s.testCmd = raw.testCmd as string[]
  }
  if (s.testCmd.length === 0) {
    problems.push('settings.json `testCmd` must be a non-empty argv array, e.g. ["npm","test"] or ["bash","-lc","pytest -q"].')
  }
  if (typeof raw.testTimeoutMs === 'number' && raw.testTimeoutMs > 0) {
    s.testTimeoutMs = Math.min(600000, Math.floor(raw.testTimeoutMs))
  }
  if (raw.mergeMethod === 'squash' || raw.mergeMethod === 'merge' || raw.mergeMethod === 'rebase') {
    s.mergeMethod = raw.mergeMethod
  }
  if (typeof raw.maxAttempts === 'number' && raw.maxAttempts >= 1) s.maxAttempts = Math.floor(raw.maxAttempts)
  if (typeof raw.maxItemsPerRun === 'number' && raw.maxItemsPerRun >= 0) {
    s.maxItemsPerRun = Math.floor(raw.maxItemsPerRun)
  }
  const argv = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null
  s.buildCmd = argv(raw.buildCmd) ?? []
  s.e2eCmd = argv(raw.e2eCmd) ?? []
  for (const k of ['buildCmd', 'e2eCmd'] as const) {
    if (raw[k] !== undefined && raw[k] !== null && argv(raw[k]) === null) problems.push(`settings.json \`${k}\` must be an argv array of strings, e.g. ["npm","run","build"], or empty.`)
  }
  const itemTypes = ['feature', 'bug', 'chore', 'docs']
  if (Array.isArray(raw.e2eFor)) {
    s.e2eFor = raw.e2eFor.filter((x): x is ItemType => itemTypes.includes(String(x)))
    if (s.e2eFor.length !== raw.e2eFor.length) problems.push('settings.json `e2eFor` may only list feature, bug, chore or docs.')
  } else if (raw.e2eFor !== undefined && raw.e2eFor !== null) problems.push('settings.json `e2eFor` must be an array of feature, bug, chore or docs.')
  if (typeof raw.requireReview === 'boolean') s.requireReview = raw.requireReview
  if (typeof raw.reviewCommand === 'string' && raw.reviewCommand.trim()) s.reviewCommand = raw.reviewCommand.trim()
  if (typeof raw.maxReviewRounds === 'number' && raw.maxReviewRounds >= 1) s.maxReviewRounds = Math.floor(raw.maxReviewRounds)
  if (raw.contextReset === 'clear' || raw.contextReset === 'compact' || raw.contextReset === 'none') {
    s.contextReset = raw.contextReset
  }
  if (typeof raw.tagRelease === 'boolean') s.tagRelease = raw.tagRelease
  if (typeof raw.requireBranchProtection === 'boolean') s.requireBranchProtection = raw.requireBranchProtection
  if (typeof raw.allowTestRemoval === 'boolean') s.allowTestRemoval = raw.allowTestRemoval
  if (typeof raw.reviewTimeoutMs === 'number' && raw.reviewTimeoutMs >= 60000) s.reviewTimeoutMs = Math.min(Math.floor(raw.reviewTimeoutMs), 21600000)
  if (raw.stopAfterVersion !== undefined && raw.stopAfterVersion !== null) {
    const v = String(raw.stopAfterVersion).replace(/^v/i, '')
    if (parseVersion(v)) s.stopAfterVersion = v
    else problems.push('settings.json `stopAfterVersion` must look like 0.3 or 1.0.0 (or be null).')
  }
  if (typeof raw.allowNoCI === 'boolean') s.allowNoCI = raw.allowNoCI
  if (typeof raw.requireTestChanges === 'boolean') s.requireTestChanges = raw.requireTestChanges
  if (raw.budgetUsd !== undefined && raw.budgetUsd !== null) {
    if (typeof raw.budgetUsd === 'number' && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 0) s.budgetUsd = raw.budgetUsd
    else problems.push('settings.json `budgetUsd` must be a number of US dollars, 0 for no budget.')
  }
  if (typeof raw.askNextPhase === 'boolean') s.askNextPhase = raw.askNextPhase
  return { settings: s, problems }
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// What the person approved: the settings and every item's decisions. Statuses
// are left out so the loop can mark work done; `proposed` items are left out
// until the person promotes them with /factory-approve.
export function decisionsHash(settings: Settings, items: Item[]): string {
  const frozen = items
    .filter(i => i.status !== 'proposed')
    .map(i => [i.id, i.type, i.title, i.how, i.accept, i.tests, i.depends.join(','), i.version].join('|'))
  const { reviewTimeoutMs: _timeout, budgetUsd, askNextPhase, ...hashed } = settings
  const added = { ...(budgetUsd !== DEFAULT_SETTINGS.budgetUsd ? { budgetUsd } : {}), ...(askNextPhase !== DEFAULT_SETTINGS.askNextPhase ? { askNextPhase } : {}) }
  return fnv1a(JSON.stringify(Object.keys(added).length > 0 ? [hashed, frozen, added] : [hashed, frozen]))
}

export function inScope(item: Item, stopAfterVersion: string | null): boolean {
  return !stopAfterVersion || !item.version || compareVersions(item.version, stopAfterVersion) <= 0
}

export function pickNext(
  items: Item[],
  blocked: ReadonlySet<string>,
  stopAfterVersion: string | null = null,
): Item | undefined {
  const done = new Set(items.filter(i => i.status === 'done').map(i => i.id))
  return items.find(
    i =>
      i.status === 'todo' &&
      !blocked.has(i.id) &&
      inScope(i, stopAfterVersion) &&
      i.depends.every(d => done.has(d)),
  )
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || 'work'
}

export function branchFor(item: Pick<Item, 'id' | 'title'>): string {
  return `factory/${item.id.toLowerCase()}-${slugify(item.title)}`
}

export function summarize(items: Item[], blocked: ReadonlySet<string>): string {
  const done = items.filter(i => i.status === 'done').length
  const todo = items.filter(i => i.status === 'todo' && !blocked.has(i.id)).length
  const proposed = items.filter(i => i.status === 'proposed').length
  return `${done} done, ${todo} to do, ${blocked.size} blocked, ${proposed} proposed`
}

// ------------------------------------------------------------ shell guards

export type BashFacts = {
  isPush: boolean
  isForcePush: boolean
  pushNamesBase: boolean
  pushesBase: boolean
  isCommit: boolean
  commitsOnBase: boolean
  isPrCreate: boolean
  isPrMerge: boolean
  hasAdmin: boolean
  hasAuto: boolean
  prSelector: string | null
  apiPrWrite: boolean
  isCiLookup: boolean
  touchesFactoryState: boolean
  repoFlag: boolean
}

const REPO_FLAG_VALUE_FLAGS = new Set(['--title', '--body', '--body-file', '--base', '--head', '--label', '--assignee', '--reviewer', '--milestone', '--project', '--template', '--subject', '--author-email', '--match-head-commit', '-t', '-b', '-F', '-B', '-H', '-l', '-a', '-p', '-T', '-A'])

function isRepoFlag(tok: string): boolean {
  if (tok === '--repo' || tok.startsWith('--repo=')) return true
  if (tok.startsWith('--') || !/^-[A-Za-z]/.test(tok)) return false
  for (const ch of tok.slice(1)) {
    if (ch === 'R') return true
    if ('tbFBHlapTA'.includes(ch)) return false
  }
  return false
}

function hasRepoFlag(t: string[]): boolean {
  for (let k = 0; k < t.length; k++) {
    if (REPO_FLAG_VALUE_FLAGS.has(t[k]!)) k++
    else if (isRepoFlag(t[k]!)) return true
  }
  return false
}

const SEVERAL_MERGES = '<several merges in one command>'

const unquote = (t: string): string => {
  let out = ''
  let q = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (!q && (c === '"' || c === "'")) q = c
    else if (c === q) q = ''
    else if (q === '"' && c === '\\' && i + 1 < t.length && '"\\$`'.includes(t[i + 1]!)) out += t[++i]!
    else out += c
  }
  return out
}

// Splits a shell line into simple commands of tokens: on ; && || | & and
// newlines outside quotes, skipping heredoc bodies and # comments, joining
// backslash-newline continuations. Quotes carry across lines (a "$(cat <<'EOF'
// ... EOF\n)" message); if a quote is still open at the end the carry has
// desynchronised, so the lines are read one by one instead. Best effort, not a
// parser.
const HEREDOC_START = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][^\s;|&()<>'"]*))/
const IN_ARITHMETIC = /\(\([^)]*$/

function scanCommands(command: string, carry: boolean, heredocOn = true): { commands: string[][]; open: boolean; pending: boolean; substs: string[] } {
  const commands: string[][] = []
  const heredocs: string[] = []
  let cur: string[] = []
  let tok = ''
  let plain = ''
  const substs: string[] = []
  let quote = ''
  let inSubst = false
  let substDepth = 0
  let innerQ = ''
  const pushTok = () => {
    if (tok !== '') cur.push(unquote(tok))
    if (plain.includes('$(') || plain.includes('`')) substs.push(plain)
    tok = ''
    plain = ''
  }
  const pushCmd = () => {
    pushTok()
    if (cur.length > 0) commands.push(cur)
    cur = []
  }
  const raw = command.split(/\r?\n/)
  for (let li = 0; li < raw.length; li++) {
    let line = raw[li]!
    if (heredocs.length > 0) {
      if (line.trim() === heredocs[0]) heredocs.shift()
      continue
    }
    if (!carry) {
      cur = []
      tok = ''
      plain = ''
      quote = ''
      inSubst = false
      substDepth = 0
      innerQ = ''
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote) {
        if (c === '\\' && quote === '"' && !(substDepth > 0 && innerQ === "'")) {
          if (i + 1 < line.length) {
            tok += c + line[i + 1]!
            plain += line[i + 1] === '`' || line[i + 1] === '$' ? '  ' : c + line[i + 1]!
            i++
          } else if (li + 1 < raw.length) {
            line = line.slice(0, i) + raw[++li]!
            i--
          }
          continue
        }
        if (quote === '"' && (c === '`' || (c === '$' && line[i + 1] === '('))) inSubst = true
        if (heredocOn && quote === '"' && inSubst && c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
          const m = HEREDOC_START.exec(line.slice(i))
          if (m && !IN_ARITHMETIC.test(line.slice(0, i))) heredocs.push(m[1] ?? m[2] ?? m[3]!)
        }
        if (quote === '"') {
          if (substDepth > 0) {
            if (innerQ) {
              if (c === innerQ) innerQ = ''
            } else if (c === '#' && (i === 0 || /[\s;|&(]/.test(line[i - 1]!))) {
              tok += line.slice(i)
              plain += line.slice(i)
              i = line.length
              continue
            } else if (c === '"' || c === "'") innerQ = c
            else if (c === '(') substDepth++
            else if (c === ')') substDepth--
            tok += c
            plain += c
            continue
          }
          if (c === '$' && line[i + 1] === '(') {
            substDepth = 1
            tok += '$('
            plain += '$('
            i++
            continue
          }
        }
        tok += c
        if (quote === '"') plain += c
        if (c === quote) {
          quote = ''
          inSubst = false
        }
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        inSubst = false
        tok += c
        if (c === '"') plain += c
      } else if (c === '\\') {
        if (i + 1 < line.length) {
          tok += line[i + 1]!
          plain += line[i + 1]!
          i++
        } else if (li + 1 < raw.length) {
          line = line.slice(0, i) + raw[++li]!
          i--
        }
      } else if (c === '#' && tok === '' && (i === 0 || /[\s;|&()]/.test(line[i - 1]!))) break
      else if (c === '<' && line[i + 1] === '<') {
        if (line[i + 2] === '<') {
          tok += '<<<'
          i += 2
        } else {
          const m = heredocOn ? HEREDOC_START.exec(line.slice(i)) : null
          if (m && !IN_ARITHMETIC.test(line.slice(0, i))) heredocs.push(m[1] ?? m[2] ?? m[3]!)
          tok += '<<'
          i++
        }
      } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}' || c === '`') {
        pushCmd()
      } else if (c === ' ' || c === '\t') pushTok()
      else {
        tok += c
        plain += c
      }
    }
    if (quote && carry) {
      tok += '\n'
      if (quote === '"') plain += '\n'
    }
    else pushCmd()
  }
  pushCmd()
  return { commands, open: quote !== '', pending: heredocs.length > 0, substs }
}

function substitutionBodies(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')') depth--
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j))
      i = j - 1
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      out.push(text.slice(i + 1, end === -1 ? text.length : end))
      if (end === -1) break
      i = end
    }
  }
  return out
}

function splitCommandsAt(command: string, depth: number): string[][] {
  let r = scanCommands(command, true)
  if (r.open || r.pending) r = scanCommands(command, false)
  if (r.pending) r = scanCommands(command, false, false)
  if (depth >= 8) return r.commands
  const inner: string[][] = []
  for (const t of r.substs) {
    for (const body of substitutionBodies(t)) inner.push(...splitCommandsAt(body, depth + 1))
  }
  return [...r.commands, ...inner]
}

export function splitCommands(command: string): string[][] {
  return splitCommandsAt(command, 0)
}

const PREFIXES = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec', 'builtin', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])

function stripPrefix(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || PREFIXES.has(tokens[i]!))) i++
  return tokens.slice(i)
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])
const API_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--jq', '-q', '--template', '-t', '--input', '--cache', '--hostname', '-p', '--preview'])

export function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (abs ? '/' : '') + out.join('/')
}

export function classifyBash(command: string, base: string, branch = ''): BashFacts {
  const facts: BashFacts = {
    isPush: false,
    isForcePush: false,
    pushNamesBase: false,
    pushesBase: false,
    isCommit: false,
    commitsOnBase: false,
    isPrCreate: false,
    isPrMerge: false,
    hasAdmin: false,
    hasAuto: false,
    prSelector: null,
    apiPrWrite: false,
    isCiLookup: false,
    touchesFactoryState: false,
    repoFlag: false,
  }
  let vb = branch // the branch as the command line goes on

  for (const raw of splitCommands(command)) {
    const t = stripPrefix(raw)
    if (t[0] === 'git') {
      let i = 1
      while (i < t.length && t[i]!.startsWith('-')) i += GIT_VALUE_OPTS.has(t[i]!) ? 2 : 1
      const sub = t[i]
      const rest = t.slice(i + 1)
      const flags = rest.filter(x => x.startsWith('-') && x !== '--')
      const pos = rest.filter(x => !x.startsWith('-'))
      if (sub === 'push') {
        facts.isPush = true
        const refspecs = pos.slice(1)
        if (flags.some(f => /^--force|^--mirror$|^--delete$|^-d$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) facts.isForcePush = true
        if (refspecs.some(r => r.startsWith('+') || r.startsWith(':'))) facts.isForcePush = true
        const dsts = refspecs.map(r => r.replace(/^\+/, '')).map(r => (r.includes(':') ? r.slice(r.indexOf(':') + 1) : r)).map(r => r.replace(/^refs\/heads\//, ''))
        if (dsts.includes(base)) facts.pushNamesBase = true
        if (vb === base && refspecs.length === 0) facts.pushesBase = true
        if (vb === base && refspecs.some(r => r === 'HEAD' || r === base)) facts.pushesBase = true
      } else if (sub === 'commit' || sub === 'merge' || sub === 'cherry-pick' || sub === 'revert' || sub === 'am') {
        facts.isCommit = true
        if (vb === base) facts.commitsOnBase = true
      } else if (sub === 'checkout' || sub === 'switch') {
        const creates = flags.some(f => /^-[bBcC]$|^--orphan$|^--create$|^--force-create$/.test(f))
        if (creates && pos[0]) vb = pos[0]
        else if (pos[0] && (pos[0] === base || pos[0].startsWith('factory/'))) vb = pos[0]
      }
    } else if (t[0] === 'gh') {
      let i = 1
      while (i < t.length && t[i]!.startsWith('-')) i += t[i] === '-R' || t[i] === '--repo' ? 2 : 1
      const sub = t[i]
      if (hasRepoFlag(t)) facts.repoFlag = true
      let ai = i + 1
      while (ai < t.length && t[ai]!.startsWith('-')) ai += t[ai] === '-R' || t[ai] === '--repo' ? 2 : 1
      const action = t[ai]
      const rest = t.slice(ai + 1)
      if (sub === 'pr' && action === 'create') facts.isPrCreate = true
      else if (sub === 'pr' && action === 'merge') {
        if (facts.isPrMerge) facts.prSelector = SEVERAL_MERGES
        facts.isPrMerge = true
        let j = 0
        while (j < rest.length) {
          const x = rest[j]!
          if (x === '--admin') facts.hasAdmin = true
          else if (x === '--auto') facts.hasAuto = true
          if (x.startsWith('-')) j += MERGE_VALUE_FLAGS.has(x) ? 2 : 1
          else {
            facts.prSelector = facts.prSelector === null ? x : SEVERAL_MERGES
            j++
          }
        }
      } else if (sub === 'pr' && action === 'checks') facts.isCiLookup = true
      else if (sub === 'run' && (action === 'view' || action === 'watch' || action === 'list')) facts.isCiLookup = true
      else if (sub === 'api') {
        const args = t.slice(i + 1)
        let method = ''
        let hasBody = false
        let endpoint = ''
        for (let j = 0; j < args.length; j++) {
          const x = args[j]!
          if (x.startsWith('--')) {
            if (x === '--method') method = (args[++j] ?? '').toUpperCase()
            else if (x.startsWith('--method=')) method = x.slice(9).toUpperCase()
            else if (x === '--field' || x === '--raw-field' || x === '--input') {
              hasBody = true
              j++
            } else if (/^--(?:field|raw-field|input)=/.test(x)) hasBody = true
            else if (API_VALUE_FLAGS.has(x)) j++
          } else if (x.startsWith('-') && x.length > 1) {
            for (let k = 1; k < x.length; k++) {
              const ch = x[k]!
              if (!'XfFHqtp'.includes(ch)) continue
              const glued = x.slice(k + 1)
              const v = glued === '' ? (args[++j] ?? '') : glued.replace(/^=/, '')
              if (ch === 'X') method = v.toUpperCase()
              else if (ch === 'f' || ch === 'F') hasBody = true
              break
            }
          } else if (!endpoint) endpoint = x
        }
        const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method || (hasBody ? 'POST' : 'GET'))
        const path = endpoint.replace(/[?#].*$/, '')
        if (writes && /\/pulls(?:\/\d+\/(?:merge|update-branch))?\/?$|\/git\/(?:refs|commits)|\/contents\/|\/merges$/.test(path)) {
          facts.apiPrWrite = true
        }
      }
    }
  }

  // Writes only: a redirect into the file, or a command that changes files
  // with the path as an argument. Merely naming the path (cat, a heredoc body,
  // a commit message) is fine. Best effort, not a sandbox.
  const names = /(?:^|[\s/'"=])(?:state|lock)\.json\b/.test(command) && /\.factory|cd\s+\S*\.factory/.test(command)
  const writeish =
    /(?:^|[^<>])>>?\s*\S/.test(command.replace(/2>&1|>\s*\/dev\/null/g, '')) ||
    /\b(?:tee|sed\s+-i\S*|mv|cp|rm|truncate|install|ln|dd)\b/.test(command) ||
    /\b(?:python3?|node|perl|ruby)\b[^|;&\n]*(?:open|write|unlink|rename|rm)/.test(command)
  facts.touchesFactoryState = names && writeish && !/^\s*(?:cat|jq|ls|head|tail|wc|stat)\s[^>|;&]*$/.test(command)
  return facts
}

const TEST_FILE = [
  /(^|\/)(tests?|__tests__|specs?|e2e)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_test\.(go|py|rb|rs)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /Tests?\.(swift|kt|java|cs)$/,
  /(^|\/)[A-Za-z]*Tests\//,
]

export function hasTestChanges(files: readonly string[]): boolean {
  return files.some(f => TEST_FILE.some(r => r.test(f)))
}

export type Check = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

export function checksVerdict(rollup: readonly Check[], allowNoCI: boolean): { ok: boolean; reason: string } {
  if (rollup.length === 0) {
    return allowNoCI
      ? { ok: true, reason: 'no CI checks, allowed by settings' }
      : {
          ok: false,
          reason:
            'The PR has no CI checks. Add CI (as its own todo item, approved by the person) or wait for checks to appear; settings.allowNoCI is false.',
        }
  }
  const bad: string[] = []
  for (const c of rollup) {
    const name = c.name ?? c.context ?? 'check'
    if (c.__typename === 'StatusContext' || c.state !== undefined) {
      if (c.state !== 'SUCCESS') bad.push(`${name}: ${c.state ?? 'unknown'}`)
    } else if (c.status !== 'COMPLETED') {
      bad.push(`${name}: ${c.status ?? 'pending'}`)
    } else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')) {
      bad.push(`${name}: ${c.conclusion ?? 'no conclusion'}`)
    }
  }
  return bad.length === 0
    ? { ok: true, reason: 'all checks passed' }
    : { ok: false, reason: `CI is not green yet: ${bad.slice(0, 6).join('; ')}` }
}

// -------------------------------------------------------------------- lock

export type Lock = { owner: string | null; heartbeat: number }

export function parseLock(text: string | null): Lock {
  if (text === null) return { owner: null, heartbeat: 0 }
  try {
    const raw = JSON.parse(text) as Partial<Lock>
    return {
      owner: typeof raw.owner === 'string' ? raw.owner : null,
      heartbeat: typeof raw.heartbeat === 'number' ? raw.heartbeat : 0,
    }
  } catch {
    return { owner: null, heartbeat: 0 }
  }
}

// Another live session holds it: an owner that is not me and beat recently.
export function isLockedByOther(lock: Lock, me: string, now: number): boolean {
  return lock.owner !== null && lock.owner !== me && now - lock.heartbeat < LOCK_TTL_MS
}

// ------------------------------------------------------ test removal guard

const ASSERTION =
  /\b(?:expect|assert\w*|XCTAssert\w*|require|should)\s*[.(]|#expect\(|\bt\.(?:Error|Fatal)\w*\(|@Test\b|\b(?:it|test|describe)\s*\(|\bdef\s+test_|\bfunc\s+test\w*\s*\(/
const SKIPPING =
  /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|\.only\(|\bit\.todo\(|@pytest\.mark\.skip|\bpytest\.skip\(|\bt\.Skip\w*\(|XCTSkip|@Disabled\b|@Ignore\b|\.todo\(/

// Reads `git diff -U0` and reports tests that were deleted, skipped or lost
// assertions (more assertion-like lines removed than added in test files).
export function testWeakening(diff: string): string[] {
  const problems: string[] = []
  let file = ''
  let isTest = false
  let isDeleted = false
  let removed = 0
  let added = 0
  const skipped: string[] = []
  const deleted: string[] = []

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = m ? m[2]! : ''
      isTest = hasTestChanges([file])
      isDeleted = false
      if (m && hasTestChanges([m[1]!]) && !isTest) deleted.push(`${m[1]} (moved out of the tests)`)
      continue
    }
    if (line.startsWith('deleted file mode')) {
      isDeleted = true
      if (isTest) deleted.push(file)
      continue
    }
    if (!isTest || isDeleted) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('-') && ASSERTION.test(line)) removed++
    else if (line.startsWith('+')) {
      if (ASSERTION.test(line)) added++
      if (SKIPPING.test(line)) skipped.push(`${file}: ${line.slice(1).trim().slice(0, 60)}`)
    }
  }
  if (deleted.length > 0) problems.push(`deleted test files: ${deleted.slice(0, 5).join(', ')}`)
  if (skipped.length > 0) problems.push(`added skipped/only/todo tests: ${skipped.slice(0, 3).join('; ')}`)
  if (removed > added) problems.push(`${removed - added} more assertion/test lines removed than added in test files`)
  return problems
}

// ------------------------------------------------------- branch protection

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

// What the base branch's protection (classic or ruleset) does and does not stop.
export function evaluateProtection(protection: unknown, rules: unknown, base: string): string[] {
  const p = obj(protection)
  const list = Array.isArray(rules) ? rules.map(obj).filter((r): r is Json => r !== null) : []
  const hasRule = (type: string): boolean => list.some(r => r.type === type)
  if (!p && list.length === 0) {
    return [`${base} has no branch protection or ruleset: nothing but this mod's best-effort guards stops a direct push or a merge on red CI.`]
  }
  const warnings: string[] = []
  if (!(p && obj(p.required_pull_request_reviews)) && !hasRule('pull_request')) {
    warnings.push(`${base} does not require pull requests, so a direct push is possible.`)
  }
  const checks = p ? obj(p.required_status_checks) : null
  const hasChecks =
    (checks &&
      ((Array.isArray(checks.contexts) && checks.contexts.length > 0) ||
        (Array.isArray(checks.checks) && checks.checks.length > 0))) ||
    hasRule('required_status_checks')
  if (!hasChecks) warnings.push(`${base} does not require status checks to pass before merging.`)
  const force = p ? obj(p.allow_force_pushes) : null
  if (!(force && force.enabled === false) && !hasRule('non_fast_forward')) {
    warnings.push(`${base} allows force-pushes.`)
  }
  const admins = p ? obj(p.enforce_admins) : null
  if (p && list.length === 0 && !(admins && admins.enabled === true)) {
    warnings.push('the protection does not apply to admins (enforce_admins is off), so an admin token can bypass it.')
  }
  return warnings
}

// ------------------------------------------------------ billing and review

// GitHub's own wording when a job never starts for money reasons. Kept
// narrow on purpose: a billing app's tests may say "payment failed" too.
const BILLING = new RegExp(
  [
    'the job was not started because',
    'recent account payments have failed',
    'spending limit needs to be increased',
    'Billing\\s*&\\s*plans',
    'exceeded.{0,40}(?:included|free|monthly).{0,30}(?:minutes|usage|quota)',
  ].join('|'),
  'i',
)

export function isBillingProblem(text: string): boolean {
  return BILLING.test(text)
}

// The text of a finished Agent tool call: its content blocks only, never the
// echoed prompt.
export function agentText(result: unknown): string {
  if (typeof result === 'string') return result
  const r = result as { content?: unknown } | null | undefined
  if (r && Array.isArray(r.content)) {
    return r.content.map(c => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
  }
  return ''
}

export const normalizeText = (t: string): string => t.replace(/\s+/g, ' ').trim()

export const stripControls = (t: string): string =>
  t.replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')

export const cleanText = (t: string): string => normalizeText(stripControls(t))

export const safeLines = (t: string): string => t.split('\n').map(stripControls).join('\n')

export const deny = (t: string): { deny: string } => ({ deny: safeLines(t) })

export const REVIEW_TAG = '[FACTORY-REVIEW-AGENT]'

export function parseReviewMarker(text: string): ReviewMark | null {
  const all = [...text.matchAll(/FACTORY-REVIEW:\s*danger=(\d+)\s+medium=(\d+)\s+sha=([0-9a-f]{7,40})/gi)]
  const m = all[all.length - 1]
  return m ? { danger: Number(m[1]), medium: Number(m[2]), sha: m[3]!.toLowerCase() } : null
}

export function isReviewClean(mark: ReviewMark | null, headSha: string): boolean {
  if (!mark || mark.danger !== 0 || mark.medium !== 0) return false
  const head = headSha.trim().toLowerCase()
  return head.length >= 7 && (head.startsWith(mark.sha) || mark.sha.startsWith(head))
}

export function parseAgentLaunch(text: string): string | null {
  if (!/\bAsync agent launched\b/i.test(text)) return null
  const m = /\bagentId:\s*([A-Za-z0-9_-]{6,})/.exec(text)
  return m ? m[1]! : null
}

export function agentLaunchId(result: unknown, text: string): string | null {
  const r = result as { status?: unknown; agentId?: unknown } | null | undefined
  if (r && typeof r === 'object' && typeof r.status === 'string') {
    return r.status === 'async_launched' && typeof r.agentId === 'string' && /^[A-Za-z0-9_-]{6,}$/.test(r.agentId) ? r.agentId : null
  }
  return parseAgentLaunch(text)
}

export const reviewWindow = (state: Pick<FactoryState, 'reviewWaitMs'>, settings: Pick<Settings, 'reviewTimeoutMs'>): number =>
  state.reviewWaitMs > 0 ? state.reviewWaitMs : settings.reviewTimeoutMs

export function isReviewPending(state: Pick<FactoryState, 'reviewAgentId' | 'reviewAgentAt'>, now: number, waitMs: number): boolean {
  return state.reviewAgentId !== null && now - state.reviewAgentAt < waitMs
}

export type ReviewAction =
  | { action: 'ignore' }
  | { action: 'record'; mark: ReviewMark }
  | { action: 'unavailable' }
  | { action: 'clear' }

export function designFileSame(onBase: string, local: string, isTodo: boolean): boolean {
  const norm = (t: string) => t.replace(/\r\n/g, '\n')
  const a = norm(onBase)
  const b = norm(local)
  return isTodo ? promoteProposed(a).text === promoteProposed(b).text : a === b
}

export function decideReviewAnswer(
  answer: string,
  agentId: string,
  state: Pick<FactoryState, 'approved' | 'autopilot' | 'reviewAgentId'>,
  hasItem: boolean,
): ReviewAction {
  if (!state.approved || !hasItem || state.reviewAgentId === null || agentId !== state.reviewAgentId) return { action: 'ignore' }
  const mark = parseReviewMarker(answer)
  if (mark) return { action: 'record', mark }
  if (/FACTORY-REVIEW:\s*unavailable/i.test(answer)) return { action: 'unavailable' }
  return { action: 'clear' }
}

export function reviewAgentPrompt(s: Settings, branch: string): string {
  return `${REVIEW_TAG} You are an independent code reviewer with a fresh context. You have not seen how this code was written.
Repository branch: ${branch}, to be merged into ${s.baseBranch}. Read .factory/design.md and the item's acceptance criteria in .factory/todo.md for intent.

Loop until clean:
1. Run the slash command ${s.reviewCommand} on the changes of this branch against origin/${s.baseBranch} (use the Skill tool if it is not directly runnable) so it reviews and fixes them.
2. Re-run the full test suite (${s.testCmd.join(' ')}) and commit the fixes with clear messages.
3. Repeat step 1 on the new state. Stop only when a full pass reports no danger/critical/high findings and no medium findings left unresolved. At most ${s.maxReviewRounds} passes; do not weaken or delete tests to get there.

Finish your answer with exactly one final line, using the output of \`git rev-parse HEAD\` after your last commit and the counts of unresolved findings from your last pass:
FACTORY-REVIEW: danger=<n> medium=<n> sha=<HEAD sha>
If ${s.reviewCommand} does not exist or cannot run, instead write exactly: FACTORY-REVIEW: unavailable`
}

// ----------------------------------------------------------------- prompts

export const DESIGN_PROMPT = `You are running the DESIGN PHASE of the code factory. Nothing is implemented in this phase; the goal is a design the person approves, after which an autonomous loop builds it without asking them anything.

Do this:
1. Read the repository (README, package/project files, existing tests, CI config) and any existing .factory/design.md and .factory/todo.md. Treat existing content as a draft to refine.
2. Interview the person with the AskUserQuestion tool, in short rounds (1-4 questions each), until every item below is settled. NEVER guess a decision the person did not make: if it matters, ask. For each technical decision offer 2-4 concrete options with trade-offs and mark your recommendation first.
   a. Product: goals, users, scope, explicit non-goals, the features and bug fixes wanted, and their priority order.
   b. Architecture: structure, data model, boundaries, constraints (platform, versions, performance, security).
   c. HOW, per feature or fix: the specific tool, library, algorithm, or workaround to use, the alternatives rejected and why, and known pitfalls. "Figure it out later" is not an acceptable answer: the build loop cannot ask.
   d. Versions: which version milestones exist (for example 0.1 walking skeleton, 0.2 core features, 1.0 launch), what each contains, and WHICH VERSION THE LOOP MUST STOP AFTER. Whether to cut a GitHub release when that version is complete.
   e. Verification: the exact commands that run the whole unit/integration suite, BUILD the app locally, and run the END-TO-END tests (for a web app: the e2e tool such as Playwright and how it starts the app; for an iOS/macOS app: xcodebuild build and test commands, simulator and UI tests). Which item types need e2e. What is not testable.
   f. CI and branch protection: does CI exist, what does it run, must it pass before merge. If it does not exist, add a first todo item to create it. Is branch protection (PRs required, status checks required, no force-push, applies to admins) enabled on the base branch? Offer to set it up with gh as an early todo item; private repos on a free GitHub plan cannot have it.
   g. Review: the loop reviews each branch with an independent agent running the slash command in settings.reviewCommand (default /review-fix) until no danger or medium findings remain. Confirm the command name.
   h. Git: base branch, merge method (squash/merge/rebase), anything protected. Context handling between items (clear, compact or none; default clear).
   i. When the loop is blocked or a decision turns out infeasible: the default is to mark the item blocked and continue with the next one.
   j. Spend: an optional US-dollar budget per run (settings.budgetUsd, 0 for none; the loop pauses when one run reaches it) and whether the factory should interview them about the next phase once every item is done (settings.askNextPhase, default true).
3. Record everything as you go, so it survives the session:
   - .factory/design.md: overview, non-goals, architecture, version plan, and a "## Decisions" section (one entry per decision: question, options, choice, why).
   - .factory/settings.json: {"baseBranch":"main","testCmd":["bash","-lc","<full test command>"],"buildCmd":["bash","-lc","<build command>"],"e2eCmd":["bash","-lc","<e2e command>"],"e2eFor":["feature","bug"],"testTimeoutMs":600000,"mergeMethod":"squash","maxAttempts":4,"maxItemsPerRun":0,"allowNoCI":false,"requireTestChanges":true,"requireReview":true,"reviewCommand":"/review-fix","maxReviewRounds":5,"contextReset":"clear","stopAfterVersion":"<e.g. 0.3.0>","tagRelease":false,"requireBranchProtection":false,"allowTestRemoval":false,"reviewTimeoutMs":1800000,"budgetUsd":0,"askNextPhase":true}   (omit buildCmd/e2eCmd only if the person says there is nothing to build or no UI; each command may run at most 10 minutes; budgetUsd pauses the loop once one run has spent that many US dollars, 0 means no budget; askNextPhase makes the factory interview the person about the next phase once every item is done)
   - .factory/todo.md in exactly this format, in priority order, one block per item:
       ## T-001 [feature] Short title      (type is feature, bug, chore or docs)
       - status: proposed
       - version: 0.1.0
       - how: the chosen tool/algorithm/workaround and why (one or more lines, continuation lines indented by two spaces)
       - accept: acceptance criteria that can be checked
       - tests: what unit and e2e tests will be written and what they assert
       - depends: T-000 (optional)
   - The factory creates .factory/.gitignore itself; do not edit it.
4. Before you finish, check .factory/settings.json exists and its testCmd is a non-empty argv array (the loop cannot start without it; /factory-approve rejects the design otherwise).
5. When the person confirms the design is complete, read it back as a short summary. Then check out the base branch, and commit .factory/design.md, .factory/settings.json, .factory/todo.md and .factory/.gitignore to it and push it (git checkout <base> && git pull --ff-only && git add .factory/design.md .factory/settings.json .factory/todo.md .factory/.gitignore && git commit -m "Add code factory design" -- .factory/design.md .factory/settings.json .factory/todo.md .factory/.gitignore && git push origin <base>); the path list on the commit keeps anything else the person has staged out of it. The loop switches back to the base branch between items, so design files that exist only on another branch disappear and the loop stops. If the push is rejected because the base branch is protected, move the commit onto a branch and keep the local base clean (git switch -c factory-design && git push -u origin factory-design && git branch -f <base> origin/<base>), open a PR from it with gh pr create and tell the person to merge it first; /factory-approve checks that origin/<base> holds exactly these files. Finally tell them to run /factory-approve to validate it and unlock the build loop, and /factory-start to run it. Do not run those yourself and do not edit the factory's state files.`

export function workPrompt(item: Item, s: Settings, resumeNote: string | null): string {
  const branch = branchFor(item)
  const needsE2e = s.e2eCmd.length > 0 && s.e2eFor.includes(item.type)
  const verify = [
    s.buildCmd.length > 0 ? `build it (${s.buildCmd.join(' ')})` : null,
    needsE2e ? `run the end-to-end tests (${s.e2eCmd.join(' ')})` : null,
  ].filter(Boolean)
  return `CODE FACTORY: work item ${item.id} [${item.type}] ${item.title}${item.version ? ` (version ${item.version})` : ''}
${resumeNote ? `\nRESUME NOTE: ${resumeNote}\n` : ''}
Approved decisions for this item (do not change them):
- how: ${item.how}
- accept: ${item.accept}
- tests: ${item.tests || '(docs item: no tests required)'}
Read .factory/design.md first; it holds the architecture and decision log. Your context may have been reset, so rely on the files, not on memory of earlier items.

Work autonomously with no questions to the person. Follow this loop exactly:
1. Sync: \`git fetch origin\`, check out ${s.baseBranch}, \`git pull --ff-only\`. Create (or resume) branch ${branch}. Never commit or push to ${s.baseBranch}.
2. Implement the item using the decided "how". If the decision is infeasible or something essential is undecided, do not improvise: create .factory/blocked/${item.id}.md explaining the question, return to ${s.baseBranch}, and stop.
3. Tests: ${item.type === 'bug' ? 'first write a regression test that fails for the bug, then fix it.' : item.type === 'docs' ? 'no tests required for a docs item.' : item.type === 'chore' ? 'add tests only where the chore changes behavior; otherwise just keep the suite green.' : 'write tests for every new behavior alongside the code, including end-to-end tests for user-facing behavior.'} Run the full suite (${s.testCmd.join(' ')}). All previously passing tests must still pass. Never delete, skip or weaken an existing test to get green.
4. Prove it works for real, not only in unit tests: ${verify.length > 0 ? verify.join(' and ') + '; then ' : ''}where the item changes something a person can see or use, run the app locally and exercise the acceptance criteria yourself (for a web app drive it with the browser/Playwright; for an iOS app build with xcodebuild and run it in the simulator). Save screenshots or logs under .factory/evidence/${item.id}/. If something fails, fix it and repeat steps 3-4.
5. In the same branch set "- status: done" for ${item.id} in .factory/todo.md, then commit with a clear message ("${item.id}: ..."). Do not commit after the review in step 6 except through the reviewer.
6. Independent review: spawn ONE fresh agent with the Agent tool (subagent_type "general-purpose", no other context) and pass it exactly this prompt:
-----
${reviewAgentPrompt(s, branch)}
-----
If the Agent tool says the agent was launched in the background, end your turn and wait: its report arrives later as a message and the factory reads the FACTORY-REVIEW line from the reviewer's own final turn, so do not spawn a second reviewer. Its answer ends with a FACTORY-REVIEW line; the factory reads it and only lets the PR open when it shows danger=0 medium=0 for the current HEAD. If it shows findings you may spawn a new reviewer again (at most ${s.maxReviewRounds} rounds in total); if it is still not clean after that, write .factory/blocked/${item.id}.md and stop.
7. Push the branch and open a PR: \`gh pr create --base ${s.baseBranch} --title "${item.id}: ${item.title}" --body "<what changed, decisions followed, tests, how you verified it locally>"\`. Before it opens, the factory itself runs${s.buildCmd.length > 0 ? ' the build,' : ''} the test suite${needsE2e ? ', the e2e tests' : ''}, checks that tests changed and that the review is clean for HEAD; fix what it reports and retry.
8. Wait for CI (\`gh pr checks <n> --watch\`). If a check fails, read the logs (\`gh run view --log-failed\`), fix, push and wait again (after any new commit the review must be re-run). If the failure is a GitHub billing, payment or spending-limit problem (jobs never start), the factory stops the loop by itself; do not try to work around it. If you cannot get green after 5 fix rounds, write .factory/blocked/${item.id}.md, return to ${s.baseBranch} and stop.
9. When CI is green: \`gh pr merge <n> --${s.mergeMethod} --delete-branch\`. The factory verifies the checks before it allows the merge.
10. Finish on ${s.baseBranch}, up to date (\`git checkout ${s.baseBranch} && git pull --ff-only\`), working tree clean. Then end your turn with two lines: what merged, and anything the person should know. The factory will reset context and hand you the next item.

Do not touch the factory's state file. Do not change decisions (how/accept/tests/version) in .factory/todo.md. If you discover extra work, append it to .factory/todo.md as a new item with "- status: proposed" and fill in every field you can; the person approves proposed items later.`
}

export function nudgePrompt(item: Item, s: Settings, why: string): string {
  return workPrompt(item, s, `${why} Check \`git status\`, the current branch, and \`gh pr list --head ${branchFor(item)} --state all\`, then continue the loop from the first unfinished step. Do not ask the person anything; if you are stuck, create .factory/blocked/${item.id}.md and stop.`)
}

export function releasePrompt(version: string, s: Settings): string {
  return `CODE FACTORY: every item up to version ${version} is merged. Cut the release.
1. \`git checkout ${s.baseBranch} && git pull --ff-only\`; confirm the working tree is clean.
2. Confirm the latest CI run on ${s.baseBranch} succeeded (\`gh run list --branch ${s.baseBranch} --limit 1\`). If it did not, or it is a billing problem, stop and say so.
3. \`gh release create v${version} --target ${s.baseBranch} --generate-notes --title "v${version}"\`.
4. End your turn with one line naming the release. Do not change code.`
}

export const STAGES = ['build', 'review', 'PR', 'CI', 'merge'] as const satisfies readonly Stage[]
export type LoopEvent = 'start' | 'commit' | 'review' | 'reviewed' | 'pr' | 'merge'

const STAGE_AFTER: Record<LoopEvent, Stage> = {
  start: 'build',
  commit: 'build',
  review: 'review',
  reviewed: 'PR',
  pr: 'CI',
  merge: 'merge',
}

export const stageAfter = (ev: LoopEvent): Stage => STAGE_AFTER[ev]

export function loopEventForBash(f: BashFacts): LoopEvent | null {
  if (f.isPrMerge) return 'merge'
  if (f.isPrCreate) return 'pr'
  if (f.isCommit) return 'commit'
  return null
}

export const VIEW_ROWS = 6
export const VIEW_CHANGES = 3
export const VIEW_EVENTS = 3

export type ViewSpend = { runUsd: number | null; itemUsd: number | null; budgetUsd: number }

export function buildView(
  items: readonly Item[],
  state: FactoryState,
  blocked: ReadonlySet<string>,
  stopAfterVersion: string | null,
  prev: FactoryView | null,
  spend: ViewSpend = { runUsd: null, itemUsd: null, budgetUsd: 0 },
): FactoryView {
  const scoped = items.filter(i => inScope(i, stopAfterVersion))
  const markOf = (i: Item): Mark => (blocked.has(i.id) ? 'blocked' : state.current === i.id && i.status !== 'proposed' ? 'doing' : i.status)
  const all: ViewRow[] = scoped.map(i => ({ id: i.id, type: i.type, title: cleanText(i.title), version: cleanText(i.version), mark: markOf(i) }))
  const marks: Record<string, Mark> = Object.fromEntries(all.map(r => [r.id, r.mark]))
  const fresh: string[] = []
  if (prev) {
    for (const r of all) {
      const was = prev.marks[r.id]
      if (was === undefined) fresh.push(`${r.id} added (${r.mark})`)
      else if (was !== r.mark) fresh.push(`${r.id} ${was} -> ${r.mark}`)
    }
  }
  const open = all.filter(r => r.mark !== 'done')
  const stage = state.current === null ? null : prev && prev.current === state.current ? prev.stage ?? 'build' : 'build'
  return {
    approved: state.approved,
    running: state.autopilot && !state.unreadable,
    pausedReason: state.pausedReason === null ? null : cleanText(state.pausedReason),
    current: state.current,
    stage,
    summary: summarize(items as Item[], blocked),
    doneCount: all.length - open.length,
    rows: open.slice(0, VIEW_ROWS),
    more: Math.max(0, open.length - VIEW_ROWS),
    marks,
    changes: [...(prev?.changes ?? []), ...fresh].slice(-VIEW_CHANGES),
    runUsd: spend.runUsd,
    itemUsd: state.current === null ? null : spend.itemUsd,
    budgetUsd: spend.budgetUsd,
    events: (state.events ?? []).slice(-VIEW_EVENTS).map(shortEvent),
  }
}

export type EventKind =
  | 'started'
  | 'commit'
  | 'pr-opened'
  | 'ci-passed'
  | 'ci-failed'
  | 'review-launched'
  | 'review-verdict'
  | 'nudge'
  | 'blocked'
  | 'merged'
  | 'done'
  | 'paused'
  | 'resumed'
  | 'skip'
  | 'retry'
  | 'release'
  | 'roadmap'

export type FactoryEvent = { ts: number; itemId: string | null; kind: EventKind; detail: string; pr?: number; url?: string }

export const MAX_EVENTS = 200

const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(['started', 'commit', 'pr-opened', 'ci-passed', 'ci-failed', 'review-launched', 'review-verdict', 'nudge', 'blocked', 'merged', 'done', 'paused', 'resumed', 'skip', 'retry', 'release', 'roadmap'])

export function sanitizeEvents(raw: unknown): FactoryEvent[] {
  if (!Array.isArray(raw)) return []
  const out: FactoryEvent[] = []
  for (const r of raw) {
    const e = obj(r)
    if (!e || typeof e.ts !== 'number' || typeof e.kind !== 'string' || !EVENT_KINDS.has(e.kind)) continue
    out.push({
      ts: e.ts,
      itemId: typeof e.itemId === 'string' ? stripControls(e.itemId) : null,
      kind: e.kind as EventKind,
      detail: typeof e.detail === 'string' ? stripControls(e.detail) : '',
      ...(typeof e.pr === 'number' ? { pr: e.pr } : {}),
      ...(typeof e.url === 'string' ? { url: stripControls(e.url) } : {}),
    })
  }
  return out.slice(-MAX_EVENTS)
}

const eventKey = (e: FactoryEvent): string => `${e.ts}|${e.kind}|${e.itemId ?? ''}|${e.detail}`

export function appendEvent(events: readonly FactoryEvent[], ev: FactoryEvent): FactoryEvent[] {
  const e: FactoryEvent = { ...ev, detail: cleanText(ev.detail).slice(0, 160), ...(ev.url !== undefined ? { url: stripControls(ev.url) } : {}) }
  const last = events[events.length - 1]
  if (last && last.kind === e.kind && last.itemId === e.itemId && last.detail === e.detail) return [...events]
  return [...events, e].slice(-MAX_EVENTS)
}

export function applyChanges(fresh: FactoryState, base: FactoryState, next: FactoryState): FactoryState {
  const out: Record<string, unknown> = { ...fresh }
  const b = base as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(next as unknown as Record<string, unknown>)) {
    if (k === 'events' || k === 'mergedIds' || k === 'approvedDone' || k === 'unreadable') continue
    if (JSON.stringify(v) !== JSON.stringify(b[k])) out[k] = v
  }
  const result = out as unknown as FactoryState
  return {
    ...result,
    events: mergeEvents(fresh.events ?? [], next.events ?? []),
    mergedIds: [...new Set([...fresh.mergedIds, ...next.mergedIds])],
    approvedDone: JSON.stringify(next.approvedDone) !== JSON.stringify(base.approvedDone) ? next.approvedDone : fresh.approvedDone,
  }
}

export function mergeEvents(onDisk: readonly FactoryEvent[], mine: readonly FactoryEvent[]): FactoryEvent[] {
  const seen = new Set<string>()
  const out: FactoryEvent[] = []
  for (const e of [...onDisk, ...mine]) {
    const k = eventKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(x => x[0])
    .slice(-MAX_EVENTS)
}

export function shortEvent(e: FactoryEvent): string {
  return stripControls(shortEventRaw(e))
}

function shortEventRaw(e: FactoryEvent): string {
  const who = e.itemId ?? 'factory'
  switch (e.kind) {
    case 'pr-opened':
      return `${who} PR${e.pr !== undefined ? ` #${e.pr}` : ''}`
    case 'ci-passed':
      return `${who} CI ✓`
    case 'ci-failed':
      return `${who} CI ✗`
    case 'review-verdict':
      return `${who} review ${e.detail.replace(/\s*sha=\S+/, '')}`.trim()
    case 'review-launched':
      return `${who} reviewing`
    default:
      return `${who} ${e.kind}`
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

const clock = (ts: number): string => new Date(ts).toISOString().slice(0, 19).replace('T', ' ')

export function formatLog(events: readonly FactoryEvent[], itemId: string | null): string {
  const id = itemId ? itemId.toUpperCase() : null
  const list = id ? events.filter(e => e.itemId === id) : [...events]
  if (list.length === 0) return id ? `No events recorded for ${id}.` : 'No events recorded yet.'
  const lines = list.map((e, i) => {
    const gap = i === 0 ? '' : `+${formatDuration(e.ts - list[i - 1]!.ts)}`
    const pr = e.kind === 'pr-opened' ? [e.pr !== undefined ? `#${e.pr}` : '', e.url ?? ''].filter(Boolean).join(' ') : ''
    const detail = [pr, e.detail].filter(Boolean).join(' ')
    return `${clock(e.ts)}Z ${gap.padStart(9)}  ${(e.itemId ?? '-').padEnd(7)} ${e.kind.padEnd(15)} ${detail}`.trimEnd()
  })
  const span = list.length > 1 ? `, ${formatDuration(list[list.length - 1]!.ts - list[0]!.ts)} from first to last` : ''
  return safeLines(`Factory timeline${id ? ` for ${id}` : ''} (${list.length} event${list.length === 1 ? '' : 's'}${span}; times UTC, gaps since the previous event):\n${lines.join('\n')}`)
}

export function commitMessage(command: string): string {
  for (const t of splitCommands(command).map(stripPrefix)) {
    if (t[0] !== 'git' || !t.includes('commit')) continue
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '-m' || t[i] === '--message') return cleanText((t[i + 1] ?? '').split('\n')[0]!).slice(0, 120)
      if (t[i]!.startsWith('--message=')) return cleanText(t[i]!.slice(10).split('\n')[0]!).slice(0, 120)
    }
    return 'commit'
  }
  return 'commit'
}

export function parsePrUrl(text: string): { pr: number; url: string } | null {
  const m = /https?:\/\/[^\s'"]+\/pull\/(\d+)/.exec(stripControls(text))
  return m ? { pr: Number(m[1]), url: m[0] } : null
}

export function ciOutcome(raw: string): 'passed' | 'failed' | null {
  const text = raw.replace(/\b0 (?:cancell?ed|failing|failed|pending|skipped|successful)\b/gi, '')
  if (/\b(?:fail(?:ed|ing|ure)?|cancell?ed|startup_failure|action_required|timed[_ ]out)\b|✗/i.test(text)) return 'failed'
  if (/\b(?:pending|queued|in_progress|in progress|waiting)\b/i.test(text)) return null
  if (/all checks were successful|\bpass(?:ed)?\b|✓/i.test(text)) return 'passed'
  return null
}

export function parseItemArg(args: string): { id: string | null; note: string } {
  if (args.length > 2000) return { id: null, note: '' }
  const m = /^\s*([A-Za-z]{1,10}-\d{1,6})(?:\s+([\s\S]*))?$/.exec(args)
  return m ? { id: m[1]!.toUpperCase(), note: cleanText(m[2] ?? '').slice(0, 300) } : { id: null, note: '' }
}

export const DESIGN_PATHS_ARG = '.factory/design.md .factory/todo.md .factory/settings.json'

export function unsafeBaseNote(): string {
  return `The baseBranch in ${SETTINGS_PATH} is not a plain branch name, so no git commands are shown; set it to the real base branch name there first.`
}

export function designPushSteps(base: string, current: string | null = null): string {
  if (!isSafeBranchName(base)) return `${unsafeBaseNote()} Then commit and push the three design files to it and run /factory-approve again.`
  const onOther = current !== null && current !== '' && current !== base
  const tail = `git add -- ${DESIGN_PATHS_ARG} && git commit -m "Code factory design" -- ${DESIGN_PATHS_ARG} && git push origin '${base}'`
  const carry = !onOther
    ? []
    : isSafeBranchName(current)
      ? [
          `  # If you committed the design files on the feature branch you are on now, run only this line:`,
          `  git checkout '${base}' && git checkout '${current}' -- ${DESIGN_PATHS_ARG} && ${tail}`,
          `  # If they are uncommitted edits you carry over to the base branch instead, run only this line:`,
        ]
      : [`  # If you committed the design files on the branch you are on now, copy them over to the base branch by hand, because that branch name is not shown. If they are uncommitted edits, run this line:`]
  return [
    `  # Commit and push the three design files to the base branch yourself, from the repository root with nothing else staged.`,
    `  # Each command line stops at its first failed step, so a failed checkout, add or commit never reaches the push.`,
    ...carry,
    `  git checkout '${base}' && ${tail}`,
    `  # If the design files are already committed on the base branch but not pushed, run only this line:`,
    `  git checkout '${base}' && git push origin '${base}'`,
    `  # If the base branch is protected, push them on a branch and merge it through a PR instead.`,
    `  # Then run /factory-approve again.`,
  ].join('\n')
}

export function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    stripControls(name) === name &&
    !/[\u{E0000}-\u{E007F}]/u.test(name) &&
    !/[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069'"`\\$~^:?*[]/.test(name) &&
    !/^[-+/.]/.test(name) &&
    !/[/.]$/.test(name) &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    name !== '@' &&
    !name.includes('//') &&
    !name.includes('/.') &&
    name !== 'HEAD'
  )
}

export type CostPhase = 'build' | 'review' | 'ci-fix' | 'design' | 'release' | 'roadmap'
export const COST_PHASES: readonly CostPhase[] = ['build', 'review', 'ci-fix', 'design', 'release', 'roadmap']
export type DriveKind = 'item' | 'design' | 'release' | 'roadmap'
export type Drive = { key: string; kind: DriveKind; title: string }
export type CostMark = Drive & { usd: number | null; at: number; tree: string }
export type ItemCost = {
  title: string
  usd: number
  models: Record<string, number[]>
  phases: Partial<Record<CostPhase, number>>
  attempts: number
  ms: number
  firstAt: number
  lastAt: number
  outcome: string
}
export type RunCost = { startedAt: number; lastAt: number; usd: number; items: number; tree: string }
export type RepoCosts = { repo: string; usd: number; items: Record<string, ItemCost>; runs: RunCost[]; marks: Record<string, CostMark> }
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }

export const COST_KEY_PREFIX = 'costs/'
export const PLAN_KEY = '_plan'
export const MAX_COST_ITEMS = 400
export const MAX_RUNS = 20
const MARK_TTL_MS = 2 * 86400000

export function repoKey(remote: string, cwd: string): string {
  const r = remote.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const m = /[:/]([^/:\s]+)\/([^/:\s]+)$/.exec(r)
  if (r && m) return `${m[1]}/${m[2]}`
  return cwd.replace(/\/+$/, '').split('/').pop() || 'unknown'
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function keptRuns(runs: RunCost[]): RunCost[] {
  const lastOfTree = new Map(runs.map((r, i) => [r.tree, i] as const))
  return runs.filter((r, i) => i >= runs.length - MAX_RUNS || (r.tree !== '' && lastOfTree.get(r.tree) === i))
}

export function emptyRepoCosts(repo: string): RepoCosts {
  return { repo, usd: 0, items: {}, runs: [], marks: {} }
}

export function normalizeRepoCosts(raw: unknown, repo: string): RepoCosts {
  const r = obj(raw)
  if (!r) return emptyRepoCosts(repo)
  const items: Record<string, ItemCost> = {}
  for (const [k, v] of Object.entries(obj(r.items) ?? {})) {
    const it = obj(v)
    if (!it) continue
    const models: Record<string, number[]> = {}
    for (const [m, arr] of Object.entries(obj(it.models) ?? {})) {
      if (Array.isArray(arr)) models[m] = [0, 1, 2, 3].map(i => num(arr[i]))
    }
    const phases: Partial<Record<CostPhase, number>> = {}
    for (const p of COST_PHASES) if (num(obj(it.phases)?.[p]) > 0) phases[p] = num(obj(it.phases)?.[p])
    items[k] = {
      title: typeof it.title === 'string' ? it.title : '',
      usd: num(it.usd),
      models,
      phases,
      attempts: num(it.attempts),
      ms: num(it.ms),
      firstAt: num(it.firstAt),
      lastAt: num(it.lastAt),
      outcome: typeof it.outcome === 'string' ? it.outcome : '',
    }
  }
  const runs = (Array.isArray(r.runs) ? r.runs : [])
    .map(obj)
    .filter((x): x is Json => x !== null)
    .map(x => ({ startedAt: num(x.startedAt), lastAt: num(x.lastAt), usd: num(x.usd), items: num(x.items), tree: typeof x.tree === 'string' ? x.tree : '' }))
  const marks: Record<string, CostMark> = {}
  for (const [k, v] of Object.entries(obj(r.marks) ?? {})) {
    const m = obj(v)
    const kind = m?.kind
    if (m && typeof m.key === 'string' && (kind === 'item' || kind === 'design' || kind === 'release' || kind === 'roadmap')) {
      marks[k] = { key: m.key, kind, title: typeof m.title === 'string' ? m.title : '', usd: typeof m.usd === 'number' && Number.isFinite(m.usd) ? m.usd : null, at: num(m.at), tree: typeof m.tree === 'string' ? m.tree : '' }
    }
  }
  return { repo: typeof r.repo === 'string' && r.repo ? r.repo : repo, usd: num(r.usd), items, runs: keptRuns(runs), marks }
}

export function costDelta(markUsd: number, nowUsd: number): number {
  if (!Number.isFinite(nowUsd) || nowUsd < 0) return 0
  return nowUsd >= markUsd ? nowUsd - markUsd : nowUsd
}

function clone(rc: RepoCosts): RepoCosts {
  return JSON.parse(JSON.stringify(rc)) as RepoCosts
}

function itemIn(rc: RepoCosts, key: string, title: string, now: number): ItemCost {
  const have = rc.items[key]
  if (have) {
    if (title && !have.title) have.title = cleanText(title)
    return have
  }
  const fresh: ItemCost = { title: cleanText(title), usd: 0, models: {}, phases: {}, attempts: 0, ms: 0, firstAt: now, lastAt: now, outcome: '' }
  rc.items[key] = fresh
  return fresh
}

function prune(rc: RepoCosts, now: number): RepoCosts {
  const keys = Object.keys(rc.items)
  if (keys.length > MAX_COST_ITEMS) {
    const keep = new Set(keys.sort((a, b) => rc.items[b]!.lastAt - rc.items[a]!.lastAt).slice(0, MAX_COST_ITEMS))
    for (const k of keys) if (!keep.has(k)) delete rc.items[k]
  }
  for (const [k, m] of Object.entries(rc.marks)) if (now - m.at > MARK_TTL_MS) delete rc.marks[k]
  rc.runs = keptRuns(rc.runs)
  return rc
}

const countsInRun = (kind: DriveKind): boolean => kind === 'item' || kind === 'release'

export type Settle = { from: string; to: string; tree: string; nowUsd: number | null; now: number; next: Drive | 'keep' | null }

export function treeRun(rc: RepoCosts, tree: string): RunCost | undefined {
  if (tree === '') return undefined
  for (let i = rc.runs.length - 1; i >= 0; i--) if (rc.runs[i]!.tree === tree) return rc.runs[i]
  return undefined
}

export function settleCost(input: RepoCosts, s: Settle): { costs: RepoCosts; delta: number } {
  const rc = clone(input)
  const mark = rc.marks[s.from]
  if (s.nowUsd === null && mark && (s.next === 'keep' || mark.usd !== null)) return { costs: prune(rc, s.now), delta: 0 }
  let delta = 0
  if (mark) {
    delta = s.nowUsd === null || mark.usd === null ? 0 : costDelta(mark.usd, s.nowUsd)
    const it = itemIn(rc, mark.key, mark.title, s.now)
    it.usd += delta
    it.ms += Math.max(0, s.now - mark.at)
    it.lastAt = s.now
    rc.usd += delta
    if (countsInRun(mark.kind)) {
      const tree = mark.tree || s.tree
      let run = treeRun(rc, tree)
      if (!run) {
        run = { startedAt: mark.at, lastAt: mark.at, usd: 0, items: 0, tree }
        rc.runs.push(run)
      }
      run.usd += delta
      run.lastAt = s.now
    }
    delete rc.marks[s.from]
  }
  const nextDrive = s.next === 'keep' ? (mark ? { key: mark.key, kind: mark.kind, title: mark.title } : null) : s.next
  if (nextDrive) {
    rc.marks[s.to] = { ...nextDrive, usd: s.nowUsd, at: s.now, tree: s.tree }
    itemIn(rc, nextDrive.key, nextDrive.title, s.now)
  }
  return { costs: prune(rc, s.now), delta }
}

export function costPhase(kind: DriveKind, stage: Stage | null, isReviewer: boolean): CostPhase {
  if (isReviewer) return 'review'
  if (kind !== 'item') return kind
  if (stage === 'CI' || stage === 'merge') return 'ci-fix'
  return stage === 'review' ? 'review' : 'build'
}

export const usageTokens = (u: Usage): number => num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)

export function addTokens(input: RepoCosts, key: string, title: string, phase: CostPhase, usage: Usage, now: number): RepoCosts {
  const rc = clone(input)
  const it = itemIn(rc, key, title, now)
  const model = (usage.model || 'unknown').slice(0, 80)
  const row = it.models[model] ?? [0, 0, 0, 0]
  it.models[model] = [row[0]! + num(usage.input_tokens), row[1]! + num(usage.output_tokens), row[2]! + num(usage.cache_read_input_tokens), row[3]! + num(usage.cache_creation_input_tokens)]
  it.phases[phase] = (it.phases[phase] ?? 0) + usageTokens(usage)
  it.lastAt = now
  return prune(rc, now)
}

export function noteItem(input: RepoCosts, key: string, title: string, now: number, change: { attempt?: boolean; outcome?: string; runItemTree?: string }): RepoCosts {
  const rc = clone(input)
  const it = itemIn(rc, key, title, now)
  if (change.attempt) it.attempts += 1
  if (change.outcome !== undefined) it.outcome = change.outcome
  it.lastAt = now
  const run = change.runItemTree === undefined ? undefined : treeRun(rc, change.runItemTree)
  if (run) run.items += 1
  return prune(rc, now)
}

export function rebaseMark(input: RepoCosts, owner: string, nowUsd: number | null, now: number): RepoCosts {
  const rc = clone(input)
  const mark = rc.marks[owner]
  if (mark && nowUsd !== null) mark.usd = nowUsd
  return prune(rc, now)
}

export function startRun(input: RepoCosts, now: number, tree: string): RepoCosts {
  const rc = clone(input)
  rc.runs.push({ startedAt: now, lastAt: now, usd: 0, items: 0, tree })
  return prune(rc, now)
}

export function liveSpend(rc: RepoCosts, owner: string, tree: string, nowUsd: number | null, currentKey: string | null): { runUsd: number; itemUsd: number } {
  const mark = rc.marks[owner]
  const pending = mark && nowUsd !== null && mark.usd !== null ? costDelta(mark.usd, nowUsd) : 0
  const run = treeRun(rc, tree)
  const runUsd = (run?.usd ?? 0) + (mark && countsInRun(mark.kind) ? pending : 0)
  const itemUsd = currentKey === null ? 0 : (rc.items[currentKey]?.usd ?? 0) + (mark && mark.key === currentKey ? pending : 0)
  return { runUsd, itemUsd }
}

export const budgetReached = (budgetUsd: number, runUsd: number): boolean => budgetUsd > 0 && runUsd >= budgetUsd

export const budgetUnreadableReason = (budgetUsd: number): string =>
  `budgetUsd is ${formatUsd(budgetUsd)} but this run's spend cannot be read (the session reports no cost, or the cost ledger could not be read or written), so the budget cannot be enforced; fix that or set budgetUsd to 0 and /factory-approve`

export const budgetPauseReason = (budgetUsd: number, runUsd: number): string =>
  `budget reached: this run spent ${formatUsd(runUsd)} of the ${formatUsd(budgetUsd)} budget (settings.budgetUsd); /factory-start begins a new run, or raise budgetUsd and /factory-approve`

export const formatUsd = (usd: number): string => `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

const shortModel = (m: string): string => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const itemLabel = (key: string): string => (key === PLAN_KEY ? '(plan)' : key)
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-')

function itemTokens(it: ItemCost): number {
  return Object.values(it.models).reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0)
}

function itemTable(rc: RepoCosts): string[] {
  const rows = Object.entries(rc.items).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]))
  if (rows.length === 0) return ['  (no items recorded)']
  const head = `  ${'item'.padEnd(8)} ${'usd'.padStart(8)} ${'share'.padStart(5)} ${'tries'.padStart(5)} ${'time'.padStart(7)}  ${'outcome'.padEnd(8)} tokens by model / phase split`
  const lines = rows.map(([k, it]) => {
    const models = Object.entries(it.models)
      .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))
      .map(([m, r]) => `${shortModel(m)} ${formatTokens(r.reduce((x, y) => x + y, 0))} (out ${formatTokens(r[1]!)})`)
      .join(', ')
    const total = Object.values(it.phases).reduce((a, b) => a + (b ?? 0), 0)
    const phases = COST_PHASES.filter(p => (it.phases[p] ?? 0) > 0)
      .map(p => `${p} ${pct(it.phases[p]!, total)}`)
      .join(' ')
    const detail = [models || 'no tokens', phases].filter(Boolean).join(' / ')
    return `  ${itemLabel(k).padEnd(8)} ${formatUsd(it.usd).padStart(8)} ${pct(it.usd, rc.usd).padStart(5)} ${String(it.attempts).padStart(5)} ${formatDuration(it.ms).padStart(7)}  ${(it.outcome || '-').padEnd(8)} ${detail}`
  })
  return [head, ...lines]
}

function repoBlock(rc: RepoCosts, isCurrent: boolean): string[] {
  const run = rc.runs[rc.runs.length - 1]
  const tokens = Object.values(rc.items).reduce((a, it) => a + itemTokens(it), 0)
  const head = `${rc.repo}${isCurrent ? ' (this repo)' : ''}: ${formatUsd(rc.usd)} over ${Object.keys(rc.items).length} item(s), ${formatTokens(tokens)} tokens, ${rc.runs.length} run(s)`
  const runLine = run ? `  last run: ${formatUsd(run.usd)}, ${run.items} item(s) merged, started ${clock(run.startedAt)}Z, last spend ${clock(run.lastAt)}Z` : '  no runs recorded'
  const top = Object.entries(rc.items)
    .filter(([, it]) => it.usd > 0)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, 3)
    .map(([k, it]) => `${itemLabel(k)} ${formatUsd(it.usd)} (${pct(it.usd, rc.usd)})${it.title ? ` ${it.title.slice(0, 40)}` : ''}`)
  return [head, runLine, ...itemTable(rc), ...(top.length > 0 ? [`  most expensive: ${top.join('; ')}`] : [])]
}

export function parseCostsArgs(args: string): { reset: string | null; filter: string } {
  const t = args.trim()
  const m = /^reset(?:\s+(\S+))?\s*$/i.exec(t)
  if (m) return { reset: m[1] ?? '', filter: '' }
  return { reset: null, filter: t }
}

export function costsReport(all: readonly RepoCosts[], filter: string, currentRepo: string | null): string {
  if (all.length === 0) return 'No factory costs recorded yet. Spend is recorded while the factory drives a turn (/factory-start, /factory-design, the next-phase interview).'
  const sorted = [...all].sort((a, b) => b.usd - a.usd || a.repo.localeCompare(b.repo))
  const grand = sorted.reduce((a, r) => a + r.usd, 0)
  const width = Math.max(...sorted.map(r => r.repo.length))
  const lines = [
    `Code factory spend, all repos: ${formatUsd(grand)} (US dollars as the session cost counter reports them; the person's own turns are not counted; advisory only, the ledger file is not protected from the model)`,
    ...sorted.map(r => `  ${r.repo.padEnd(width)} ${formatUsd(r.usd).padStart(9)} ${pct(r.usd, grand).padStart(5)}${r.repo === currentRepo ? '  <- this repo' : ''}`),
    '',
  ]
  const f = filter.trim().toLowerCase()
  const picked = f === 'all' ? sorted : f ? sorted.filter(r => r.repo.toLowerCase().includes(f)) : sorted.filter(r => r.repo === currentRepo)
  if (picked.length === 0) {
    lines.push(f ? `No recorded repo matches "${filter.trim()}".` : `Nothing recorded for this repo${currentRepo ? ` (${currentRepo})` : ''}; /factory-costs all lists every repo.`)
    return safeLines(lines.join('\n'))
  }
  for (const rc of picked) lines.push(...repoBlock(rc, rc.repo === currentRepo), '')
  return safeLines(lines.join('\n').trimEnd())
}

export function costSummaryForPrompt(rc: RepoCosts | null): string {
  if (!rc || Object.keys(rc.items).length === 0) return 'No spend was recorded for this repo.'
  const rows = Object.entries(rc.items)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, 40)
    .map(([k, it]) => `- ${itemLabel(k)}${it.title ? ` ${it.title}` : ''}: ${formatUsd(it.usd)}, ${it.attempts} attempt(s), ${formatDuration(it.ms)}${it.outcome ? `, ${it.outcome}` : ''}`)
  return `Total recorded for ${rc.repo}: ${formatUsd(rc.usd)}.\n${rows.join('\n')}`
}

export type StatusInput = {
  state: FactoryState
  settings: Settings
  items: readonly Item[]
  blocked: ReadonlyMap<string, string>
  stage: Stage | null
  now: number
  runUsd: number | null
  itemUsd: number | null
}

export function statusReport(x: StatusInput): string {
  const { state: s, settings } = x
  const blockedSet = new Set(x.blocked.keys())
  const head = `Factory: ${s.approved ? (s.autopilot && !s.unreadable ? 'running' : `paused (${s.pausedReason ?? 'stopped'})`) : 'design not approved'}${settings.stopAfterVersion ? `; stops after version ${settings.stopAfterVersion}` : ''}`
  const lines = [head, summarize(x.items as Item[], blockedSet)]
  const cur = s.current ? x.items.find(i => i.id === s.current) : undefined
  if (s.current) {
    const evs = s.events.filter(e => e.itemId === s.current)
    const started = [...evs].reverse().find(e => e.kind === 'started')
    const pr = [...evs].reverse().find(e => e.kind === 'pr-opened')
    const parts = [
      `stage ${x.stage ?? 'build'}`,
      `attempt ${s.attempts + 1}/${settings.maxAttempts + 1}`,
      `review round ${s.reviewRounds}/${settings.maxReviewRounds}`,
      pr ? `PR${pr.pr !== undefined ? ` #${pr.pr}` : ''}${pr.url ? ` ${pr.url}` : ''}` : 'no PR yet',
      started ? `${formatDuration(x.now - started.ts)} elapsed` : null,
      x.itemUsd !== null ? `${formatUsd(x.itemUsd)} spent` : null,
      s.reviewAgentId ? `review agent ${s.reviewAgentId} pending` : null,
    ].filter(Boolean)
    lines.push(`Current: ${s.current}${cur ? ` [${cur.type}] ${cur.title}` : ''}: ${parts.join(', ')}`)
  }
  if (x.runUsd === null && settings.budgetUsd > 0) {
    lines.push(`This run: spend cannot be read (the session reports no cost or the ledger is unavailable), so the ${formatUsd(settings.budgetUsd)} budget cannot be enforced and the loop pauses instead of running unmetered`)
  }
  if (x.runUsd !== null) {
    lines.push(`This run: ${formatUsd(x.runUsd)}${settings.budgetUsd > 0 ? ` of the ${formatUsd(settings.budgetUsd)} budget` : ' (no budget set)'}, ${s.doneThisRun} item(s) merged`)
  }
  const queue = x.items.filter(i => i.status === 'todo' && !blockedSet.has(i.id) && i.id !== s.current && inScope(i, settings.stopAfterVersion))
  lines.push(`Queue: ${queue.length > 0 ? queue.map(i => i.id).join(', ') : '(empty)'}`)
  if (x.blocked.size > 0) {
    lines.push('Blocked:')
    for (const [id, why] of x.blocked) lines.push(`- ${id}: ${cleanText(why).slice(0, 160) || '(no reason given)'}`)
    lines.push(`Notes are in ${BLOCKED_DIR}/; /factory-retry <ID> makes one eligible again.`)
  }
  const last = s.events.slice(-5)
  if (last.length > 0) lines.push(`Recent: ${last.map(shortEvent).join(' · ')} (/factory-log for the timeline)`)
  lines.push('Items:')
  for (const i of x.items) {
    const tag = blockedSet.has(i.id) ? 'blocked' : i.status
    const v = i.version ? ` v${i.version}` : ''
    const out = inScope(i, settings.stopAfterVersion) ? '' : ' (after stop version)'
    lines.push(`- ${i.id} [${i.type}]${v} ${tag}${s.current === i.id ? ' (current)' : ''}${out}: ${i.title}`)
  }
  return safeLines(lines.join('\n'))
}

export function planComplete(items: readonly Item[]): boolean {
  return items.length > 0 && items.every(i => i.status === 'done')
}

export function shouldAskRoadmap(settings: Pick<Settings, 'askNextPhase'>, state: Pick<FactoryState, 'approved' | 'roadmapAsked'>, items: readonly Item[]): boolean {
  return settings.askNextPhase && state.approved && !state.roadmapAsked && planComplete(items)
}

export function nextItemId(items: readonly Item[]): string {
  let prefix = 'T'
  let max = 0
  let width = 3
  for (const i of items) {
    const m = /^([A-Z]+)-(\d+)$/.exec(i.id)
    if (!m) continue
    const n = Number(m[2])
    if (n >= max) {
      max = n
      prefix = m[1]!
      width = Math.max(3, m[2]!.length)
    }
  }
  return `${prefix}-${String(max + 1).padStart(width, '0')}`
}

export const ROADMAP_IDLE_MS = 1800000
export const ROADMAP_MAX_TURNS = 40
export const ROADMAP_CEILING_MS = 4 * 3600000
export const ROADMAP_DONE = 'ROADMAP-DONE'

export const roadmapExpired = (startedAt: number, lastAt: number, turns: number, now: number): boolean =>
  now - lastAt >= ROADMAP_IDLE_MS || turns >= ROADMAP_MAX_TURNS || now - startedAt >= ROADMAP_CEILING_MS

export const isRoadmapDone = (answer: string): boolean => /(?:^|\n)[ \t]*ROADMAP-DONE[ \t]*$/.test(answer.trimEnd())

export function roadmapPrompt(items: readonly Item[], mergedIds: readonly string[], costSummary: string, s: Settings): string {
  const done = items.filter(i => i.status === 'done')
  const shipped = done.length > 0 ? done.map(i => `- ${i.id} [${i.type}]${i.version ? ` v${i.version}` : ''} ${i.title}${mergedIds.includes(i.id) ? ' (PR merged by the factory)' : ''}`).join('\n') : '- (nothing recorded as done)'
  return `CODE FACTORY: NEXT-PHASE INTERVIEW. Every item in .factory/todo.md is done. Nothing is built in this phase: do not start implementing, do not create factory/* branches, do not open PRs.

What shipped (from .factory/todo.md and the factory state):
${shipped}

What it cost (from the factory's spend ledger, US dollars):
${costSummary}

Do this:
1. Read .factory/design.md, .factory/todo.md and \`gh pr list --state merged --limit 30\`, then give the person a short summary of what shipped and what it cost (use the figures above; name the most expensive items).
2. Interview the person with the AskUserQuestion tool about the NEXT phase, in short rounds (1-4 questions each), offering 2-4 concrete options with your recommendation first:
   a. Goals of the next phase, and what is explicitly out of scope.
   b. Versions: the next version milestone(s), what each contains, and WHICH VERSION THE LOOP MUST STOP AFTER (settings.stopAfterVersion), and whether to cut a release.
   c. The concrete items (features, bug fixes, chores, docs) in priority order.
   d. For each item, the HOW decision (tool, library, algorithm or workaround, the rejected alternatives and why), the acceptance criteria, and the tests that verify it. The build loop cannot ask later, so settle every decision now.
   Always offer "nothing more, stop here" as an option. If the person chooses it, write nothing, change no files, and end by saying the work is complete.
3. Otherwise record the agreed phase:
   - Append the new items to .factory/todo.md in the existing format, with "- status: proposed", ids continuing the numbering (the next id is ${nextItemId(items)}), and every field filled (version, how, accept, tests, depends). Do not change existing items.
   - Update .factory/design.md: the new goals, the version plan, and one "## Decisions" entry per new decision.
   - Update .factory/settings.json only where the person decided so (for example stopAfterVersion).
4. Read the new items back as a short summary and ask the person to confirm; change the files until they do.
5. Do not commit, push, stage, branch or open a PR: leave the edits in the working tree (the factory refuses commits and pushes to the base branch during this turn). Finish by telling the person to commit and push the three design files to the base branch themselves, giving them exactly these lines (they are for the person):
${designPushSteps(s.baseBranch)}
   and then to run /factory-start after /factory-approve passes. These commands are for the person: do not run any of them yourself, do not start building, and do not edit the factory's state files.
6. End the FINAL message of this interview with a last line containing only ${ROADMAP_DONE}: after the person confirmed the recorded items, or after they chose "nothing more, stop here". Never put that line in an earlier message.`
}
