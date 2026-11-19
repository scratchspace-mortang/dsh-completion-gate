import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { attestSchemaErrors } from '../lib/tracker.js'
import { contentKey, isDocumentationPath } from '../lib/changes.js'
import { userMessage } from './user-message.mjs'

// These tests drive the real service, so they fail if the gate goes back to a source that
// cannot separate the user's pre-existing uncommitted work from a change this session made.
// That defect is the reason this work exists: the old rule was `git status --porcelain` over
// the whole repository, which reports a file dirtied before the session as a session change.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete their repositories, so each run leaves them in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function tempRepo() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-')))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// A fake host recorder: synchronous `summary(sessionId, seq)` returning the announcement for
// one `workspace/changes` event sequence, exactly like the installed service.
function recorder(entries = new Map()) {
  const announced = []
  return {
    announced,
    entries,
    summary(sessionId, seq) { announced.push(seq); return entries.get(`${sessionId}:${seq}`) },
    async diff() { return undefined },
  }
}

function service({ workspaceChanges = recorder() } = {}) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-settings-')))
  // The gate starts against a stub host, so the test drives its change observer and its stop hook directly. The
  // session/event listener is captured so a real user message reaches the prompt bound the way the host sends it.
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
  let published = 0
  instance.publish = (sessionId, type, data) => listeners.get('session/event')({ id: sessionId }, { type, seq: ++published, time: Date.now(), data })
  return instance
}

function agentFor(cwd, id = 'session-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd }, events: [] }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

// Ticket personal#0k21 (hourly throttle): the gate speaks at most one non-credential
// advisory per session per hour, so a test that expects a second prompt to speak ages
// the last-advisory time past the hour, as tests/stop-message.test.mjs does.
function pastHour(svc, agent) { svc.state(agent).lastAdvisoryAt = Date.now() - (60 * 60 * 1000 + 1000) }

// The host appends the batch of queued messages to its `turn/start`, the real user prompt included, before the first
// step. The gate reads that prompt on the `session/event` hook, so one message is delivered here for every turn
// opened, and a stop never runs in a state the host cannot produce.
function userPrompt(svc, sessionId, turn) {
  svc.publish(sessionId, 'user/message', userMessage(sessionId, turn))
}

// One root-session file-tool call, as the host records it: the tool name and its arguments as the raw JSON string the
// session event carries. The gate reads the path from this call, never from the recorder's file list.
function fileToolCall(svc, sessionId, turn, name, args) {
  svc.publish(sessionId, 'tool/call', { turn, name, arguments: JSON.stringify(args) })
}

// Announce one `workspace/changes` event the way the host recorder does, and register the
// summary the service will serve for that sequence. `cwd` is the directory the recorder reports its paths against.
// `calls` names the paths the root session's own file tools wrote this turn, and defaults to every listed path: a
// turn the session edited directly. An empty list announces the same change record for a turn no file tool named,
// which is a shell command or another writer's change.
function announce(svc, sessionId, turn, seq, files, cwd, { calls = files.map(entry => entry.path) } = {}) {
  svc.changes.observe({ id: sessionId }, { type: 'turn/start', data: { turn } })
  userPrompt(svc, sessionId, turn)
  for (const file of calls) fileToolCall(svc, sessionId, turn, 'write', { file_path: file, content: 'x\n' })
  svc.changes.observe({ id: sessionId }, { type: 'workspace/changes', seq, data: { turn } })
  svc.changeService().entries.set(`${sessionId}:${seq}`, {
    turn, cwd, files, total: files.length, added: files.length, deleted: 0,
  })
}

const file = (p) => ({ path: p, display: p, added: 1, deleted: 0 })

// A catalog with one item, 'unit', so an attestation can state it.
function writeUnitCatalog(repo) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items: [{ id: 'unit', name: 'Unit', proves: 'app.js sets value', addedAt: stamp, updatedAt: stamp }] }, null, 2)}\n`)
}

test('a repository with pre-existing dirt does not look changed to the gate', async t => {
  const repo = tempRepo(t)
  // The user's own uncommitted work exists before the session starts and stays untouched.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  assert.match(git(repo, ['status', '--porcelain=v1']), /app\.js/, 'precondition: the tree is dirty')

  const svc = service()
  try {
    const agent = agentFor(repo)
    // The turn ran and the recorder announced nothing for it, because the turn changed no file. The dirt above is
    // in the baseline, so no file is attributed to this session and the stop has nothing to say.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'pre-existing dirt must not produce an advisory')
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.repositories, [], 'pre-existing dirt must not be attributed to this session')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn the recorder reported changes for is attributed to the session', async t => {
  const repo = tempRepo(t)
  const changes = recorder()
  const svc = service({ workspaceChanges: changes })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 305, [file('src/feature.js')], repo)
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.absolute) })),
      [{ root: repo, files: [path.join(repo, 'src', 'feature.js')] }],
    )
    assert.deepEqual(changes.announced, [305], 'the summary must be read by the event sequence, not the turn number')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The intersection, from the other side: the recorder lists a file a shell command changed, and no root-session file
// tool named it, so it is not this session's obligation.
test('a turn whose only change is a shell command tracks no file', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 200, [file('src/from-shell.js')], repo, { calls: [] })
    await svc.stopping({ agent, turn: 2 })
    assert.equal(agent.steers.length, 0, 'a shell-command change is not the session\'s, so the stop has nothing to say')
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.repositories, [], 'the shell-command file must not be tracked')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Another writer's change on a different path, with no root-session file-tool call naming it. The root session wrote its
// own path this turn, so a turn that tracked every listed path would blame this one for the other writer's file.
test('a path another writer changed, which no file-tool call names, is not tracked', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 210, [file('src/theirs.js')], repo, { calls: ['src/mine.js'] })
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.repositories, [], 'a different-path other-writer change must not be tracked')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The guarantee is path overlap, not authorship: the recorder summary carries no author, so a path a root-session file
// tool named is tracked even when another writer changed the same path in the same turn.
test('a same-path change by another writer is tracked, because the guarantee is path overlap', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 220, [file('src/shared.js')], repo, { calls: ['src/shared.js'] })
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.path) })),
      [{ root: repo, files: ['src/shared.js'] }],
      'the path both the recorder and the file-tool call name is tracked',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The host canonicalizes each file-tool path through its longest existing ancestor before it lists the file, so a write
// through a relative symlink to a file that does not exist yet must compare equal to the recorder's path for it.
test('a relative symlink path with a missing leaf canonicalizes to the path the recorder lists', async t => {
  const repo = tempRepo(t)
  fs.mkdirSync(path.join(repo, 'target'))
  fs.symlinkSync('target', path.join(repo, 'link'))
  const svc = service()
  try {
    const agent = agentFor(repo)
    // The recorder lists the canonical path of the new file; the session's own write names the symlinked one.
    announce(svc, 'session-1', 2, 230, [file('target/new.js')], repo, { calls: ['link/new.js'] })
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.absolute) })),
      [{ root: repo, files: [path.join(repo, 'target', 'new.js')] }],
      'the symlinked tool path and the recorder path name one file',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The recorder stamps its summary with the raw session cwd but reports each inside-workspace path relative to the
// canonical working directory. A session started in a symlinked directory must therefore file the path its own file
// tool named, or the recorder's spelling and the tool's canonical spelling never meet and nothing is tracked.
test('a session whose working directory is a symlink tracks the file it wrote', async t => {
  const repo = tempRepo(t)
  const linked = path.join(path.dirname(repo), `${path.basename(repo)}-link`)
  fs.symlinkSync(repo, linked)
  const svc = service()
  try {
    const agent = agentFor(linked)
    // The host lists `app.js` against the real directory even though the turn's cwd is the link.
    announce(svc, 'session-1', 2, 240, [file('app.js')], linked, { calls: ['app.js'] })
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.absolute) })),
      [{ root: repo, files: [path.join(repo, 'app.js')] }],
      'the raw cwd resolves to the directory the recorder reports against',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A raw working directory can spell the same directory two ways: `link/..` names the parent of the link's target when
// the host realpaths it first, and the link's own parent when a resolver collapses it lexically. The host records the
// turn against the real directory, so the session's own file-tool path must resolve against that same directory or the
// overlap is lost and the file the session wrote is not tracked.
test('a session whose cwd contains symlink/.. tracks the file it wrote', async t => {
  const repo = tempRepo(t)
  const target = path.join(repo, 'target')
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true })
  fs.symlinkSync(path.join('target', 'nested'), path.join(repo, 'link'))
  const cwd = `${path.join(repo, 'link')}${path.sep}..`
  // Precondition: the two spellings of this cwd name different directories, so a lexical `..` misses the record base.
  assert.equal(path.resolve(cwd), repo, 'the lexical parent is the repository root')
  assert.equal(await fs.promises.realpath(cwd), target, 'the real parent is the link target\'s parent')
  const svc = service()
  try {
    const agent = agentFor(cwd)
    // The recorder reports `app.js` against the real directory; the session's write named it through the raw cwd.
    announce(svc, 'session-1', 2, 250, [file('app.js')], cwd, { calls: ['app.js'] })
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.absolute) })),
      [{ root: repo, files: [path.join(target, 'app.js')] }],
      'the raw cwd canonicalizes before the file-tool path is resolved, so the write overlaps the recorded path',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('an absent recorder blocks saying changes cannot be determined', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: null })
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    userPrompt(svc, 'session-1', 1)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the recorder is absent')
    assert.match(agent.steers[0].content[0].text, /The host change recorder \(workspaceChanges\) is not available, so the files this turn changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a documentation-only turn still requires attestation of every changed file', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: recorder() })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 7, 700, [file('README.md')], repo)
    await svc.stopping({ agent, turn: 7 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory for an unattested documentation change')
    const text = agent.steers[0].content[0].text
    assert.match(text, /Attestation: missing\./)
    assert.match(text, /Changed documentation not checked yet:\n- .*README\.md/, 'a prose change is still reviewed, and its path is named')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Each kind of changed path, sorted by the documentation check: an extension, a plain basename, or neither.
test('the documentation path classifier sorts each kind of changed path', () => {
  assert.equal(isDocumentationPath('README.md'), true)
  assert.equal(isDocumentationPath('notes.txt'), true)
  assert.equal(isDocumentationPath('docs/a.mdx'), true)
  assert.equal(isDocumentationPath('LICENSE'), true)
  assert.equal(isDocumentationPath('CODEOWNERS'), true)
  assert.equal(isDocumentationPath('src/app.js'), false)
  assert.equal(isDocumentationPath('LICENSE.md'), true)
  assert.equal(isDocumentationPath('licence'), true)
})

test('an in-turn check before the turn has any change record is undetermined in the status report', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    // The turn has started but the recorder has announced nothing for it yet.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    const status = await svc.statusResult(agent)
    assert.match(status.markdown, /^Notice: The host change record for turn 1 has not been written yet, so the files this turn has changed cannot be determined until the turn stops\.$/m)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn keeps its attestation across repeated stops while its files and contents are unchanged', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const svc = service()
  try {
    const agent = agentFor(repo)
    // The prompt arrives after its `turn/start`, once. Each call below is one `workspace/changes` announcement, as a
    // stop produces it, for the same prompt.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 3 } })
    userPrompt(svc, 'session-1', 3)
    const publish = seq => {
      fileToolCall(svc, 'session-1', 3, 'write', { file_path: 'app.js', content: 'const value = 2\n' })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 3 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 3, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    }
    writeUnitCatalog(repo)
    const attestation = {
      action: 'attest', repository_root: repo, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed app.js.',
    }

    publish(305)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'stop 1 sends one advisory message until the change set is attested')
    assert.match(agent.steers[0].content[0].text, /Attestation: missing/)
    assert.ok(agent.steers[0].content[0].text.includes(`Root: ${repo}`), 'the advisory names the repository it is about')

    const attested = await svc.attest(agent, attestation)
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    publish(307)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'a repeated stop over an attested, unchanged change set must send nothing')

    fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
    publish(309)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'a changed file inside the prompt must not speak again; the reopen waits for the next real user message')
    // The next real user prompt starts turn 4, which re-arms the one message and names the reopened repository.
    pastHour(svc, agent)
    announce(svc, 'session-1', 4, 311, [file('app.js')], repo)
    await svc.stopping({ agent, turn: 4 })
    assert.equal(agent.steers.length, 2, 'the next real prompt sends one message about the reopened repository')
    assert.match(agent.steers[1].content[0].text, /Attestation: stale/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a moved nested repository pointer changes the attestation identity and an unmoved one keeps it', async t => {
  const repo = tempRepo(t)
  // A nested repository inside the workspace. The host lists it as a changed directory.
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const svc = service()
  try {
    const agent = agentFor(repo)

    // The nested repository is its own repository root, so the pointer is attested under the child root as the path '.'.
    announce(svc, 'session-1', 5, 60, [file('nested')], repo)
    writeUnitCatalog(child)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // No move: the same child commit keeps the attestation valid at the next stop.
    announce(svc, 'session-1', 5, 61, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 0, 'an unmoved nested repository must keep its attestation')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    announce(svc, 'session-1', 5, 63, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 1, 'a moved nested repository pointer must reopen the attestation and send one message')
    assert.match(agent.steers[0].content[0].text, /Attestation: stale/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Regression guard for the decided behavior (overseer decision (i)). The host writes no change record for
// a turn that changed nothing, so after the turn has ended an absent record means no changes. The stop check
// and the status report must agree, and the "not written yet" block must not return after the turn ends.
// It fails when an ended turn is read as undetermined, or as still open.
test('an ended turn with no change record reads as no changes: the stop sends nothing and the status shows no notice', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    // No workspace/changes event is observed for this turn: the recorder writes nothing for a turn that changed nothing.

    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'the stop sends nothing for an ended turn with no change record')

    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.notices, [], 'an ended turn must not report its record as missing or undetermined')
    assert.deepEqual(report.repositories, [], 'a turn with no change record attributes no repository')
    const status = await svc.statusResult(agent)
    assert.doesNotMatch(status.markdown, /not been written yet/, 'an ended turn must not report its record as not yet written')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn that changed nothing reports its stop result once the turn has ended', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })

    // Before the stop, the recorder has written nothing for this turn, so its change set is undetermined.
    const open = await svc.turnChanges(agent)
    assert.equal(open.determined, false)
    assert.match(open.reason, /has not been written yet/)

    // The stop passes a turn that changed nothing. The stop hook alone does not end the turn, because a
    // steered stop continues the same turn number, so a call made now is still inside the turn.
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'a turn that changed nothing passes its stop')
    assert.equal((await svc.turnChanges(agent)).determined, false)

    // The host ends the turn after its stop. From here a missing record means the turn changed nothing.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    const ended = await svc.turnChanges(agent)
    assert.equal(ended.determined, true, `the change set must be determined once the turn has ended: ${ended.reason}`)
    assert.deepEqual(ended.files, [])

    // A repository with no changed file owes no claim and no item, so an attest made after the turn ended passes.
    const attested = await svc.attest(agent, { action: 'attest', repository_root: repo })
    assert.deepEqual(attested.problems, [], `attest after the turn ended failed: ${JSON.stringify(attested.problems)}`)
    assert.equal(attested.pass, true)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a stop after a transient diff read failure rescans the same bytes and names the credential the failed read hid, on the next real prompt', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\npassword = "hunter2hunter2"\n')
  const changes = recorder()
  // The diff read fails once, at stop 1 only. Every later read succeeds.
  let failures = 1
  changes.diff = async () => {
    if (failures > 0) { failures -= 1; throw new Error('transient read failure') }
    return { kind: 'text', hunks: [{ lines: ['-const value = 1', '+const value = 2', '+password = "hunter2hunter2"'] }] }
  }
  const svc = service({ workspaceChanges: changes })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    // One real prompt, then everything a stop produces for it. The prompt arrives after its `turn/start`.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 4 } })
    userPrompt(svc, 'session-1', 4)
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 4 } })
      changes.entries.set(`session-1:${seq}`, { turn: 4, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    }

    publish(50)
    await svc.stopping({ agent, turn: 4, signal })
    assert.equal(agent.steers.length, 1, 'stop 1 sends its advisory even though the diff read failed')
    assert.doesNotMatch(agent.steers[0].content[0].text, /Possible hard-coded credential/, 'the failed read hides the credential, so stop 1 cannot name it')
    assert.match(agent.steers[0].content[0].text, /1 changed file could not be read for this scan/, 'stop 1 must name the unread file, since no credential hit exists to carry it')

    // A second stop of the same prompt stays silent even though the diff now reads: the prompt spent its message.
    publish(52)
    await svc.stopping({ agent, turn: 4, signal })
    assert.equal(agent.steers.length, 1, 'a second stop of the same prompt must not speak again, whatever the diff read returns')

    // The next real user message starts turn 5, whose change record is announced first. Same bytes, same listed
    // file, and the diff now reads, so the credential the failed read hid must be named by that prompt's one message.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq: 54, data: { turn: 5 } })
    changes.entries.set('session-1:54', { turn: 5, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    userPrompt(svc, 'session-1', 5)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 2, `the next prompt must rescan the same bytes and send its one message: ${agent.steers.at(-1)?.content[0].text}`)
    const text = agent.steers[1].content[0].text
    assert.match(text, /Possible hard-coded credential or secret/, 'the next prompt must name the credential the failed read hid')
    assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A test script that passes only once a file outside the change set exists, and that writes `ran` each time it
// runs. The marker shows whether a stop or an attest started the script.
function readyCheckRepo(t) {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'check.js'), "require('fs').writeFileSync('ran', 'x')\nprocess.exit(require('fs').existsSync('ready') ? 0 : 1)\n")
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2) + '\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  return repo
}

test('a stop starts no project check, so a failing check is neither run nor named at any stop', async t => {
  const repo = readyCheckRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 40, [file('app.js')], repo)
    await svc.stopping({ agent, turn: 2 })
    assert.equal(agent.steers.length, 1, 'stop 1 sends its advisory about the unclaimed file')
    assert.doesNotMatch(agent.steers[0].content[0].text, /failed/, 'a stop must not name a check failure')
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'stop 1 must not run the test script')

    // The environment is fixed and the listed bytes are unchanged. The next stop still runs nothing.
    fs.writeFileSync(path.join(repo, 'ready'), '')
    announce(svc, 'session-1', 2, 42, [file('app.js')], repo)
    await svc.stopping({ agent, turn: 2 })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'stop 2 must not run the test script after the fix either')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('attest starts no project check, and no stop starts it either', async t => {
  const repo = readyCheckRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 40, [file('app.js')], repo)
    assert.equal(fs.existsSync(path.join(repo, 'ready')), false, 'precondition: the test script would fail without the ready file')
    await svc.attest(agent, { action: 'attest', repository_root: repo })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'attest must not run the test script')

    await svc.stopping({ agent, turn: 2 })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'the stop must not run the test script')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository whose HEAD cannot be read at one stop. The pointer does not move, so the stop must say the gate
// could not check the commit at that stop, without reopening the attestation. Once the HEAD reads, the stop sends nothing.
test('an unreadable nested HEAD is reported at the stop, and the attestation holds once it reads again', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const svc = service()
  try {
    const agent = agentFor(repo)
    const headFile = path.join(child, '.git', 'HEAD')
    const savedHead = fs.readFileSync(headFile, 'utf8')

    // The nested pointer is a file of its own repository (a directory with a .git entry owns itself), so the attest
    // names the child root and the pointer is the child root itself: the path '.'.
    writeUnitCatalog(child)
    announce(svc, 'session-1', 1, 60, [file('nested')], repo)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // Stop 1: the child HEAD reads and the pointer is unchanged, so the stop passes.
    announce(svc, 'session-1', 1, 61, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'stop 1 passes at the attested commit')

    // Stop 2: git cannot read the child HEAD, because HEAD names a branch that does not exist. The pointer did not move.
    fs.writeFileSync(headFile, 'ref: refs/heads/missing-for-test\n')
    announce(svc, 'session-1', 1, 62, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'stop 2 sends one notice while the nested HEAD cannot be read')
    assert.match(agent.steers[0].content[0].text, /Nested repository nested: could not read its HEAD at this stop/)
    assert.doesNotMatch(agent.steers[0].content[0].text, /Attestation: (missing|stale)/, 'an unreadable HEAD must keep the identity of the path, so the attestation stays current')

    // The status report names the same read failure, and the attested child repository still reads as complete.
    const during = await svc.repositoryReport(agent)
    assert.deepEqual(during.notices, ['Nested repository nested: could not read its HEAD.'])
    const childEntry = during.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.complete, true, 'the attested child keeps its identity while its HEAD is unreadable')

    // Stop 3: the HEAD reads again at the same commit, so the stop sends nothing new.
    fs.writeFileSync(headFile, savedHead)
    announce(svc, 'session-1', 1, 63, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, `stop 3 must send nothing once the nested HEAD reads again: ${agent.steers.at(-1)?.content[0].text}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The first HEAD read of a nested repository fails, so no earlier HEAD stands in for it. An attest made in that
// window must bind nothing: it throws with its own refusal message, and one attest after recovery passes.
test('an attest during a first nested HEAD read failure binds nothing, and one attest after recovery passes', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const headFile = path.join(child, '.git', 'HEAD')
  const savedHead = fs.readFileSync(headFile, 'utf8')
  // HEAD names a branch that does not exist, so the first-ever read of this path fails.
  fs.writeFileSync(headFile, 'ref: refs/heads/missing-for-test\n')

  const svc = service()
  try {
    const agent = agentFor(repo)
    const attestation = {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    }

    announce(svc, 'session-1', 5, 80, [file('nested')], repo)
    await assert.rejects(svc.attest(agent, attestation), /Nested repository nested has no readable HEAD yet, so nothing is attested/)
    // The refused call bound nothing: the child repository is listed with no attestation.
    const refused = await svc.repositoryReport(agent)
    const childEntry = refused.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.attestation, null, 'a refused attest must bind nothing to the placeholder identity')

    fs.writeFileSync(headFile, savedHead)
    writeUnitCatalog(child)
    announce(svc, 'session-1', 5, 81, [file('nested')], repo)
    const attested = await svc.attest(agent, attestation)
    assert.equal(attested.pass, true, `one attest after recovery must pass: ${JSON.stringify(attested.blockers)}`)

    announce(svc, 'session-1', 5, 82, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 0, `the stop after that attest must pass: ${agent.steers.at(-1)?.content[0].text}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository with no commit yet. Git cannot read its HEAD, so the gate reports it as unreadable, the same as
// a broken HEAD. The host does not list such a repository, so the test announces it directly.
test('an unborn nested repository is reported as unreadable until it has a commit', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 1, 90, [file('nested')], repo)
    const blocked = await svc.repositoryReport(agent)
    assert.deepEqual(blocked.notices, ['Nested repository nested: could not read its HEAD.'], 'an unborn nested repository must be named as unreadable')

    git(child, ['config', 'user.email', 'test@example.com'])
    git(child, ['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child A'])
    announce(svc, 'session-1', 1, 91, [file('nested')], repo)
    const committed = await svc.repositoryReport(agent)
    assert.deepEqual(committed.notices, [], 'a committed nested repository reads its HEAD, so no notice is left')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository under a directory whose name contains a newline. git prints the top-level path before
// the HEAD commit, so the path must not be split on its newline, or the moved pointer is never seen.
test('a moved nested pointer under a path containing a newline changes the attestation identity', async t => {
  const repo = tempRepo(t)
  const listed = 'odd\ndir/nested'
  const child = path.join(repo, 'odd\ndir', 'nested')
  fs.mkdirSync(child, { recursive: true })
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])
  const headA = git(child, ['rev-parse', 'HEAD']).trim()

  // The identity of the listed directory is its child's HEAD, even under a newline path.
  assert.equal(await contentKey(repo, listed), `head:${headA}`, 'a nested pointer under a newline path is keyed by its HEAD')

  const svc = service()
  try {
    const agent = agentFor(repo)
    // The listed directory owns itself, so the attest names the child root and the pointer is the path '.'.
    writeUnitCatalog(child)
    announce(svc, 'session-1', 6, 70, [file(listed)], repo)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'], demonstrated_files: [{ path: '.', note: 'ran the fixture' }],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)
    announce(svc, 'session-1', 6, 71, [file(listed)], repo)
    await svc.stopping({ agent, turn: 6 })
    assert.equal(agent.steers.length, 0, 'precondition: the unmoved pointer passes')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    assert.notEqual(await contentKey(repo, listed), `head:${headA}`, 'the moved pointer changes the key')
    announce(svc, 'session-1', 6, 73, [file(listed)], repo)
    await svc.stopping({ agent, turn: 6 })
    assert.equal(agent.steers.length, 1, 'a moved pointer under a newline path must reopen the attestation and send one message')
    assert.match(agent.steers[0].content[0].text, /Attestation: stale/)

    const report = await svc.repositoryReport(agent)
    const childEntry = report.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.complete, false, 'the status must not show a moved pointer under a newline path as complete')
    assert.match(childEntry.problems.join(' '), /No current attestation for this repository/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A change record that was announced and then lost. The stop cannot tell which files the turn changed, so it says so.
test('an announced change record that has vanished leaves its turn undetermined at the stop', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 310, [file('app.js')], repo)
    svc.changeService().entries.delete('session-1:310')
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the announced record is gone')
    assert.match(agent.steers[0].content[0].text, /The host change record for turn 3 \(sequence 310\) is no longer available, so the files this turn changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A change record that is announced but whose read throws. The stop reports the read failure rather than reading the turn as unchanged.
test('a host change record that cannot be read leaves its turn undetermined at the stop', async t => {
  const repo = tempRepo(t)
  const changes = recorder()
  const svc = service({ workspaceChanges: changes })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 320, [file('app.js')], repo)
    changes.summary = () => { throw new Error('summary read broke') }
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the record read throws')
    assert.match(agent.steers[0].content[0].text, /Reading the host change record for turn 3 failed: summary read broke\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A subagent session is not covered by the host change recorder, so its turn's changes cannot be determined. The status
// report says so rather than reading the turn as unchanged.
test('a subagent session is reported as not covered by the host change recorder', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo, 'subagent-1')
    agent.session.header.parentSession = 'session-1'
    svc.changes.observe({ id: 'subagent-1' }, { type: 'turn/start', data: { turn: 1 } })
    const status = await svc.statusResult(agent)
    assert.match(status.markdown, /Notice: The host change recorder does not record this session, so the files turn 1 changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// T2: a repository whose history gives each filed path a distinct last-change state relative to one
// named commit. `old.js` was last changed strictly before it, `at.js` by the commit itself, `later.js`
// strictly after it, and `dirty.js` carries an uncommitted change on top of a last commit that is
// strictly before it.
function historyRepo(t) {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'old.js'), 'const old = 1\n')
  fs.writeFileSync(path.join(repo, 'dirty.js'), 'const dirty = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'old work'])
  fs.writeFileSync(path.join(repo, 'at.js'), 'const at = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'new work'])
  const before = git(repo, ['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(repo, 'later.js'), 'const later = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'later work'])
  fs.writeFileSync(path.join(repo, 'dirty.js'), 'const dirty = 2\n')
  return { repo, before }
}

// A repository with two files whose names match the same glob pathspec. `a[1].js` was last changed
// strictly before the named commit, while that commit created `a1.js`; a raw pathspec for the filed
// bracket name would glob onto the plain file and take its history instead.
function globRepo(t) {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'a[1].js'), 'const bracket = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'bracket file'])
  fs.writeFileSync(path.join(repo, 'a1.js'), 'const plain = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'plain file'])
  return { repo, before: git(repo, ['rev-parse', 'HEAD']).trim() }
}

// File the history paths and give each an initial `mine` claim, so a later batch can be judged by
// what it changes (or keeps) rather than by filling an unclaimed ledger.
async function fileAndClaimMine(svc, agent, repo) {
  const names = ['old.js', 'at.js', 'dirty.js', 'later.js']
  announce(svc, 'session-1', 1, 500, names.map(file), repo)
  return svc.attest(agent, {
    action: 'attest', repository_root: repo,
    claims: names.map(p => ({ path: p, decision: 'mine' })),
  })
}

// File one named path as mine in a repository built by one of the helpers above.
async function fileOneMine(svc, agent, repo, name) {
  announce(svc, 'session-1', 1, 500, [file(name)], repo)
  return svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ path: name, decision: 'mine' }] })
}

const batchClear = before => ({ action: 'attest', claims: [{ before_commit: before, decision: 'not-mine' }] })

function claimByPath(svc, agent) {
  const snapshot = svc.repositories.repositories(agent.id)
  return Object.fromEntries(snapshot[0].files.map(f => [path.basename(f.path), f.claim]))
}

function toolService() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-tool-')))
  let registered = null
  const ctx = {
    reflect: { get: () => null },
    on: () => () => {},
    provide: () => () => {},
    tools: { register: definition => { registered = definition; return () => {} } },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
  }
  const instance = new CompletionGateService(ctx, {}, { settingsPath: path.join(dir, 'settings.json') })
  instance.start()
  return { instance, registered, dir }
}

test('T2 before_commit clears a path last changed strictly before the named commit', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ before_commit: before, decision: 'not-mine' }] })
    assert.equal(claimByPath(svc, agent)['old.js'], 'not-mine', 'a path last changed strictly before the commit is cleared')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit keeps a path the named commit itself changed', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ before_commit: before, decision: 'not-mine' }] })
    assert.equal(claimByPath(svc, agent)['at.js'], 'mine', 'the commit\'s own change keeps its claim under a strict since boundary')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit keeps a path with an uncommitted change', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ before_commit: before, decision: 'not-mine' }] })
    assert.equal(claimByPath(svc, agent)['dirty.js'], 'mine', 'a path with an uncommitted change keeps its claim and ledger place')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit refuses an unresolvable commit name by name', async t => {
  const { repo } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    await assert.rejects(
      svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ before_commit: 'no-such-commit-xyz', decision: 'not-mine' }] }),
      /no-such-commit-xyz/,
      'the refusal names the commit input',
    )
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit refuses an unreadable history naming the repository', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/missing-for-test\n')
    let message = ''
    try {
      await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [{ before_commit: before, decision: 'not-mine' }] })
    } catch (error) { message = error.message }
    assert.ok(message.includes(repo), `the refusal must name the repository ${repo}, got: ${message}`)
    assert.match(message, /history/i, 'the refusal says the history could not be read')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 a refused before_commit batch writes nothing', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    let refused = ''
    try {
      await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [
        { before_commit: before, decision: 'not-mine' },
        { before_commit: 'no-such-commit-xyz', decision: 'not-mine' },
      ] })
    } catch (error) { refused = error.message }
    assert.equal(claimByPath(svc, agent)['old.js'], 'mine', 'the valid entry in a refused batch writes no clearing')
    assert.match(refused, /no-such-commit-xyz/, 'the second entry refuses the batch by name')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 a before_commit decision other than not-mine is refused with the value named', async t => {
  // 'maybe' is a value the fixed wording 'not-mine' cannot contain, so a dropped interpolation fails this test.
  const errors = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ before_commit: 'abc123', decision: 'maybe' }] })
  assert.ok(errors.some(error => error.includes('"maybe"')), `the validator must name the quoted decision value: ${errors.join('; ')}`)
  assert.deepEqual(attestSchemaErrors({ repository_root: process.cwd(), claims: [{ before_commit: 'abc123', decision: 'not-mine' }] }), [], 'a not-mine batch entry is valid')
  const { instance, registered, dir } = toolService()
  try {
    const svc = service()
    try {
      let message = ''
      try {
        await svc.attest(agentFor(process.cwd()), { action: 'attest', repository_root: process.cwd(), claims: [{ before_commit: 'abc123', decision: 'maybe' }] })
      } catch (error) { message = error.message }
      assert.ok(message.includes('"maybe"'), `the end-to-end refusal must name the quoted decision value: ${message}`)
    } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
    const oneOf = registered.parameters.properties.claims.items.oneOf
    const batch = oneOf.find(variant => variant.properties?.before_commit)
    assert.ok(batch, 'the tool schema publishes a before_commit claims branch')
    assert.deepEqual(batch.properties.decision.enum ?? [batch.properties.decision.const], ['not-mine'], 'the tool schema constrains a before_commit decision to not-mine')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('T2 claims validate key presence and agree with the published oneOf schema', t => {
  const both = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ path: 'a.js', before_commit: 'abc123', decision: 'not-mine' }] })
  assert.ok(both.some(error => error.includes('exactly one of path or before_commit')), `both keys must be refused: ${both.join('; ')}`)
  const neither = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ decision: 'not-mine' }] })
  assert.ok(neither.some(error => error.includes('exactly one of path or before_commit')), `neither key must be refused: ${neither.join('; ')}`)
  const nonString = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ path: 'a.js', before_commit: 5, decision: 'mine' }] })
  assert.ok(nonString.some(error => error.includes('before_commit must be a non-empty string')), `a non-string before_commit key must be refused: ${nonString.join('; ')}`)
  const emptyPath = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ path: '', before_commit: 'HEAD', decision: 'not-mine' }] })
  assert.ok(emptyPath.some(error => error.includes('path must be a non-empty string')), `an empty path key must be refused: ${emptyPath.join('; ')}`)
  // A space counts as one character under minLength, so each whitespace literal must be refused by the handler
  // and by the pattern the published schema carries for the same field.
  const whitespacePath = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ path: '   ', decision: 'mine' }] })
  assert.ok(whitespacePath.some(error => error.includes('path must be a non-empty string')), `a whitespace-only path must be refused by the handler: ${whitespacePath.join('; ')}`)
  const whitespaceCommit = attestSchemaErrors({ repository_root: process.cwd(), claims: [{ before_commit: '   ', decision: 'not-mine' }] })
  assert.ok(whitespaceCommit.some(error => error.includes('before_commit must be a non-empty string')), `a whitespace-only before_commit must be refused by the handler: ${whitespaceCommit.join('; ')}`)
  const whitespaceRoot = attestSchemaErrors({ repository_root: '   ', claims: [] })
  assert.ok(whitespaceRoot.some(error => error.includes('repository_root is required')), `a whitespace-only repository_root must be refused by the handler: ${whitespaceRoot.join('; ')}`)
  const { registered, dir } = toolService()
  try {
    const oneOf = registered.parameters.properties.claims.items.oneOf
    const pathBranch = oneOf.find(variant => variant.properties?.path)
    const batchBranch = oneOf.find(variant => variant.properties?.before_commit)
    assert.equal(pathBranch.additionalProperties, false, 'the path branch forbids a before_commit key')
    assert.equal(pathBranch.properties.before_commit, undefined, 'the path branch publishes no before_commit key')
    assert.equal(pathBranch.properties.path.minLength, 1, 'the path branch requires a non-empty path')
    assert.equal(batchBranch.additionalProperties, false, 'the batch branch forbids a path key')
    assert.equal(batchBranch.properties.path, undefined, 'the batch branch publishes no path key')
    assert.equal(batchBranch.properties.before_commit.type, 'string', 'the batch branch requires a string before_commit')
    assert.equal(batchBranch.properties.before_commit.minLength, 1, 'the batch branch requires a non-empty before_commit')
    const props = registered.parameters.properties
    const fields = [
      ['claims[].path', pathBranch.properties.path, 'a.js'],
      ['claims[].before_commit', batchBranch.properties.before_commit, 'abc123'],
      ['repository_root', props.repository_root, process.cwd()],
      ['reviewed_code_files[]', props.reviewed_code_files.items, 'a.js'],
      ['demonstrated_files[].path', props.demonstrated_files.items.properties.path, 'a.js'],
      ['demonstrated_files[].note', props.demonstrated_files.items.properties.note, 'a note'],
      ['items[].id', props.items.items.properties.id, 'unit'],
    ]
    for (const [label, field, valid] of fields) {
      assert.equal(field.minLength, 1, `the published ${label} requires a non-empty string`)
      assert.equal(field.pattern, '\\S', `the published ${label} requires a non-whitespace character`)
      assert.equal(new RegExp(field.pattern).test('   '), false, `the published ${label} refuses a whitespace-only literal`)
      assert.equal(new RegExp(field.pattern).test(valid), true, `the published ${label} still accepts ${valid}`)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('T2 before_commit keeps a path committed after the named commit', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    await svc.attest(agent, { ...batchClear(before), repository_root: repo })
    assert.equal(claimByPath(svc, agent)['later.js'], 'mine', 'a path committed strictly after the commit keeps its claim')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 a batch entry over a path explicitly claimed in one call is refused by name with nothing written', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    let message = ''
    try {
      await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [
        { path: 'old.js', decision: 'mine' },
        { before_commit: before, decision: 'not-mine' },
      ] })
    } catch (error) { message = error.message }
    assert.match(message, /old\.js/, `the refusal names the shared path: ${message}`)
    assert.match(message, /ambiguous/, 'the refusal names the ambiguity class')
    const claims = claimByPath(svc, agent)
    assert.equal(claims['old.js'], 'mine', 'the explicit claim keeps its ledger place')
    assert.equal(claims['at.js'], 'mine', 'the untouched path is unchanged')
    assert.equal(claims['later.js'], 'mine', 'the untouched path is unchanged')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 every unresolvable before_commit name appears in one refusal', async t => {
  const { repo } = historyRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    let message = ''
    try {
      await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [
        { before_commit: 'nope1', decision: 'not-mine' },
        { before_commit: 'nope2', decision: 'not-mine' },
      ] })
    } catch (error) { message = error.message }
    assert.match(message, /nope1/, 'the first unresolvable name is named')
    assert.match(message, /nope2/, 'the second unresolvable name is named in the same refusal')
    assert.equal(claimByPath(svc, agent)['old.js'], 'mine', 'nothing is cleared by the refused batch')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit judges a filed glob path by its literal name', async t => {
  const { repo, before } = globRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileOneMine(svc, agent, repo, 'a[1].js')
    await svc.attest(agent, { ...batchClear(before), repository_root: repo })
    assert.equal(claimByPath(svc, agent)['a[1].js'], 'not-mine', 'a bracket-named path is cleared from its own history')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit keeps a glob path clear when a glob-matched sibling is dirty', async t => {
  const { repo, before } = globRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    await fileOneMine(svc, agent, repo, 'a[1].js')
    fs.writeFileSync(path.join(repo, 'a1.js'), 'const plain = 2\n')
    assert.match(git(repo, ['status', '--porcelain=v1', '--', 'a1.js']), /a1\.js/, 'precondition: the sibling is dirty')
    await svc.attest(agent, { ...batchClear(before), repository_root: repo })
    assert.equal(claimByPath(svc, agent)['a[1].js'], 'not-mine', 'a dirty glob sibling does not keep the filed bracket path')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('T2 before_commit refuses an unreadable per-path history naming the repository and path', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'old.js'), 'const old = 1\n')
  fs.mkdirSync(path.join(repo, 'sub'))
  fs.writeFileSync(path.join(repo, 'sub', 'x.js'), 'const x = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'old work'])
  fs.writeFileSync(path.join(repo, 'at.js'), 'const at = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'new work'])
  const before = git(repo, ['rev-parse', 'HEAD']).trim()
  const subTree = git(repo, ['rev-parse', 'HEAD~1:sub']).trim()
  const objectPath = path.join(repo, '.git', 'objects', subTree.slice(0, 2), subTree.slice(2))
  assert.ok(fs.existsSync(objectPath), 'precondition: the sub tree object is loose')
  const svc = service()
  let restored = false
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 1, 500, [file('old.js'), file('sub/x.js')], repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [
      { path: 'old.js', decision: 'mine' }, { path: 'sub/x.js', decision: 'mine' },
    ] })
    fs.chmodSync(objectPath, 0o000)
    git(repo, ['rev-list', '--max-count=1', 'HEAD'])
    assert.throws(() => git(repo, ['log', '-1', '--format=%H', '--', 'sub/x.js']), 'precondition: the sub path log fails while HEAD still reads')
    let message = ''
    try { await svc.attest(agent, { ...batchClear(before), repository_root: repo }) }
    catch (error) { message = error.message }
    assert.ok(message.includes(repo), `the refusal must name the repository: ${message}`)
    assert.match(message, /sub\/x\.js/, 'the refusal names the path whose history failed')
    assert.match(message, /history/i, 'the refusal names the unreadable history')
    assert.equal(claimByPath(svc, agent)['old.js'], 'mine', 'nothing is cleared when one path is unreadable')
    fs.chmodSync(objectPath, 0o644)
    restored = true
  } finally {
    if (!restored) fs.chmodSync(objectPath, 0o644)
    fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true })
  }
})

test('T2 before_commit refuses an unreadable uncommitted state naming the path, repository, and commit', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  const indexPath = path.join(repo, '.git', 'index')
  let restored = false
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 1, 500, [file('old.js'), file('at.js')], repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: [
      { path: 'old.js', decision: 'mine' }, { path: 'at.js', decision: 'mine' },
    ] })
    fs.chmodSync(indexPath, 0o000)
    assert.throws(() => git(repo, ['status', '--porcelain=v1', '--', 'old.js']), 'precondition: status fails while the index is unreadable')
    git(repo, ['log', '-1', '--format=%H', '--', 'old.js'])
    git(repo, ['rev-list', '--max-count=1', 'HEAD'])
    let message = ''
    try { await svc.attest(agent, { ...batchClear(before), repository_root: repo }) }
    catch (error) { message = error.message }
    assert.ok(message.includes(repo), `the refusal must name the repository: ${message}`)
    assert.match(message, /Cannot read the uncommitted state of (old|at)\.js in /, `the refusal names a relative path of an unreadable status: ${message}`)
    assert.ok(message.includes(before), `the refusal must name the before_commit input: ${message}`)
    assert.equal(claimByPath(svc, agent)['old.js'], 'mine', 'nothing is cleared when the uncommitted state is unreadable')
    fs.chmodSync(indexPath, 0o644)
    restored = true
  } finally {
    if (!restored) fs.chmodSync(indexPath, 0o644)
    fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true })
  }
})

test('T2 before_commit refuses a merge-base error other than the not-ancestor answer', async t => {
  const { repo, before } = historyRepo(t)
  const svc = service()
  const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-gitshim-')))
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "merge-base" ]; then echo "simulated merge-base failure" >&2; exit 2; fi; done\nexec ${realGit} "$@"\n`)
  fs.chmodSync(path.join(shimDir, 'git'), 0o755)
  const originalPath = process.env.PATH
  try {
    const agent = agentFor(repo)
    await fileAndClaimMine(svc, agent, repo)
    process.env.PATH = `${shimDir}:${originalPath}`
    let message = ''
    try { await svc.attest(agent, { ...batchClear(before), repository_root: repo }) }
    catch (error) { message = error.message }
    assert.ok(message.includes(repo), `the refusal must name the repository: ${message}`)
    assert.match(message, /compare the history of [^ ]+\.js with before_commit/, 'the refusal names the path whose ancestry could not be read')
    assert.equal(claimByPath(svc, agent)['old.js'], 'mine', 'nothing is cleared when ancestry is unreadable')
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true })
  }
})

test('T2 a before_commit batch stays a constant plus a small number of git spawns per path and entry', async t => {
  const N = 200
  const repo = tempRepo(t)
  const names = []
  for (let i = 0; i < N; i += 1) {
    const name = `p${String(i).padStart(3, '0')}.js`
    fs.writeFileSync(path.join(repo, name), `const p${i} = ${i}\n`)
    names.push(name)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'many files'])
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'unrelated'])
  const named = git(repo, ['rev-parse', 'HEAD']).trim()
  const svc = service()
  const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-shim-')))
  const spawnLog = path.join(shimDir, 'spawns.log')
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_SPAWN_LOG"\nexec ${realGit} "$@"\n`)
  fs.chmodSync(path.join(shimDir, 'git'), 0o755)
  fs.writeFileSync(spawnLog, '')
  const originalPath = process.env.PATH
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 1, 500, names.map(file), repo)
    await svc.attest(agent, { action: 'attest', repository_root: repo, claims: names.map(name => ({ path: name, decision: 'mine' })) })
    process.env.PATH = `${shimDir}:${originalPath}`
    process.env.GIT_SPAWN_LOG = spawnLog
    const measure = async claims => {
      fs.writeFileSync(spawnLog, '')
      const started = Date.now()
      await svc.attest(agent, { action: 'attest', repository_root: repo, claims })
      return { spawns: fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length, ms: Date.now() - started }
    }
    const none = await measure([])
    const one = await measure([{ before_commit: named, decision: 'not-mine' }])
    const two = await measure([{ before_commit: named, decision: 'not-mine' }, { before_commit: named, decision: 'not-mine' }])
    // One shared readable check plus two reads per path, then one resolve plus one ancestry per path and entry.
    // Pin the exact counts: a partial regression that repeats a shared read inside the entry loop moves one
    // count by one and two by two, so an upper bound with slack would let it pass.
    const expectedOne = 1 + 2 * N + 1 + N
    const expectedTwo = 1 + 2 * N + 2 * (1 + N)
    console.log(`T2 spawn shape: none=${none.spawns} one=${one.spawns} two=${two.spawns} expectedOne=${expectedOne} expectedTwo=${expectedTwo} paths=${N} wall=${two.ms}ms`)
    assert.equal(none.spawns, 0, 'an attest with no batch starts no git processes')
    assert.equal(one.spawns, expectedOne, `one entry must not repeat the shared reads: ${one.spawns}`)
    assert.equal(two.spawns, expectedTwo, `two entries over ${N} paths must not repeat the shared reads: ${two.spawns}`)
  } finally {
    process.env.PATH = originalPath
    delete process.env.GIT_SPAWN_LOG
    fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true })
  }
})
