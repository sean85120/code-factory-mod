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
  releasedVersion: string | null
  releaseAttempts: number
  mergedIds: string[]
  approvedDone: string[]
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
  releasedVersion: null,
  releaseAttempts: 0,
  mergedIds: [],
  approvedDone: [],
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
    problems.push(`${SETTINGS_PATH} is missing.`)
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
  if (Array.isArray(raw.e2eFor)) {
    s.e2eFor = raw.e2eFor.filter((x): x is ItemType => ['feature', 'bug', 'chore', 'docs'].includes(String(x)))
  }
  if (typeof raw.requireReview === 'boolean') s.requireReview = raw.requireReview
  if (typeof raw.reviewCommand === 'string' && raw.reviewCommand.trim()) s.reviewCommand = raw.reviewCommand.trim()
  if (typeof raw.maxReviewRounds === 'number' && raw.maxReviewRounds >= 1) s.maxReviewRounds = Math.floor(raw.maxReviewRounds)
  if (raw.contextReset === 'clear' || raw.contextReset === 'compact' || raw.contextReset === 'none') {
    s.contextReset = raw.contextReset
  }
  if (typeof raw.tagRelease === 'boolean') s.tagRelease = raw.tagRelease
  if (typeof raw.requireBranchProtection === 'boolean') s.requireBranchProtection = raw.requireBranchProtection
  if (typeof raw.allowTestRemoval === 'boolean') s.allowTestRemoval = raw.allowTestRemoval
  if (raw.stopAfterVersion !== undefined && raw.stopAfterVersion !== null) {
    const v = String(raw.stopAfterVersion).replace(/^v/i, '')
    if (parseVersion(v)) s.stopAfterVersion = v
    else problems.push('settings.json `stopAfterVersion` must look like 0.3 or 1.0.0 (or be null).')
  }
  if (typeof raw.allowNoCI === 'boolean') s.allowNoCI = raw.allowNoCI
  if (typeof raw.requireTestChanges === 'boolean') s.requireTestChanges = raw.requireTestChanges
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
  return fnv1a(JSON.stringify([settings, frozen]))
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
}

const unquote = (t: string): string => t.replace(/^['"]+|['"]+$/g, '')

// Splits a shell line into simple commands of tokens: on ; && || | & and
// newlines outside quotes, skipping heredoc bodies. Best effort, not a parser.
export function splitCommands(command: string): string[][] {
  const commands: string[][] = []
  let heredoc: string | null = null
  for (const line of command.split(/\r?\n/)) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null
      continue
    }
    const h = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line)
    let cur: string[] = []
    let tok = ''
    let quote = ''
    const pushTok = () => {
      if (tok !== '') cur.push(unquote(tok))
      tok = ''
    }
    const pushCmd = () => {
      pushTok()
      if (cur.length > 0) commands.push(cur)
      cur = []
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote) {
        tok += c
        if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        tok += c
      } else if (c === '\\' && i + 1 < line.length) {
        tok += line[i + 1]!
        i++
      } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
        pushCmd()
      } else if (c === ' ' || c === '\t') pushTok()
      else tok += c
    }
    pushCmd()
    if (h) heredoc = h[1]!
  }
  return commands
}

const PREFIXES = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec', 'builtin'])

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
      const action = t[i + 1]
      const rest = t.slice(i + 2)
      if (sub === 'pr' && action === 'create') facts.isPrCreate = true
      else if (sub === 'pr' && action === 'merge') {
        facts.isPrMerge = true
        let j = 0
        while (j < rest.length) {
          const x = rest[j]!
          if (x === '--admin') facts.hasAdmin = true
          else if (x === '--auto') facts.hasAuto = true
          if (x.startsWith('-')) j += MERGE_VALUE_FLAGS.has(x) ? 2 : 1
          else {
            if (facts.prSelector === null) facts.prSelector = x
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
          if (x === '-X' || x === '--method') method = (args[++j] ?? '').toUpperCase()
          else if (x.startsWith('--method=')) method = x.slice(9).toUpperCase()
          else if (x === '-f' || x === '-F' || x === '--field' || x === '--raw-field' || x === '--input') {
            hasBody = true
            j++
          } else if (x.startsWith('-')) {
            if (API_VALUE_FLAGS.has(x)) j++
          } else if (!endpoint) endpoint = x
        }
        const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method || (hasBody ? 'POST' : 'GET'))
        if (writes && /\/pulls(?:\/\d+\/(?:merge|update-branch))?\/?$|\/git\/(?:refs|commits)|\/contents\/|\/merges$/.test(endpoint)) {
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
3. Record everything as you go, so it survives the session:
   - .factory/design.md: overview, non-goals, architecture, version plan, and a "## Decisions" section (one entry per decision: question, options, choice, why).
   - .factory/settings.json: {"baseBranch":"main","testCmd":["bash","-lc","<full test command>"],"buildCmd":["bash","-lc","<build command>"],"e2eCmd":["bash","-lc","<e2e command>"],"e2eFor":["feature","bug"],"testTimeoutMs":600000,"mergeMethod":"squash","maxAttempts":4,"maxItemsPerRun":0,"allowNoCI":false,"requireTestChanges":true,"requireReview":true,"reviewCommand":"/review-fix","maxReviewRounds":5,"contextReset":"clear","stopAfterVersion":"<e.g. 0.3.0>","tagRelease":false,"requireBranchProtection":false,"allowTestRemoval":false}   (omit buildCmd/e2eCmd only if the person says there is nothing to build or no UI; each command may run at most 10 minutes)
   - .factory/todo.md in exactly this format, in priority order, one block per item:
       ## T-001 [feature] Short title      (type is feature, bug, chore or docs)
       - status: proposed
       - version: 0.1.0
       - how: the chosen tool/algorithm/workaround and why (one or more lines, continuation lines indented by two spaces)
       - accept: acceptance criteria that can be checked
       - tests: what unit and e2e tests will be written and what they assert
       - depends: T-000 (optional)
   - The factory creates .factory/.gitignore itself; do not edit it.
4. When the person confirms the design is complete, read it back as a short summary, then tell them to run /factory-approve to validate it and unlock the build loop, and /factory-start to run it. Do not run those yourself and do not edit the factory's state file.`

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
Wait for it. Its answer ends with a FACTORY-REVIEW line; the factory reads it and only lets the PR open when it shows danger=0 medium=0 for the current HEAD. If it shows findings you may spawn a new reviewer again (at most ${s.maxReviewRounds} rounds in total); if it is still not clean after that, write .factory/blocked/${item.id}.md and stop.
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

export function buildView(
  items: readonly Item[],
  state: FactoryState,
  blocked: ReadonlySet<string>,
  stopAfterVersion: string | null,
  prev: FactoryView | null,
): FactoryView {
  const scoped = items.filter(i => inScope(i, stopAfterVersion))
  const markOf = (i: Item): Mark => (blocked.has(i.id) ? 'blocked' : state.current === i.id && i.status !== 'proposed' ? 'doing' : i.status)
  const all: ViewRow[] = scoped.map(i => ({ id: i.id, type: i.type, title: i.title, version: i.version, mark: markOf(i) }))
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
    running: state.autopilot,
    pausedReason: state.pausedReason,
    current: state.current,
    stage,
    summary: summarize(items as Item[], blocked),
    doneCount: all.length - open.length,
    rows: open.slice(0, VIEW_ROWS),
    more: Math.max(0, open.length - VIEW_ROWS),
    marks,
    changes: [...(prev?.changes ?? []), ...fresh].slice(-VIEW_CHANGES),
  }
}
