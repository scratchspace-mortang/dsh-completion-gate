// Step-two real end-to-end proof for ticket x9qb (rewritten round 3).
// Mounts the BUILT host services, runs a real parent turn, dispatches a real
// child through the host's startInProcessRun driver, and lets the child's
// scripted model emit a real `write` tool call that the host ToolRuntime
// executes. The parent gate status must file that child write with no
// recorder entry. The probe never writes the child's file itself, so the
// file on disk proves the dispatched tool call ran. See EVIDENCE.md.
// Re-run: DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CHECKOUT, realDispatch } from './dispatch-harness.mjs'

const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT
const CHILD_FILE = 'dispatch-child.js'
const CHILD_CONTENT = 'const fromDispatchedChild = 1\n'

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

const { gate, parent, run, observed } = await realDispatch({
  checkout: DSH_CHECKOUT, repo,
  settingsPath: path.join(settingsDir, 'settings.json'),
  childFile: CHILD_FILE, childContent: CHILD_CONTENT,
})

const target = path.join(repo, CHILD_FILE)
const onDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
const report = await gate.repositoryReport(parent)
console.log(JSON.stringify({ parentId: parent.id, childId: run.id, parentHeader: parent.session.header, childEvents: observed.filter(e => e.sessionId === run.id), parentWorkspaceChanges: observed.filter(e => e.sessionId === parent.id && e.type === 'workspace/changes'), notices: report.notices, repositories: report.repositories }, null, 2))
const status = await gate.statusResult(parent)
console.log(status.markdown)

const filed = report.repositories.flatMap(r => r.files.map(f => f.absolute))
const checks = [
  ['child file written by the dispatched tool call', onDisk === CHILD_CONTENT],
  ['parent status files the child write', filed.includes(target)],
  ['filed under the parent repository root', report.repositories[0]?.root === repo],
  ['provenance names the dispatched child session', report.repositories[0]?.files[0]?.writerId === run.id],
  ['lineage marks the child delegated under the parent', gate.changes.lineage.get(run.id)?.delegated === true && gate.changes.lineage.get(run.id)?.parentId === parent.id],
  ['no recorder service mounted (control)', gate.changeService() === null],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`)
  if (!pass) ok = false
}
console.log(ok ? 'STEP-TWO-PROBE: PARENT STATUS FILES DISPATCHED CHILD WRITE' : 'STEP-TWO-PROBE: FAIL')
await run.dispose()
process.exit(ok ? 0 : 1)
