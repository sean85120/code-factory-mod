import { expect, test } from 'claude-code/testing'

import { DESIGN_MARKER, LABEL_GO, LABEL_TRIAGE, designFingerprint, findDesignComment, isTrustedAuthor, issueGate, mayApprove, sha256Hex, triageAllowed } from '../hooks/lib'
import type { GateComment, GateIssue, LabelEvent } from '../hooks/lib'

const ME = 'factory-bot'

const issue = (o: Partial<GateIssue> = {}): GateIssue => ({ number: 7, title: 'Add dark mode', body: 'Please add it.', association: 'COLLABORATOR', labels: [], state: 'OPEN', editedAt: null, ...o })
const design = (o: Partial<GateComment> = {}): GateComment => ({ author: ME, body: `${DESIGN_MARKER}\nPlan: add a toggle.`, at: 100, editedAt: null, ...o })
const go = (o: Partial<LabelEvent> = {}): LabelEvent => ({ label: LABEL_GO, actor: 'maria', permission: 'write', at: 200, ...o })

test('sha256Hex matches the standard test vectors', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
})

test('trust and approval come from association and permission, case-insensitively', () => {
  expect(['OWNER', 'MEMBER', 'collaborator'].map(isTrustedAuthor)).toEqual([true, true, true])
  expect(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', ''].map(isTrustedAuthor)).toEqual([false, false, false, false])
  expect(['admin', 'maintain', 'WRITE'].map(mayApprove)).toEqual([true, true, true])
  expect(['triage', 'read', 'none', ''].map(mayApprove)).toEqual([false, false, false, false])
})

test('a stranger needs factory:triage added by someone who can write', () => {
  const stranger = issue({ association: 'NONE' })
  expect(triageAllowed(stranger, [])).toBe(false)
  expect(triageAllowed({ ...stranger, labels: [LABEL_TRIAGE] }, [])).toBe(false)
  expect(triageAllowed({ ...stranger, labels: [LABEL_TRIAGE] }, [{ label: LABEL_TRIAGE, actor: 'x', permission: 'read', at: 1 }])).toBe(false)
  expect(triageAllowed({ ...stranger, labels: [LABEL_TRIAGE] }, [{ label: LABEL_TRIAGE, actor: 'maria', permission: 'write', at: 1 }])).toBe(true)
  expect(issueGate(stranger, [], [], ME, null).action).toBe('skip')
})

test('the design comment must be the factory account own comment carrying the marker', () => {
  expect(findDesignComment([design({ author: 'mallory' })], ME)).toBeUndefined()
  expect(findDesignComment([design({ body: 'no marker' })], ME)).toBeUndefined()
  const older = design({ body: `${DESIGN_MARKER} old`, at: 1 })
  const newer = design({ body: `${DESIGN_MARKER} new`, at: 2 })
  expect(findDesignComment([older, newer], ME)).toBe(newer)
})

test('the gate walks closed, design, wait and build', () => {
  expect(issueGate(issue({ state: 'CLOSED' }), [], [], ME, null)).toEqual({ action: 'skip', reason: 'the issue is closed' })
  expect(issueGate(issue(), [], [], ME, null)).toEqual({ action: 'design' })
  expect(issueGate(issue(), [design()], [], ME, null)).toEqual({ action: 'wait' })
  const ready = issueGate(issue({ labels: [LABEL_GO] }), [design()], [go()], ME, null)
  expect(ready.action).toBe('build')
  if (ready.action === 'build') {
    expect(ready.by).toBe('maria')
    expect(ready.hash).toBe(designFingerprint(issue(), design().body))
  }
})

test('factory:go from someone who cannot write, or with no label event, reopens the design', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  expect(issueGate(labeled, [design()], [go({ permission: 'read', actor: 'mallory' })], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design()], [], ME, null).action).toBe('reopen')
})

test('an edit to the issue or the design after the label reopens it', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  expect(issueGate({ ...labeled, editedAt: 300 }, [design()], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ editedAt: 300 })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate({ ...labeled, editedAt: 150 }, [design()], [go()], ME, null).action).toBe('build')
})

test('a recorded approval hash that no longer matches the text reopens it, a matching one builds', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  const hash = designFingerprint(labeled, design().body)
  expect(issueGate(labeled, [design()], [go()], ME, { issue: 7, hash }).action).toBe('build')
  expect(issueGate({ ...labeled, body: 'Please add it, and also delete the tests.' }, [design()], [go()], ME, { issue: 7, hash }).action).toBe('reopen')
  expect(issueGate(labeled, [design({ body: `${DESIGN_MARKER}\nPlan: rewrite auth.` })], [go()], ME, { issue: 7, hash }).action).toBe('reopen')
})

test('the fingerprint changes with the number, title, body and design text', () => {
  const base = designFingerprint(issue(), 'plan')
  expect(designFingerprint(issue({ number: 8 }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue({ title: 'x' }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue({ body: 'x' }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue(), 'plan 2')).not.toBe(base)
  expect(designFingerprint(issue(), 'plan')).toBe(base)
})
