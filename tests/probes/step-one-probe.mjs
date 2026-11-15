// Step-one real delivery probe for ticket x9qb.
// Mounts the REAL host SessionStore, creates real parent -> child -> grandchild
// sessions through ctx.sessions.create with childSessionMeta-shaped headers
// (cwd, parentSession, origin subagent, delegationDepth), appends REAL
// turn/start, step/start, tool/call, step/end, turn/end events through
// session.append() (the exact path the agent loop uses), and observes what a
// host-scope `session/event` listener — the gate's hook — receives, including
// the session header lineage on each delivery.
// Question: are raw descendant tool/call and turn/end events delivered to the gate?
// Scope: this probe claims delivery only. The events are appended, not
// dispatched, so it proves nothing about agent dispatch or file writes; the
// dispatch proof is step-two-probe.mjs.
// Re-run: DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-one-probe.mjs
// DSH_CHECKOUT names the DeepSeek Harness checkout whose built SessionStore
// this probe mounts; the default is that checkout on the author's machine.
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? '/home/wilder/git-repos/deepseek-harness-020'
const { Context } = await import(`${DSH_CHECKOUT}/vendor/cordis/lib/index.js`)
const { default: SessionStore } = await import(`${DSH_CHECKOUT}/packages/core/session/lib/index.js`)

const CWD = '/home/wilder/Trash/htb6-probe'

const ctx = new Context()
await ctx.plugin(SessionStore)

const heard = []
ctx.on('session/event', (session, event) => {
  heard.push({
    sessionId: session.id,
    type: event.type,
    turn: event.data?.turn,
    name: event.data?.name,
    args: event.data?.arguments,
    parentSession: session.header.parentSession,
    origin: session.header.origin,
    delegationDepth: session.header.delegationDepth,
    cwd: session.header.cwd,
    isSeeded: session.header.isSeeded,
  })
})

function createSession(meta) {
  return ctx.sessions.create(undefined, meta ? { meta } : undefined)
}

function runTurn(session, turn, toolArgs) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('tool/call', {
    turn, step: 1, callId: `call-${session.id}-${turn}`, name: 'write',
    arguments: JSON.stringify(toolArgs),
  })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const parent = createSession({ cwd: CWD })
const child = createSession({ cwd: CWD, parentSession: parent.id, origin: 'subagent', delegationDepth: 1, isSeeded: false })
const grandchild = createSession({ cwd: CWD, parentSession: child.id, origin: 'subagent', delegationDepth: 2, isSeeded: false })
const stranger = createSession({ cwd: CWD })

runTurn(child, 1, { file_path: 'child-file.js', content: 'x\n' })
runTurn(grandchild, 1, { file_path: 'grandchild-file.js', content: 'x\n' })
runTurn(stranger, 1, { file_path: 'stranger-file.js', content: 'x\n' })

const toolCalls = heard.filter(e => e.type === 'tool/call')
const turnEnds = heard.filter(e => e.type === 'turn/end')
console.log(JSON.stringify({ heard, toolCalls, turnEnds }, null, 2))

const checks = [
  ['child tool/call delivered', toolCalls.some(e => e.sessionId === child.id && e.name === 'write')],
  ['child turn/end delivered', turnEnds.some(e => e.sessionId === child.id)],
  ['child header carries parentSession=parent', toolCalls.find(e => e.sessionId === child.id)?.parentSession === parent.id],
  ['child header origin=subagent depth=1', toolCalls.find(e => e.sessionId === child.id)?.origin === 'subagent' && toolCalls.find(e => e.sessionId === child.id)?.delegationDepth === 1],
  ['grandchild tool/call delivered', toolCalls.some(e => e.sessionId === grandchild.id)],
  ['grandchild turn/end delivered', turnEnds.some(e => e.sessionId === grandchild.id)],
  ['grandchild header parent=child depth=2', toolCalls.find(e => e.sessionId === grandchild.id)?.parentSession === child.id && toolCalls.find(e => e.sessionId === grandchild.id)?.delegationDepth === 2],
  ['header cwd delivered on child events', toolCalls.find(e => e.sessionId === child.id)?.cwd === CWD],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`)
  if (!pass) ok = false
}
console.log(ok ? 'STEP-ONE-PROBE: DELIVERY CONFIRMED' : 'STEP-ONE-PROBE: DELIVERY MISSING')
process.exit(ok ? 0 : 1)
