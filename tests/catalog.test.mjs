import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { archivePathOf, isStale, readArchive, registerItems } from '../lib/catalog.js'

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete them, so each run leaves its workspaces in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '122g-tests')

function makeWorkDir(prefix) {
  fs.mkdirSync(workRoot, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(workRoot, prefix)))
}

function gitRepo(prefix = 'repo-') {
  const dir = makeWorkDir(prefix)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

function agentIn(cwd) { return { id: 'a', session: { header: { cwd } } } }

const signal = () => new AbortController().signal
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The gate runs against a stub host. The tool it registers is captured so a test can call its execute, and the change
// recorder answers the turn summaries a test announces. The run seam throws, so a register call that reached a check
// fails the test instead of running one.
let published = 0
function gateFor(t, summaries = new Map()) {
  const listeners = new Map()
  const tools = {}
  const off = () => () => {}
  const reflect = { get: name => (name === 'workspaceChanges' ? { summary: (id, seq) => summaries.get(`${id}:${seq}`) } : undefined) }
  const host = {
    reflect,
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off,
    tools: { register: definition => { tools.completion_gate = definition; return off() } },
    commands: { register: () => off() },
    systemPrompt: { section: off },
    webServer: { register: off },
  }
  const settingsDir = makeWorkDir('settings-')
  const svc = new CompletionGateService(host, {}, { settingsPath: path.join(settingsDir, 'settings.json') })
  svc.start()
  svc.__listeners = listeners
  svc.__tool = tools.completion_gate
  return svc
}

function emit(svc, a, type, data) {
  svc.__listeners.get('session/event')({ id: a.id }, { type, seq: ++published, time: Date.now(), data })
}

// One turn as the host publishes it: the turn starts, then its change record is announced under a sequence number. The
// root session wrote every listed path with its own `write` tool, so each path is its obligation.
function announceTurn(svc, a, summaries, turn, cwd, paths) {
  emit(svc, a, 'turn/start', { turn })
  for (const file of paths) emit(svc, a, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: file, content: 'x\n' }) })
  const seq = published + 1
  summaries.set(`${a.id}:${seq}`, { turn, cwd, files: paths.map(p => ({ path: p, display: p, added: 1, deleted: 0 })), total: paths.length, added: paths.length, deleted: 0 })
  emit(svc, a, 'workspace/changes', { turn })
}

function register(svc, a, repositoryRoot, items) {
  return svc.__tool.execute({ action: 'register', repository_root: repositoryRoot, items }, { agent: a, signal: signal() })
}

function readCatalog(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.dsh', 'verification.json'), 'utf8'))
}

function excludeLines(repo) {
  return fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/)
}

test('register writes a version 1 catalog whose item ids are the name slugs', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [{ name: 'Unit tests (npm)', proves: 'The parser handles every fixture.', command: 'npm test' }])
  const catalog = readCatalog(repo)
  assert.equal(catalog.version, 1)
  assert.equal(catalog.items.length, 1)
  const [item] = catalog.items
  assert.equal(item.id, 'unit-tests-npm')
  assert.equal(item.name, 'Unit tests (npm)')
  assert.equal(item.proves, 'The parser handles every fixture.')
  assert.equal(item.command, 'npm test')
  assert.ok(Date.parse(item.addedAt) > 0, 'addedAt is a timestamp')
  assert.equal(item.updatedAt, item.addedAt)
})

test('a missing proves is refused with an error, and no catalog or exclusion is written', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const before = excludeLines(repo)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Lint' }]), /proves/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false, 'no catalog directory is created')
  assert.deepEqual(excludeLines(repo), before, 'the exclude file is unchanged')
})

test('re-registering a name updates proves and command, keeps the id and addedAt, and moves updatedAt', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const a = agentIn(repo)
  await register(svc, a, repo, [{ name: 'Build', proves: 'It compiles.', command: 'npm run build' }])
  const first = readCatalog(repo).items[0]
  await sleep(20)
  await register(svc, a, repo, [{ name: 'Build', proves: 'It compiles on Node 22.', command: 'npm run build -- --strict' }])
  const items = readCatalog(repo).items
  assert.equal(items.length, 1, 'the name is updated in place, not added twice')
  assert.equal(items[0].id, first.id)
  assert.equal(items[0].addedAt, first.addedAt)
  assert.ok(Date.parse(items[0].updatedAt) > Date.parse(first.updatedAt), 'updatedAt moves forward')
  assert.equal(items[0].proves, 'It compiles on Node 22.')
  assert.equal(items[0].command, 'npm run build -- --strict')
})

test('two different names whose slugs collide get distinct ids', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [
    { name: 'Unit tests', proves: 'First.' },
    { name: 'unit-tests', proves: 'Second.' },
    { name: 'UNIT TESTS', proves: 'Third.' },
  ])
  const items = readCatalog(repo).items
  assert.deepEqual(items.map(item => item.id), ['unit-tests', 'unit-tests-2', 'unit-tests-3'])
  assert.deepEqual(items.map(item => item.name), ['Unit tests', 'unit-tests', 'UNIT TESTS'])
})

test('the two exact catalog paths are excluded once across two registers, git ignores both catalogs, and .gitignore is unchanged', async t => {
  const repo = gitRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  const svc = gateFor(t)
  const a = agentIn(repo)
  await register(svc, a, repo, [{ name: 'Lint', proves: 'No lint errors.' }])
  await register(svc, a, repo, [{ name: 'Typecheck', proves: 'No type errors.' }])
  const lines = excludeLines(repo)
  assert.equal(lines.filter(line => line === '.dsh/verification.json').length, 1, 'the catalog path appears exactly once')
  assert.equal(lines.filter(line => line === '.dsh/verification-archive.json').length, 1, 'the archive path appears exactly once')
  assert.equal(lines.includes('.dsh/'), false, 'the whole .dsh/ directory is not excluded')
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules/\n', 'the tracked .gitignore is not edited')
  for (const file of ['.dsh/verification.json', '.dsh/verification-archive.json']) {
    const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd: repo })
    assert.equal(ignored.status, 0, `git ignores ${file} through the local exclude`)
  }
})

test('T5 the exact catalog path is excluded, not the whole .dsh/ directory', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [{ name: 'Lint', proves: 'No lint errors.' }])
  const lines = excludeLines(repo)
  assert.ok(lines.includes('.dsh/verification.json'), `the exclude file carries the exact catalog path: ${lines.join('|')}`)
  assert.equal(lines.includes('.dsh/'), false, 'the whole directory is not excluded')
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.dsh/verification.json'], { cwd: repo }).status, 0, 'the catalog is ignored')
})

test('T5 the exact archive path is excluded, not the whole .dsh/ directory', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [{ name: 'Lint', proves: 'No lint errors.' }])
  const lines = excludeLines(repo)
  assert.ok(lines.includes('.dsh/verification-archive.json'), `the exclude file carries the exact archive path: ${lines.join('|')}`)
  assert.equal(lines.includes('.dsh/'), false, 'the whole directory is not excluded')
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.dsh/verification-archive.json'], { cwd: repo }).status, 0, 'the archive is ignored')
})

test('T5 a pre-existing whole-directory .dsh/ line is replaced by the two exact paths', async t => {
  const repo = gitRepo()
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.dsh/\n')
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [{ name: 'Lint', proves: 'No lint errors.' }])
  const lines = excludeLines(repo)
  assert.equal(lines.includes('.dsh/'), false, 'the old whole-directory line is gone')
  assert.ok(lines.includes('.dsh/verification.json'), 'the exact catalog path replaced it')
  assert.ok(lines.includes('.dsh/verification-archive.json'), 'the exact archive path replaced it')
})

test('T5 a command between the old and new bounds is accepted', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const command = 'x'.repeat(1500)
  await register(svc, agentIn(repo), repo, [{ name: 'Long verification', proves: 'It runs the long scenario.', command }])
  assert.equal(readCatalog(repo).items[0].command, command, 'the 1500-character command is stored whole')
})

test('T5 a command over 4000 characters is refused with the bound named', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Too long', proves: 'It is refused.', command: 'x'.repeat(4001) }]), /4000 characters/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false, 'no catalog is written')
})

test('a corrupt catalog makes register refuse, naming the path and the parse failure, and leaves its bytes unchanged', async t => {
  const repo = gitRepo()
  const file = path.join(repo, '.dsh', 'verification.json')
  fs.mkdirSync(path.dirname(file))
  const bytes = '{"version": 1, "items": [\n'
  fs.writeFileSync(file, bytes)
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Lint', proves: 'No lint errors.' }]), error => {
    assert.ok(error.message.includes(file), `the error names the catalog path: ${error.message}`)
    assert.match(error.message, /not valid JSON: \S/, 'the error names the parse failure')
    return true
  })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the corrupt catalog is not overwritten')
  assert.equal(excludeLines(repo).includes('.dsh/verification.json'), false, 'a refused register adds no catalog exclusion')
  assert.equal(excludeLines(repo).includes('.dsh/verification-archive.json'), false, 'a refused register adds no archive exclusion')
})

test('a root with no git gets the catalog and reports no exclusion, without an error', async t => {
  const dir = makeWorkDir('plain-')
  const svc = gateFor(t)
  const result = await register(svc, agentIn(dir), dir, [{ name: 'Smoke', proves: 'The script starts.' }])
  assert.equal(readCatalog(dir).items[0].id, 'smoke')
  assert.equal(result.registered.exclusion.applied, false)
  assert.match(result.registered.exclusion.reason, /not a git repository/)
})

test('a folder with an empty .git entry inside another repository registers there, and the outer repository ignores the catalog', async t => {
  const outer = gitRepo('outer-')
  const nested = path.join(outer, 'nested')
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true })
  fs.writeFileSync(path.join(nested, 'app.js'), 'const value = 1\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(outer)
  announceTurn(svc, a, summaries, 1, outer, ['nested/app.js'])
  const result = await register(svc, a, nested, [{ name: 'Nested smoke', proves: 'The nested app starts.' }])
  assert.equal(readCatalog(nested).items[0].id, 'nested-smoke')
  assert.equal(result.registered.exclusion.applied, true, 'the exclusion is applied through the repository git resolves')
  assert.equal(result.registered.exclusion.added, true)
  assert.equal(fs.realpathSync(result.registered.exclusion.file), fs.realpathSync(path.join(outer, '.git', 'info', 'exclude')), 'the line goes into the outer repository exclude file')
  assert.equal(excludeLines(outer).includes('nested/.dsh/verification.json'), true, 'the outer repository excludes the nested catalog')
  assert.equal(excludeLines(outer).includes('nested/.dsh/verification-archive.json'), true, 'the outer repository excludes the nested archive')
  assert.equal(excludeLines(outer).includes('.dsh/'), false, 'the outer repository does not exclude the whole directory')
  const ignored = spawnSync('git', ['check-ignore', '-q', 'nested/.dsh/verification.json'], { cwd: outer })
  assert.equal(ignored.status, 0, 'git ignores the nested catalog through the outer repository local exclude')
})

test('register refuses a repository root the session has not seen, and writes nothing there', async t => {
  const session = gitRepo('session-')
  const stranger = gitRepo('stranger-')
  const svc = gateFor(t)
  const before = excludeLines(stranger)
  await assert.rejects(register(svc, agentIn(session), stranger, [{ name: 'Lint', proves: 'No lint errors.' }]), /not a repository this session/)
  assert.equal(fs.existsSync(path.join(stranger, '.dsh')), false)
  assert.deepEqual(excludeLines(stranger), before)
})

test('register accepts a repository the session changed in an earlier turn, given as a path relative to the session', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.writeFileSync(path.join(sibling, 'app.js'), 'const value = 1\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'app.js')])
  await register(svc, a, path.relative(session, sibling), [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
})

test('register writes into a symlinked sibling repository, never into the workspace that links to it', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.writeFileSync(path.join(sibling, 'app.js'), 'const value = 1\n')
  fs.symlinkSync(sibling, path.join(session, 'vendor'))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  // The host reports a file outside the working directory by its canonical absolute path, which is the sibling's path.
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'app.js')])
  await register(svc, a, 'vendor', [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(fs.existsSync(path.join(session, '.dsh')), false, 'the workspace gets no catalog')
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
  assert.equal(excludeLines(sibling).includes('.dsh/verification.json'), true, 'the sibling excludes its own catalog')
  assert.equal(excludeLines(sibling).includes('.dsh/verification-archive.json'), true, 'the sibling excludes its own archive')
  assert.equal(excludeLines(session).includes('.dsh/'), false, 'the workspace exclude file is unchanged')
})

test('register writes into a sibling subdirectory that a symlink points at, never into the workspace that links to it', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.mkdirSync(path.join(sibling, 'sub'))
  fs.writeFileSync(path.join(sibling, 'sub', 'app.js'), 'const value = 1\n')
  fs.symlinkSync(path.join(sibling, 'sub'), path.join(session, 'vendor'))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  // The host reports a file outside the working directory by its canonical absolute path, which is the sibling's path.
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'sub', 'app.js')])
  await register(svc, a, 'vendor', [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(fs.existsSync(path.join(session, '.dsh')), false, 'the workspace gets no catalog')
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
  assert.equal(excludeLines(sibling).includes('.dsh/verification.json'), true, 'the sibling excludes its own catalog')
  assert.equal(excludeLines(sibling).includes('.dsh/verification-archive.json'), true, 'the sibling excludes its own archive')
  assert.equal(excludeLines(session).includes('.dsh/'), false, 'the workspace exclude file is unchanged')
})

// A session working in a subdirectory files a change outside every repository under that directory, and the status tells
// the model to register there. Register then writes the catalog inside the subdirectory, so the exclude line must go into
// the enclosing repository's exclude file, or the catalog shows up as an untracked file in the user's checkout.
test('register in a subdirectory of a repository excludes its catalog in that repository', async t => {
  const repo = gitRepo('subdir-')
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(sub)
  const loose = path.join(path.dirname(repo), `loose-${path.basename(repo)}.js`)
  fs.writeFileSync(loose, 'export const loose = 1\n')
  t.after(() => fs.rmSync(loose, { force: true }))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(sub)
  announceTurn(svc, a, summaries, 1, sub, [loose])
  const out = await register(svc, a, sub, [{ name: 'Subdir smoke', proves: 'The catalog stays out of git.' }])
  assert.match(out.markdown, /Exclusion: \.dsh\/ was (added to|already listed in) .*\.git\/info\/exclude, so git ignores the catalog\./, out.markdown)
  assert.ok(fs.existsSync(path.join(sub, '.dsh', 'verification.json')), 'the catalog is written under the working directory')
  execFileSync('git', ['check-ignore', '-q', 'sub/.dsh/verification.json'], { cwd: repo })
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'the enclosing repository stays clean')
})

test('register keeps the item text as entered, and status prints paths and count instead of the unstated item', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const a = agentIn(repo)
  const result = await svc.__tool.execute({ action: 'register', repository_root: repo, items: [{ name: 'Lint\n## Forged name', proves: 'Line one\n### Forged heading' }] }, { agent: a, signal: signal() })
  const stored = readCatalog(repo).items[0]
  assert.equal(stored.name, 'Lint\n## Forged name', 'the catalog holds the name as entered')
  assert.equal(stored.proves, 'Line one\n### Forged heading', 'the catalog holds the proves text as entered')
  assert.equal(result.markdown.split('\n').some(line => line.startsWith('## Forged')), false, 'the register report starts no heading from the name')
  assert.equal(result.markdown.split('\n').filter(line => line === '- lint-forged-name: Lint ## Forged name (registered)').length, 1, 'the register report lists the written item on one line')
  const { markdown } = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: signal() })
  const lines = markdown.split('\n')
  assert.equal(lines.some(line => line.startsWith('## Forged') || line.startsWith('### Forged')), false, 'the status report starts no heading from the item text')
  assert.ok(lines.includes(`Catalog path: ${path.join(repo, '.dsh', 'verification.json')}`), markdown)
  assert.ok(lines.includes(`Archive path: ${path.join(repo, '.dsh', 'verification-archive.json')}`), markdown)
  assert.ok(lines.includes('Active catalog items: 1'), markdown)
  assert.ok(lines.includes('Unstated catalog items: 1 (history; no action required unless adopted).'), markdown)
  assert.equal(lines.some(line => line.startsWith('- lint-forged-name:')), false, 'an unstated item has no per-item line in the status report')
  assert.equal(markdown.includes('Line one'), false, 'the unstated item proves text reaches no report')
})

test('an unreadable catalog quotes its text on one line in the status report', async t => {
  const repo = gitRepo()
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
  const file = path.join(repo, '.dsh', 'verification.json')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, '{\n"a":\n### Forged\n}\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(repo)
  announceTurn(svc, a, summaries, 1, repo, ['app.js'])
  const { markdown } = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: signal() })
  const lines = markdown.split('\n')
  assert.ok(markdown.includes('### Forged'), 'the parse problem quotes the file text, so the check below is not vacuous')
  assert.equal(lines.some(line => line.startsWith('### Forged')), false, 'the quoted file text starts no heading of its own')
  assert.equal(lines.filter(line => line.startsWith('Catalog unreadable')).length, 1, 'the problem is one line')
})

const DAY_MS = 24 * 60 * 60 * 1000
const catalogFile = repo => path.join(repo, '.dsh', 'verification.json')
const archiveFileOf = repo => archivePathOf(repo)

function daysAgo(days, extraMs = 0) { return new Date(Date.now() - days * DAY_MS - extraMs).toISOString() }
function makeItem(id, name, updatedAt, extra = {}) {
  return { id, name, proves: `Proves ${name}.`, addedAt: daysAgo(10), updatedAt, ...extra }
}
function seedFile(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
}
function seedCatalog(repo, items) { seedFile(catalogFile(repo), items) }
function seedArchive(repo, items) { seedFile(archiveFileOf(repo), items) }
function readActive(repo) { return JSON.parse(fs.readFileSync(catalogFile(repo), 'utf8')).items }
function readArchived(repo) { return readArchive(repo).items }
// Makes the Nth rename onto a file with this name throw, simulating a failed atomic write. Returns a restore function.
function failRenameOn(fileName, onCall = 1) {
  const original = fs.renameSync
  let count = 0
  fs.renameSync = (src, dest) => {
    if (String(dest).endsWith(fileName)) {
      count += 1
      if (count === onCall) throw new Error('simulated rename failure')
    }
    return original(src, dest)
  }
  return () => { fs.renameSync = original }
}

test('isStale: exactly 2 days is not stale, beyond is, unparseable never is', () => {
  const now = Date.now()
  assert.equal(isStale({ updatedAt: new Date(now - 2 * DAY_MS).toISOString() }, now), false, 'exactly 2 days is not stale')
  assert.equal(isStale({ updatedAt: new Date(now - 2 * DAY_MS - 1).toISOString() }, now), true, '1ms beyond 2 days is stale')
  assert.equal(isStale({ updatedAt: new Date(now - 2 * DAY_MS + 1000).toISOString() }, now), false, 'within 2 days is not stale')
  assert.equal(isStale({ updatedAt: 'not-a-date' }, now), false, 'unparseable is never stale')
  assert.equal(isStale({}, now), false, 'missing updatedAt is never stale')
})

test('register archives a stale item with the full item preserved and leaves it out of the active catalog', async t => {
  const repo = gitRepo()
  const stale = makeItem('old-item', 'Old item', daysAgo(3), { command: 'npm test', proves: 'It proved the old thing.' })
  const fresh = makeItem('fresh-item', 'Fresh item', daysAgo(1))
  seedCatalog(repo, [stale, fresh])
  const result = await registerItems(repo, [{ name: 'Brand new', proves: 'It is new.' }])
  assert.equal(result.archive.path, archiveFileOf(repo))
  assert.deepEqual(result.archive.moved, ['old-item'])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(readArchived(repo), [stale], 'the archived item is the full original item')
  const active = readActive(repo)
  assert.deepEqual(active.map(item => item.id).sort(), ['brand-new', 'fresh-item'])
  assert.deepEqual(result.items, [{ id: 'brand-new', name: 'Brand new', created: true }])
})

test('register keeps items within 2 days and with unparseable updatedAt in the active catalog', async t => {
  const repo = gitRepo()
  const within = makeItem('within-item', 'Within item', daysAgo(2, -60 * 1000))
  const unparseable = makeItem('weird-item', 'Weird item', 'not-a-date')
  seedCatalog(repo, [within, unparseable])
  const result = await registerItems(repo, [{ name: 'Fresh name', proves: 'Fresh.' }])
  assert.deepEqual(result.archive.moved, [])
  assert.equal(fs.existsSync(archiveFileOf(repo)), false, 'no archive file is written')
  assert.deepEqual(readActive(repo).map(item => item.id).sort(), ['fresh-name', 'weird-item', 'within-item'])
})

test('register with only fresh items writes no archive file', async t => {
  const repo = gitRepo()
  const result = await registerItems(repo, [{ name: 'Only fresh', proves: 'Fresh.' }])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(result.archive.moved, [])
  assert.equal(fs.existsSync(archiveFileOf(repo)), false)
})

test('a second pass at the same time writes nothing to the archive', async t => {
  const repo = gitRepo()
  seedCatalog(repo, [makeItem('old-item', 'Old item', daysAgo(3))])
  await registerItems(repo, [{ name: 'First fresh', proves: 'First.' }])
  const bytes = fs.readFileSync(archiveFileOf(repo), 'utf8')
  const mtime = fs.statSync(archiveFileOf(repo)).mtimeMs
  await sleep(20)
  const second = await registerItems(repo, [{ name: 'Second fresh', proves: 'Second.' }])
  assert.deepEqual(second.archive.moved, [])
  assert.equal(fs.readFileSync(archiveFileOf(repo), 'utf8'), bytes, 'archive bytes are unchanged')
  assert.equal(fs.statSync(archiveFileOf(repo)).mtimeMs, mtime, 'archive file is not rewritten')
})

test('an unreadable archive returns a problem without throwing and writes nothing', async t => {
  const repo = gitRepo()
  seedCatalog(repo, [makeItem('fresh-item', 'Fresh item', daysAgo(1))])
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const corrupt = '{"version": 1, "items": [\n'
  fs.writeFileSync(archiveFileOf(repo), corrupt)
  const catalogBefore = fs.readFileSync(catalogFile(repo), 'utf8')
  const result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.ok(result.archive.problem.includes(archiveFileOf(repo)), `problem names the archive path: ${result.archive.problem}`)
  assert.deepEqual(result.archive.moved, [])
  assert.deepEqual(result.items, [])
  assert.equal(fs.readFileSync(catalogFile(repo), 'utf8'), catalogBefore, 'active catalog is byte-equal')
  assert.equal(fs.readFileSync(archiveFileOf(repo), 'utf8'), corrupt, 'archive file is byte-equal')
  assert.equal(readActive(repo).some(item => item.name === 'Incoming'), false, 'no incoming item is written')
})

test('an archive write failure returns a problem, preserves the active catalog, and writes no incoming items', async t => {
  const repo = gitRepo()
  seedCatalog(repo, [makeItem('old-item', 'Old item', daysAgo(3))])
  const catalogBefore = fs.readFileSync(catalogFile(repo), 'utf8')
  const restore = failRenameOn('verification-archive.json')
  let result
  try { result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
  finally { restore() }
  assert.ok(result.archive.problem.includes(archiveFileOf(repo)), `problem names the archive path: ${result.archive.problem}`)
  assert.deepEqual(result.archive.moved, [])
  assert.deepEqual(result.items, [])
  assert.equal(fs.readFileSync(catalogFile(repo), 'utf8'), catalogBefore, 'active catalog is preserved')
  assert.equal(fs.existsSync(archiveFileOf(repo)), false, 'no archive file is left behind')
})

test('a failed active write after the archive write leaves a duplicate that the retry reconciles', async t => {
  const repo = gitRepo()
  const stale = makeItem('old-item', 'Old item', daysAgo(3), { command: 'npm test' })
  seedCatalog(repo, [stale])
  const restore = failRenameOn('verification.json')
  let failed
  try { failed = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
  finally { restore() }
  assert.ok(failed.archive.problem.includes(catalogFile(repo)), `problem names the failing path: ${failed.archive.problem}`)
  assert.deepEqual(failed.archive.moved, [])
  assert.deepEqual(readArchived(repo), [stale], 'the archive write is durable')
  assert.deepEqual(readActive(repo), [stale], 'the active copy is still there: a duplicate')
  assert.equal(readActive(repo).some(item => item.name === 'Incoming'), false, 'no incoming item is written')

  const retried = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.equal(retried.archive.problem, null)
  assert.deepEqual(readArchived(repo), [stale], 'the archive keeps the full item')
  assert.deepEqual(readActive(repo).map(item => item.name), ['Incoming'], 'the retry removes the duplicate active copy and writes the incoming item')
})

test('a crafted duplicate (archive written, active not) is reconciled by the next pass', async t => {
  const repo = gitRepo()
  const item = makeItem('dup-item', 'Dup item', daysAgo(3), { command: 'npm test' })
  seedCatalog(repo, [item])
  seedArchive(repo, [item])
  const result = await registerItems(repo, [{ name: 'Next fresh', proves: 'Next.' }])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(readArchived(repo), [item])
  assert.deepEqual(readActive(repo).map(item => item.name), ['Next fresh'])
})

test('an equal-timestamp different-content duplicate is refused with both files byte-equal', async t => {
  const repo = gitRepo()
  const stamp = daysAgo(3)
  seedCatalog(repo, [makeItem('dup-item', 'Dup item', stamp, { proves: 'Active version.' })])
  seedArchive(repo, [makeItem('dup-item', 'Dup item', stamp, { proves: 'Archived version.' })])
  const catalogBefore = fs.readFileSync(catalogFile(repo), 'utf8')
  const archiveBefore = fs.readFileSync(archiveFileOf(repo), 'utf8')
  const result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.ok(result.archive.problem.includes(archiveFileOf(repo)), `problem names the archive path: ${result.archive.problem}`)
  assert.deepEqual(result.archive.moved, [])
  assert.deepEqual(result.items, [])
  assert.equal(fs.readFileSync(catalogFile(repo), 'utf8'), catalogBefore, 'active catalog is byte-equal')
  assert.equal(fs.readFileSync(archiveFileOf(repo), 'utf8'), archiveBefore, 'archive file is byte-equal')
})

test('a duplicate with an unparseable updatedAt on either copy is refused with both files byte-equal', async t => {
  const repo = gitRepo()
  seedCatalog(repo, [makeItem('dup-item', 'Dup item', 'not-a-date')])
  seedArchive(repo, [makeItem('dup-item', 'Dup item', daysAgo(3))])
  const catalogBefore = fs.readFileSync(catalogFile(repo), 'utf8')
  const archiveBefore = fs.readFileSync(archiveFileOf(repo), 'utf8')
  const result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.ok(result.archive.problem, 'a problem is returned')
  assert.equal(fs.readFileSync(catalogFile(repo), 'utf8'), catalogBefore, 'active catalog is byte-equal')
  assert.equal(fs.readFileSync(archiveFileOf(repo), 'utf8'), archiveBefore, 'archive file is byte-equal')
})

test('a newer active duplicate prunes the older archive copy', async t => {
  const repo = gitRepo()
  const activeCopy = makeItem('dup-item', 'Dup item', daysAgo(2, 1000), { proves: 'Newer active version.' })
  const archiveCopy = makeItem('dup-item', 'Dup item', daysAgo(4), { proves: 'Older archived version.' })
  seedCatalog(repo, [activeCopy])
  seedArchive(repo, [archiveCopy])
  // The active copy is newer, so it is kept; it is also stale, so the same pass then archives it.
  const result = await registerItems(repo, [{ name: 'Next fresh', proves: 'Next.' }])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(readArchived(repo), [activeCopy], 'the newer active copy wins and is archived by the pass')
  assert.deepEqual(readActive(repo).map(item => item.name), ['Next fresh'])
})

test('a newer active duplicate that is fresh prunes the archive without archiving the keeper', async t => {
  const repo = gitRepo()
  const activeCopy = makeItem('dup-item', 'Dup item', daysAgo(1), { proves: 'Newer active version.' })
  const archiveCopy = makeItem('dup-item', 'Dup item', daysAgo(4), { proves: 'Older archived version.' })
  seedCatalog(repo, [activeCopy])
  seedArchive(repo, [archiveCopy])
  const result = await registerItems(repo, [{ name: 'Next fresh', proves: 'Next.' }])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(readArchived(repo), [], 'the older archive copy is pruned')
  assert.deepEqual(readActive(repo).map(item => item.id).sort(), ['dup-item', 'next-fresh'])
  assert.equal(readActive(repo).find(item => item.id === 'dup-item').proves, 'Newer active version.')
})

test('a newer archive duplicate drops the older active copy', async t => {
  const repo = gitRepo()
  const activeCopy = makeItem('dup-item', 'Dup item', daysAgo(4), { proves: 'Older active version.' })
  const archiveCopy = makeItem('dup-item', 'Dup item', daysAgo(3), { proves: 'Newer archived version.' })
  seedCatalog(repo, [activeCopy])
  seedArchive(repo, [archiveCopy])
  const result = await registerItems(repo, [{ name: 'Next fresh', proves: 'Next.' }])
  assert.equal(result.archive.problem, null)
  assert.deepEqual(readArchived(repo), [archiveCopy], 'the newer archived copy is kept')
  assert.deepEqual(readActive(repo).map(item => item.name), ['Next fresh'])
})

test('a second failure during reconciliation preserves both copies with no loss', async t => {
  const repo = gitRepo()
  const item = makeItem('dup-item', 'Dup item', daysAgo(3))
  seedCatalog(repo, [item])
  seedArchive(repo, [item])
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const restore = failRenameOn('verification.json')
    let result
    try { result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
    finally { restore() }
    assert.ok(result.archive.problem, `attempt ${attempt + 1} returns a problem`)
    assert.deepEqual(readActive(repo), [item], `attempt ${attempt + 1} keeps the active copy`)
    assert.deepEqual(readArchived(repo), [item], `attempt ${attempt + 1} keeps the archived copy`)
    assert.equal(readActive(repo).some(entry => entry.name === 'Incoming'), false, 'no incoming item is written')
  }
  const retried = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.equal(retried.archive.problem, null)
  assert.deepEqual(readArchived(repo), [item])
  assert.deepEqual(readActive(repo).map(item => item.name), ['Incoming'])
})

test('ids are reserved across both files for slug collisions', async t => {
  const repo = gitRepo()
  const archived = makeItem('unit-tests', 'Unit tests', daysAgo(3))
  seedCatalog(repo, [])
  seedArchive(repo, [archived])
  const result = await registerItems(repo, [{ name: 'unit-tests', proves: 'A different name, the same slug.' }])
  assert.deepEqual(result.items, [{ id: 'unit-tests-2', name: 'unit-tests', created: true }])
  assert.deepEqual(readArchived(repo), [archived], 'the archived item keeps its id')
  assert.deepEqual(readActive(repo).map(item => item.id), ['unit-tests-2'])
})

test('re-registering an archived name creates a new active item with a fresh id', async t => {
  const repo = gitRepo()
  const archived = makeItem('old-item', 'Old item', daysAgo(3), { proves: 'Archived version.' })
  seedCatalog(repo, [])
  seedArchive(repo, [archived])
  const result = await registerItems(repo, [{ name: 'Old item', proves: 'New active version.' }])
  assert.deepEqual(result.items, [{ id: 'old-item-2', name: 'Old item', created: true }])
  assert.deepEqual(readArchived(repo), [archived], 'the archived item is untouched')
  const active = readActive(repo)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'old-item-2')
  assert.equal(active[0].proves, 'New active version.')
})

test('a stale active name is archived by the pass and re-enters as a new active item with a fresh id', async t => {
  const repo = gitRepo()
  const stale = makeItem('stale-item', 'Stale item', daysAgo(3), { proves: 'Stale version.' })
  seedCatalog(repo, [stale])
  const result = await registerItems(repo, [{ name: 'Stale item', proves: 'Fresh re-registration.' }])
  assert.deepEqual(result.archive.moved, ['stale-item'])
  assert.deepEqual(readArchived(repo), [stale], 'the archived copy keeps the old item in full')
  const active = readActive(repo)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'stale-item-2', 'the re-registration gets a fresh id')
  assert.equal(active[0].proves, 'Fresh re-registration.')
  assert.equal(active[0].addedAt, active[0].updatedAt, 'the new item starts fresh')
  assert.deepEqual(result.items, [{ id: 'stale-item-2', name: 'Stale item', created: true }])
})

test('failure and retry with one reconcilable duplicate plus one stale item keeps the reconciled state', async t => {
  const repo = gitRepo()
  const dupActive = makeItem('dup-item', 'Dup item', daysAgo(3), { proves: 'Newer active copy.' })
  const dupArchive = makeItem('dup-item', 'Dup item', daysAgo(4), { proves: 'Older archived copy.' })
  const stale = makeItem('stale-item', 'Stale item', daysAgo(3))
  seedCatalog(repo, [dupActive, stale])
  seedArchive(repo, [dupArchive])
  // The first archive write (pruning the older duplicate copy) succeeds; the second (archiving the stale items) fails.
  const restore = failRenameOn('verification-archive.json', 2)
  let failed
  try { failed = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
  finally { restore() }
  assert.ok(failed.archive.problem.includes(archiveFileOf(repo)), `problem names the archive path: ${failed.archive.problem}`)
  assert.deepEqual(readArchived(repo), [], 'the reconciliation is durable: the older archive copy is gone')
  assert.deepEqual(readActive(repo).map(item => item.id).sort(), ['dup-item', 'stale-item'], 'both items survive active')
  assert.equal(readActive(repo).some(item => item.name === 'Incoming'), false, 'no incoming item is written')

  const retried = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }])
  assert.equal(retried.archive.problem, null)
  assert.deepEqual(readArchived(repo), [dupActive, stale], 'the retry archives both stale items in full')
  assert.deepEqual(readActive(repo).map(item => item.name), ['Incoming'])
})

test('register refuses proves longer than the 1000 character bound and writes nothing', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Long', proves: 'x'.repeat(1001) }]), /1000 characters/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false)
})

test('a failed final active write returns a refusal without throwing and writes no incoming items', async t => {
  const repo = gitRepo()
  seedCatalog(repo, [makeItem('fresh-item', 'Fresh item', daysAgo(1))])
  const catalogBefore = fs.readFileSync(catalogFile(repo), 'utf8')
  // No stale items, so the first verification.json rename is the final incoming-items write.
  const restore = failRenameOn('verification.json', 1)
  let result
  try { result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
  finally { restore() }
  assert.ok(result.archive.problem.includes(catalogFile(repo)), `problem names the failing catalog path: ${result.archive.problem}`)
  assert.ok(result.archive.problem.includes('simulated rename failure'), `problem names the cause: ${result.archive.problem}`)
  assert.deepEqual(result.archive.moved, [])
  assert.deepEqual(result.items, [])
  assert.equal(fs.readFileSync(catalogFile(repo), 'utf8'), catalogBefore, 'active catalog is byte-equal, no incoming item is written')
  assert.equal(fs.existsSync(archiveFileOf(repo)), false, 'no archive file is written')
})

test('a failed final active write after a successful archive pass returns a refusal and keeps the durable archive move', async t => {
  const repo = gitRepo()
  const stale = makeItem('old-item', 'Old item', daysAgo(3), { command: 'npm test' })
  seedCatalog(repo, [stale])
  // The first verification.json rename removes the stale item (archive pass); the second is the final incoming-items write.
  const restore = failRenameOn('verification.json', 2)
  let result
  try { result = await registerItems(repo, [{ name: 'Incoming', proves: 'Incoming.' }]) }
  finally { restore() }
  assert.ok(result.archive.problem.includes(catalogFile(repo)), `problem names the failing catalog path: ${result.archive.problem}`)
  assert.ok(result.archive.problem.includes('simulated rename failure'), `problem names the cause: ${result.archive.problem}`)
  assert.deepEqual(result.items, [])
  assert.deepEqual(readArchived(repo), [stale], 'the archive pass move stays durable')
  assert.deepEqual(readActive(repo), [], 'the active catalog holds no incoming item after the failed final write')
})
