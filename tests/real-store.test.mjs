import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CHECKOUT, checkoutReady, realDispatch } from './probes/dispatch-harness.mjs'

// End to end against a real dispatched descendant (ticket x9qb, finding 6,
// round 3): the built host services dispatch a real child session through
// startInProcessRun, the child's scripted model emits a real `write` tool
// call that the host ToolRuntime executes, and the real gate observes the
// host `session/event` dispatch. The test never writes the child's file
// itself, so the bytes on disk prove the dispatched tool call ran, and the
// parent status files it with no recorder entry. The suite version of
// tests/probes/step-two-probe.mjs; it skips when no DeepSeek Harness checkout
// with the built services is available (DSH_CHECKOUT, default
// /home/wilder/git-repos/deepseek-harness-020).
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT
const ready = checkoutReady(DSH_CHECKOUT)

test('a real dispatched child write files under the parent', { skip: ready ? false : `no built DeepSeek Harness services at ${DSH_CHECKOUT}`, timeout: 120_000 }, async () => {
  const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')
  fs.mkdirSync(workRoot, { recursive: true })
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-real-store-')))
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  const settingsDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-real-store-settings-')))
  const childFile = 'dispatch-child.js'
  const childContent = 'const fromDispatchedChild = 1\n'

  const { gate, parent, run, observed } = await realDispatch({
    checkout: DSH_CHECKOUT, repo,
    settingsPath: path.join(settingsDir, 'settings.json'),
    childFile, childContent,
  })
  try {
    const target = path.join(repo, childFile)
    assert.equal(fs.readFileSync(target, 'utf8'), childContent, 'the dispatched child tool call wrote the file; the test never did')
    const report = await gate.repositoryReport(parent)
    const filed = report.repositories.flatMap(entry => entry.files.map(file => file.absolute))
    assert.ok(filed.includes(target), `the dispatched child write must file under the parent: ${JSON.stringify(report.repositories)}`)
    assert.equal(report.repositories[0].root, repo)
    assert.equal(report.repositories[0].files[0].writerId, run.id, 'the filed record retains the dispatched child provenance')
    assert.equal(gate.changes.lineage.get(run.id)?.delegated, true, 'the child events carry delegated lineage')
    assert.equal(gate.changes.lineage.get(run.id)?.parentId, parent.id, 'the child events name the parent')
    assert.equal(gate.changeService(), null, 'no recorder is mounted, so the filing proves the credited path')
    assert.deepEqual(observed.filter(e => e.sessionId === parent.id && e.type === 'workspace/changes'), [], 'the parent announces no change record')
  } finally { await run.dispose() }
})
