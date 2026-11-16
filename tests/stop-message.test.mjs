import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { advisoryMessage, registerMarkdown, repositoriesMarkdown } from '../lib/report.js'
import { userMessage } from './user-message.mjs'

// The stop message of ticket personal#3nm5. At a stop the gate sends at most one advisory steer, covering every repository
// the session changed that still has unfinished work. The stop path runs no project check, so a test script in a
// repository never runs during a stop. These tests drive the service through its own seam, a stub host that feeds
// session events and a change record, and read the steers it sends. Fixtures live under the task's Trash root.

const TURN = 3
const INTRO = 'new to this session'
const workRoot = path.join(os.homedir(), 'Trash', '3nm5-tests')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// A committed repository with one file. Each call makes a new directory, so tests never share a tree.
function tempRepo(label) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, `${label}-`)))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// A repository whose app.js differs from its commit, so it is a changed repository.
function changedRepo(label) {
  const dir = tempRepo(label)
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 2\n')
  return dir
}

// A fake host recorder. `summary` serves one announced sequence, and `diff` serves the added lines of each listed file.
function recorder() {
  const entries = new Map()
  const diffs = new Map()
  return {
    entries,
    diffs,
    summary(sessionId, seq) { return entries.get(`${sessionId}:${seq}`) },
    async diff(sessionId, seq, index) {
      const lines = diffs.get(`${sessionId}:${seq}`)?.[index]
      return lines === undefined ? undefined : { kind: 'text', hunks: [{ lines }] }
    },
  }
}

// The gate on a stub host. Turn events reach it through the session/event hook, as the host publishes them.
function service({ workspaceChanges = recorder(), settings = {} } = {}) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'settings-')))
  const listeners = new Map()
  const tools = {}
  const off = () => () => {}
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) },
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off,
    tools: { register: definition => { tools.completion_gate = definition; return off() } },
    commands: { register: off }, systemPrompt: { section: off }, webServer: { register: off },
  }
  const instance = new CompletionGateService(ctx, settings, { settingsPath: path.join(dir, 'settings.json') })
  instance.start()
  instance.__tool = tools.completion_gate
  let published = 0
  // Publishes one event the way the host does, and returns the sequence the event was given.
  instance.publish = (agent, type, data) => {
    const seq = ++published
    listeners.get('session/event')({ id: agent.id }, { type, seq, time: Date.now(), data })
    return seq
  }
  return instance
}

function agentFor(cwd, { id = 'session-1', subagent = false } = {}) {
  const steers = [], followups = []
  const header = subagent ? { cwd, parentSession: 'root', delegationDepth: 1 } : { cwd }
  return { id, session: { header }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

// The host opens every turn with `turn/start`, then appends the batch of queued messages for that turn, the real user
// prompt included, before the first step. The gate reads that prompt on the `session/event` hook, so the harness
// delivers the same sequence here and a stop never runs in a state the host cannot produce.
function begin(svc, agent, turn = TURN) {
  svc.publish(agent, 'turn/start', { turn })
  svc.publish(agent, 'user/message', userMessage(agent.id, turn))
}

// Announces one turn's change record the way the host does: first the root session's own file-tool calls for each path
// (the session wrote every listed file with its `write` tool), then the event and the summary it serves for that sequence.
function announce(svc, agent, { turn = TURN, cwd, files, total = files.length, diffs = null }) {
  for (const file of files) svc.publish(agent, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: file, content: 'x\n' }) })
  const seq = svc.publish(agent, 'workspace/changes', { turn })
  svc.changeService().diffs.delete(`${agent.id}:${seq}`)
  svc.changeService().entries.set(`${agent.id}:${seq}`, {
    turn, cwd, files: files.map(p => ({ path: p, display: p, added: 1, deleted: 0 })), total, added: files.length, deleted: 0,
  })
  if (diffs) svc.changeService().diffs.set(`${agent.id}:${seq}`, diffs)
  return seq
}

// A catalog with the given item ids. Each item carries its name and what passing it proves.
function writeCatalog(repo, ids) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  const items = ids.map(id => ({ id, name: id, proves: `${id} holds`, addedAt: stamp, updatedAt: stamp }))
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
}

function stop(svc, agent, turn = TURN) {
  return svc.stopping({ agent, turn, signal: new AbortController().signal })
}

// A real user prompt reaches the hook as the turn's `user/message` with the host's `user` source kind. `begin`
// already delivers the prompt that opens a turn, so this publishes only the extra prompts a test needs.
function prompt(svc, agent, turn = TURN) {
  svc.publish(agent, 'user/message', userMessage(agent.id, turn))
}

function steerText(steer) { return steer.content.map(part => part.text).join('') }

// Ticket personal#0k21 (hourly throttle): the gate tracks the last spoken advisory time
// per session. A test ages that time directly, so a later prompt can be at/after the
// hour without waiting in real time.
const HOUR_MS = 60 * 60 * 1000
function ageLastAdvisory(svc, agent, msAgo) { svc.state(agent).lastAdvisoryAt = Date.now() - msAgo }
function pastHour(svc, agent) { ageLastAdvisory(svc, agent, HOUR_MS + 1000) }

// The advisory shape every message keeps: it says nothing is stopped and never uses blocking wording.
function assertAdvisory(text) {
  assert.match(text, /nothing is stopped/i, 'the message must say nothing is stopped')
  assert.doesNotMatch(text, /blocked|block/i, 'the message must not use blocking wording')
}

test('two repositories with unfinished work produce one steer that names both', async () => {
  const a = changedRepo('two-a')
  const b = changedRepo('two-b')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent)
  announce(svc, agent, { cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'one stop with two unfinished repositories must send exactly one steer')
  const text = steerText(agent.steers[0])
  assert.ok(text.includes(`Root: ${a}`), `the steer must name the first root: ${text}`)
  assert.ok(text.includes(`Root: ${b}`), `the steer must name the second root: ${text}`)
  assert.ok(text.includes(path.join(a, 'app.js')), 'the steer must list the first repository\'s changed file')
  assert.ok(text.includes(path.join(b, 'app.js')), 'the steer must list the second repository\'s changed file')
})

test('several unfinished repositories produce one steer per stop', async () => {
  const a = changedRepo('several-a')
  const b = changedRepo('several-b')
  const c = changedRepo('several-c')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent)
  announce(svc, agent, { cwd: a, files: ['app.js', path.join(b, 'app.js'), path.join(c, 'app.js')] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'three unfinished repositories must still produce exactly one steer')
  const text = steerText(agent.steers[0])
  for (const root of [a, b, c]) assert.ok(text.includes(`Root: ${root}`), `the steer must name ${root}`)
})

test('a fully attested repository with no unfinished work produces no steer', async () => {
  const repo = changedRepo('attested')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the attestation must complete the repository: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a complete repository must not produce a steer')
})

test('the introduction appears in the first message for a repository and never again', async () => {
  const repo = changedRepo('intro')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the first prompt sends the first message')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a later stop of the same prompt is silent')
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt sends one message')
  const first = steerText(agent.steers[0])
  const second = steerText(agent.steers[1])
  assert.ok(first.includes(INTRO), 'the first message must introduce the repository')
  assert.ok(first.includes(path.join(repo, '.dsh', 'verification.json')), 'the introduction must point at the catalog')
  assert.ok(first.includes('Attestation: missing'), 'a repository never attested must say its attestation is missing')
  assert.ok(!second.includes(INTRO), 'the second message must not repeat the introduction')
  assert.ok(second.includes(`Root: ${repo}`), 'the second message must still name the repository')
})

test('a silent stop does not spend the repository introduction', async () => {
  const repo = changedRepo('intro-wait')
  const svc = service({ settings: { enabled: false } })
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'precondition: a disabled gate sends nothing, so nothing is introduced')
  svc.updateSettings({ enabled: true })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the first delivered message must come after the gate is enabled')
  assert.ok(steerText(agent.steers[0]).includes(INTRO), 'the introduction must reach the first delivered message')
})

test('an assumed item shows its reason and is labelled a promise, not a run', async () => {
  const repo = changedRepo('assumed')
  writeCatalog(repo, ['browser'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    items: [{ id: 'browser', state: 'assumed', reason: 'no display is attached to this host' }],
  })
  assert.equal(result.pass, false, 'precondition: app.js is still unclaimed, so the repository stays open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('no display is attached to this host'), `the assumed reason must be shown: ${text}`)
  assert.match(text, /assumed, not run/, 'an assumed item must be labelled as not run')
  assert.match(text, /promise, not a pass/, 'an assumed item must be labelled as a promise')
})

// Ticket personal#tz9r: the message keeps the review obligations in front of the model. A claimed code file the latest
// attestation did not review, and a changed document no true documentation check covered, are listed by path, and the one
// next step says to review, check the documents, then honestly attest.
test('the message lists a claimed code file that is not reviewed and the missing documentation check', async () => {
  const repo = changedRepo('review-nag')
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'notes\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'NOTES.md'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'NOTES.md', decision: 'mine' }],
  })
  assert.equal(result.pass, false, 'precondition: the unreviewed code file and the unchecked document keep the repository open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  const lines = text.split('\n')
  const codeAt = lines.indexOf('Changed code not reviewed yet:')
  assert.ok(codeAt >= 0, `the message must list the code files not reviewed: ${text}`)
  assert.equal(lines[codeAt + 1], `- ${path.join(repo, 'app.js')}`, 'the unreviewed claimed code file must be listed under its heading')
  const docsAt = lines.indexOf('Changed documentation not checked yet:')
  assert.ok(docsAt >= 0, `the message must list the missing documentation check: ${text}`)
  assert.equal(lines[docsAt + 1], `- ${path.join(repo, 'NOTES.md')}`, 'the unchecked document must be listed under its heading')
  const next = lines.find(line => line.startsWith('Next:'))
  assert.ok(next, 'the message must carry a next step')
  assert.match(next, /review each changed code file you claim/, 'the next step must say to review the claimed code files')
  assert.match(next, /check each changed document you did not reject/, 'the next step must say to check the unrejected documents')
  assert.match(next, /honestly attest/, 'the next step must say to attest honestly')
  assert.match(next, /demonstrate the change in real use/, 'the next step must say to demonstrate the change, because a review is only a reading')
  assert.match(next, /demonstrated_files naming each path/, 'the next step must name the field that records the run')
})

test('the message lists reviewed files that were never demonstrated and says a review is not a run', async () => {
  const repo = changedRepo('demonstration-nag')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const reviewed = await svc.attest(agent, { repository_root: repo, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] })
  assert.equal(reviewed.pass, false, 'precondition: a reviewed file with no run keeps the repository open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const lines = steerText(agent.steers[0]).split('\n')
  const at = lines.indexOf('Reviewed as a reading but not demonstrated yet (a review is not a run; show the change working in the place it serves):')
  assert.ok(at >= 0, `the message must name the reviewed but undemonstrated files: ${lines.join('\n')}`)
  assert.equal(lines[at + 1], `- ${path.join(repo, 'app.js')}`, 'the reviewed file must be listed under that heading')
})

test('an item marked unrelated to the session is omitted from the message', async () => {
  const repo = changedRepo('unrelated-omitted')
  writeCatalog(repo, ['unit', 'browser'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'unrelated' }],
  })
  assert.equal(result.pass, false, 'precondition: other.js is unclaimed, so the repository stays open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('- unit (unit): passed'), `the item that bears on the session is listed: ${text}`)
  assert.ok(text.includes(path.join(repo, 'other.js')), 'precondition: the unclaimed file is listed')
  assert.doesNotMatch(text, /browser/, 'the unrelated item is omitted from the message')
})

test('a repository whose items are all unrelated contributes nothing to the message', async () => {
  const repo = changedRepo('all-unrelated')
  writeCatalog(repo, ['unit', 'browser'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'unrelated' }, { id: 'browser', state: 'unrelated' }],
  })
  assert.equal(result.pass, true, `precondition: nothing else is unfinished: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a repository with only unrelated items left must contribute nothing')
})

// The message when no item is marked unrelated: the stated items are listed with their states in catalog order, and one
// summary line names the unstated items as history.
test('with no item marked unrelated the message lists the stated items and one summary line', async () => {
  const repo = changedRepo('no-unrelated')
  writeCatalog(repo, ['unit', 'browser', 'smoke'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'assumed', reason: 'no display is attached' }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  const lines = text.split('\n')
  const at = lines.indexOf('Verification items:')
  assert.ok(at >= 0, 'precondition: the message lists the verification items')
  const listed = []
  for (let index = at + 1; index < lines.length && lines[index].startsWith('- '); index += 1) listed.push(lines[index])
  assert.deepEqual(listed, [
    '- unit (unit): passed',
    '- browser (browser): assumed, not run. This is a promise, not a pass. Reason: no display is attached',
  ])
  assert.equal(lines.filter(line => line === 'Unstated catalog items: 1 (history; no action required unless adopted).').length, 1, `the unstated item is one summary line: ${text}`)
  assert.ok(!lines.some(line => line.startsWith('- smoke')), 'the unstated item has no per-item line')
})

// The zero case: when every catalog item is stated, neither output prints the history line.
test('a message whose every item is stated omits the summary line', async () => {
  const repo = changedRepo('zero-unstated')
  writeCatalog(repo, ['unit', 'browser'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'assumed', reason: 'no display is attached' }],
  })
  assert.equal(result.pass, false, 'precondition: other.js is unclaimed, so the repository stays open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const lines = steerText(agent.steers[0]).split('\n')
  assert.ok(lines.includes('- unit (unit): passed'), 'the stated item is listed')
  assert.ok(!lines.some(line => line.startsWith('Unstated catalog items:')), 'every item is stated, so the summary line is omitted')
})

test('the message says it is advisory, nothing is stopped, and it never says BLOCKED', async () => {
  const repo = changedRepo('advisory')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /advisory/i, 'the message must say it is advisory')
  assert.match(text, /nothing is stopped/i, 'the message must say nothing is stopped')
  assert.match(text, /no project verification check ran/, 'the header must say no project verification check ran')
  assert.doesNotMatch(text, /gate ran no check/, 'the header must not claim the gate ran no check')
  assert.doesNotMatch(text, /blocked|block/i, 'the message must not use blocking wording')
})

test('one prompt speaks once, a changed change set waits, and the next prompt speaks again', async () => {
  const repo = changedRepo('bound')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 4; i += 1) await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the prompt speaks once, whatever the number of stops')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a changed file inside the prompt must not speak again')
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt speaks again')
})

test('a repository changed after its attestation says its attestation is stale', async () => {
  const repo = changedRepo('stale')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the attestation must complete the repository: ${result.problems.join(' | ')}`)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a change after the attestation reopens the repository, so a message speaks')
  const text = steerText(agent.steers[0])
  assert.match(text, /Attestation: stale/, 'the attestation must be reported as stale')
  assert.match(text, /dropped/, 'the stale attestation must say it was dropped')
})

test('a changed file in a repository with an unreadable catalog is named, and the catalog is not listed as empty', async () => {
  const repo = changedRepo('unreadable')
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), '{ not json')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /Catalog unreadable/, 'an unreadable catalog must be named as unreadable')
  assert.match(text, /cannot be read/, 'the introduction must say the catalog cannot be read')
  assert.doesNotMatch(text, /Read it, adopt/, 'an unreadable catalog must not be told to read and adopt items')
  const next = text.split('\n').find(line => line.startsWith('Next:'))
  assert.ok(next, 'the message must carry a next step')
  assert.match(next, /^Next: repair the verification catalog/, 'the next step must repair the catalog before any registration')
})

test('an absent host recorder gives one short undetermined message', async () => {
  const svc = service({ workspaceChanges: null })
  const agent = agentFor(tempRepo('absent'))
  begin(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an undetermined change set must produce one message')
  assert.match(steerText(agent.steers[0]), /cannot be determined/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a gated subagent session gives one undetermined message', async () => {
  const svc = service({ settings: { gateSubagents: true } })
  const agent = agentFor(tempRepo('subagent'), { subagent: true })
  begin(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a subagent the recorder excludes must produce one message')
  assert.match(steerText(agent.steers[0]), /does not record this session/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('an announced record whose summary is missing gives one undetermined message', async () => {
  const svc = service()
  const agent = agentFor(tempRepo('missing-summary'))
  begin(svc, agent)
  svc.publish(agent, 'workspace/changes', { turn: TURN })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an announced record that cannot be read must produce one message')
  assert.match(steerText(agent.steers[0]), /no longer available/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a truncated record gives one undetermined message', async () => {
  const repo = changedRepo('truncated')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'], total: 2 })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a truncated record must produce one message')
  assert.match(steerText(agent.steers[0]), /carries only 1 of them/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a change set over the changed-file bound gives one undetermined message', async () => {
  const repo = tempRepo('over-bound')
  const files = Array.from({ length: 11 }, (_, i) => `file${i}.js`)
  const svc = service({ settings: { maxChangedFiles: 10 } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a change set over the bound must produce one message')
  assert.match(steerText(agent.steers[0]), /over the configured limit of 10/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('an ended turn with no change announcement produces no message', async () => {
  const repo = tempRepo('ended')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  svc.publish(agent, 'turn/end', { turn: TURN })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a covered turn that changed nothing must send nothing')
})

test('a credential pattern in the added lines is named by its rule, and its value is not echoed', async () => {
  const repo = changedRepo('credential')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('Possible hard-coded credential or secret'), `the rule must be named: ${text}`)
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

test('the stop runs no project check: a test script that writes a marker leaves it absent', async () => {
  const repo = changedRepo('no-check')
  const marker = path.join(repo, 'check-ran.marker')
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'probe', version: '1.0.0', scripts: { test: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
  }, null, 2)}\n`)
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the stop must still send its message')
  assert.equal(fs.existsSync(marker), false, 'the stop must not start the project test script')
})

test('a later turn without a real user prompt does not re-arm the advisory', async () => {
  const repo = changedRepo('bound-turn')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its one message')
  // A later turn whose only user message carries another producer's kind, as a recovery followup or injected
  // context does. `begin` opens the turn but delivers no real prompt, so the spent message stays spent.
  svc.publish(agent, 'turn/start', { turn: 4 })
  svc.publish(agent, 'user/message', { id: 'plugin-note', role: 'user', source: { kind: 'plugin:other' }, content: [{ type: 'text', text: 'context' }] })
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a turn the user did not start must not re-arm the message')
})

test('a message for 51 unfinished files names every file, the last one included', async () => {
  const repo = tempRepo('many-files')
  const files = Array.from({ length: 51 }, (_, i) => `file${i}.js`)
  for (const file of files) fs.writeFileSync(path.join(repo, file), 'const x = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('Changed files not claimed yet'))
  assert.ok(start >= 0, 'precondition: the message must list the unclaimed files')
  const unclaimed = []
  for (let i = start + 1; i < lines.length && lines[i].startsWith('- '); i += 1) unclaimed.push(lines[i])
  assert.equal(unclaimed.length, 51, 'every unclaimed file must be listed, not summarized')
  assert.ok(unclaimed.every(line => line.startsWith(`- ${repo}`)), 'every unclaimed line must be a path, with no count line')
  assert.ok(unclaimed.some(line => line.endsWith('file50.js')), 'the last unclaimed file must be listed')
})

// An item the session never stated is history: it gets no per-item line, and one summary line names the count.
test('an unstated item is one summary line, not a per-item state', async () => {
  const repo = changedRepo('unreported-item')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /^Unstated catalog items: 1 \(history; no action required unless adopted\)\.$/m, 'the unstated item must be counted as history')
  assert.doesNotMatch(text, /unit \(unit\)/, 'an unstated item must get no per-item line')
  assert.doesNotMatch(text, /no state reported yet/, 'the old per-item wording must be gone')
})

test('a changed file whose added lines could not be read is named even when no credential hit exists', async () => {
  const repo = changedRepo('gap-only')
  writeCatalog(repo, ['unit'])
  const changes = recorder()
  changes.diff = async () => { throw new Error('transient read failure') }
  const svc = service({ workspaceChanges: changes })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an unread file must send a message even when the repository is complete')
  const text = steerText(agent.steers[0])
  assert.match(text, /1 changed file could not be read for this scan/, 'the heading must count the unread file')
  assert.match(text, /^- app\.js: transient read failure$/m, 'the unread file must be named by its path, with its read error')
  assertAdvisory(text)
})

test('with the credential scan off, an unread file sends nothing when the repository is complete', async () => {
  const repo = changedRepo('gap-scan-off')
  writeCatalog(repo, ['unit'])
  const changes = recorder()
  changes.diff = async () => { throw new Error('transient read failure') }
  const svc = service({ workspaceChanges: changes, settings: { securityScan: false } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'with no scan running, a gap must not claim that a scan was incomplete')
})

test('an attested nested repository whose HEAD becomes unreadable on a later stop with no change is named', async () => {
  const repo = tempRepo('nested-later')
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child'])
  writeCatalog(child, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 1)
  announce(svc, agent, { turn: 1, cwd: repo, files: [child] })
  const result = await svc.attest(agent, {
    repository_root: child,
    claims: [{ path: '.', decision: 'mine' }],
    reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the nested repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 0, 'precondition: the attested nested repository is complete at its commit')
  // Turn 2 ends with no change record. Git can no longer read the nested HEAD, and the pointer did not move.
  begin(svc, agent, 2)
  svc.publish(agent, 'turn/end', { turn: 2 })
  fs.writeFileSync(path.join(child, '.git', 'HEAD'), 'ref: refs/heads/missing-for-test\n')
  await stop(svc, agent, 2)
  assert.equal(agent.steers.length, 1, 'a later stop must name the nested HEAD it could not read')
  const text = steerText(agent.steers[0])
  assert.match(text, /Nested repository .*: could not read its HEAD at this stop/, 'the notice must say the nested HEAD could not be read at this stop')
  assert.ok(text.includes(child), 'the notice must name the nested repository by its path')
  assertAdvisory(text)
})

// A file the host cannot compare as text serves no lines, so the scan never reads its added lines. The gate saw that gap,
// so the gap line must name it, with a complete repository, exactly as a thrown read does.
for (const kind of ['binary', 'oversized']) {
  test(`a changed file whose added lines come back ${kind} is named as unread, even when no credential hit exists`, async () => {
    const repo = changedRepo(`gap-${kind}`)
    writeCatalog(repo, ['unit'])
    const changes = recorder()
    changes.diff = async () => ({ kind, path: 'app.js', display: 'app.js' })
    const svc = service({ workspaceChanges: changes })
    const agent = agentFor(repo)
    begin(svc, agent)
    announce(svc, agent, { cwd: repo, files: ['app.js'] })
    const result = await svc.attest(agent, {
      repository_root: repo,
      claims: [{ path: 'app.js', decision: 'mine' }],
      reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }],
    })
    assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
    await stop(svc, agent)
    assert.equal(agent.steers.length, 1, `the ${kind} file must send a message even when the repository is complete`)
    const text = steerText(agent.steers[0])
    assert.match(text, /1 changed file could not be read for this scan/, 'the heading must count the unread file')
    assert.match(text, new RegExp(`^- app\\.js: ${kind}$`, 'm'), `the advisory must list app.js on its own line with its kind ${kind}`)
    assertAdvisory(text)
  })
}

test('a turn whose changed files cannot be attributed to a repository is named at the stop, and no check runs', async () => {
  const repo = changedRepo('attribution-failure')
  writeCatalog(repo, ['unit'])
  const svc = service()
  svc.repositories.merge = async () => { throw new Error('simulated EIO') }
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a failed attribution must send a message, because the gate saw the failure')
  const text = steerText(agent.steers[0])
  assert.match(text, /could not attribute the changed files of turn 3 to their repositories: simulated EIO/, 'the message must name the turn and the failure')
  assert.match(text, /no project verification check ran/i, 'the message must say no check ran')
  assertAdvisory(text)
})

// Ticket personal#x9af: the advisory speaks at most once since the last real user message. The host dispatches the
// stop hook at every attempt to end the turn, and the gate's own steer continues the turn, so a per-stop message
// repeats. The prompt is the turn a real user message starts; its source kind tells it apart from this plugin's
// steer and from the premature-stop recovery followup, which starts a turn of its own.

test('a user prompt with unfinished work sends exactly one advisory across every stop of its turn', async () => {
  const repo = changedRepo('one-per-prompt')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 4; i += 1) await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'one prompt must produce at most one advisory, however often the model tries to end')
})

test('a second stop of the same prompt sends nothing even when the change set changed', async () => {
  const repo = changedRepo('same-prompt-new-set')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a changed file inside one prompt must not speak twice')
  fs.writeFileSync(path.join(repo, 'app2.js'), 'const extra = 1\n')
  announce(svc, agent, { cwd: repo, files: ['app.js', 'app2.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a new file inside one prompt must not speak twice')
})

test('a new real user message re-arms exactly one message', async () => {
  const repo = changedRepo('rearm')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 3; i += 1) await stop(svc, agent, 3)
  const before = agent.steers.length
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, before + 1, 'a new real user message must re-arm exactly one advisory')
  assert.equal(before, 1, 'precondition: the first prompt has spent its one message')
})

test('the gate\'s own steered continuation does not re-arm the advisory', async () => {
  const repo = changedRepo('steer-no-rearm')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  // A steer stays in the same turn, and the host appends its message with this plugin's source.
  svc.publish(agent, 'user/message', {
    id: 'steered', role: 'user', source: { kind: 'plugin:dsh-completion-gate' },
    content: [{ type: 'text', text: steerText(agent.steers[0]) }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the gate\'s own steer must not re-arm its one message')
})

test('a premature-stop recovery turn does not re-arm the advisory, even with the message unspent', async () => {
  const repo = changedRepo('followup-no-rearm')
  const svc = service()
  const agent = agentFor(repo)
  // The real prompt changes nothing, so its own stop has nothing to say and the one message stays unspent.
  begin(svc, agent, 3)
  // The model ends turn 3 while saying work is pending, so the guard queues its recovery followup straight away.
  svc.publish(agent, 'assistant/message', { turn: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'Next I will run the suite.' }] } })
  await stop(svc, agent, 3)
  assert.equal(agent.followups.length, 1, 'precondition: a future-intent stop queues one recovery followup')
  assert.equal(agent.steers.length, 0, 'precondition: the prompt message is still unspent')
  // The followup opens the next host turn, and its message carries this plugin's source, so no real prompt starts.
  // That turn owes real work, so a bound keyed on the turn alone would speak here. The prompt is what bounds the
  // message, so the recovery turn speaks the prompt's one message rather than a second one.
  svc.publish(agent, 'turn/start', { turn: 4 })
  const queued = svc.publish(agent, 'user/message', {
    id: 'followup', role: 'user', source: { kind: 'plugin:dsh-completion-gate' },
    content: [{ type: 'text', text: 'PREMATURE STOP RECOVERY: Continue the unfinished task.' }],
  })
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  assert.ok(Number.isInteger(queued), 'precondition: the followup message was published')
  assert.match(svc.state(agent).promptId, /^prompt-session-1-3/, 'precondition: the followup did not start a prompt')
  svc.publish(agent, 'assistant/message', { turn: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'The suite passes.' }] } })
  // The recovery turn answers plainly, so the guard queues no second followup and the stop reaches the bound.
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'the recovery turn speaks the prompt\'s single message, not a second one')
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a later stop of the recovery turn must stay silent')
  assert.equal(agent.followups.length, 1, 'the recovery turn must not queue a second followup')
  // A real user message is what re-arms, so the next prompt speaks once more.
  pastHour(svc, agent)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'the next real prompt must re-arm exactly one message')
})

test('a notice recorded after the prompt message waits for the next real prompt', async () => {
  const a = changedRepo('notice-wait-a')
  const b = changedRepo('notice-wait-b')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: a, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1)
  assert.ok(steerText(agent.steers[0]).includes(INTRO), 'precondition: the first message introduces the first repository')
  announce(svc, agent, { turn: 3, cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a repository seen after the message must wait for the next prompt')
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt carries the waiting notice')
  const second = steerText(agent.steers[1])
  assert.ok(second.includes(INTRO), 'the second message must introduce the repository that waited')
  assert.ok(second.includes(`Root: ${b}`), 'the second message must name the waiting repository')
})

test('a credential hit recorded after the prompt message waits for the next real prompt', async () => {
  const repo = changedRepo('credential-wait')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'the first message has no hit to name')
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a hit recorded after the message must ride the next prompt, not a second message')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt carries the hit')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the next message must name the rule')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

// A hit the bound suppressed is kept, not lost: the change record is turn-scoped, so the next prompt's own diff cannot
// show it again. The hit rides the next prompt's one message even when that prompt changes nothing that trips the scan.
test('a credential hit suppressed by the bound is carried into the next prompt even when its own diff is clean', async () => {
  const repo = changedRepo('credential-carried')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'precondition: the first message has no hit to name')
  // The same prompt stops again, and now the read succeeds and exposes the credential. The bound suppresses the message.
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the second stop of one prompt must stay silent')
  // The next prompt changes nothing that trips the scan, so only a retained hit can name the credential.
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt must speak once')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the carried hit must be named even when the new diff is clean')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
  // The carried hit is spent: a later prompt must not repeat a credential the session already saw.
  pastHour(svc, agent)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 5)
  const later = agent.steers.at(-1)
  assert.equal(agent.steers.length, 3, 'precondition: the later prompt speaks about its own unfinished work')
  assert.doesNotMatch(steerText(later), /Possible hard-coded credential/, 'a carried hit must not be repeated once it has been named')
})

test('verificationNudgeLimit is not consulted', async () => {
  const repo = changedRepo('nudge-dead')
  const svc = service({ settings: { verificationNudgeLimit: 0 } })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a zero verificationNudgeLimit must not silence the advisory')
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the retired limit must not bound a later prompt either')
})

test('an enabled false setting silences the gate for a real prompt', async () => {
  const repo = changedRepo('disabled-prompt')
  const svc = service({ settings: { enabled: false } })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 0, 'a disabled gate must not speak')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 0, 'a disabled gate must stay silent across prompts')
})

test('a stop with nothing to say does not spend the prompt message', async () => {
  const repo = changedRepo('nothing-then-something')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  // The turn ended covered and announced no change, so the first stop has nothing to say.
  svc.publish(agent, 'turn/end', { turn: 3 })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 0, 'precondition: an unchanged turn sends nothing')
  const b = changedRepo('nothing-then-something-b')
  announce(svc, agent, { turn: 3, cwd: repo, files: [path.join(b, 'app.js')] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the first stop with something to say must carry the prompt message')
})

// A stop the host dispatched before any real user message armed the bound owes the one message later, so the first
// prompt of the session is not swallowed as if the unarmed stop had spent it.
test('a stop that arrives before any real user prompt does not spend the first prompt message', async () => {
  const repo = changedRepo('unarmed')
  const svc = service()
  const agent = agentFor(repo)
  svc.publish(agent, 'turn/start', { turn: 1 })
  announce(svc, agent, { turn: 1, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 0, 'precondition: no prompt has armed the bound, so the first stop speaks nothing')
  prompt(svc, agent, 1)
  announce(svc, agent, { turn: 1, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 1, 'the first real prompt must still get its one message')
})

// The bound is one message per prompt, so a second real user message reaches the gate as a second prompt of the same
// turn and must be able to speak, even though the turn number did not change.
test('a second real user message in the same turn re-arms the bound', async () => {
  const repo = changedRepo('same-turn')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first prompt speaks')
  pastHour(svc, agent)
  svc.publish(agent, 'user/message', userMessage(agent.id, 3))
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 2, 'a second real prompt in the same turn must arm its own message')
})

// Two silent stops of one prompt rescan the same turn record. The kept hit must name the credential once, not once
// per stop, and the next prompt's own clean diff adds nothing.
test('two silent stops keep one copy of the same credential hit', async () => {
  const repo = changedRepo('credential-dedup')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  // The prompt's own stop reports unclaimed work, so it spends the one message before any hit exists.
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its message')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'precondition: the first message has no hit to name')
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'both stops of the prompt must stay silent')
  begin(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt speaks once')
  // The message counts hits by rule, so one kept hit reads as one line, not as two.
  const text = steerText(agent.steers[1])
  assert.match(text, /- Possible hard-coded credential or secret: 1 line$/m, `the carried hit must be counted once: ${text}`)
})

// A file whose added lines could not be read at a silent stop is a notice the next prompt's clean diff cannot show,
// so it rides the next prompt's message the same way a kept credential hit does.
test('a silent stop carries an unread-file notice the next prompt cannot read again', async () => {
  const repo = changedRepo('gap-carried')
  writeCatalog(repo, ['unit'])
  // Every read fails until the next prompt opens, so the unread file exists only in what the gate kept. The flips
  // the read off just before the prompt that must carry it.
  const changes = recorder()
  let failing = true
  changes.diff = async () => (failing ? Promise.reject(new Error('transient read failure')) : { kind: 'text', hunks: [{ lines: [] }] })
  const svc = service({ workspaceChanges: changes })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sent the advisory')
  assert.match(steerText(agent.steers[0]), /1 changed file could not be read for this scan/, 'precondition: the first message already named the unread file')
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its message on the unread file')
  // The repository is complete now. The host drops turn 3's saved diffs, so the report re-reads that turn cleanly and
  // the only way the unread file can be named again is the copy the bound kept.
  changes.diffs.clear()
  await svc.attest(agent, { repository_root: repo, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }], items: [{ id: 'unit', state: 'passed' }] })
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a stop over an attested, unchanged set must stay silent')
  failing = false
  pastHour(svc, agent)
  begin(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt speaks once')
  const text = steerText(agent.steers[1])
  assert.match(text, /1 changed file could not be read for this scan/, `the kept unread file must be named at the next prompt: ${text}`)
  assert.match(text, /- app\.js: transient read failure$/m, 'the kept unread file must be named by its path')
})

// Ticket personal#9v2n (catalog-spam C2, invariant I3): status/attest catalog sections print the catalog path, the
// archive path, and the active count, and never an unstated item's name, proves, or command text. Stated session
// items keep their individual lines.
const CATALOG_SPAM_ROOT = '/home/wilder/Trash/catalog-spam-report-tests'
function reportPaths() {
  const catalogPath = path.join(CATALOG_SPAM_ROOT, '.dsh', 'verification.json')
  const archivePath = path.join(CATALOG_SPAM_ROOT, '.dsh', 'verification-archive.json')
  return { catalogPath, archivePath }
}
function reportRepo({ catalog, items = [], unstatedCount = 0, problems = [] } = {}) {
  const { catalogPath } = reportPaths()
  return {
    label: 'repo', root: CATALOG_SPAM_ROOT, catalogPath,
    files: [], unclaimed: [], unreviewed: [], docsUnchecked: [], undemonstrated: [],
    catalog, items, unstatedCount, attestation: null, stale: false, introduced: true,
    problems, complete: false,
  }
}
function readableCatalog() {
  const { catalogPath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  return {
    path: catalogPath, state: 'readable', problem: null,
    items: [
      { id: 'unit', name: 'Stated unit name', proves: 'STATED-PROVES-ONE', command: 'node stated-one.js', addedAt: stamp, updatedAt: stamp },
      { id: 'secret-one', name: 'Unstated secret one name', proves: 'UNSTATED-PROVES-ONE', command: 'node unstated-one.js', addedAt: stamp, updatedAt: stamp },
      { id: 'secret-two', name: 'Unstated secret two name', proves: 'UNSTATED-PROVES-TWO', command: 'node unstated-two.js', addedAt: stamp, updatedAt: stamp },
    ],
  }
}

test('ticket 1: a readable catalog prints both paths and the count, the stated item, and no unstated item text', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({
    catalog: readableCatalog(),
    items: [{ id: 'unit', name: 'Stated unit name', state: 'passed' }],
    unstatedCount: 2,
  })
  const text = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  assert.ok(text.includes(catalogPath), `the catalog path must be printed: ${text}`)
  assert.ok(text.includes(archivePath), `the archive path must be printed: ${text}`)
  assert.ok(text.includes('Active catalog items: 3'), `the active count must be printed: ${text}`)
  assert.ok(text.includes('- unit: Stated unit name | passed'), `the stated item keeps its line: ${text}`)
  for (const secret of ['Unstated secret one name', 'Unstated secret two name', 'UNSTATED-PROVES-ONE', 'UNSTATED-PROVES-TWO', 'node unstated-one.js', 'node unstated-two.js', 'secret-one', 'secret-two']) {
    assert.ok(!text.includes(secret), `no unstated item text may be printed (${secret}): ${text}`)
  }
  assert.doesNotMatch(text, /STATED-PROVES-ONE|node stated-one\.js/, 'even the stated item proves and command text stay out of the catalog section')
})

test('ticket 1: a stated archived item keeps its line while the active catalog is only counted', () => {
  const { catalogPath, archivePath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  const catalog = {
    path: catalogPath, state: 'readable', problem: null,
    items: [{ id: 'fresh', name: 'Fresh unstated name', proves: 'FRESH-UNSTATED-PROVES', command: 'node fresh.js', addedAt: stamp, updatedAt: stamp }],
  }
  const repo = reportRepo({
    catalog,
    items: [{ id: 'old', name: 'Archived stated name', state: 'passed', archived: true }],
    unstatedCount: 1,
  })
  const status = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  assert.ok(status.includes('- old: Archived stated name | passed (archived)'), `the stated archived item keeps its status line and is marked archived: ${status}`)
  assert.ok(status.includes(catalogPath) && status.includes(archivePath), `both paths must be printed: ${status}`)
  assert.ok(status.includes('Active catalog items: 1'), `the active count must be printed: ${status}`)
  assert.ok(!status.includes('Fresh unstated name') && !status.includes('FRESH-UNSTATED-PROVES') && !status.includes('node fresh.js'), `the unstated active item text must not be printed: ${status}`)
  const advisory = advisoryMessage({ repositories: [repo] })
  assert.ok(advisory.includes(catalogPath) && advisory.includes(archivePath), `the advisory must gain both path lines: ${advisory}`)
  assert.ok(advisory.includes('- Archived stated name (old): passed (archived)'), `the advisory keeps the stated archived item and marks it archived: ${advisory}`)
  assert.ok(!advisory.includes('Fresh unstated name'), `the advisory must not list the unstated item: ${advisory}`)
})

test('ticket 1: an absent catalog prints both paths and a zero count', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'absent', items: [], problem: null } })
  const text = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an absent catalog: ${text}`)
  assert.ok(text.includes('Active catalog items: 0'), `an absent catalog counts zero active items: ${text}`)
  assert.match(text, /No catalog exists yet/, 'the absent catalog still says so')
})

test('ticket 1: an unreadable catalog prints both paths and its problem, never as readable', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'unreadable', items: [], problem: 'the file is not valid JSON: boom' } })
  const text = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an unreadable catalog: ${text}`)
  assert.match(text, /Catalog unreadable, so its items are not listed: the file is not valid JSON: boom/, 'the unreadable problem line is kept')
  assert.doesNotMatch(text, /Catalog readable, with no items yet/, 'an unreadable catalog is never shown as readable and empty')
})

test('ticket 1: an empty catalog prints both paths and a zero count', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'readable', items: [], problem: null } })
  const text = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an empty catalog: ${text}`)
  assert.ok(text.includes('Active catalog items: 0'), `an empty catalog counts zero active items: ${text}`)
  assert.match(text, /Catalog readable, with no items yet/, 'an empty readable catalog still says so')
})

test('ticket 1: register markdown with an archive problem names the path and problem with no success indication', () => {
  const { catalogPath, archivePath } = reportPaths()
  const text = registerMarkdown({
    path: catalogPath,
    items: [],
    exclusion: { applied: false, reason: 'the root is not a git repository' },
    archive: { path: archivePath, moved: [], problem: 'cannot write the archive file: EIO' },
  })
  assert.ok(text.includes(catalogPath), `the catalog path must be named: ${text}`)
  assert.ok(text.includes(archivePath), `the archive path must be named: ${text}`)
  assert.ok(text.includes('cannot write the archive file: EIO'), `the archive problem must be named: ${text}`)
  assert.doesNotMatch(text, /registered|updated/, 'a refused register shows no success indication')
})

test('ticket 1: register markdown without an archive problem names the archive path', () => {
  const { catalogPath, archivePath } = reportPaths()
  const text = registerMarkdown({
    path: catalogPath,
    items: [{ id: 'unit', name: 'Unit', created: true }],
    exclusion: { applied: false, reason: 'the root is not a git repository' },
    archive: { path: archivePath, moved: [], problem: null },
  })
  assert.ok(text.includes(archivePath), `the archive path must be named: ${text}`)
  assert.ok(text.includes('- unit: Unit (registered)'), `a successful register still lists its items: ${text}`)
})

test('ticket 1: the stop advisory prints both paths, the stated item, and no unstated item name', async () => {
  const repo = changedRepo('catalog-spam-advisory')
  writeCatalog(repo, ['unit', 'smoke'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes(path.join(repo, '.dsh', 'verification.json')), `the advisory must print the catalog path: ${text}`)
  assert.ok(text.includes(path.join(repo, '.dsh', 'verification-archive.json')), `the advisory must print the archive path: ${text}`)
  assert.ok(text.includes('- unit (unit): passed'), `the stated item keeps its advisory line: ${text}`)
  assert.doesNotMatch(text, /smoke/, 'the unstated item name must not appear in the advisory')
})

// Review round 1 finding 1: an unreadable archive is an unfinished obligation. The advisory must render the problem
// (archive path and cause) with repair guidance instead of silently dropping it and sending the model to register again.
test('review round 1: an unreadable archive is surfaced in the advisory with repair guidance', () => {
  const { catalogPath, archivePath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  const repo = reportRepo({
    catalog: { path: catalogPath, state: 'readable', problem: null, items: [{ id: 'unit', name: 'Unit', proves: 'p', addedAt: stamp, updatedAt: stamp }] },
    items: [{ id: 'unit', name: 'Unit', state: 'passed' }],
    problems: [`The archive at ${archivePath} cannot be read: the file is not valid JSON: boom.`],
  })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes(archivePath), `the advisory must name the archive path: ${text}`)
  assert.ok(text.includes('the file is not valid JSON: boom'), `the advisory must name the cause: ${text}`)
  assert.match(text, /Repair the archive/, 'the advisory must give repair guidance')
  assert.match(text, /do not register items until/i, 'the advisory must say not to register until the archive reads again')
  assert.match(text, /repair the verification archive/i, 'the next step must repair the archive before registering')
})

test('review round 1: a corrupt archive file reaches the stop advisory through the evaluator problem', async () => {
  const repo = changedRepo('advisory-corrupt-archive')
  writeCatalog(repo, ['unit'])
  const archivePath = path.join(repo, '.dsh', 'verification-archive.json')
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  fs.writeFileSync(archivePath, '{"version": 1, "items": [\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes(archivePath), `the advisory must name the corrupt archive path: ${text}`)
  assert.ok(text.includes('the file is not valid JSON'), `the advisory must name the cause: ${text}`)
  assert.match(text, /Repair the archive/, 'the advisory must give repair guidance')
})

// Review round 1 finding 2: every advisory reports the active count, independently of the unstated count. An unreadable
// catalog prints paths without a count, like the status report. The cases are all-stated, mixed, and empty.
test('review round 1: the advisory reports the active count when every item is stated', () => {
  const { catalogPath, archivePath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  const repo = reportRepo({
    catalog: { path: catalogPath, state: 'readable', problem: null, items: [
      { id: 'unit', name: 'Unit', proves: 'p', addedAt: stamp, updatedAt: stamp },
      { id: 'smoke', name: 'Smoke', proves: 'p', addedAt: stamp, updatedAt: stamp },
    ] },
    items: [{ id: 'unit', name: 'Unit', state: 'passed' }, { id: 'smoke', name: 'Smoke', state: 'passed' }],
    unstatedCount: 0,
  })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed: ${text}`)
  assert.ok(text.includes('Active catalog items: 2'), `the active count must be printed even when nothing is unstated: ${text}`)
  assert.doesNotMatch(text, /Unstated catalog items:/, 'no unstated line when every item is stated')
})

test('review round 1: the advisory reports the active count alongside the unstated count', () => {
  const { catalogPath, archivePath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  const repo = reportRepo({
    catalog: { path: catalogPath, state: 'readable', problem: null, items: [
      { id: 'unit', name: 'Unit', proves: 'p', addedAt: stamp, updatedAt: stamp },
      { id: 'secret-one', name: 'Unstated name', proves: 'SECRET-PROVES', command: 'node secret.js', addedAt: stamp, updatedAt: stamp },
    ] },
    items: [{ id: 'unit', name: 'Unit', state: 'passed' }],
    unstatedCount: 1,
  })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes('Active catalog items: 2'), `the active count must be printed independently: ${text}`)
  assert.ok(text.includes('Unstated catalog items: 1 (history; no action required unless adopted).'), `the unstated line is kept: ${text}`)
  assert.doesNotMatch(text, /Unstated name|SECRET-PROVES|node secret\.js/, 'no unstated item text may reach the advisory')
})

test('review round 1: the advisory reports a zero active count for an empty readable catalog', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'readable', items: [], problem: null } })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an empty catalog: ${text}`)
  assert.ok(text.includes('Active catalog items: 0'), `an empty readable catalog counts zero active items: ${text}`)
})

test('review round 1: the advisory reports a zero active count for an absent catalog', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'absent', items: [], problem: null } })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an absent catalog: ${text}`)
  assert.ok(text.includes('Active catalog items: 0'), `an absent catalog counts zero active items: ${text}`)
})

test('review round 1: the advisory for an unreadable catalog prints paths without an active count', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'unreadable', items: [], problem: 'the file is not valid JSON: boom' } })
  const text = advisoryMessage({ repositories: [repo] })
  assert.ok(text.includes(catalogPath) && text.includes(archivePath), `both paths must be printed for an unreadable catalog: ${text}`)
  assert.match(text, /Catalog unreadable/, 'the unreadable problem line is kept')
  assert.doesNotMatch(text, /Active catalog items:/, 'an unreadable catalog prints no count, like the status report')
})

test('review round 1: the advisory reports an active count through the stop path', async () => {
  const repo = changedRepo('advisory-active-count')
  writeCatalog(repo, ['unit', 'smoke'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('Active catalog items: 2'), `the advisory must print the active count: ${text}`)
})

// Tier-2 note from ticket 3 (model.md v1 event 7): a stated archived item is reported under its archived state. The
// archived tag must distinguish the two states in both the status and the advisory, while the count stays active-only.
test('review round 1: status and advisory distinguish an archived stated item from an active one', () => {
  const { catalogPath } = reportPaths()
  const stamp = '2026-11-07T00:00:00.000Z'
  const repo = reportRepo({
    catalog: { path: catalogPath, state: 'readable', problem: null, items: [
      { id: 'fresh', name: 'Fresh name', proves: 'FRESH-PROVES', command: 'node fresh.js', addedAt: stamp, updatedAt: stamp },
      { id: 'other', name: 'Other name', proves: 'OTHER-PROVES', command: 'node other.js', addedAt: stamp, updatedAt: stamp },
    ] },
    items: [
      { id: 'fresh', name: 'Fresh name', state: 'passed', archived: false },
      { id: 'old', name: 'Archived name', state: 'passed', archived: true },
    ],
    unstatedCount: 1,
  })
  const status = repositoriesMarkdown({ turn: 1, notices: [], repositories: [repo] })
  const statusLines = status.split('\n')
  assert.ok(statusLines.includes('- fresh: Fresh name | passed'), `the active stated item has no archived tag in status: ${status}`)
  assert.ok(statusLines.includes('- old: Archived name | passed (archived)'), `the archived stated item is marked archived in status: ${status}`)
  assert.ok(status.includes('Active catalog items: 2'), `the count stays active-only: ${status}`)
  const advisory = advisoryMessage({ repositories: [repo] })
  const advisoryLines = advisory.split('\n')
  assert.ok(advisoryLines.includes('- Fresh name (fresh): passed'), `the active stated item has no archived tag in the advisory: ${advisory}`)
  assert.ok(advisoryLines.includes('- Archived name (old): passed (archived)'), `the archived stated item is marked archived in the advisory: ${advisory}`)
  assert.ok(advisory.includes('Active catalog items: 2'), `the advisory count stays active-only: ${advisory}`)
})

// The turn's changed lines are readable even when the repository report throws, so a credential in them is named now
// rather than lost with the error notice.
test('a credential is named even when the repository report fails', async () => {
  const repo = changedRepo('credential-report-failure')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  const report = svc.repositoryReport
  svc.repositoryReport = async () => { throw new Error('report failure') }
  try { await stop(svc, agent, 3) } finally { svc.repositoryReport = report }
  assert.equal(agent.steers.length, 1, 'an evaluation failure still sends its one message')
  const text = steerText(agent.steers[0])
  assert.match(text, /could not evaluate the workspace/, 'the failure is still named')
  assert.match(text, /Possible hard-coded credential or secret/, 'the readable changed lines must still be scanned')
})

// Ticket 3 tool-level regressions: a register refused by an archive problem must reach the model as failure markdown
// through the tool handler, naming the path and cause with no success indication. Makes the first rename onto the named
// file throw, simulating a failed atomic write. Returns a restore function.
function failRenameOnce(fileName) {
  const original = fs.renameSync
  let done = false
  fs.renameSync = (src, dest) => {
    if (!done && String(dest).endsWith(fileName)) { done = true; throw new Error('simulated rename failure') }
    return original(src, dest)
  }
  return () => { fs.renameSync = original }
}

function seedStaleCatalog(repo) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const items = [{ id: 'old-item', name: 'Old item', proves: 'Old proves.', addedAt: stamp, updatedAt: stamp }]
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
}

function registerThroughTool(svc, agent, repo) {
  return svc.__tool.execute({ action: 'register', repository_root: repo, items: [{ name: 'Incoming', proves: 'Incoming proves.' }] }, { agent, signal: new AbortController().signal })
}

function assertFailureMarkdown(markdown, { catalogPath, archivePath, cause }) {
  assert.ok(markdown.includes(catalogPath), `the catalog path must be named: ${markdown}`)
  assert.ok(markdown.includes(archivePath), `the archive path must be named: ${markdown}`)
  assert.match(markdown, /Archive problem:/, 'the failure is named')
  assert.ok(markdown.includes(cause), `the cause must be named: ${markdown}`)
  assert.doesNotMatch(markdown, /registered|updated/, 'a refused register shows no success indication')
  assert.doesNotMatch(markdown, /^- incoming:/m, 'no incoming item is listed as written')
}

test('ticket 3: register through the tool handler renders an unreadable archive as failure markdown', async () => {
  const repo = changedRepo('tool-unreadable-archive')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const archivePath = path.join(repo, '.dsh', 'verification-archive.json')
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  fs.writeFileSync(archivePath, '{"version": 1, "items": [\n')
  const result = await registerThroughTool(svc, agent, repo)
  assertFailureMarkdown(result.markdown, {
    catalogPath: path.join(repo, '.dsh', 'verification.json'), archivePath,
    cause: 'the file is not valid JSON',
  })
})

test('ticket 3: register through the tool handler renders an archive-write failure as failure markdown', async () => {
  const repo = changedRepo('tool-archive-write-failure')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  seedStaleCatalog(repo)
  const restore = failRenameOnce('verification-archive.json')
  let result
  try { result = await registerThroughTool(svc, agent, repo) }
  finally { restore() }
  assertFailureMarkdown(result.markdown, {
    catalogPath: path.join(repo, '.dsh', 'verification.json'),
    archivePath: path.join(repo, '.dsh', 'verification-archive.json'),
    cause: 'simulated rename failure',
  })
})

test('ticket 3: register through the tool handler renders an active-write failure as failure markdown', async () => {
  const repo = changedRepo('tool-active-write-failure')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  seedStaleCatalog(repo)
  const catalogPath = path.join(repo, '.dsh', 'verification.json')
  const restore = failRenameOnce('verification.json')
  let result
  try { result = await registerThroughTool(svc, agent, repo) }
  finally { restore() }
  // The archive move is durable, so the stale item is a duplicate until the retry; either way the markdown names the
  // failing catalog path and cause with no success indication.
  assertFailureMarkdown(result.markdown, {
    catalogPath, archivePath: path.join(repo, '.dsh', 'verification-archive.json'),
    cause: 'simulated rename failure',
  })
})

// Review finding P3 (catalog-spam): advisory instructions must respect an unreadable archive. A new session with only
// an unreadable archive must not be told to adopt/register; it must be directed to repair the archive first.
test('review P3: a new session with only an unreadable archive repairs the archive before any adoption or registration', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'readable', items: [], problem: null } })
  repo.introduced = false
  repo.problems = [`The archive at ${archivePath} cannot be read: the file is not valid JSON: boom.`]
  const text = advisoryMessage({ repositories: [repo] })
  const intro = text.split('\n').find(line => line.startsWith('This repository is new'))
  assert.ok(intro, `the advisory must introduce the repository: ${text}`)
  assert.doesNotMatch(intro, /Read it, adopt/, `the introduction must not tell the session to adopt items while the archive is unreadable: ${intro}`)
  assert.doesNotMatch(intro, /register the items you will run/, `the introduction must not tell the session to register items while the archive is unreadable: ${intro}`)
  assert.ok(intro.includes(archivePath), `the introduction must name the unreadable archive: ${intro}`)
  assert.match(intro, /verification archive.*cannot be read/, 'the introduction must say the archive cannot be read')
  assert.match(intro, /Repair it so it reads again/i, 'the introduction must direct repair of the archive')
  assert.match(intro, /do not register items until/i, 'the introduction must defer registration until the archive reads again')
  assertAdvisory(text)
})

// Review finding P3 (catalog-spam): when both catalog and archive are unreadable, the next step must name BOTH repairs
// before any registration, because registering still refuses until the archive is repaired too.
// Ticket personal#0k21 (hourly throttle core, Q1/Q2/Q4): the first advisory in a
// session speaks at once and starts the hour; a second non-credential stop inside
// the hour stays silent and is held.
test('hourly throttle: the first advisory speaks at once and a second stop within the hour stays silent', async () => {
  const repo = changedRepo('hourly-first')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the first advisory in a session must speak at once')
  assert.ok(steerText(agent.steers[0]).includes(`Root: ${repo}`), 'the first advisory must name the repository')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'two non-credential stops within an hour must produce exactly one spoken advisory')
})

// Ticket personal#0k21 (hourly throttle core, S3): a stop just before the hour
// stays silent; the held advisory speaks at the first prompt-eligible stop at/after
// the hour.
test('hourly throttle: a stop just before the hour stays silent and the held advisory speaks at the hour', async () => {
  const repo = changedRepo('hourly-boundary')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a stop inside the hour must stay silent')
  ageLastAdvisory(svc, agent, 59 * 60 * 1000)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 1, 'a stop just before the hour must stay silent')
  ageLastAdvisory(svc, agent, HOUR_MS)
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 2, 'the held advisory must speak at the first prompt-eligible stop at/after the hour')
  assert.ok(steerText(agent.steers[1]).includes(`Root: ${repo}`), 'the spoken held advisory must name the repository')
})

// Ticket personal#0k21 (hourly throttle core, S5 latest-wins): distinct held
// advisories A then B deliver B, never A, at a prompt-eligible stop at/after
// the hour, when that stop carries its own advisory.
test('hourly throttle: held advisories A then B deliver B, never A, when the at-hour stop carries its own advisory', async () => {
  const repo = changedRepo('hourly-latest-own')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'alpha-held-reason' }] })
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'held advisory A must stay silent inside the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'beta-held-reason' }] })
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 1, 'held advisory B must stay silent inside the hour')
  pastHour(svc, agent)
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  const other = changedRepo('hourly-latest-own-current')
  writeCatalog(other, ['current'])
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js', path.join(other, 'app.js')] })
  // The held repository is completed before the at-hour stop, so its held B
  // fact is present only in the held snapshot. The at-hour stop carries its
  // own distinct fact on the other repository, so dropping the held facts
  // would lose B while the own-advisory assertion alone would still pass.
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the held repository must be complete, so B is held-only: ${completed.problems.join(' | ')}`)
  await svc.attest(agent, { repository_root: other, items: [{ id: 'current', state: 'assumed', reason: 'gamma-current-reason' }] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 2, 'the at-hour stop must speak the held advisory')
  const text = steerText(agent.steers[1])
  assert.ok(text.includes('beta-held-reason'), `the spoken advisory must carry the latest held facts (B): ${text}`)
  assert.ok(text.includes('gamma-current-reason'), `the spoken advisory must carry the at-hour stop's own distinct fact: ${text}`)
  assert.doesNotMatch(text, /alpha-held-reason/, `the spoken advisory must never carry the older held facts (A): ${text}`)
})

// Ticket personal#0k21 (hourly throttle core, S5 latest-wins): distinct held
// advisories A then B deliver B, never A, at a prompt-eligible stop at/after
// the hour, when that stop carries no advisory of its own.
test('hourly throttle: held advisories A then B deliver B, never A, when the at-hour stop carries no advisory', async () => {
  const repo = changedRepo('hourly-latest-none')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'alpha-held-reason' }] })
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'held advisory A must stay silent inside the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'beta-held-reason' }] })
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 1, 'held advisory B must stay silent inside the hour')
  // The at-hour stop carries no advisory of its own: the repository is completed
  // before it, so only the held facts can speak.
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js'] })
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the repository must be complete, so the at-hour stop has no advisory of its own: ${completed.problems.join(' | ')}`)
  pastHour(svc, agent)
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 2, 'the held advisory must speak even when the at-hour stop carries no advisory')
  const text = steerText(agent.steers[1])
  assert.ok(text.includes('beta-held-reason'), `the spoken advisory must carry the latest held facts (B): ${text}`)
  assert.doesNotMatch(text, /alpha-held-reason/, `the spoken advisory must never carry the older held facts (A): ${text}`)
  assert.ok(text.includes(`Root: ${repo}`), 'the spoken held advisory must name the repository')
  assert.match(text, /historical/i, `the held snapshot of a repository completed before delivery must be labelled historical, not present unfinished work: ${text}`)
  assert.doesNotMatch(text, /Attestation: missing\./, `an obsolete missing attestation must not be represented as a current obligation: ${text}`)
  assert.doesNotMatch(text, /Next: register/, `an obsolete call to action must not be represented as a current obligation: ${text}`)
})

// A transient warning seen at a same-prompt stop silenced by the prompt bound
// is held, so it still speaks at the first prompt-eligible stop at/after the
// hour even when the warning has cleared by then. The prompt bound itself
// speaks at most once per prompt.
test('prompt bound: a transient warning at a same-prompt stop is held and speaks at the hour after it clears', async () => {
  const repo = changedRepo('prompt-bound-held')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and arms the prompt bound')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'transient-warning-reason' }] })
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the same-prompt stop must stay silent and hold the transient warning')
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the warning must clear before the at-hour stop: ${completed.problems.join(' | ')}`)
  pastHour(svc, agent)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the held transient warning must speak at the first prompt-eligible stop at/after the hour')
  assert.ok(steerText(agent.steers[1]).includes('transient-warning-reason'), `the spoken advisory must carry the held transient warning: ${steerText(agent.steers[1])}`)
})

// Ticket personal#tr7n (credential bypass, Q3, invariant S2): a stop carrying a
// credential hit in a new prompt speaks at once inside the hour, bypassing the
// hourly limit from ticket personal#0k21.
test('credential bypass: a credential stop inside the hour in a new prompt speaks immediately (Q3)', async () => {
  const repo = changedRepo('credential-bypass-within-hour')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first non-credential advisory speaks and starts the hour')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'a credential stop inside the hour in a new prompt must speak immediately, bypassing the hourly limit')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the bypassed advisory must name the credential rule')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

// Ticket personal#tr7n (credential bypass, Q3, invariant S2): a credential hit
// seen at a stop the prompt bound silences is held in heldCredentials and
// speaks at the next prompt-eligible stop, which is also a credential speak
// that bypasses the hour, with no loss even when that stop's own diff is clean.
test('credential bypass: a credential hit at a prompt-silenced stop is held and speaks at the next prompt-eligible stop with no loss (Q3, S2)', async () => {
  const repo = changedRepo('credential-bypass-held')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory and starts the hour')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'precondition: the first message has no hit to name')
  // The same prompt stops again and now exposes the credential. The prompt
  // bound silences this stop, so the hit is retained, not spoken and not lost.
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a credential hit at a prompt-silenced stop must stay silent at that stop')
  // The next prompt is inside the hour and its own diff is clean, so only the
  // held hit can name the credential, and held credentials bypass the hour.
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the held credential must speak at the next prompt-eligible stop without waiting for the hour')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the held credential must be named at the next prompt-eligible stop, with no loss')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

// Ticket personal#tr7n (credential bypass, Q3): a credential speak restarts
// the hour for later non-credential advisories. The held non-credential
// advisory then speaks at the first prompt-eligible stop at/after that new
// hour. Elapsed time is simulated by shifting the recorded speak time, so the
// shift is relative to whatever the credential speak actually recorded.
test('credential bypass: a credential speak restarts the hour, so a later non-credential stop is held (Q3)', async () => {
  const repo = changedRepo('credential-bypass-restarts-hour')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  // Simulate the first speak being 40 minutes ago, so the credential stop is
  // still inside the hour and needs the bypass.
  ageLastAdvisory(svc, agent, 40 * 60 * 1000)
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'precondition: the credential stop inside the hour must speak by bypass')
  const credentialSpeakAt = svc.state(agent).lastAdvisoryAt
  assert.ok(credentialSpeakAt !== null, 'precondition: the credential speak must record a speak time')
  // Simulate 30 minutes passing since the credential speak: still inside the
  // restarted hour, but 70 minutes after the first speak, so only a restarted
  // hour holds the next non-credential stop.
  svc.state(agent).lastAdvisoryAt = credentialSpeakAt - 30 * 60 * 1000
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'a non-credential stop after a credential speak must be held by the restarted hour')
  // At/after the restarted hour the held advisory speaks.
  svc.state(agent).lastAdvisoryAt = credentialSpeakAt - HOUR_MS - 1000
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 3, 'the held advisory must speak at the first prompt-eligible stop at/after the restarted hour')
  assert.ok(steerText(agent.steers[2]).includes(`Root: ${repo}`), 'the spoken held advisory must name the repository')
})

// Review round 2 P2 (gap-only erasure): a stop inside the hour whose only
// advisory content is an unread file must not overwrite the advisory facts an
// earlier stop held. The gap is kept in heldGaps, as before; the held facts
// must still speak at the hour.
test('hourly throttle: a gap-only stop inside the hour preserves the held advisory facts', async () => {
  const repo = changedRepo('hourly-gap-only')
  writeCatalog(repo, ['unit'])
  const changes = recorder()
  let failing = false
  changes.diff = async () => (failing ? Promise.reject(new Error('transient read failure')) : { kind: 'text', hunks: [{ lines: [] }] })
  const svc = service({ workspaceChanges: changes })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'held-facts-reason' }] })
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'precondition: the held advisory stays silent inside the hour')
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the repository must be complete, so the gap-only stop has no advisory facts: ${completed.problems.join(' | ')}`)
  failing = true
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 1, 'a gap-only stop inside the hour must stay silent')
  failing = false
  pastHour(svc, agent)
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 2, 'the held advisory must speak at the hour')
  const text = steerText(agent.steers[1])
  assert.ok(text.includes('held-facts-reason'), `the gap-only stop must not erase the held advisory facts: ${text}`)
  assert.match(text, /1 changed file could not be read for this scan/, `the unread file must still be named at the hour: ${text}`)
  assert.match(text, /- app\.js: transient read failure$/m, 'the kept unread file must be named by its path')
})

// Review round 2 P3 (held notice wording): a held nested-HEAD notice is a
// fact from the silenced stop, so its replay must not claim the failure
// happened at the speaking stop.
test('held notices are marked as hold-time when they are replayed, not claimed as current', async () => {
  const repo = changedRepo('notice-held')
  writeCatalog(repo, ['unit'])
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child'])
  writeCatalog(child, ['unit'])
  const headPath = path.join(child, '.git', 'HEAD')
  const head = fs.readFileSync(headPath, 'utf8')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js', child] })
  const childDone = await svc.attest(agent, {
    repository_root: child,
    claims: [{ path: '.', decision: 'mine' }],
    reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(childDone.pass, true, `precondition: the nested repository must be complete: ${childDone.problems.join(' | ')}`)
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the parent advisory speaks and starts the hour')
  fs.writeFileSync(headPath, 'ref: refs/heads/missing-for-test\n')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a stop inside the hour must stay silent and hold the nested-HEAD notice')
  fs.writeFileSync(headPath, head)
  const parentDone = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(parentDone.pass, true, `precondition: the parent repository must be complete, so the held notice is the only payload: ${parentDone.problems.join(' | ')}`)
  pastHour(svc, agent)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'the held notice must speak at the hour')
  const text = steerText(agent.steers[1])
  assert.match(text, /At the silenced stop: Nested repository/, `the replayed notice must be marked as hold-time: ${text}`)
  assert.match(text, /could not read its HEAD at the silenced stop/, `the replayed notice must name the silenced stop, not the speaking stop: ${text}`)
  assert.doesNotMatch(text, /HEAD at this stop/, `the replayed notice must not claim the failure happened at the speaking stop: ${text}`)
  assertAdvisory(text)
})

// Review round 2 P3 (mutant M3): a credential-only stop silenced by the
// prompt bound must not overwrite the advisory facts an earlier stop held,
// because credentials are not advisory facts.
test('a credential-only prompt-silenced stop preserves the held advisory facts', async () => {
  const repo = changedRepo('credential-only-preserves')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and arms the prompt bound')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'held-facts-reason' }] })
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the same-prompt stop stays silent and holds the facts')
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the repository must be complete, so the credential-only stop has no advisory facts: ${completed.problems.join(' | ')}`)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the credential-only prompt-silenced stop must stay silent')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the held credential must speak at the next prompt-eligible stop')
  const text = steerText(agent.steers[1])
  assert.ok(text.includes('held-facts-reason'), `the credential-only stop must not erase the held advisory facts: ${text}`)
  assert.match(text, /Possible hard-coded credential or secret/, 'the held credential must be named')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

// Review round 2 P3 (mutant M4): speaking the held facts clears them, so the
// next prompt never replays already-spoken held facts.
test('a spoken held advisory is cleared, so the next prompt does not replay the held facts', async () => {
  const repo = changedRepo('held-no-replay')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  await svc.attest(agent, { repository_root: repo, items: [{ id: 'unit', state: 'assumed', reason: 'held-facts-reason' }] })
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'precondition: the held advisory stays silent inside the hour')
  const completed = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: the repository must be complete, so the at-hour stop has no advisory of its own: ${completed.problems.join(' | ')}`)
  pastHour(svc, agent)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'precondition: the held advisory speaks at the hour')
  assert.ok(steerText(agent.steers[1]).includes('held-facts-reason'), 'precondition: the spoken advisory carried the held facts')
  pastHour(svc, agent)
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 2, 'the next prompt must not replay held facts that already spoke')
})

// Review round 2 P3 (mutant M5): a repository shown only as a historical
// held snapshot was never shown its introduction, so it must not be marked
// introduced, and its first current advisory carries the introduction.
test('a historical held repository is not marked introduced when its held facts speak', async () => {
  const repoA = changedRepo('intro-held-a')
  writeCatalog(repoA, ['unit'])
  const repoB = changedRepo('intro-held-b')
  writeCatalog(repoB, ['unit'])
  const svc = service()
  const agent = agentFor(repoA)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repoA, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first advisory speaks and starts the hour')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repoA, files: ['app.js', path.join(repoB, 'app.js')] })
  await svc.attest(agent, { repository_root: repoB, items: [{ id: 'unit', state: 'assumed', reason: 'b-held-reason' }] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'precondition: repository B is first seen inside the hour and its facts are held, never spoken')
  const completed = await svc.attest(agent, {
    repository_root: repoB,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(completed.pass, true, `precondition: repository B must be complete, so it can speak only as a historical held snapshot: ${completed.problems.join(' | ')}`)
  pastHour(svc, agent)
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repoA, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'precondition: the held facts speak at the hour')
  assert.ok(steerText(agent.steers[1]).includes('b-held-reason'), `precondition: the spoken advisory carried the held facts of repository B: ${steerText(agent.steers[1])}`)
  const repoBEntry = svc.repositories.sessions.get(agent.id)?.repos.get(repoB)
  assert.ok(repoBEntry, 'precondition: the tracker must hold repository B')
  assert.equal(repoBEntry.introduced, false, 'a historical held snapshot must not mark the repository introduced')
  await svc.attest(agent, { repository_root: repoB, items: [{ id: 'unit', state: 'assumed', reason: 'b-open-again' }] })
  pastHour(svc, agent)
  begin(svc, agent, 6)
  prompt(svc, agent, 6)
  announce(svc, agent, { turn: 6, cwd: repoB, files: ['app.js'] })
  await stop(svc, agent, 6)
  assert.equal(agent.steers.length, 3, 'precondition: the reopened repository speaks again after the hour')
  assert.match(steerText(agent.steers[2]), /new to this session/, `the introduction of a repository only ever shown as historical held facts must appear on its first current advisory: ${steerText(agent.steers[2])}`)
})

test('review P3: when both catalog and archive are unreadable the next step repairs both before registering', () => {
  const { catalogPath, archivePath } = reportPaths()
  const repo = reportRepo({ catalog: { path: catalogPath, state: 'unreadable', items: [], problem: 'the file is not valid JSON: boom' } })
  repo.problems = [`The archive at ${archivePath} cannot be read: the file is not valid JSON: boom.`]
  const text = advisoryMessage({ repositories: [repo] })
  const next = text.split('\n').find(line => line.startsWith('Next:'))
  assert.ok(next, `the advisory must carry a next step: ${text}`)
  assert.ok(next.includes('repair the verification catalog'), `the next step must name the catalog repair: ${next}`)
  assert.ok(next.includes('repair the verification archive'), `the next step must name the archive repair: ${next}`)
  assert.ok(next.includes(catalogPath), `the next step must name the catalog path: ${next}`)
  assert.ok(next.includes(archivePath), `the next step must name the archive path: ${next}`)
  const catalogAt = next.indexOf('repair the verification catalog')
  const archiveAt = next.indexOf('repair the verification archive')
  const registerAt = next.indexOf('then register')
  assert.ok(catalogAt >= 0 && archiveAt >= 0 && registerAt > catalogAt && registerAt > archiveAt, `both repairs must precede registration: ${next}`)
  assertAdvisory(text)
})
