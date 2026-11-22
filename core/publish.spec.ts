import assert from 'node:assert/strict'
import { test } from 'node:test'

import { publishDesignWith } from '../hooks/lib.ts'
import type { GitInit, GitRun } from '../hooks/lib.ts'

const SHA40 = 'c'.repeat(40)
const PARENT = 'a'.repeat(40)
const BLOB = 'b'.repeat(40)
const TREE = 'd'.repeat(40)
const OLD = 'e'.repeat(40)
const NEW = 'f'.repeat(40)

type Knobs = { refuse?: boolean; baseBlob?: Record<string, string>; headBlob?: Record<string, string>; branch?: string; head?: string; treeBlob?: string; ahead?: boolean; prefix?: string; noCommit?: boolean }

function fake(k: Knobs = {}) {
  const calls: string[] = []
  const stdins: string[] = []
  const indexes = new Set<string>()
  const ok = (stdout = ''): GitRun => ({ exitCode: 0, stdout, stderr: '' })
  const bad = (stderr = ''): GitRun => ({ exitCode: 1, stdout: '', stderr })
  const run = async (argv: string[], init: GitInit = {}): Promise<GitRun> => {
    const cmd = argv.join(' ')
    calls.push(cmd)
    const index = init.env?.GIT_INDEX_FILE
    if (index) indexes.add(index)
    const mine = typeof index === 'string' && /^\/repo\/\.git\/factory-design-.*\.index$/.test(index)
    if (cmd === 'git rev-parse --show-prefix') return ok(k.prefix ?? '')
    if (cmd === 'git rev-parse --absolute-git-dir') return ok('/repo/.git\n')
    if (cmd === 'git rev-parse --verify origin/main^{commit}') return ok(`${PARENT}\n`)
    const baseAt = /^git rev-parse --verify -q origin\/main:(.+)$/.exec(cmd)
    if (baseAt) return k.baseBlob?.[baseAt[1]!] ? ok(`${k.baseBlob[baseAt[1]!]}\n`) : bad()
    const headAt = /^git rev-parse --verify -q HEAD:(.+)$/.exec(cmd)
    if (headAt) return k.headBlob?.[headAt[1]!] ? ok(`${k.headBlob[headAt[1]!]}\n`) : bad()
    if (cmd === 'git hash-object -w --stdin') {
      stdins.push(init.stdin ?? '')
      return ok(`${BLOB}\n`)
    }
    if (cmd === 'git write-tree') return mine ? ok(`${TREE}\n`) : bad('no private index')
    if (cmd.startsWith(`git rev-parse ${TREE}:`)) return ok(`${k.treeBlob ?? BLOB}\n`)
    if (cmd === 'git merge-base --is-ancestor origin/main HEAD') return k.ahead ? ok() : bad()
    if (cmd.startsWith('git commit-tree')) return k.noCommit ? bad('Author identity unknown') : ok(`${SHA40}\n`)
    if (cmd.startsWith('git push origin')) return k.refuse ? bad('remote: protected branch') : ok()
    if (/^git (read-tree|update-index)/.test(cmd)) return mine ? ok() : bad('no private index')
    if (cmd === 'git branch --show-current') return ok(`${k.branch ?? 'feature'}\n`)
    if (cmd === 'git rev-parse HEAD') return ok(`${k.head ?? NEW}\n`)
    return ok()
  }
  return { run, calls, stdins, indexes }
}

const FILES = [
  { path: '.factory/settings.json', text: '{}\n' },
  { path: '.factory/todo.md', text: '# Todo\n' },
  { path: '.factory/design.md', text: '# Design\n' },
  { path: '.factory/.gitignore', text: 'blocked/\n' },
]
const pushed = (calls: string[]): boolean => calls.some(c => c.startsWith('git push origin'))

test('publishes with a private index and a fast-forward push, no checkout, and cleans up', async () => {
  const f = fake()
  const r = await publishDesignWith(f.run, 'main', FILES, [])
  assert.deepEqual(r, { sha: SHA40 })
  assert.equal(f.calls.find(c => c.startsWith('git commit-tree')), `git commit-tree ${TREE} -p ${PARENT} -m Code factory design`)
  assert.equal(f.calls.find(c => c.startsWith('git push origin')), `git push origin ${SHA40}:refs/heads/main`)
  assert.equal(f.calls.some(c => /--force|\+refs|checkout|git add|git commit /.test(c)), false)
  assert.deepEqual(f.calls.filter(c => c.startsWith('git update-index')).map(c => c.split(',')[2]), FILES.map(x => x.path))
  assert.equal(f.stdins[2], '# Design\n')
  assert.equal(f.indexes.size, 1)
  const [index] = [...f.indexes]
  assert.equal(f.calls.at(-1), `rm -f ${index} ${index}.lock`)
})

test('leaves an existing base .gitignore alone and syncs the base branch it stands at the old tip', async () => {
  const f = fake({ baseBlob: { '.factory/.gitignore': OLD }, branch: 'main', head: PARENT })
  const r = await publishDesignWith(f.run, 'main', FILES, [])
  assert.deepEqual(r, { sha: SHA40 })
  assert.equal(f.calls.filter(c => c.startsWith('git update-index')).some(c => c.includes('.gitignore')), false)
  assert.ok(f.calls.includes(`git update-ref refs/heads/main ${SHA40} ${PARENT}`))
  assert.ok(f.calls.includes('git reset -q -- .factory/settings.json .factory/todo.md .factory/design.md'))
})

test('leaves a local base branch that is not at the old tip alone', async () => {
  const f = fake({ branch: 'main', head: NEW })
  assert.deepEqual(await publishDesignWith(f.run, 'main', FILES, []), { sha: SHA40 })
  assert.equal(f.calls.some(c => c.startsWith('git update-ref')), false)
})

test('refuses to overwrite a base version the checkout does not have, pushing nothing', async () => {
  const f = fake({ baseBlob: { '.factory/todo.md': OLD }, headBlob: { '.factory/todo.md': NEW } })
  const r = await publishDesignWith(f.run, 'main', FILES, ['.factory/todo.md'])
  assert.ok('error' in r && /update your checkout \(git pull\) first/.test(r.error))
  assert.equal(pushed(f.calls), false)
  assert.equal(f.calls.some(c => c.startsWith('git commit-tree')), false)
})

test('publishes a file the checkout committed ahead of the base', async () => {
  const f = fake({ ahead: true, baseBlob: { '.factory/todo.md': OLD }, headBlob: { '.factory/todo.md': NEW } })
  assert.deepEqual(await publishDesignWith(f.run, 'main', FILES, ['.factory/todo.md']), { sha: SHA40 })
})

test('refuses when the head blob is missing for a changed file', async () => {
  const f = fake({ baseBlob: { '.factory/todo.md': OLD } })
  const r = await publishDesignWith(f.run, 'main', FILES, ['.factory/todo.md'])
  assert.ok('error' in r && /git pull/.test(r.error))
  assert.equal(pushed(f.calls), false)
})

test('pushes nothing when the tree does not hold what was stored', async () => {
  const f = fake({ treeBlob: '9'.repeat(40) })
  const r = await publishDesignWith(f.run, 'main', FILES, [])
  assert.ok('error' in r && /did not hold/.test(r.error))
  assert.equal(pushed(f.calls), false)
  assert.equal(f.calls.at(-1)?.startsWith('rm -f'), true)
})

test('a refused push is reported and the index is still removed', async () => {
  const f = fake({ refuse: true })
  const r = await publishDesignWith(f.run, 'main', FILES, [])
  assert.ok('error' in r && /the push to main failed or was refused \(remote: protected branch\)/.test(r.error))
  assert.equal(f.calls.at(-1)?.startsWith('rm -f'), true)
})

test('a failed commit names the git identity', async () => {
  const r = await publishDesignWith(fake({ noCommit: true }).run, 'main', FILES, [])
  assert.ok('error' in r && /user\.name and user\.email/.test(r.error))
})

test('publishes nothing from a subdirectory of the repository', async () => {
  const f = fake({ prefix: 'sub/\n' })
  const r = await publishDesignWith(f.run, 'main', FILES, [])
  assert.ok('error' in r && /from the repository root/.test(r.error))
  assert.equal(pushed(f.calls), false)
  assert.equal(f.calls.some(c => c.startsWith('rm -f')), false)
})

test('every run is a fresh private index file', async () => {
  const a = fake()
  const b = fake()
  await publishDesignWith(a.run, 'main', FILES, [])
  await publishDesignWith(b.run, 'main', FILES, [])
  assert.notEqual([...a.indexes][0], [...b.indexes][0])
})
