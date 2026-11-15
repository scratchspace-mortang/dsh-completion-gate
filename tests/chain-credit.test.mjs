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
  instance.disposeSession = id => listeners.get('session/disposed')({ id })
  return instance
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
    svc.disposeSession(child.id)
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
