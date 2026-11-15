import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { userMessage } from './user-message.mjs'

// Chain credit (ticket x9qb): a dispatched child writer's write/edit call files
// its named path under the top parent, without any parent recorder entry, once
// the writer's own turn has ended. These tests drive the real service through
// its session/event listener, the way the host publishes events: the session
// first (with its header lineage), then { type, seq, time, data }.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-chain-')))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

function recorder(entries = new Map()) {
  return {
    entries,
    summary(sessionId, seq) { return entries.get(`${sessionId}:${seq}`) },
    async diff() { return undefined },
  }
}

let published = 0
function service({ workspaceChanges = recorder(), settingsDir = null } = {}) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = settingsDir ?? fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-chain-settings-')))
  const listeners = new Map()
  const off = () => () => {}
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) },
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off, tools: { register: off }, commands: { register: off }, systemPrompt: { section: off }, webServer: { register: off },
  }
  const instance = new CompletionGateService(ctx, {}, { settingsPath: path.join(dir, 'settings.json') })
  instance.__testSettingsDir = dir
  instance.start()
  instance.publish = (session, type, data) => {
    const id = typeof session === 'string' ? session : session.id
    listeners.get('session/event')(
      typeof session === 'string' ? { id } : session,
      { type, seq: ++published, time: Date.now(), data },
    )
  }
  instance.disposeSession = async (id, cwd = '') => { await listeners.get('session/disposed')({ id, header: cwd ? { cwd } : {} }) }
  return instance
}

// Run the body against a fresh service and remove its state directory after,
// so the cleanup in every test stays one line (a third copy of the setup
// block factors a helper instead of repeating the try/finally).
async function withCleanup(svc, body) {
  try { return await body(svc) } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
}

// Run the body with a first service and its shared state directory, for the
// restart tests that stand in a second service over the same directory.
async function withSharedSettings(body) {
  const first = service()
  const settingsDir = first.__testSettingsDir
  try { return await body(first, settingsDir) } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
}

function sessionOf(id, header = {}) { return { id, header } }
function parentOf(cwd, id = 'parent-1') { return sessionOf(id, { cwd }) }
function childOf(cwd, parentSession, id, depth) { return sessionOf(id, { cwd, parentSession, origin: 'subagent', delegationDepth: depth }) }
function agentFor(cwd, id = 'parent-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd } }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

const file = p => ({ path: p, display: p, added: 1, deleted: 0 })

function writerTurn(svc, writer, turn, args, { end = true } = {}) {
  const id = writer.id
  svc.publish(writer, 'turn/start', { turn })
  svc.publish(writer, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: args, content: 'x\n' }) })
  if (end) svc.publish(writer, 'turn/end', { turn })
}

function parentIdleTurn(svc, parent, turn) {
  svc.publish(parent, 'turn/start', { turn })
  svc.publish(parent, 'user/message', userMessage(parent.id, turn))
  svc.publish(parent, 'turn/end', { turn })
}

function announceParentTurn(svc, parent, turn, files, cwd, calls = files.map(entry => entry.path)) {
  const id = typeof parent === 'string' ? parent : parent.id
  svc.publish(parent, 'turn/start', { turn })
  svc.publish(parent, 'user/message', userMessage(id, turn))
  for (const call of calls) svc.publish(parent, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: call, content: 'x\n' }) })
  svc.publish(parent, 'workspace/changes', { turn })
  svc.changeService().entries.set(`${id}:${published}`, { turn, cwd, files, total: files.length, added: files.length, deleted: 0 })
  svc.publish(parent, 'turn/end', { turn })
}

function filesOf(report) {
  return report.repositories.flatMap(repo => repo.files.map(entry => entry.absolute)).sort()
}

// A child write in the covered repository files under the parent, with no parent
// recorder entry naming it: the parent turn announced no change record at all.
test('a child write in the covered repository files under the parent without a parent record entry', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'child.js'), 'const child = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'child.js')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(entry => entry.absolute) })),
      [{ root: repo, files: [path.join(repo, 'child.js')] }],
      'the credited child path files under the parent repository',
    )
    const entry = report.repositories[0].files[0]
    assert.equal(entry.claim, 'unclaimed', 'crediting files the path unclaimed')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The whole chain: a grandchild write files under the top parent, not under the
// intermediate child.
test('a grandchild write files under the top parent', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'grandchild.js'), 'const grandchild = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    const grandchild = childOf(repo, child.id, 'grandchild-1', 2)
    // The intermediate child emits an event so its own lineage link is observed,
    // as its dispatch of the grandchild would.
    svc.publish(child, 'turn/start', { turn: 1 })
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, grandchild, 1, 'grandchild.js')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'grandchild.js')], 'the grandchild write files under the top parent')
    assert.deepEqual(report.repositories.map(repository => repository.root), [repo])
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A credited write to a sibling repository files under that repository's own
// root, not under the parent's repository.
test('a sibling-repository credited write files under its own repository root', async t => {
  const repo = tempRepo()
  const sibling = tempRepo()
  const siblingFile = path.join(sibling, 'sibling.js')
  fs.writeFileSync(siblingFile, 'const sibling = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, siblingFile)
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(entry => entry.absolute) })),
      [{ root: sibling, files: [siblingFile] }],
      'the credited path files under the repository that owns it',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A background child that writes after the parent turn ended files once its
// own turn ends: before that it files nothing, after it files the path.
test('a background child write made after the parent turn ends files once that child turn ends', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'late.js'), 'const late = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'late.js', { end: false })
    const before = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(before.repositories, [], 'a still-running child wait: nothing files before its turn ends')
    svc.publish(child, 'turn/end', { turn: 1 })
    const after = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(after), [path.join(repo, 'late.js')], 'the write files once the child turn ends, even though the parent turn already ended')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A credited write counts once the writer's own turn has ended, not earlier:
// the parent is still in an open turn here.
test('a credited write counts only once the writer turn has ended', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'early.js'), 'const early = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    svc.publish(parent, 'turn/start', { turn: 1 })
    svc.publish(parent, 'user/message', userMessage(parent.id, 1))
    writerTurn(svc, child, 1, 'early.js', { end: false })
    const before = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(before.repositories, [], 'a write whose writer turn is still open files nothing yet')
    svc.publish(child, 'turn/end', { turn: 1 })
    const after = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(after), [path.join(repo, 'early.js')], 'once the writer turn ends the write files, even in the parent open turn')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A stranger session is nobody's descendant, so its writes never file.
test('a stranger session write never files', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'stranger.js'), 'const stranger = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const stranger = sessionOf('stranger-1', { cwd: repo })
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, stranger, 1, 'stranger.js')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(report.repositories, [], 'a stranger write must not be adopted')
    assert.ok(!report.notices.some(notice => /Coverage unknown/.test(notice)), 'a stranger is a known root, not unknown coverage')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Pre-existing dirt stays baseline for non-credited paths: a recorder path no
// file-tool call names stays out, while a credited path files beside it.
test('a pre-dirty file stays baseline for non-credited paths while a credited path files', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'dirty.js'), 'const dirty = 1\n')
  fs.writeFileSync(path.join(repo, 'credited.js'), 'const credited = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    // The parent turn's recorder names the shell-changed dirty file; no parent
    // file-tool call names it, so it is not the session's obligation.
    announceParentTurn(svc, parent, 1, [file('dirty.js')], repo, [])
    writerTurn(svc, child, 1, 'credited.js')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'credited.js')], 'only the credited path files; the shell-changed dirty file stays baseline')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Retention on disposal: a child session disposed after its turn ends keeps its
// credited write available to the parent.
test('a disposed child keeps its credited write for the parent', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'kept.js'), 'const kept = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'kept.js')
    await svc.disposeSession(child.id)
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'kept.js')], 'disposal of the child must not drop its credited write')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Retention across restart: a fresh service over the same state dir recovers
// the retained credited record without any event being replayed.
test('a restarted gate recovers the retained credited record', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'retained.js'), 'const retained = 1\n')
  const first = service()
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(first, parent, 1)
  writerTurn(first, child, 1, 'retained.js')
  const settingsDir = first.__testSettingsDir
  try {
    // A new service instance over the same settings/state directory stands in
    // for a host restart: its in-memory ledger is empty.
    const second = service({ settingsDir })
    second.__testSettingsDir = settingsDir
    const report = await second.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'retained.js')], 'the retained record files after restart without replayed events')
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
})

// Undetectable loss: a writer whose parent chain is incomplete never resolves a
// top, so nothing files and the status names coverage unknown, not clean.
test('an incomplete parent chain leaves coverage unknown rather than clean', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'orphan.js'), 'const orphan = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const orphan = childOf(repo, 'missing-middle', 'orphan-1', 2)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, orphan, 1, 'orphan.js')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(report.repositories, [], 'an orphaned write files nothing')
    assert.ok(report.notices.some(notice => /Coverage unknown/.test(notice)), `status names coverage unknown, not clean: ${JSON.stringify(report.notices)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

function writeUnitCatalog(repo) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items: [{ id: 'unit', name: 'Unit', proves: 'child.js works', addedAt: stamp, updatedAt: stamp }] }, null, 2)}\n`)
}

// F1: a credited file carries its writer; claiming it mine without a recorded
// adoption is refused, and with an explicit adoption it is accepted.
test('claiming a credited child write mine without adoption is refused, with adoption is accepted', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'child.js'), 'const child = 1\n')
  writeUnitCatalog(repo)
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'child.js')
    const agent = agentFor(repo, parent.id)
    const base = {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'child.js', decision: 'mine' }],
      reviewed_code_files: ['child.js'],
      demonstrated_files: [{ path: 'child.js', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the child write.',
    }
    await assert.rejects(svc.attest(agent, base), /adopt/i, 'a claim over another writer bytes without recorded adoption must be refused')
    const accepted = await svc.attest(agent, { ...base, adopted_files: ['child.js'] })
    assert.equal(accepted.pass, true, `attest with explicit adoption must pass: ${JSON.stringify(accepted.blockers)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// F2: after restart, a resumed child write before the first repositoryReport
// must not overwrite the retained marker with only its new path.
test('a resumed child write before the first status keeps the earlier retained paths', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'first.js'), 'const first = 1\n')
  fs.writeFileSync(path.join(repo, 'second.js'), 'const second = 1\n')
  const first = service()
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(first, parent, 1)
  writerTurn(first, child, 1, 'first.js')
  const settingsDir = first.__testSettingsDir
  try {
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    writerTurn(secondSvc, child, 2, 'second.js')
    const report = await secondSvc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'first.js'), path.join(repo, 'second.js')], 'both the retained and the resumed write file')
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
})

// F3: parent disposal before attestation must retain the descendant marker so
// a restart recovers it.
test('parent disposal before attestation retains the marker for a restart', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'kept.js'), 'const kept = 1\n')
  const first = service()
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(first, parent, 1)
  writerTurn(first, child, 1, 'kept.js')
  const settingsDir = first.__testSettingsDir
  try {
    await first.disposeSession(parent.id, repo)
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    const report = await secondSvc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'kept.js')], 'an unattested parent disposal must not delete the recoverable marker')
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
})

// F4: a late-arriving ancestor header must update the descendant marker, so a
// restart still completes the chain.
test('a late ancestor header updates the descendant marker before a restart', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'grandchild.js'), 'const grandchild = 1\n')
  const first = service()
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  const grandchild = childOf(repo, child.id, 'grandchild-1', 2)
  const settingsDir = first.__testSettingsDir
  try {
    // Grandchild writes before the intermediate child's header is ever seen.
    writerTurn(first, grandchild, 1, 'grandchild.js')
    // The ancestor header arrives late, completing the chain in memory.
    first.publish(child, 'turn/start', { turn: 1 })
    parentIdleTurn(first, parent, 1)
    const before = await first.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(before), [path.join(repo, 'grandchild.js')], 'precondition: the completed in-memory chain files')
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    const report = await secondSvc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'grandchild.js')], 'after restart the late ancestor must still complete the chain from the retained marker')
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
})

// F5a: coverage-unknown for an orphan writer must reach the stop advisory.
test('stopping on an orphan writer names unknown coverage in the advisory', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'orphan.js'), 'const orphan = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const orphan = childOf(repo, 'missing-middle', 'orphan-1', 2)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, orphan, 1, 'orphan.js')
    const agent = agentFor(repo, parent.id)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'the stop must speak about unknown coverage')
    assert.match(agent.steers[0].content[0].text, /Coverage unknown/, 'the advisory must carry the coverage notice')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// F5b: a corrupt retained marker must reach the stop advisory after restart.
test('stopping with a corrupt retained marker names the retention loss in the advisory', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'corrupt.js'), 'const corrupt = 1\n')
  const first = service()
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(first, parent, 1)
  writerTurn(first, child, 1, 'corrupt.js')
  const settingsDir = first.__testSettingsDir
  try {
    const dir = first.changes.creditedDir
    for (const marker of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, marker), '{ not json')
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    const agent = agentFor(repo, parent.id)
    await secondSvc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'the stop must speak about the corrupt retained marker')
    assert.match(agent.steers[0].content[0].text, /[Rr]etained|unknown/, 'the advisory must carry the retention/coverage notice')
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }) }
})

// A corrupt retained marker is a known loss: the status names it as a warning
// and coverage stays unknown.
test('a corrupt retained marker is named as a warning with unknown coverage', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'corrupt.js'), 'const corrupt = 1\n')
  const svc = service()
  try {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'corrupt.js')
    // Corrupt every retained marker file for this state directory, as a torn
    // write or disk damage would.
    const dir = svc.changes.creditedDir
    const markers = fs.readdirSync(dir)
    assert.ok(markers.length > 0, 'the credited write retains a marker file')
    for (const marker of markers) fs.writeFileSync(path.join(dir, marker), '{ not json')
    const report = await svc.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'corrupt.js')], 'the in-memory record still files while the marker is corrupt')
    assert.ok(report.notices.some(notice => /retained/i.test(notice) && /unknown/i.test(notice)), `status names the retained-record loss with unknown coverage: ${JSON.stringify(report.notices)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Per-operation provenance: a second child writer on the same unchanged path
// does not ride the first writer's adoption. The attestation digest binds the
// credited provenance, so the second write reopens the repository, and a new
// attest without adopted_files is refused until the new provenance is adopted.
test('a second child writer on the same unchanged path does not ride the first adoption', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'shared.js'), 'const same = 1\n')
  writeUnitCatalog(repo)
  await withCleanup(service(), async svc => {
    const parent = parentOf(repo)
    const first = childOf(repo, parent.id, 'child-1', 1)
    const second = childOf(repo, parent.id, 'child-2', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, first, 1, 'shared.js')
    const agent = agentFor(repo, parent.id)
    const base = {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'shared.js', decision: 'mine' }],
      reviewed_code_files: ['shared.js'],
      demonstrated_files: [{ path: 'shared.js', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the first write.',
    }
    const accepted = await svc.attest(agent, { ...base, adopted_files: ['shared.js'] })
    assert.equal(accepted.pass, true, 'attest adopting the first writer passes')
    writerTurn(svc, second, 1, 'shared.js')
    const report = await svc.repositoryReport(agent)
    assert.equal(report.repositories[0].complete, false, 'the second writer reopens the repository instead of riding the first adoption')
    assert.equal(report.repositories[0].files[0].writerId, 'child-2', 'the filed record names the latest writer')
    await assert.rejects(svc.attest(agent, base), /adopt/i, 'attest without adoption must refuse the new writer provenance')
    const readopted = await svc.attest(agent, { ...base, adopted_files: ['shared.js'] })
    assert.equal(readopted.pass, true, `attest adopting the new writer passes: ${JSON.stringify(readopted.blockers)}`)
  })
})

// docs_checked is a review of documentation, so it needs adoption for a
// child-written doc the same way a code review does: the second writer's doc
// write is not covered by docs_checked without adopted_files.
test('docs_checked does not cover a second writer doc without adoption', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'doc.md'), '# Doc\n')
  writeUnitCatalog(repo)
  await withCleanup(service(), async svc => {
    const parent = parentOf(repo)
    const first = childOf(repo, parent.id, 'child-1', 1)
    const second = childOf(repo, parent.id, 'child-2', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, first, 1, 'doc.md')
    const agent = agentFor(repo, parent.id)
    const base = {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'doc.md', decision: 'mine' }],
      docs_checked: true,
      demonstrated_files: [{ path: 'doc.md', note: 'read the doc' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the first doc write.',
    }
    const accepted = await svc.attest(agent, { ...base, adopted_files: ['doc.md'] })
    assert.equal(accepted.pass, true, 'attest adopting the first doc writer passes')
    writerTurn(svc, second, 1, 'doc.md')
    await assert.rejects(svc.attest(agent, base), /adopt/i, 'docs_checked without adoption must refuse the new writer provenance')
    const readopted = await svc.attest(agent, { ...base, adopted_files: ['doc.md'] })
    assert.equal(readopted.pass, true, `attest adopting the new doc writer passes: ${JSON.stringify(readopted.blockers)}`)
  })
})

// Corrupt marker preservation: a corrupt marker is renamed aside with its
// bytes intact before the same writer's new write overwrites that writer's
// record, not silently replaced by it. The loss is named with unknown
// coverage in the status.
test('a corrupt retained marker is preserved when the same writer writes after a restart', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1\n')
  fs.writeFileSync(path.join(repo, 'b.js'), 'const b = 1\n')
  await withSharedSettings(async (first, settingsDir) => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(first, parent, 1)
    writerTurn(first, child, 1, 'a.js')
    const dir = first.changes.creditedDir
    for (const marker of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, marker), '{ not json CORRUPT-BYTES')
    const second = service({ settingsDir })
    second.__testSettingsDir = settingsDir
    parentIdleTurn(second, parent, 1)
    writerTurn(second, child, 2, 'b.js')
    const preserved = fs.readdirSync(dir).filter(name => fs.readFileSync(path.join(dir, name), 'utf8').includes('CORRUPT-BYTES'))
    assert.equal(preserved.length, 1, 'the corrupt bytes survive in exactly one preserved file')
    const report = await second.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'b.js')], 'the new write files while the corrupt record stays unknown')
    assert.ok(report.notices.some(notice => /retained/i.test(notice) && /unknown/i.test(notice)), `status names the preserved corrupt marker with unknown coverage: ${JSON.stringify(report.notices)}`)
  })
})

// Stale parent snapshot: a child write that ends after the last attestation
// but before disposal must not be unlinked with its marker. Disposal refreshes
// and compares, so the marker survives for the restart that recovers it.
test('parent disposal after a late child write retains the marker for a restart', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'first.js'), 'const first = 1\n')
  fs.writeFileSync(path.join(repo, 'second.js'), 'const second = 1\n')
  writeUnitCatalog(repo)
  await withSharedSettings(async (first, settingsDir) => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(first, parent, 1)
    writerTurn(first, child, 1, 'first.js')
    const agent = agentFor(repo, parent.id)
    const attested = await first.attest(agent, {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'first.js', decision: 'mine' }],
      reviewed_code_files: ['first.js'],
      demonstrated_files: [{ path: 'first.js', note: 'ran the fixture' }],
      adopted_files: ['first.js'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the first write.',
    })
    assert.equal(attested.pass, true, 'precondition: the first write is attested')
    // The interleaving: the child write ends after the attestation, and no
    // report runs before disposal.
    writerTurn(first, child, 2, 'second.js')
    await first.disposeSession(parent.id, repo)
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    const report = await secondSvc.repositoryReport(agent)
    assert.deepEqual(filesOf(report), [path.join(repo, 'first.js'), path.join(repo, 'second.js')], 'the retained marker keeps every child write, including the late one, for a restart')
  })
})

// Same-process unattested disposal: disposing the parent without attestation
// keeps the credited operations in memory, so a same-process report still
// files them instead of silently seeing nothing.
test('unattested parent disposal keeps credited writes for a same-process report', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'kept.js'), 'const kept = 1\n')
  await withCleanup(service(), async svc => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'kept.js')
    const agent = agentFor(repo, parent.id)
    assert.deepEqual(filesOf(await svc.repositoryReport(agent)), [path.join(repo, 'kept.js')], 'precondition: the child write files')
    await svc.disposeSession(parent.id, repo)
    parentIdleTurn(svc, parent, 2)
    const after = await svc.repositoryReport(agent)
    assert.deepEqual(filesOf(after), [path.join(repo, 'kept.js')], 'the same process must still file the unattested credited write after disposal')
  })
})

// Durable corrupt-loss indication: a corrupt marker preserved aside during a
// later write must keep the loss unknown after another restart, not read as
// clean on a fresh tracker whose in-memory losses are empty.
test('a preserved corrupt marker keeps coverage unknown after a second restart', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1\n')
  fs.writeFileSync(path.join(repo, 'b.js'), 'const b = 1\n')
  await withSharedSettings(async (first, settingsDir) => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(first, parent, 1)
    writerTurn(first, child, 1, 'a.js')
    const dir = first.changes.creditedDir
    for (const marker of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, marker), '{ not json CORRUPT-BYTES')
    const second = service({ settingsDir })
    second.__testSettingsDir = settingsDir
    parentIdleTurn(second, parent, 1)
    writerTurn(second, child, 2, 'b.js')
    const preserved = fs.readdirSync(dir).filter(name => name.includes('.json.corrupt-'))
    assert.equal(preserved.length, 1, 'precondition: the corrupt marker is preserved aside')
    const third = service({ settingsDir })
    third.__testSettingsDir = settingsDir
    parentIdleTurn(third, parent, 1)
    const report = await third.repositoryReport(agentFor(repo, parent.id))
    assert.deepEqual(filesOf(report), [path.join(repo, 'b.js')], 'the new write files after the second restart')
    assert.ok(report.notices.some(notice => /retained/i.test(notice) && /unknown/i.test(notice)), `status names the preserved corrupt marker with unknown coverage: ${JSON.stringify(report.notices)}`)
  })
})

// A still-open descendant turn is not part of the credited operations the
// attestation comparison sees, so disposal must retain the marker even when
// the earlier ended writes are fully attested; otherwise it deletes the
// in-flight write before its turn ends.
test('parent disposal with a still-open child turn retains the in-flight write for recovery', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'first.js'), 'const first = 1\n')
  fs.writeFileSync(path.join(repo, 'second.js'), 'const second = 1\n')
  writeUnitCatalog(repo)
  await withSharedSettings(async (first, settingsDir) => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(first, parent, 1)
    writerTurn(first, child, 1, 'first.js')
    const agent = agentFor(repo, parent.id)
    const attested = await first.attest(agent, {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'first.js', decision: 'mine' }],
      reviewed_code_files: ['first.js'],
      demonstrated_files: [{ path: 'first.js', note: 'ran the fixture' }],
      adopted_files: ['first.js'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the first write.',
    })
    assert.equal(attested.pass, true, 'precondition: the first write is attested')
    writerTurn(first, child, 2, 'second.js', { end: false })
    await first.disposeSession(parent.id, repo)
    assert.ok(fs.readdirSync(first.changes.creditedDir).some(name => name.endsWith('.json')), 'disposal must retain the marker while a credited turn is still open')
    const secondSvc = service({ settingsDir })
    secondSvc.__testSettingsDir = settingsDir
    parentIdleTurn(secondSvc, parent, 1)
    secondSvc.publish(child, 'turn/end', { turn: 2 })
    const report = await secondSvc.repositoryReport(agent)
    assert.deepEqual(filesOf(report), [path.join(repo, 'first.js'), path.join(repo, 'second.js')], 'after restart and child turn end, both writes file')
  })
})

// The other side of disposal: once a durable attestation covers the exact
// writer turns and paths, disposal deletes the markers.
test('parent disposal deletes markers once the attestation covers the child writes', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'covered.js'), 'const covered = 1\n')
  writeUnitCatalog(repo)
  await withCleanup(service(), async svc => {
    const parent = parentOf(repo)
    const child = childOf(repo, parent.id, 'child-1', 1)
    parentIdleTurn(svc, parent, 1)
    writerTurn(svc, child, 1, 'covered.js')
    const agent = agentFor(repo, parent.id)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: repo,
      claims: [{ path: 'covered.js', decision: 'mine' }],
      reviewed_code_files: ['covered.js'],
      demonstrated_files: [{ path: 'covered.js', note: 'ran the fixture' }],
      adopted_files: ['covered.js'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Adopted the child write.',
    })
    assert.equal(attested.pass, true, 'precondition: the child write is attested')
    assert.ok(fs.readdirSync(svc.changes.creditedDir).length > 0, 'precondition: a retained marker exists')
    await svc.disposeSession(parent.id, repo)
    assert.deepEqual(fs.readdirSync(svc.changes.creditedDir), [], 'disposal deletes the markers the attestation covers')
  })
})
