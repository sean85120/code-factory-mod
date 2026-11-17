import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { Host, Run, Runtime } from './factory.ts'

const OUTPUT_CAP = 4 * 1024 * 1024

// File and process access for a host that runs on Node or Bun (both OpenCode
// and Codex do). Paths are relative to the repository the session works in.
export type Io = Pick<Host, 'run' | 'read' | 'exists' | 'write' | 'list' | 'remove'>

export function nodeIo(dir: string): Io {
  const abs = (p: string): string => (isAbsolute(p) ? p : join(dir, p))
  return {
    run(argv: string[], timeoutMs = 60000): Promise<Run> {
      return new Promise(resolve => {
        if (argv.length === 0) {
          resolve({ exitCode: 127, stdout: '', stderr: 'empty command' })
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const done = (r: Run): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(r)
        }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env: { ...process.env, CI: '1', GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
          resolve({ exitCode: 127, stdout: '', stderr: `could not run ${argv.slice(0, 3).join(' ')}: ${String(err)}` })
          return
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done({ exitCode: 124, stdout, stderr: `${stderr}\n${argv.slice(0, 3).join(' ')} ran past ${Math.round(timeoutMs / 1000)}s` })
        }, timeoutMs)
        child.stdout?.on('data', (b: Buffer) => {
          if (stdout.length < OUTPUT_CAP) stdout += b.toString()
        })
        child.stderr?.on('data', (b: Buffer) => {
          if (stderr.length < OUTPUT_CAP) stderr += b.toString()
        })
        child.on('error', err => done({ exitCode: 127, stdout, stderr: `could not run ${argv.slice(0, 3).join(' ')} (not installed?): ${String(err)}` }))
        child.on('close', code => done({ exitCode: code ?? 1, stdout, stderr }))
      })
    },
    async read(p: string): Promise<string | null> {
      try {
        return await readFile(abs(p), 'utf8')
      } catch {
        return null
      }
    },
    async exists(p: string): Promise<boolean> {
      try {
        await stat(abs(p))
        return true
      } catch {
        return false
      }
    },
    async write(p: string, text: string): Promise<void> {
      await writeAtomic(abs(p), text)
    },
    async list(p: string): Promise<string[]> {
      try {
        return await readdir(abs(p))
      } catch {
        return []
      }
    },
    async remove(p: string): Promise<void> {
      await rm(abs(p), { force: true })
    },
  }
}

export const EMPTY_RUNTIME: Runtime = { epoch: 0, turn: null, nonce: '' }

export function parseRuntime(raw: unknown): Runtime {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Runtime>) : {}
  const turn = r.turn && typeof r.turn === 'object' && (r.turn.kind === 'work' || r.turn.kind === 'design') && Number.isFinite(r.turn.at) ? { kind: r.turn.kind, at: r.turn.at, owner: typeof r.turn.owner === 'string' ? r.turn.owner : '' } : null
  return { epoch: Number.isFinite(r.epoch) ? Number(r.epoch) : 0, turn, nonce: typeof r.nonce === 'string' ? r.nonce : '' }
}

// Runtime flags kept outside the repository, one file per working tree, for a
// host whose hooks run as separate processes (Codex).
export function fileRuntime(dataDir: string, repoDir: string): { load: () => Promise<Runtime>; save: (r: Runtime) => Promise<void> } {
  const file = join(dataDir, `runtime-${createHash('sha256').update(repoDir).digest('hex').slice(0, 16)}.json`)
  return {
    async load(): Promise<Runtime> {
      try {
        return parseRuntime(JSON.parse(await readFile(file, 'utf8')))
      } catch {
        return { ...EMPTY_RUNTIME }
      }
    },
    async save(r: Runtime): Promise<void> {
      await writeAtomic(file, JSON.stringify(r))
    },
  }
}

// Hooks of one session can run as concurrent processes: a reader must never see
// a half-written file, so files are written beside the target and renamed over it.
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

// Paths are compared after symlinks are resolved (on macOS /var is /private/var).
export function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

// The top folder of the git repository holding `start` (a .git folder or a
// worktree's .git file), or null outside one.
export function repoTop(start: string): string | null {
  let d = real(start)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

// A git or gh command run from another repository or worktree: the gates read
// the factory repository's branch and HEAD, so they would check it against the
// wrong branch.
export function gitElsewhere(command: string, root: string, callDir: string | null): boolean {
  if (!callDir || !/\b(?:git|gh)\b/.test(command)) return false
  const top = repoTop(resolve(root, callDir))
  return top !== null && top !== repoTop(root)
}

export const GIT_ELSEWHERE_DENY = "code-factory: run git and gh commands from the factory's repository while the loop runs, not from another worktree or clone."
