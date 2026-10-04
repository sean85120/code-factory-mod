export type Stage = 'build' | 'review' | 'PR' | 'CI' | 'merge'
export type Mark = 'done' | 'doing' | 'todo' | 'blocked' | 'proposed'
export type ViewRow = { id: string; type: 'feature' | 'bug' | 'chore' | 'docs'; title: string; version: string; mark: Mark }
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
}

declare module 'claude-code' {
  interface PluginState {
    'code-factory': { view: FactoryView | null }
  }
}
