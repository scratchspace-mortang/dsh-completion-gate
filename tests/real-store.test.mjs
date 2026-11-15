import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CHECKOUT, checkoutReady, realDispatch, runGateStatus } from './probes/dispatch-harness.mjs'

// End to end against a real dispatched descendant (ticket x9qb, round 4):
// the built host services mount the REAL completion-gate plugin, a real
// parent turn calls the registered `subagent` tool, the dispatched child's
// scripted model emits a real `write` tool call that the host ToolRuntime
// executes, and the registered `completion_gate` tool with action `status`
// files that write under the parent. A stranger top-level session writes its
// own file the same way and must stay unfiled. The test never writes either
// file itself, so the bytes on disk prove the dispatched tool calls ran.
// The suite version of tests/probes/step-two-probe.mjs; it skips when no
// DeepSeek Harness checkout with the built services is available
// (DSH_CHECKOUT, default /home/wilder/git-repos/deepseek-harness-020).
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT
const ready = checkoutReady(DSH_CHECKOUT)

test('a real dispatched child write files under the parent and a stranger write stays unfiled', { skip: ready ? false : `no built DeepSeek Harness services at ${DSH_CHECKOUT}`, timeout: 120_000 }, async () => {
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
  const strangerFile = 'stranger-write.js'
  const strangerContent = 'const fromStranger = 1\n'

  const { ctx, parent, childId, observed, ToolCallId, dispose } = await realDispatch({
    checkout: DSH_CHECKOUT, repo, settingsDir,
    childFile, childContent, strangerFile, strangerContent,
  })
  try {
    const childTarget = path.join(repo, childFile)
    const strangerTarget = path.join(repo, strangerFile)
    assert.equal(fs.readFileSync(childTarget, 'utf8'), childContent, 'the dispatched child tool call wrote the file; the test never did')
    assert.equal(fs.readFileSync(strangerTarget, 'utf8'), strangerContent, 'the stranger tool call wrote its file; the test never did')
    const { result, text } = await runGateStatus(ctx, parent, ToolCallId)
    assert.equal(result.isError, false, 'the completion_gate status action must run through the registered tool')
    assert.ok(text.includes(childTarget), `the status output must file the dispatched child write: ${text}`)
    assert.ok(text.includes(`Root: ${repo}`), `the status output must file it under the parent repository root: ${text}`)
    assert.ok(!text.includes(strangerTarget), `the status output must leave the stranger write unfiled: ${text}`)
    const childEvents = observed.filter(event => event.sessionId === childId)
    assert.ok(childEvents.some(event => event.parentSession === parent.id && event.origin === 'subagent' && event.delegationDepth === 1), 'the child events carry the dispatch lineage')
    assert.deepEqual(observed.filter(event => event.sessionId === parent.id && event.type === 'workspace/changes'), [], 'the parent announces no change record')
  } finally { await dispose() }
})
