import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CompletionGateService } from '../lib/index.js'

// End to end against a real session store (ticket x9qb, finding 6): the real
// host SessionStore creates real parent -> child sessions, real events are
// appended through session.append() (the agent loop's path), the real gate
// service observes them through its session/event hook, and the parent's
// status must file the child's credited write with no parent recorder entry.
// This is the suite version of tests/probes/step-two-probe.mjs. It skips when
// no DeepSeek Harness checkout with a built SessionStore is available
// (DSH_CHECKOUT, default /home/wilder/git-repos/deepseek-harness-020).
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? '/home/wilder/git-repos/deepseek-harness-020'
const storeReady = fs.existsSync(path.join(DSH_CHECKOUT, 'vendor/cordis/lib/index.js'))
  && fs.existsSync(path.join(DSH_CHECKOUT, 'packages/core/session/lib/index.js'))

test('a real child write through the real session store files under the parent', { skip: storeReady ? false : `no built DeepSeek Harness checkout at ${DSH_CHECKOUT}` }, async () => {
  const { Context } = await import(`${DSH_CHECKOUT}/vendor/cordis/lib/index.js`)
  const { default: SessionStore } = await import(`${DSH_CHECKOUT}/packages/core/session/lib/index.js`)

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
  const childFile = path.join(repo, 'real-store-child.js')
  fs.writeFileSync(childFile, 'const child = 1\n')
  const settingsDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-real-store-settings-')))

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const gate = new CompletionGateService(ctx, {}, { settingsPath: path.join(settingsDir, 'settings.json') })
  ctx.on('session/event', (session, event) => {
    gate.changes.observe(session, event)
    gate.turns.observe(session, event)
    gate.observePrompt(session, event)
  })

  const parent = ctx.sessions.create(undefined, { meta: { cwd: repo } })
  const child = ctx.sessions.create(undefined, { meta: { cwd: repo, parentSession: parent.id, origin: 'subagent', delegationDepth: 1, isSeeded: false } })
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  child.append('turn/start', { turn: 1 })
  child.append('step/start', { turn: 1, step: 1 })
  child.append('tool/call', { turn: 1, step: 1, callId: 'call-real-store', name: 'write', arguments: JSON.stringify({ file_path: 'real-store-child.js', content: 'const child = 1\n' }) })
  child.append('step/end', { turn: 1, step: 1 })
  child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const agent = { id: parent.id, session: { header: { cwd: repo }, events: [] }, steer() {}, followup() {} }
  const report = await gate.repositoryReport(agent)
  const filed = report.repositories.flatMap(entry => entry.files.map(file => file.absolute))
  assert.ok(filed.includes(childFile), `the real child write must file under the parent: ${JSON.stringify(report.repositories)}`)
  assert.equal(report.repositories[0].root, repo)
  assert.equal(report.repositories[0].files[0].writerId, child.id, 'the filed record retains the child writer provenance')
  fs.rmSync(settingsDir, { recursive: true, force: true })
})
