// Shared real-dispatch assembly for the ticket x9qb probes and suite test.
// Mounts the BUILT host services (AgentLoop, SessionStore, ToolRuntime,
// LocalFileSystem, the real ToolFs `write` tool, SubagentRuntime), registers a
// scripted mock LLM adapter (the same StreamChunk shape as the host's own
// MockAdapter in packages/core/agent-loop/tests/mock-adapter.ts), runs one
// real parent turn, then dispatches a real child through the host's
// startInProcessRun driver. The child's scripted model emits a real `write`
// tool call, which the host ToolRuntime executes against the real filesystem.
// The real gate service observes the host `session/event` dispatch throughout.
// The caller owns the fresh git repository and the settings directory; nothing
// here writes the child's file: only the dispatched child's tool call does.
// Re-run: see EVIDENCE.md.
import fs from 'node:fs'
import { CompletionGateService } from '../../lib/index.js'

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
    'packages/subagent/subagent-in-process-driver/lib/index.js',
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

// Dispatch one real child that writes `childFile` with `childContent` in
// `repo`: a fresh parent turn, then the driver's real child turn whose model
// emits the write tool call. Returns the context, the wired gate, the parent
// agent, the completed run, and the observed session events. The gate's
// change recorder is deliberately NOT mounted, so the filing below proves the
// credited path needs no recorder entry.
export async function realDispatch({ checkout, repo, settingsPath, childFile, childContent }) {
  const P = rel => `${checkout}/${rel}`
  const { Context } = await import(P('vendor/cordis/lib/index.js'))
  const { SessionId } = await import(P('packages/core/session/lib/index.js'))
  const { LlmAdapter, ToolCallId, createUserMessage } = await import(P('packages/llm/llm/lib/index.js'))
  const { mountAgentLoopTestDependencies } = await import(P('packages/test-support/agent-loop-testkit/lib/index.js'))
  const AgentLoop = (await import(P('packages/core/agent-loop/lib/index.js'))).default
  const SubagentRuntime = (await import(P('packages/subagent/subagent/lib/index.js'))).default
  const { snapshotSubagentDescriptor } = await import(P('packages/subagent/subagent/lib/index.js'))
  const { startInProcessRun } = await import(P('packages/subagent/subagent-in-process-driver/lib/index.js'))
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
  await ctx.plugin(LocalFileSystem, { cwd: repo })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)

  const adapter = new ScriptedAdapter([
    textResponse('parent setup'),
    toolCallResponse('call-write', 'write', { file_path: childFile, content: childContent }, ToolCallId),
    textResponse('child done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  const gate = new CompletionGateService(ctx, {}, { settingsPath })
  const observed = []
  ctx.on('session/event', (session, event) => {
    observed.push({ sessionId: session.id, type: event.type, turn: event.data?.turn, name: event.data?.name, parentSession: session.header?.parentSession, origin: session.header?.origin, delegationDepth: session.header?.delegationDepth, cwd: session.header?.cwd })
    gate.changes.observe(session, event)
    gate.turns.observe(session, event)
    gate.observePrompt(session, event)
  })

  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: repo })
  // One real parent turn, so the parent session emits real events and the
  // gate learns the parent lineage from them, as it does when the parent
  // dispatches from within its own turn.
  const idle = new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === parent && status === 'idle') { dispose(); resolve() }
    })
  })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'setup' }], source: { kind: 'user' } }))
  await idle

  const run = await startInProcessRun({
    label: 'child task',
    prompt: [{ type: 'text', text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'test', label: 'child task' }),
    agentOptions: { provider: 'mock', model: 'mock' },
  }, {})
  const result = await run.result
  return { ctx, gate, parent, run, result, observed, adapter }
}
