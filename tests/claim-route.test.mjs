import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { userMessage } from './user-message.mjs'

// Model claim route (ticket jwap): a claim names a file with no record entry and the gate files it
// under its owning root, admitting a previously unseen root explicitly. Credited writes still file
// unclaimed and a parent attestation over another writer's bytes records mine adoption. Register scope
// stays separate and unchanged.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-claim-')))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

function writeUnitCatalog(repo) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items: [{ id: 'unit', name: 'Unit', proves: 'file works', addedAt: stamp, updatedAt: stamp }] }, null, 2)}\n`)
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
  const dir = settingsDir ?? fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-claim-settings-')))
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

function announceParentTurn(svc, parent, turn, files, cwd, calls = files.map(entry => entry.path), total = files.length) {
  const id = typeof parent === 'string' ? parent : parent.id
  svc.publish(parent, 'turn/start', { turn })
  svc.publish(parent, 'user/message', userMessage(id, turn))
  for (const call of calls) svc.publish(parent, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: call, content: 'x\n' }) })
  svc.publish(parent, 'workspace/changes', { turn })
  svc.changeService().entries.set(`${id}:${published}`, { turn, cwd, files, total, added: files.length, deleted: 0 })
  svc.publish(parent, 'turn/end', { turn })
}

function filesOf(report) {
  return report.repositories.flatMap(repo => repo.files.map(entry => entry.absolute)).sort()
}

// The attest-to-status path for a claimed file: an incomplete attest (claim only) names the review and
// demonstration obligations, and the complete attest (claim, review, demonstration) is complete in status.
async function assertClaimToComplete(svc, agent, root, claimPath, claimAbsolute) {
  const claimed = await svc.attest(agent, {
    action: 'attest', repository_root: root,
    claims: [{ path: claimPath, decision: 'mine' }],
    items: [],
  })
  assert.equal(claimed.pass, false, 'a claim alone owes review and demonstration')
  assert.ok(claimed.blockers.some(b => b.startsWith('Claimed code files not reviewed:')), claimed.markdown)
  assert.ok(claimed.blockers.some(b => b.startsWith('Claimed files reviewed but not demonstrated:')) === false, 'undemonstrated appears only once reviewed')
  const reviewed = await svc.attest(agent, {
    action: 'attest', repository_root: root,
    reviewed_code_files: [claimPath],
    items: [],
  })
  assert.ok(reviewed.blockers.some(b => b.startsWith('Claimed files reviewed but not demonstrated:')), reviewed.markdown)
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: root,
    reviewed_code_files: [claimPath],
    demonstrated_files: [{ path: claimPath, note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  const repo = report.repositories.find(r => r.root === root)
  assert.ok(repo, 'status lists the claimed repository')
  assert.ok(report.repositories.some(r => r.files.some(f => f.absolute === claimAbsolute && f.claim === 'mine' && f.reviewed && f.demonstrated)), 'status shows the file mine, reviewed, and demonstrated')
  assert.equal(repo.complete, true, 'the claimed repository is complete in status')
}

// A claim naming a path with no record entry files it.
test('a claim naming a path with no record entry files it', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'shell.js'), 'export const shell = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'no record entry files nothing')
  await assertClaimToComplete(svc, agent, repo, 'shell.js', path.join(repo, 'shell.js'))
})

// A claim naming a path outside the covered repo files it under its owning root, including a previously
// unseen owning root. The register scope stays separate and unchanged: register still refuses the unseen root.
test('a claim naming a sibling path files it under the unseen sibling root, register still refuses it', async t => {
  const repo = tempRepo()
  const sibling = tempRepo()
  const sibFile = path.join(sibling, 'sib.js')
  fs.writeFileSync(sibFile, 'export const sib = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assert.rejects(
    svc.register ? svc.register(agent, { repository_root: sibling, items: [{ name: 'Smoke', proves: 'it starts' }] }) : Promise.reject(new Error('register missing')),
    /register refused|is not a repository/,
    'register refuses a root with no prior entry',
  )
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'no prior entry files nothing for the sibling')
  const claimed = await svc.attest(agent, {
    action: 'attest', repository_root: sibling,
    claims: [{ path: sibFile, decision: 'mine' }],
    items: [],
  })
  assert.equal(claimed.pass, false, 'the claim alone owes review and demonstration')
  assert.ok(claimed.blockers.some(b => b.startsWith('Claimed code files not reviewed:')), claimed.markdown)
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: sibling,
    reviewed_code_files: [sibFile],
    demonstrated_files: [{ path: sibFile, note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  assert.ok(report.repositories.some(r => r.root === sibling && r.files.some(f => f.absolute === sibFile && f.claim === 'mine')), 'the claimed file files under the sibling root')
  assert.equal(report.repositories.find(r => r.root === sibling).complete, true, 'the sibling repository is complete')
})

// Crediting a descendant only files the path unclaimed (child).
test('a credited child write files unclaimed', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'child.js'), 'const child = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, child, 1, 'child.js')
  const report = await svc.repositoryReport(agentFor(repo, parent.id))
  assert.deepEqual(filesOf(report), [path.join(repo, 'child.js')])
  assert.equal(report.repositories[0].files[0].claim, 'unclaimed', 'crediting files the path unclaimed')
})

// Crediting a descendant only files the path unclaimed (grandchild).
test('a credited grandchild write files unclaimed under the top parent', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'gc.js'), 'const gc = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  const gc = childOf(repo, child.id, 'gc-1', 2)
  svc.publish(child, 'turn/start', { turn: 1 })
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, gc, 1, 'gc.js')
  const report = await svc.repositoryReport(agentFor(repo, parent.id))
  assert.deepEqual(filesOf(report), [path.join(repo, 'gc.js')])
  assert.equal(report.repositories[0].files[0].claim, 'unclaimed', 'crediting files the path unclaimed')
})

// A stranger session is nobody's descendant, so its writes never file.
test('a stranger write never files', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'stranger.js'), 'const stranger = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  const stranger = sessionOf('stranger-1', { cwd: repo })
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, stranger, 1, 'stranger.js')
  const report = await svc.repositoryReport(agentFor(repo, parent.id))
  assert.deepEqual(report.repositories, [], 'a stranger write must not be adopted')
})

// A successful parent mine over a child file needs recorded adoption (no claim refused, positive accepted).
test('a parent mine over a child file without adoption is refused, with adoption is accepted', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'child.js'), 'const child = 1\n')
  writeUnitCatalog(repo)
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
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
    items: [{ id: 'unit', state: 'passed' }],
  }
  await assert.rejects(svc.attest(agent, base), /adopt/i, 'no adoption refused')
  const done = await svc.attest(agent, { ...base, adopted_files: ['child.js'] })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  assert.equal(report.repositories[0].files[0].claim, 'mine')
  assert.equal(report.repositories[0].files[0].adopted, true, 'adoption is recorded')
})

// A not-mine rejection never adopts.
test('a not-mine rejection never adopts a child file', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'child.js'), 'const child = 1\n')
  writeUnitCatalog(repo)
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, child, 1, 'child.js')
  const agent = agentFor(repo, parent.id)
  const rejected = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'child.js', decision: 'not-mine' }],
    adopted_files: ['child.js'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(rejected.pass, true, rejected.markdown)
  const afterReject = await svc.repositoryReport(agent)
  assert.equal(afterReject.repositories[0].files[0].claim, 'not-mine')
  assert.equal(afterReject.repositories[0].files[0].adopted, false, 'not-mine never adopts')
  await assert.rejects(svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'child.js', decision: 'mine' }],
    reviewed_code_files: ['child.js'],
    demonstrated_files: [{ path: 'child.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  }), /adopt/i, 'a later mine without adoption is still refused after a not-mine')
})

// Later content changes reopen a recorded adoption.
test('a later content change reopens a recorded adoption', async t => {
  const repo = tempRepo()
  const childFile = path.join(repo, 'child.js')
  fs.writeFileSync(childFile, 'const child = 1\n')
  writeUnitCatalog(repo)
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
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
    adopted_files: ['child.js'],
    items: [{ id: 'unit', state: 'passed' }],
  }
  assert.equal((await svc.attest(agent, base)).pass, true)
  fs.writeFileSync(childFile, 'const child = 2\n')
  const report = await svc.repositoryReport(agent)
  assert.equal(report.repositories[0].files[0].claim, 'unclaimed', 'content change reopens the claims')
  assert.equal(report.repositories[0].files[0].adopted, false, 'content change reopens the adoption')
  await assert.rejects(svc.attest(agent, { ...base, adopted_files: undefined }), /adopt/i, 'reopened adoption needs adopting again')
  assert.equal((await svc.attest(agent, base)).pass, true, 're-adopting after the reopen passes')
})

// The staged filing stays atomic: a refused attest drops the claim filing with the staged copy.
test('a refused attest drops the claim filing with the staged copy', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'shell.js'), 'export const shell = 1\n')
  writeUnitCatalog(repo)
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assert.rejects(svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'shell.js', decision: 'mine' }],
    items: [{ id: 'nope', state: 'passed' }],
  }), /is not an item in this repository's catalog/, 'an unknown item refuses the attest')
  const report = await svc.repositoryReport(agent)
  assert.deepEqual(report.repositories, [], 'the refused filing leaves no repository entry')
})

// One named regression test each by case, asserting the public attest-to-status path.

test('regression: no record entry', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'shell.js'), 'export const shell = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assertClaimToComplete(svc, agent, repo, 'shell.js', path.join(repo, 'shell.js'))
})

test('regression: pre-dirty file', async t => {
  const repo = tempRepo()
  // The file was dirty before the turn, so the turn record never lists it (baseline).
  fs.writeFileSync(path.join(repo, 'dirty.js'), 'export const dirty = 1\n')
  fs.writeFileSync(path.join(repo, 'other.js'), 'export const other = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('other.js')], repo)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(filesOf(before), [path.join(repo, 'other.js')], 'precondition: the pre-dirty file is baseline')
  // Attest the pre-dirty file by claim; the other recorded file is claimed too.
  const claimed = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'dirty.js', decision: 'mine' }, { path: 'other.js', decision: 'mine' }],
    items: [],
  })
  assert.equal(claimed.pass, false, 'a claim alone owes review and demonstration')
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['dirty.js', 'other.js'],
    demonstrated_files: [{ path: 'dirty.js', note: 'ran the fixture' }, { path: 'other.js', note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  const entry = report.repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, 'dirty.js'))
  assert.equal(entry.claim, 'mine')
  assert.ok(entry.reviewed && entry.demonstrated, 'evidence obligations preserved')
})

test('regression: ignored path', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n')
  fs.writeFileSync(path.join(repo, 'ignored.js'), 'export const ignored = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'the ignored path has no record entry')
  await assertClaimToComplete(svc, agent, repo, 'ignored.js', path.join(repo, 'ignored.js'))
})

test('regression: nested inner file', async t => {
  const repo = tempRepo()
  const nested = path.join(repo, 'vendor')
  fs.mkdirSync(nested)
  git(nested, ['init', '-q', '.'])
  git(nested, ['config', 'user.email', 'test@example.com'])
  git(nested, ['config', 'user.name', 'test'])
  const inner = path.join(nested, 'lib.js')
  fs.writeFileSync(inner, 'module.exports = 1\n')
  git(nested, ['add', '-A'])
  git(nested, ['commit', '-qm', 'nested'])
  fs.writeFileSync(inner, 'module.exports = 2\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'the inner file has no record entry')
  const claimed = await svc.attest(agent, {
    action: 'attest', repository_root: nested,
    claims: [{ path: inner, decision: 'mine' }],
    items: [],
  })
  assert.equal(claimed.pass, false, 'a claim alone owes review and demonstration')
  assert.ok(claimed.blockers.some(b => b.startsWith('Claimed code files not reviewed:')), claimed.markdown)
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: nested,
    reviewed_code_files: [inner],
    demonstrated_files: [{ path: inner, note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  assert.ok(report.repositories.some(r => r.root === nested && r.files.some(f => f.absolute === inner && f.claim === 'mine' && f.reviewed && f.demonstrated)), 'the inner file files under the nested root')
  assert.equal(report.repositories.find(r => r.root === nested).complete, true, 'the nested repository is complete')
})

test('regression: truncated record', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'first.js'), 'export const first = 1\n')
  fs.writeFileSync(path.join(repo, 'second.js'), 'export const second = 1\n')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  // The record carries only first.js but reports total 2, so the change set is truncated.
  announceParentTurn(svc, parent, 1, [file('first.js')], repo, ['first.js'], 2)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.ok(before.notices.some(n => /only 1 of them/.test(n) || /truncated|complete set/.test(n)), `precondition: truncation is named: ${JSON.stringify(before.notices)}`)
  assert.deepEqual(filesOf(before), [path.join(repo, 'first.js')], 'only the carried file files from the truncated record')
  // The second file is named by neither the record nor a file-tool call, so the claim files it.
  const claimed = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'second.js', decision: 'mine' }, { path: 'first.js', decision: 'mine' }],
    items: [],
  })
  assert.equal(claimed.pass, false, 'claims alone owe review and demonstration')
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['first.js', 'second.js'],
    demonstrated_files: [{ path: 'first.js', note: 'ran the fixture' }, { path: 'second.js', note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, done.markdown)
  const report = await svc.repositoryReport(agent)
  for (const name of ['first.js', 'second.js']) {
    const entry = report.repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, name))
    assert.equal(entry.claim, 'mine', `${name} is claimed`)
    assert.ok(entry.reviewed && entry.demonstrated, `${name} evidence preserved`)
  }
  assert.equal(report.repositories[0].complete, true, 'the truncated-record repository is complete')
})

test('regression: symlink claim resolves to the filed file', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'real.js'), 'export const real = 1\n')
  fs.symlinkSync(path.join(repo, 'real.js'), path.join(repo, 'link.js'))
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assertClaimToComplete(svc, agent, repo, 'link.js', path.join(repo, 'real.js'))
})

test('regression: staged deletion claims with absent digest', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'gone.js'), 'export const gone = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'add gone'])
  git(repo, ['rm', '-q', 'gone.js'])
  assert.equal(git(repo, ['status', '--short']).trim(), 'D  gone.js', 'precondition: the deletion is staged')
  assert.equal(git(repo, ['ls-files', 'gone.js']).trim(), '', 'precondition: the index entry is gone')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'no record entry files nothing')
  await assertClaimToComplete(svc, agent, repo, 'gone.js', path.join(repo, 'gone.js'))
  const report = await svc.repositoryReport(agent)
  const entry = report.repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, 'gone.js'))
  assert.equal(entry.key, 'absent', 'the staged deletion keeps the absent digest')
})

test('regression: a never-tracked missing claim stays refused', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assert.rejects(svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'typo.js', decision: 'mine' }],
    items: [],
  }), /typo\.js is not a changed file of this repository/, 'a typo name that git never tracked stays refused')
})

test('regression: a wildcard claim stays refused against a tracked matching file', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'missing1.js'), 'export const missing1 = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'add missing1'])
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  await assert.rejects(svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'missing*.js', decision: 'mine' }],
    items: [],
  }), /missing\*\.js is not a changed file of this repository/, 'glob metacharacters never match a tracked file')
  const report = await svc.repositoryReport(agent)
  assert.deepEqual(report.repositories, [], 'the refused wildcard claim files nothing')
})

test('regression: deleted tracked file claims with absent digest', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'deleted.js'), 'export const deleted = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'add deleted'])
  fs.rmSync(path.join(repo, 'deleted.js'))
  assert.equal(git(repo, ['status', '--short']).trim(), 'D deleted.js', 'precondition: the deletion is the working-tree change')
  const svc = service()
  t.after(() => fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)
  const before = await svc.repositoryReport(agent)
  assert.deepEqual(before.repositories, [], 'no record entry files nothing')
  await assertClaimToComplete(svc, agent, repo, 'deleted.js', path.join(repo, 'deleted.js'))
  const report = await svc.repositoryReport(agent)
  const entry = report.repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, 'deleted.js'))
  assert.equal(entry.key, 'absent', 'the deleted file keeps the absent digest')
})
