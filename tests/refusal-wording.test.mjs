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

// T1 overlap refusal: within one path argument, a group and an exact entry (or two groups)
// that name the same filed path are ambiguous. The refusal names that absolute path and the
// whole call writes nothing. Overlap is checked per argument, never across arguments.

test('T1 a group and an exact entry naming one filed path are refused by name with nothing written', async t => {
  const repo = tempRepo()
  for (const name of ['ab.js', 'abc.js']) fs.writeFileSync(path.join(repo, name), `export const ${name} = 1\n`)
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('ab.js'), file('abc.js')], repo)
  const agent = agentFor(repo, parent.id)
  const shared = path.join(repo, 'ab.js')
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'ab*', decision: 'not-mine' }, { path: 'ab.js', decision: 'not-mine' }],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'a group and an exact entry over one path must refuse')
  const message = error.errors?.join('\n') ?? error.message
  assert.ok(message.includes(shared), `the refusal names the overlapping path ${shared}: ${message}`)
  assert.match(message, /named by both|ambiguous/i, 'the refusal names the overlap, not an unfiled path')
  const files = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files)
  assert.deepEqual(files.map(f => f.claim), ['unclaimed', 'unclaimed'], 'nothing was written to the ledger')
})

test('T1 two groups naming one filed path are refused by name with nothing written', async t => {
  const repo = tempRepo()
  for (const name of ['ab.js', 'abc.js']) fs.writeFileSync(path.join(repo, name), `export const ${name} = 1\n`)
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('ab.js'), file('abc.js')], repo)
  const agent = agentFor(repo, parent.id)
  const shared = path.join(repo, 'abc.js')
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'ab*', decision: 'not-mine' }, { path: 'abc*', decision: 'not-mine' }],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'two groups over one path must refuse')
  const message = error.errors?.join('\n') ?? error.message
  assert.ok(message.includes(shared), `the refusal names the overlapping path ${shared}: ${message}`)
  assert.match(message, /named by both|ambiguous/i, 'the refusal names the overlap')
  const files = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files)
  assert.deepEqual(files.map(f => f.claim), ['unclaimed', 'unclaimed'], 'nothing was written to the ledger')
})

test('T1 overlap is checked within one path argument, not across arguments', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'ab.js'), 'export const ab = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, child, 1, 'ab.js')
  const agent = agentFor(repo, parent.id)
  // The same group names ab.js in claims and in adopted_files. That is two arguments, so it is
  // not an overlap. A mutant that pools the arguments would refuse this call.
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'ab*', decision: 'mine' }],
    adopted_files: ['ab*'],
    reviewed_code_files: ['ab*'],
    demonstrated_files: [{ path: 'ab*', note: 'ran the fixture' }],
    items: [],
  })
  assert.equal(done.pass, true, `the same group across arguments is not an overlap: ${done.markdown}`)
  const entry = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, 'ab.js'))
  assert.equal(entry.claim, 'mine', 'the claim across arguments was applied')
  assert.equal(entry.adopted, true, 'the adoption across arguments was applied')
})

// T1 (OCR-CODE-T1-R2-9): the per-argument overlap check covers every descriptor, not just
// claims. A group and an exact entry naming one filed path in adopted_files or
// demonstrated_files are refused by name and write nothing.
test('T1 an adopted group and exact entry naming one filed path are refused by name with nothing written', async t => {
  const repo = tempRepo()
  for (const name of ['lib/one.js', 'lib/two.js']) {
    const target = path.join(repo, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'export const one = 1\n')
  }
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('lib/one.js'), file('lib/two.js')], repo)
  const agent = agentFor(repo, parent.id)
  const shared = path.join(repo, 'lib/one.js')
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    adopted_files: ['lib/', 'lib/one.js'],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'an adopted group and exact entry over one path must refuse')
  const message = error.errors?.join('\n') ?? error.message
  assert.ok(message.includes(shared), `the refusal names the overlapping path ${shared}: ${message}`)
  assert.match(message, /named by both lib\/ and lib\/one\.js/, 'the refusal names the two entries that share the path')
  const entry = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files).find(f => f.absolute === shared)
  assert.equal(entry.adopted, false, 'no adopted state was written')
})

test('T1 a demonstrated group and exact entry naming one filed path are refused by name with nothing written', async t => {
  const repo = tempRepo()
  for (const name of ['lib/one.js', 'lib/two.js']) {
    const target = path.join(repo, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'export const one = 1\n')
  }
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('lib/one.js'), file('lib/two.js')], repo)
  const agent = agentFor(repo, parent.id)
  const shared = path.join(repo, 'lib/one.js')
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    demonstrated_files: [{ path: 'lib/', note: 'ran the fixture' }, { path: 'lib/one.js', note: 'ran the fixture' }],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'a demonstrated group and exact entry over one path must refuse')
  const message = error.errors?.join('\n') ?? error.message
  assert.ok(message.includes(shared), `the refusal names the overlapping path ${shared}: ${message}`)
  assert.match(message, /named by both lib\/ and lib\/one\.js/, 'the refusal names the two entries that share the path')
  const entry = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files).find(f => f.absolute === shared)
  assert.equal(entry.reviewed, false, 'no reviewed state was written')
  assert.equal(entry.demonstrated, null, 'no demonstrated state was written')
})

// T1 (OCR-CODE-T1-R1-5): two identical exact values in reviewed_code_files or adopted_files
// are permitted by the schema and were accepted before grouping. They resolve idempotently
// to one filed path and must not be refused as an ambiguous overlap of a path with itself.
test('duplicate exact reviewed and adopted entries stay accepted', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'ab.js'), 'export const ab = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('ab.js')], repo)
  const agent = agentFor(repo, parent.id)
  const done = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'ab.js', decision: 'mine' }],
    reviewed_code_files: ['ab.js', 'ab.js'],
    adopted_files: ['ab.js', 'ab.js'],
    demonstrated_files: [{ path: 'ab.js', note: 'ran the fixture' }],
    items: [],
    summary: 'Duplicate exact evidence values are idempotent.',
  })
  assert.equal(done.pass, true, `duplicate exact evidence stays accepted: ${JSON.stringify(done.blockers)}`)
  const entry = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files).find(f => f.absolute === path.join(repo, 'ab.js'))
  assert.equal(entry.reviewed, true, 'the duplicated review applied')
  assert.equal(entry.adopted, true, 'the duplicated adoption applied')
})

// T1 (OCR-CODE-T1-R2-3): identical spellings are one entry repeated and stay accepted, but two
// different spellings that resolve to one filed path name that path twice. The exact/exact
// overlap refusal must name the shared absolute path and write nothing.
test('two different exact spellings of one filed path are refused as ambiguous', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'ab.js'), 'export const ab = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  announceParentTurn(svc, parent, 1, [file('ab.js')], repo)
  const agent = agentFor(repo, parent.id)
  const shared = path.join(repo, 'ab.js')
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['./ab.js', 'ab.js'],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'two spellings of one filed path must refuse')
  const message = error.errors?.join('\n') ?? error.message
  assert.ok(message.includes(shared), `the refusal names the shared absolute path ${shared}: ${message}`)
  assert.match(message, /named by both|ambiguous/i, 'the refusal names the overlap, not an unfiled path')
  const entry = (await svc.repositoryReport(agent)).repositories.flatMap(r => r.files).find(f => f.absolute === shared)
  assert.equal(entry.reviewed, false, 'no reviewed state was written')
  assert.equal(entry.adopted, false, 'no adopted state was written')
})

// T1 (OCR-CODE-T1-R2-2): reviewed_code_files has no schema duplicate refusal, so two identical
// exact spellings of one credited path must still produce one adoption-refusal line, not one per
// spelling. The plan deduplicates reviewed paths before the adoption loop reports them.
test('duplicate exact reviews of a child-written file emit one adoption refusal', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'ab.js'), 'export const ab = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  const child = childOf(repo, parent.id, 'child-1', 1)
  parentIdleTurn(svc, parent, 1)
  writerTurn(svc, child, 1, 'ab.js')
  const agent = agentFor(repo, parent.id)
  const error = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['ab.js', 'ab.js'],
    items: [],
  }).then(() => null, e => e)
  assert.ok(error, 'covering a credited file with a review requires adoption')
  const refusals = (error.errors ?? [error.message]).filter(line => /was written by child-1, so covering it with a review requires listing it in adopted_files/.test(line))
  assert.equal(refusals.length, 1, `one adoption refusal for one path: ${JSON.stringify(error.errors ?? error.message)}`)
})

// T1 (OCR-CODE-T1-R1-6): a group naming no filed path gets its own next action. A group claim
// is skipped by the claim route, but an exact claim of the concrete path would file it, so the
// refusal must name that action instead of claiming no action helps (or that adding the group
// to claims files it).
test('a group naming no filed path names the exact claim that files the concrete file', async t => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'concrete.js'), 'export const concrete = 1\n')
  const svc = service()
  t.after(() => cleanupService(svc))
  const parent = parentOf(repo)
  parentIdleTurn(svc, parent, 1)
  const agent = agentFor(repo, parent.id)

  const claimRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'concrete*', decision: 'mine' }],
    items: [],
  }).then(() => null, e => e)
  assert.ok(claimRefusal, 'a group claim naming no filed path must refuse')
  const claimMessage = claimRefusal.errors?.join('\n') ?? claimRefusal.message
  assert.match(claimMessage, /names no filed changed file/, 'the refusal names the condition')
  assert.match(claimMessage, /exact value|exact claim|exact path/i, 'the claim refusal names the exact-claim next action')
  assert.doesNotMatch(claimMessage, /no action on this path helps/, 'the claim refusal does not say nothing helps')

  const reviewRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    reviewed_code_files: ['concrete*'],
    items: [],
  }).then(() => null, e => e)
  assert.ok(reviewRefusal, 'a group review naming no filed path must refuse')
  const reviewMessage = reviewRefusal.errors?.join('\n') ?? reviewRefusal.message
  assert.match(reviewMessage, /exact value|exact claim|exact path/i, 'the non-claim refusal also names the exact-claim next action')
  assert.doesNotMatch(reviewMessage, /a claim is the route that files it/, 'the non-claim refusal does not promise the group claim files it')

  // The adopted and demonstrated descriptor rows share this wording. A group-only claim flag
  // leak in either row adds the claim-only clause, which is false for those entries.
  const adoptedRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    adopted_files: ['concrete*'],
    items: [],
  }).then(() => null, e => e)
  assert.ok(adoptedRefusal, 'an adopted group naming no filed path must refuse')
  const adoptedMessage = adoptedRefusal.errors?.join('\n') ?? adoptedRefusal.message
  assert.match(adoptedMessage, /exact value|exact claim|exact path/i, 'the adopted refusal names the exact-claim action')
  assert.doesNotMatch(adoptedMessage, /so this grouped claim files nothing/, 'the adopted refusal does not use claim-only wording')

  const demonstratedRefusal = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    demonstrated_files: [{ path: 'concrete*', note: 'ran the fixture' }],
    items: [],
  }).then(() => null, e => e)
  assert.ok(demonstratedRefusal, 'a demonstrated group naming no filed path must refuse')
  const demonstratedMessage = demonstratedRefusal.errors?.join('\n') ?? demonstratedRefusal.message
  assert.match(demonstratedMessage, /exact value|exact claim|exact path/i, 'the demonstrated refusal names the exact-claim action')
  assert.doesNotMatch(demonstratedMessage, /so this grouped claim files nothing/, 'the demonstrated refusal does not use claim-only wording')

  const accepted = await svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: [{ path: 'concrete.js', decision: 'mine' }],
    reviewed_code_files: ['concrete.js'],
    demonstrated_files: [{ path: 'concrete.js', note: 'ran the fixture' }],
    items: [],
    summary: 'The concrete exact claim files the path.',
  })
  assert.equal(accepted.pass, true, `an exact claim of the concrete path files it: ${JSON.stringify(accepted.blockers)}`)
})
