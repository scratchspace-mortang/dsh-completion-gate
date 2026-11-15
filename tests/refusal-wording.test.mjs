import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CompletionGateService } from '../lib/index.js'
import { gitRootOf } from '../lib/repositories.js'
import { userMessage } from './user-message.mjs'

// Refusal wording and retention naming (ticket kxeh): an unfiled path in an
// attest refusal names the condition, the next action (the claim route for a
// review, demonstration, or adoption entry over a path the claim route can
// file, namely a file on disk or a tracked deletion; a plain statement that no
// action helps for a claim, which already tried that route, and for such an
// entry over a typo name the claim route cannot file either), and never
// suggests touching a file to force a record. A record loss the gate cannot detect may
// be present in any status render, so every render qualifies coverage rather
// than reading the filed set as complete; a known child record loss is named
// in status as a warning. Filed paths keep their existing behavior.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function makeWorkDir(prefix) {
  fs.mkdirSync(workRoot, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(workRoot, prefix)))
}

function tempRepo() {
  const dir = makeWorkDir('cg-refusal-')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
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
function service() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-refusal-settings-')))
  const listeners = new Map()
  const off = () => () => {}
  const rec = recorder()
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? rec : undefined) },
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
  return instance
}

function cleanupService(instance) {
  if (instance?.__testSettingsDir) fs.rmSync(instance.__testSettingsDir, { recursive: true, force: true })
}

function sessionOf(id, header = {}) { return { id, header } }
function parentOf(cwd, id = 'parent-1') { return sessionOf(id, { cwd }) }
function childOf(cwd, parentSession, id, depth) { return sessionOf(id, { cwd, parentSession, origin: 'subagent', delegationDepth: depth }) }
function agentFor(cwd, id = 'parent-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd } }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

function writerTurn(svc, writer, turn, file) {
  svc.publish(writer, 'turn/start', { turn })
  svc.publish(writer, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: file, content: 'x\n' }) })
  svc.publish(writer, 'turn/end', { turn })
}

function parentIdleTurn(svc, parent, turn) {
  svc.publish(parent, 'turn/start', { turn })
  svc.publish(parent, 'user/message', userMessage(parent.id, turn))
  svc.publish(parent, 'turn/end', { turn })
}

const file = p => ({ path: p, display: p, added: 1, deleted: 0 })

function announceParentTurn(svc, parent, turn, files, cwd, calls = files.map(entry => entry.path)) {
  const id = parent.id
  svc.publish(parent, 'turn/start', { turn })
  svc.publish(parent, 'user/message', userMessage(id, turn))
  for (const call of calls) svc.publish(parent, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: call, content: 'x\n' }) })
  svc.publish(parent, 'workspace/changes', { turn })
  svc.changeService().entries.set(`${id}:${published}`, { turn, cwd, files, total: files.length, added: files.length, deleted: 0 })
  svc.publish(parent, 'turn/end', { turn })
}

// An unfiled path: the refusal names the condition (no filed record), the
// next action (check the spelling and the path), and a plain statement that
// no action helps; it never suggests touching a file to force a record.
test('an unfiled path refusal names the condition, the next action, and that no action helps', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const agent = agentFor(repo, parent.id)
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'missing.js', decision: 'mine' }],
  }).then(() => null, e => e)
  assert.ok(error, 'an unfiled path must refuse the attest')
  const message = error.message
  assert.match(message, /missing\.js is not a changed file of this repository\./, 'the refusal still names the path as unfiled')
  assert.match(message, /No filed record names it/, 'the refusal names the condition: no filed record names the path')
  assert.match(message, /Check the spelling and the path/, 'the refusal names the next action')
  assert.match(message, /editing the file will not create a filed record, and no action on this path helps/, 'the refusal states plainly that no action helps')
  assert.doesNotMatch(message, /touch/i, 'the refusal never suggests touching a file')
  assert.doesNotMatch(message, /edit the file to/i, 'the refusal never suggests editing the file to force a record')
})

// Filed paths are unchanged: a filed path still attests to complete.
test('a filed path still attests to complete after the refusal wording change', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const agent = agentFor(repo, parent.id)
  await svc.register(agent, { repository_root: repo, items: [{ name: 'Unit', proves: 'app.js sets value' }] })
  // File app.js through the credited-operation route is not needed here: file
  // it through a parent turn announced by the recorder stub would need the
  // host summary; instead file it through the model claim route, which is the
  // existing filed-path behavior under test.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
  const accepted = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
    summary: 'Filed path attested.',
  })
  assert.equal(accepted.pass, true, `a filed path attests to complete: ${JSON.stringify(accepted.blockers)}`)
})

// A known child record loss: a corrupt retained marker is named in status as
// a warning, with coverage unknown.
test('a known child record loss is named in status as a warning with unknown coverage', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'corrupt.js'), 'const corrupt = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, child, 1, 'corrupt.js')
  const dir = svc.changes.creditedDir
  const markers = fs.readdirSync(dir)
  assert.ok(markers.length > 0, 'precondition: a retained marker exists')
  for (const marker of markers) fs.writeFileSync(path.join(dir, marker), '{ not json')
  const report = await svc.repositoryReport(agentFor(repo, parent.id))
  const notice = report.notices.find(n => /retained/i.test(n))
  assert.ok(notice, `status names the known loss: ${JSON.stringify(report.notices)}`)
  assert.match(notice, /Warning:/, 'the known loss is named as a warning')
  assert.match(notice, /unknown/i, 'coverage stays unknown for the known loss')
  const status = await svc.statusResult(agentFor(repo, parent.id))
  assert.match(status.markdown, /Warning:.*[Rr]etained/, 'the status text carries the warning')
})

// A record loss the gate cannot detect: an incomplete parent chain files
// nothing, and status names coverage unknown rather than reading as clean.
test('a record loss the gate cannot detect leaves coverage unknown in status', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'orphan.js'), 'const orphan = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const orphan = childOf(repo, 'missing-middle', 'orphan-1', 2)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, orphan, 1, 'orphan.js')
  const report = await svc.repositoryReport(agentFor(repo, parent.id))
  assert.deepEqual(report.repositories, [], 'an orphaned write files nothing')
  const notice = report.notices.find(n => /Coverage unknown/.test(n))
  assert.ok(notice, `status names coverage unknown, not clean: ${JSON.stringify(report.notices)}`)
  assert.match(notice, /Warning:/, 'the unknown coverage is named as a warning')
})

// A fully undetectable loss: with no observable record at all, status still
// qualifies coverage as a plain notice, so "nothing attributed yet" never
// reads as "coverage is complete", and the ordinary no-work case gets no alarm.
test('a status with no observable record qualifies coverage as a plain notice', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => cleanupService(svc))
  const status = await svc.statusResult(agentFor(repo, 'parent-1'))
  assert.match(status.markdown, /No changed file is attributed to a repository in this session yet\./, 'the empty state is still named')
  assert.match(status.markdown, /Notice: A record loss the gate cannot detect may be present, so nothing here proves coverage is complete\./, 'the undetectable-loss caveat is named')
  assert.doesNotMatch(status.markdown, /Warning:/, 'the caveat is a notice, not an alarm')
})

// A review-only attest refusal must name the claim route as the next action:
// the same attest carrying claims files the path and passes, so "no action
// helps" would contradict the legitimate route.
test('a review-only refusal names the claim route, and the claim-carrying attest passes', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const agent = agentFor(repo, parent.id)
  await svc.register(agent, { repository_root: repo, items: [{ name: 'Unit', proves: 'app.js sets value' }] })
  const refusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['app.js'],
  }).then(() => null, e => e)
  assert.ok(refusal, 'a review-only attest over an unfiled path must refuse')
  const message = refusal.message
  assert.match(message, /app\.js is not a changed file of this repository\./, 'the refusal still names the path as unfiled')
  assert.match(message, /No filed record names it/, 'the refusal names the condition')
  assert.match(message, /Add it to claims instead/, 'the refusal names the claim route as the next action')
  assert.match(message, /mine or not-mine/, 'the refusal names the decision to claim with')
  assert.doesNotMatch(message, /no action on this path helps/, 'the refusal never denies the claim route')
  assert.doesNotMatch(message, /touch/i, 'the refusal never suggests touching a file')
  const accepted = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
    summary: 'The claim route files the path.',
  })
  assert.equal(accepted.pass, true, `a claim-carrying attest passes with blockers=[]: ${JSON.stringify(accepted.blockers)}`)
  assert.deepEqual(accepted.blockers, [], 'the claim-carrying attest has no blockers')
})

// A review, demonstration, or adoption entry over an existing file in another
// repository must not promise the claim route against the selected root: the
// claim route files under the owning root, so a claim against the selected
// root still refuses. The refusal names the owning root as the correct
// target, and an attest against that root files and completes the file.
test('a cross-repository entry names the owning root instead of promising the claim route', async t => {
  const repo = tempRepo()
  const other = tempRepo()
  const otherFile = path.join(other, 'other.js')
  fs.writeFileSync(otherFile, 'export const other = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const agent = agentFor(repo, parent.id)
  const entryArgs = [
    { reviewed_code_files: [otherFile] },
    { demonstrated_files: [{ path: otherFile, note: 'ran the fixture' }] },
    { adopted_files: [otherFile] },
  ]
  for (const extra of entryArgs) {
    const refusal = await svc.attest(agent, {
      action: 'attest', repository_root: repo, ...extra,
    }).then(() => null, e => e)
    assert.ok(refusal, `a cross-repository entry must refuse: ${JSON.stringify(extra)}`)
    const message = refusal.message
    assert.match(message, /is not a changed file of this repository\./, 'the refusal still names the path as unfiled')
    assert.match(message, /No filed record names it/, 'the refusal names the condition')
    assert.ok(message.includes(other), `the refusal names the owning root ${other}: ${message}`)
    assert.match(message, /claim against this repository cannot file it/, 'the refusal states a claim against the selected root cannot file it')
    assert.match(message, /attest against/, 'the refusal names the correct target')
    assert.doesNotMatch(message, /Add it to claims instead/, 'the refusal never promises the claim route against the selected root')
    assert.doesNotMatch(message, /a claim is the route that files it/, 'the refusal never calls the claim route the filing route')
  }
  const claimRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: otherFile, decision: 'mine' }],
    reviewed_code_files: [otherFile],
    demonstrated_files: [{ path: otherFile, note: 'ran the fixture' }],
  }).then(() => null, e => e)
  assert.ok(claimRefusal, 'a claim against the selected root over a foreign file must refuse')
  assert.ok(claimRefusal.message.includes(other), `the claim refusal names the owning root: ${claimRefusal.message}`)
  const accepted = await svc.attest(agent, {
    action: 'attest', repository_root: other,
    claims: [{ path: otherFile, decision: 'mine' }],
    reviewed_code_files: [otherFile],
    demonstrated_files: [{ path: otherFile, note: 'ran the fixture' }],
    summary: 'The owning root files the path.',
  })
  assert.equal(accepted.pass, true, `an attest against the owning root completes: ${JSON.stringify(accepted.blockers)}`)
})

// A review-only refusal over a typo name (no file on disk, never tracked) must
// not promise the claim route, because the claim route refuses that name too
// (stagedAttest skips a missing name git never tracked). It takes the same
// no-action wording a claim takes, so the two refusals no longer contradict.
test('a review-only refusal over a nonexistent untracked path does not promise the claim route', async t => {
  const repo = tempRepo()
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const agent = agentFor(repo, parent.id)
  const refusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['missing.js'],
  }).then(() => null, e => e)
  assert.ok(refusal, 'a review-only attest over a typo name must refuse')
  const message = refusal.message
  assert.match(message, /missing\.js is not a changed file of this repository\./, 'the refusal still names the path as unfiled')
  assert.match(message, /No filed record names it/, 'the refusal names the condition')
  assert.match(message, /Check the spelling and the path/, 'the refusal names the next action')
  assert.match(message, /no action on this path helps/, 'the refusal states plainly that no action helps')
  assert.doesNotMatch(message, /Add it to claims instead/, 'the refusal never promises the claim route it cannot keep')
  assert.doesNotMatch(message, /a claim is the route that files it/, 'the refusal never calls the claim route the filing route')
  assert.doesNotMatch(message, /touch/i, 'the refusal never suggests touching a file')
})

// An ownerless existing file (no git root above it) files under the fallback
// cwd, not the selected root, when the two differ. A review-only entry under
// the selected root must not promise the claim route there: it names the
// fallback cwd as the target, a claim against the selected root still
// refuses, and an attest against the fallback cwd files and completes.
test('an ownerless file names the fallback cwd instead of promising the claim route under a differing selected root', async t => {
  const selected = tempRepo()
  const cwdRepo = tempRepo()
  const ownerlessDir = makeWorkDir('cg-ownerless-')
  const ownerless = path.join(ownerlessDir, 'ownerless.js')
  fs.writeFileSync(ownerless, 'export const ownerless = 1\n')
  assert.equal(await gitRootOf(ownerless), null, 'precondition: the file has no owning git repository')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(cwdRepo)
  announceParentTurn(svc, parent, 1, [file('app.js')], selected)
  const agent = agentFor(cwdRepo, parent.id)
  const seen = await svc.repositoryReport(agent)
  assert.ok(seen.repositories.some(r => r.root === selected), 'precondition: the selected repository is seen')

  const refusal = await svc.attest(agent, {
    action: 'attest', repository_root: selected,
    reviewed_code_files: [ownerless],
  }).then(() => null, e => e)
  assert.ok(refusal, 'a review-only attest over the ownerless file under the selected root must refuse')
  const message = refusal.message
  assert.match(message, /is not a changed file of this repository\./, 'the refusal still names the path as unfiled')
  assert.match(message, /No filed record names it/, 'the refusal names the condition')
  assert.ok(message.includes(cwdRepo), `the refusal names the fallback cwd ${cwdRepo}: ${message}`)
  assert.match(message, /claim against this repository cannot file it/, 'the refusal states a claim against the selected root cannot file it')
  assert.match(message, /attest against/, 'the refusal names the correct target')
  assert.doesNotMatch(message, /Add it to claims instead/, 'the refusal never promises the claim route against the selected root')
  assert.doesNotMatch(message, /a claim is the route that files it/, 'the refusal never calls the claim route the filing route')
  assert.doesNotMatch(message, /touch/i, 'the refusal never suggests touching a file')

  const claimRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: selected,
    claims: [{ path: ownerless, decision: 'mine' }],
    reviewed_code_files: [ownerless],
    demonstrated_files: [{ path: ownerless, note: 'ran the fixture' }],
  }).then(() => null, e => e)
  assert.ok(claimRefusal, 'a claim against the selected root over the ownerless file must refuse')
  assert.ok(claimRefusal.message.includes(cwdRepo), `the claim refusal names the fallback cwd: ${claimRefusal.message}`)
  assert.match(claimRefusal.message, /claim cannot file it under this repository/, 'the claim refusal names the fallback as the filing root')

  const accepted = await svc.attest(agent, {
    action: 'attest', repository_root: cwdRepo,
    claims: [{ path: ownerless, decision: 'mine' }],
    reviewed_code_files: [ownerless],
    demonstrated_files: [{ path: ownerless, note: 'ran the fixture' }],
    summary: 'The fallback cwd files the ownerless path.',
  })
  assert.equal(accepted.pass, true, `an attest against the fallback cwd completes: ${JSON.stringify(accepted.blockers)}`)
  assert.deepEqual(accepted.blockers, [], 'the fallback attest has no blockers')
  const report = await svc.repositoryReport(agent)
  assert.ok(report.repositories.some(r => r.root === cwdRepo && r.files.some(f => f.absolute === ownerless && f.claim === 'mine')), 'the ownerless file files under the fallback cwd')
})
