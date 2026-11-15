// Step-two real end-to-end proof for ticket x9qb (rewritten round 4).
// Mounts the BUILT host services, mounts the REAL completion-gate plugin
// (its service `start()` installs the gate's own `session/event` listener
// and registers the `completion_gate` tool), runs one real parent turn whose
// scripted model calls the registered `subagent` tool, and lets the
// dispatched child's scripted model emit a real `write` tool call that the
// host ToolRuntime executes. The probe then runs the registered
// `completion_gate` tool with action `status` for the parent and asserts on
// that output: the child write must be filed under the parent repository,
// and a stranger top-level session's own write must stay unfiled. The probe
// never writes either file itself, so the bytes on disk prove the dispatched
// tool calls ran. See EVIDENCE.md.
// Re-run: DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CHECKOUT, realDispatch, runGateStatus } from './dispatch-harness.mjs'

const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT
const CHILD_FILE = 'dispatch-child.js'
const CHILD_CONTENT = 'const fromDispatchedChild = 1\n'
const STRANGER_FILE = 'stranger-write.js'
const STRANGER_CONTENT = 'const fromStranger = 1\n'

const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')
fs.mkdirSync(workRoot, { recursive: true })
const repo = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-step2-')))
execFileSync('git', ['init', '-q', '.'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
execFileSync('git', ['add', '-A'], { cwd: repo })
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
const settingsDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-step2-settings-')))

const { ctx, parent, stranger, childId, observed, ToolCallId, dispose } = await realDispatch({
  checkout: DSH_CHECKOUT, repo, settingsDir,
  childFile: CHILD_FILE, childContent: CHILD_CONTENT,
  strangerFile: STRANGER_FILE, strangerContent: STRANGER_CONTENT,
})

const childTarget = path.join(repo, CHILD_FILE)
const strangerTarget = path.join(repo, STRANGER_FILE)
const childOnDisk = fs.existsSync(childTarget) ? fs.readFileSync(childTarget, 'utf8') : null
const strangerOnDisk = fs.existsSync(strangerTarget) ? fs.readFileSync(strangerTarget, 'utf8') : null
const { result, text: statusText } = await runGateStatus(ctx, parent, ToolCallId)
console.log(JSON.stringify({ parentId: parent.id, strangerId: stranger.id, childId, childEvents: observed.filter(e => e.sessionId === childId), parentWorkspaceChanges: observed.filter(e => e.sessionId === parent.id && e.type === 'workspace/changes') }, null, 2))
console.log(statusText)

const childEvents = observed.filter(e => e.sessionId === childId)
const checks = [
  ['status action ran without error', result.isError === false],
  ['child file written by the dispatched tool call', childOnDisk === CHILD_CONTENT],
  ['status output files the child write', statusText.includes(childTarget)],
  ['status output files it under the parent repository root', statusText.includes(`Root: ${repo}`)],
  ['child events carry the dispatch lineage', childEvents.some(e => e.parentSession === parent.id && e.origin === 'subagent' && e.delegationDepth === 1)],
  ['stranger file written by its own tool call (control is real)', strangerOnDisk === STRANGER_CONTENT],
  ['status output leaves the stranger write unfiled (negative control)', !statusText.includes(strangerTarget)],
  ['parent announces no workspace/changes record', !observed.some(e => e.sessionId === parent.id && e.type === 'workspace/changes')],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`)
  if (!pass) ok = false
}
console.log(ok ? 'STEP-TWO-PROBE: PARENT STATUS FILES DISPATCHED CHILD WRITE' : 'STEP-TWO-PROBE: FAIL')
await dispose()
process.exit(ok ? 0 : 1)
