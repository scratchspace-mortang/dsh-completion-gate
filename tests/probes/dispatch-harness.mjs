// Shared real-dispatch assembly for the ticket x9qb probes and suite test.
// Mounts the BUILT host services (AgentLoop, SessionStore, ToolRuntime,
// LocalFileSystem, the real ToolFs `write` tool, SubagentRuntime, the
// in-process spawn subagent provider, and the registered `subagent` tool),
// mounts the REAL completion-gate plugin (lib/index.js `apply`, which runs
// the service `start()` that registers the `completion_gate` tool and the
// gate's own `session/event` listener), registers a scripted mock LLM
// adapter (the same StreamChunk shape as the host's own MockAdapter in
// packages/core/agent-loop/tests/mock-adapter.ts), and runs one real parent
// turn whose model emits a `subagent` tool call. The host ToolRuntime
// executes that registered tool, which dispatches a real child through the
// spawn provider (the host `startInProcessRun` driver); the child's scripted
// model emits a real `write` tool call, which the host ToolRuntime executes
// against the real filesystem. A second real top-level session (the stranger)
// then writes its own file the same way, as the negative control. The caller
// owns the fresh git repository and the settings directory; nothing here
// writes the child or stranger file: only the dispatched tool calls do.
// The `observed` listener below is a passive test observer: it records the
// host `session/event` dispatch and never feeds the gate. The gate sees
// events only through the listener its own `start()` installed.
// Re-run: see EVIDENCE.md.
import fs from 'node:fs'
import * as GatePlugin from '../../lib/index.js'

export const DEFAULT_CHECKOUT = '/home/wilder/git-repos/deepseek-harness-020'

// Whether this checkout has the built host services the dispatch assembly
// needs, so the suite test can skip honestly when it does not.
export function checkoutReady(checkout) {
  const needed = [
    'vendor/cordis/lib/index.js',
    'packages/core/session/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/test-support/agent-loop-testkit/lib/index.js',
    'packages/core/agent-loop/lib/index.js',
    'packages/subagent/subagent/lib/index.js',
    'packages/subagent/subagent-spawn-in-process/lib/index.js',
    'packages/subagent/subagent-in-process-driver/lib/index.js',
    'packages/subagent/tool-subagent/lib/index.js',
    'packages/interaction/commands/lib/index.js',
    'packages/host/webserver/lib/index.js',
    'packages/fs/fs-local/lib/index.js',
    'packages/fs/tool-fs/lib/index.js',
    'packages/fs/fs-observation-policy/lib/index.js',
  ]
  return needed.every(rel => fs.existsSync(`${checkout}/${rel}`))
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, c => ({ type: 'text-delta', index: 0, text: c })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(callId, name, args, ToolCallId) {
  const id = ToolCallId(callId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id, argumentsDelta: json.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function waitIdle(ctx, agent) {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

let statusCallCounter = 0

// Run the registered `completion_gate` tool with action `status` for one
// agent through the host ToolRuntime, and return the raw result plus the
// rendered text the model would see.
export async function runGateStatus(ctx, agent, ToolCallId) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-gate-status-${++statusCallCounter}`),
    name: 'completion_gate',
    arguments: { action: 'status' },
    agent,
  })
  const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? result.value?.markdown ?? ''
  return { result, text }
}

// Dispatch one real child that writes `childFile` with `childContent` in
// `repo`: a fresh parent turn whose model calls the registered `subagent`
// tool, then the real child turn whose model emits the write tool call. A
// stranger top-level session then writes `strangerFile` with
// `strangerContent` in its own real turn. Returns the context, the parent
// and stranger agents, the dispatched child session id (learned from the
// observed events), and the observed session events. The gate's change
// recorder is deliberately NOT mounted, so the filing below proves the
// credited path needs no recorder entry.
export async function realDispatch({ checkout, repo, settingsDir, childFile, childContent, strangerFile, strangerContent }) {
  const P = rel => `${checkout}/${rel}`
  const { Context } = await import(P('vendor/cordis/lib/index.js'))
  const { SessionId } = await import(P('packages/core/session/lib/index.js'))
  const { LlmAdapter, ToolCallId, createUserMessage } = await import(P('packages/llm/llm/lib/index.js'))
  const { mountAgentLoopTestDependencies } = await import(P('packages/test-support/agent-loop-testkit/lib/index.js'))
  const AgentLoop = (await import(P('packages/core/agent-loop/lib/index.js'))).default
  const SubagentRuntime = (await import(P('packages/subagent/subagent/lib/index.js'))).default
  const SpawnInProcess = await import(P('packages/subagent/subagent-spawn-in-process/lib/index.js'))
  const ToolSubagent = await import(P('packages/subagent/tool-subagent/lib/index.js'))
  const Commands = (await import(P('packages/interaction/commands/lib/index.js'))).default
  const WebServer = (await import(P('packages/host/webserver/lib/index.js'))).default
  const LocalFileSystem = (await import(P('packages/fs/fs-local/lib/index.js'))).default
  const FsPolicy = await import(P('packages/fs/fs-observation-policy/lib/index.js'))
  const ToolFs = await import(P('packages/fs/tool-fs/lib/index.js'))

  class ScriptedAdapter extends LlmAdapter {
    constructor(script) { super(); this.script = [...script]; this.requests = [] }
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      this.requests.push(options)
      const entry = this.script.shift()
      if (!entry) throw new Error('ScriptedAdapter: script exhausted')
      for (const chunk of entry) {
        if (options.signal?.aborted) throw new Error('aborted')
        yield chunk
      }
    }
  }

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn' })
  await ctx.plugin(LocalFileSystem, { cwd: repo })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(Commands)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // The gate plugin's `apply` derives its settings path from DSH_STATE_HOME
  // at construction, so point that at the caller's fresh settings directory
  // for the mount and restore the caller's value afterwards.
  const previousStateHome = process.env.DSH_STATE_HOME
  process.env.DSH_STATE_HOME = settingsDir
  try { await ctx.plugin(GatePlugin, {}) }
  finally {
    if (previousStateHome === undefined) delete process.env.DSH_STATE_HOME
    else process.env.DSH_STATE_HOME = previousStateHome
  }

  const adapter = new ScriptedAdapter([
    toolCallResponse('call-subagent', 'subagent', { description: 'child write', prompt: `Write ${childFile} in the repository.`, run_in_background: false }, ToolCallId),
    toolCallResponse('call-write', 'write', { file_path: childFile, content: childContent }, ToolCallId),
    textResponse('child done'),
    textResponse('parent done'),
    textResponse('parent done again'),
    textResponse('parent done once more'),
    toolCallResponse('call-stranger-write', 'write', { file_path: strangerFile, content: strangerContent }, ToolCallId),
    textResponse('stranger done'),
    textResponse('stranger done again'),
    textResponse('stranger done once more'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  const observed = []
  ctx.on('session/event', (session, event) => {
    observed.push({ sessionId: session.id, type: event.type, turn: event.data?.turn, name: event.data?.name, parentSession: session.header?.parentSession, origin: session.header?.origin, delegationDepth: session.header?.delegationDepth, cwd: session.header?.cwd })
  })

  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: repo })
  const parentIdle = waitIdle(ctx, parent)
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate the child write' }], source: { kind: 'user' } }))
  await parentIdle

  const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' }, { cwd: repo })
  const strangerIdle = waitIdle(ctx, stranger)
  stranger.followup(createUserMessage({ content: [{ type: 'text', text: 'write the stranger file' }], source: { kind: 'user' } }))
  await strangerIdle

  const childWrite = observed.find(event => event.type === 'tool/call' && event.name === 'write' && event.sessionId !== parent.id && event.sessionId !== stranger.id)
  // Disposing the root fiber unloads every mounted plugin (including the
  // listening WebServer service), so a suite test that mounts this assembly
  // must call it before returning or its process never exits.
  return { ctx, parent, stranger, childId: childWrite?.sessionId, observed, adapter, ToolCallId, dispose: () => ctx.fiber.dispose() }
}
