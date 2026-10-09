export type Stage = 'build' | 'review' | 'PR' | 'CI' | 'merge'
export type Mark = 'done' | 'doing' | 'todo' | 'blocked' | 'proposed'
export type ViewRow = { id: string; type: 'feature' | 'bug' | 'chore' | 'docs'; title: string; version: string; mark: Mark }
export type StepState = 'done' | 'doing' | 'todo'
export type Step = { label: string; state: StepState; detail: string }
export type AgentRow = { id: string; label: string; kind: string; status: string; summary: string; recent: string[]; parent: string | null }
export type BlockedRow = { id: string; title: string; reason: string }
export type DoctorCheck = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }
export type FactoryView = {
  approved: boolean
  running: boolean
  pausedReason: string | null
  current: string | null
  stage: Stage | null
  summary: string
  doneCount: number
  rows: ViewRow[]
  more: number
  marks: Record<string, Mark>
  changes: string[]
  runUsd: number | null
  itemUsd: number | null
  budgetUsd: number
  events: string[]
  total?: number
  blockedCount?: number
  attempt?: number
  maxAttempts?: number
  reviewRound?: number
  maxReviewRounds?: number
  prNumber?: number | null
  elapsedMs?: number | null
  steps?: Step[]
  agents?: AgentRow[]
  blocked?: BlockedRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'code-factory': { view: FactoryView | null; openAgent: string | null; skipTarget: string | null; checks: DoctorCheck[] | null }
  }
}
