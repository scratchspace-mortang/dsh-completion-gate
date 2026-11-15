// Step-two real end-to-end proof for ticket x9qb.
// Mounts the REAL host SessionStore, creates real parent -> child sessions, and
// wires the REAL gate service's session(event) handling to the SAME host event
// dispatch the gate hook uses. Real events are appended to the real child
// session (turn/start, step/start, tool/call write, step/end, turn/end), then
// the parent's status is read through the real gate. Asserts the child's
// credited write files under the parent with no parent recorder entry.
// Re-run: DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
// DSH_CHECKOUT names the DeepSeek Harness checkout whose built SessionStore
// this probe mounts; the default is that checkout on the author's machine.
// The gate under test is this repository's own lib/index.js (relative import).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CompletionGateService } from '../../lib/index.js'
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? '/home/wilder/git-repos/deepseek-harness-020'
const { Context } = await import(`${DSH_CHECKOUT}/vendor/cordis/lib/index.js`)
const { default: SessionStore } = await import(`${DSH_CHECKOUT}/packages/core/session/lib/index.js`)

const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')
fs.mkdirSync(workRoot, { recursive: true })
const repo = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-step2-')))
execFileSync('git', ['init', '-q', '.'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
execFileSync('git', ['add', '-A'], { cwd: repo })
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
const childFile = path.join(repo, 'step2-child.js')
fs.writeFileSync(childFile, 'const child = 1\n')

const settingsDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-step2-settings-')))

const ctx = new Context()
await ctx.plugin(SessionStore)

// The gate service with its host-equivalent inputs: the session/event handle
// wired to the same host dispatch, plus a stub recorder that serves NOTHING
// (proving the filing needs no parent record entry).
const gate = new CompletionGateService(ctx, {}, { settingsPath: path.join(settingsDir, 'settings.json') })
ctx.on('session/event', (session, event) => {
  gate.changes.observe(session, event)
  gate.turns.observe(session, event)
  gate.observePrompt(session, event)
})

function createSession(meta) { return ctx.sessions.create(undefined, meta ? { meta } : undefined) }

const parent = createSession({ cwd: repo })
const child = createSession({ cwd: repo, parentSession: parent.id, origin: 'subagent', delegationDepth: 1, isSeeded: false })

// The parent runs one idle turn and ends it.
parent.append('turn/start', { turn: 1 })
parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

// The child writes a file in the covered repository during its own turn.
child.append('turn/start', { turn: 1 })
child.append('step/start', { turn: 1, step: 1 })
child.append('tool/call', { turn: 1, step: 1, callId: 'call-step2', name: 'write', arguments: JSON.stringify({ file_path: 'step2-child.js', content: 'const child = 1\n' }) })
child.append('step/end', { turn: 1, step: 1 })
child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

const agent = { id: parent.id, session: { header: { cwd: repo }, events: [] }, steer() {}, followup() {} }
const report = await gate.repositoryReport(agent)
console.log(JSON.stringify({ parentId: parent.id, childId: child.id, parentHeader: parent.header, childHeader: child.header, notices: report.notices, repositories: report.repositories }, null, 2))
const status = await gate.statusResult(agent)
console.log(status.markdown)

const filed = report.repositories.flatMap(r => r.files.map(f => f.absolute))
const ok = filed.includes(childFile) && report.repositories[0].root === repo
console.log(ok ? 'STEP-TWO-PROBE: PARENT STATUS FILES CHILD WRITE' : 'STEP-TWO-PROBE: FAIL')
process.exit(ok ? 0 : 1)
