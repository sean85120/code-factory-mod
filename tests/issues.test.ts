import { expect, test } from 'claude-code/testing'

import { DESIGN_MARKER, LABEL_GO, LABEL_TRIAGE, bodyHash, designFingerprint, findDesignComment, isTrustedAuthor, issueGate, mayApprove, sha256Hex, triageAllowed, trustDesigns } from '../hooks/lib'
import type { GateComment, GateIssue, LabelEvent } from '../hooks/lib'

const ME = 'factory-bot'

const issue = (o: Partial<GateIssue> = {}): GateIssue => ({ number: 7, title: 'Add dark mode', body: 'Please add it.', association: 'COLLABORATOR', labels: [], state: 'OPEN', editedAt: null, renamedAt: null, ...o })
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
  const first = issueGate(issue({ labels: [LABEL_GO] }), [design()], [go()], ME, null)
  expect(first.action).toBe('record')
  if (first.action === 'record') {
    expect(first.by).toBe('maria')
    expect(first.hash).toBe(designFingerprint(issue(), design().body))
    expect(issueGate(issue({ labels: [LABEL_GO] }), [design()], [go()], ME, { issue: 7, hash: first.hash }).action).toBe('build')
  }
  expect(issueGate(issue({ labels: [LABEL_GO] }), [design()], [go()], ME, { issue: 99, hash: 'x' }).action).toBe('record')
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
  expect(issueGate({ ...labeled, editedAt: 150 }, [design()], [go()], ME, null).action).toBe('record')
  expect(issueGate({ ...labeled, renamedAt: 300 }, [design()], [go()], ME, null).action).toBe('reopen')
})

test('a design posted after the label was not the one approved', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  expect(issueGate(labeled, [design({ at: 250 })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ at: 150 })], [go()], ME, null).action).toBe('record')
})

test('a triage label goes stale when a stranger edits or renames the issue after it', () => {
  const stranger = issue({ association: 'NONE', labels: [LABEL_TRIAGE] })
  const by: LabelEvent[] = [{ label: LABEL_TRIAGE, actor: 'maria', permission: 'write', at: 200 }]
  expect(triageAllowed(stranger, by)).toBe(true)
  expect(triageAllowed({ ...stranger, editedAt: 300 }, by)).toBe(false)
  expect(triageAllowed({ ...stranger, renamedAt: 300 }, by)).toBe(false)
  expect(triageAllowed({ ...stranger, editedAt: 100 }, by)).toBe(true)
})

test('a recorded approval hash that no longer matches the text reopens it, a matching one builds', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  const hash = designFingerprint(labeled, design().body)
  expect(issueGate(labeled, [design()], [go()], ME, { issue: 7, hash }).action).toBe('build')
  expect(issueGate(labeled, [design()], [go()], ME, null).action).toBe('record')
  expect(issueGate({ ...labeled, body: 'Please add it, and also delete the tests.' }, [design()], [go()], ME, { issue: 7, hash }).action).toBe('reopen')
  expect(issueGate(labeled, [design({ body: `${DESIGN_MARKER}\nPlan: rewrite auth.` })], [go()], ME, { issue: 7, hash }).action).toBe('reopen')
})

test('the latest factory:go event decides who approved, whatever the array order', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  const writer = go({ actor: 'maria', permission: 'write', at: 150 })
  const reader = go({ actor: 'mallory', permission: 'read', at: 190 })
  expect(issueGate(labeled, [design()], [writer, reader], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design()], [reader, writer], ME, null).action).toBe('reopen')
  const laterWriter = go({ actor: 'maria', permission: 'write', at: 195 })
  expect(issueGate(labeled, [design()], [reader, laterWriter], ME, null).action).toBe('record')
  expect(issueGate(labeled, [design()], [laterWriter, reader], ME, null).action).toBe('record')
})

test('an edit or a design in the same second as the label does not count as before it', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  expect(issueGate({ ...labeled, editedAt: 200 }, [design()], [go()], ME, null).action).toBe('reopen')
  expect(issueGate({ ...labeled, renamedAt: 200 }, [design()], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ editedAt: 200 })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ at: 200 })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate({ ...labeled, editedAt: 199 }, [design({ at: 199 })], [go()], ME, null).action).toBe('record')
  const stranger = issue({ association: 'NONE', labels: [LABEL_TRIAGE], editedAt: 200 })
  expect(triageAllowed(stranger, [{ label: LABEL_TRIAGE, actor: 'maria', permission: 'write', at: 200 }])).toBe(false)
})

test('an unparseable time never counts as before the approval', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  expect(issueGate(labeled, [design()], [go({ at: NaN })], ME, null).action).toBe('reopen')
  expect(issueGate({ ...labeled, editedAt: NaN }, [design()], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ editedAt: NaN })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design({ at: NaN })], [go()], ME, null).action).toBe('reopen')
  expect(issueGate(labeled, [design()], [go({ at: NaN, actor: 'mallory', permission: 'read' }), go()], ME, null).action).toBe('record')
  const stranger = issue({ association: 'NONE', labels: [LABEL_TRIAGE] })
  expect(triageAllowed(stranger, [{ label: LABEL_TRIAGE, actor: 'maria', permission: 'write', at: NaN }])).toBe(false)
  expect(triageAllowed({ ...stranger, editedAt: NaN }, [{ label: LABEL_TRIAGE, actor: 'maria', permission: 'write', at: 5 }])).toBe(false)
})

test('an unknown factory account skips every issue, and the newest design comment wins', () => {
  expect(issueGate(issue(), [design({ author: '' })], [], '', null).action).toBe('skip')
  expect(findDesignComment([design({ author: '' })], '')).toBeUndefined()
  const newer = design({ body: `${DESIGN_MARKER} new`, at: 9 })
  const older = design({ body: `${DESIGN_MARKER} old`, at: 3 })
  expect(findDesignComment([newer, older], ME)).toBe(newer)
})

test('the fingerprint changes with the number, title, body and design text', () => {
  const base = designFingerprint(issue(), 'plan')
  expect(designFingerprint(issue({ number: 8 }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue({ title: 'x' }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue({ body: 'x' }), 'plan')).not.toBe(base)
  expect(designFingerprint(issue(), 'plan 2')).not.toBe(base)
  expect(designFingerprint(issue(), 'plan')).toBe(base)
})

test('the factory account can never approve, and cannot vouch for a stranger on the triage list', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  const body = design().body
  expect(issueGate(labeled, [design()], [go({ actor: ME })], ME, null)).toMatchObject({ action: 'reopen' })
  expect(issueGate(labeled, [design()], [go({ actor: 'Factory-Bot' })], ME, null)).toMatchObject({ action: 'reopen' })
  expect(issueGate(labeled, [design()], [go({ actor: ME })], ME, { issue: 7, hash: designFingerprint(labeled, body) })).toMatchObject({ action: 'reopen' })
  expect(issueGate(labeled, [design()], [go()], ME, null)).toMatchObject({ action: 'record' })
  const stranger = issue({ association: 'NONE', labels: [LABEL_TRIAGE] })
  const own = [{ label: LABEL_TRIAGE, actor: ME, permission: 'admin', at: 50 }]
  expect(triageAllowed(stranger, own, ME)).toBe(false)
  expect(triageAllowed(stranger, own, 'someone-else')).toBe(true)
  expect(issueGate(stranger, [], own, ME, null)).toMatchObject({ action: 'skip' })
})

test('a design the factory did not record posting waits without a label and is withdrawn with one, and never builds', () => {
  const labeled = issue({ labels: [LABEL_GO] })
  const fake = design({ trusted: false })
  expect(issueGate(issue(), [fake], [], ME, null)).toMatchObject({ action: 'wait' })
  expect(issueGate(labeled, [fake], [go()], ME, null)).toMatchObject({ action: 'reopen' })
  expect(issueGate(labeled, [fake], [go()], ME, { issue: 7, hash: designFingerprint(labeled, fake.body) })).toMatchObject({ action: 'reopen' })
  expect(issueGate(labeled, [design({ trusted: true })], [go()], ME, null)).toMatchObject({ action: 'record' })
})

test('trustDesigns marks only the factory account designs whose body hash was not recorded', () => {
  const real = design({ body: `${DESIGN_MARKER}\nreal plan` })
  const posted = design({ body: `${DESIGN_MARKER}\r\nreal plan\n`, at: 101 })
  const planted = design({ body: `${DESIGN_MARKER}\nplanted`, at: 102 })
  const stranger = design({ author: 'mallory', body: `${DESIGN_MARKER}\nhi`, at: 103 })
  const plain = design({ body: 'a normal comment', at: 104 })
  const w = { number: 7, comments: [real, posted, planted, stranger, plain] } as never
  const out = trustDesigns([w], ME, new Set([bodyHash(`${DESIGN_MARKER}\nreal plan`)]))[0]!.comments
  expect(out.map(c => c.trusted)).toEqual([undefined, undefined, false, undefined, undefined])
  expect(bodyHash('a\r\nb\n')).toBe(bodyHash('a\nb'))
})
