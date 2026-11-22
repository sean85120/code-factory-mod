import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeIo } from './io.ts'

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'cf-io-'))
const ECHO_STDIN = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("["+s+"]"))'

test('env reaches the child next to CI and GH_PROMPT_DISABLED', async () => {
  const io = nodeIo(await dir())
  const r = await io.run([process.execPath, '-e', 'process.stdout.write([process.env.CF_X, process.env.CI, process.env.GH_PROMPT_DISABLED].join(","))'], 20000, { env: { CF_X: 'hello' } })
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout, 'hello,1,1')
})

test('stdin reaches the child, including an empty string', async () => {
  const io = nodeIo(await dir())
  assert.equal((await io.run([process.execPath, '-e', ECHO_STDIN], 20000, { stdin: 'design text\n' })).stdout, '[design text\n]')
  assert.equal((await io.run([process.execPath, '-e', ECHO_STDIN], 20000, { stdin: '' })).stdout, '[]')
})

test('without stdin the child sees a closed input, as before', async () => {
  const io = nodeIo(await dir())
  assert.equal((await io.run([process.execPath, '-e', ECHO_STDIN])).stdout, '[]')
})

test('a child that ignores a large stdin does not hang or crash the run', async () => {
  const io = nodeIo(await dir())
  const r = await io.run([process.execPath, '-e', 'process.exit(3)'], 20000, { stdin: 'x'.repeat(5_000_000) })
  assert.equal(r.exitCode, 3)
})
