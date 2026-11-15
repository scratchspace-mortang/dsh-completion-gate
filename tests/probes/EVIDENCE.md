# Real host probes for ticket x9qb

`tests/chain-credit.test.mjs` drives the gate with synthetic session/event
payloads. That proves the gate's own logic but not host delivery or real
dispatch. The probes below use the real host services from a built DeepSeek
Harness checkout. Their scopes differ and are stated on each block: step one
claims delivery only, step two claims a real dispatched child write.

## Re-run commands

Requires a DeepSeek Harness checkout with the built `vendor/cordis`,
`packages/core/session`, agent-loop, tool-fs, and subagent-driver output.
`DSH_CHECKOUT` names it (default `/home/wilder/git-repos/deepseek-harness-020`).

```
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-one-probe.mjs
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
```

Both exit 0 on success. The suite version of step two is
`tests/real-store.test.mjs` (run by `npm test`; it skips when no checkout
with the built services is present). The shared dispatch assembly lives in
`tests/probes/dispatch-harness.mjs`.

## Output (recorded 2026-11-15, after the x9qb round-3 fixes)

### Step one: delivery (delivery scope only)

```
PASS: child tool/call delivered
PASS: child turn/end delivered
PASS: child header carries parentSession=parent
PASS: child header origin=subagent depth=1
PASS: grandchild tool/call delivered
PASS: grandchild turn/end delivered
PASS: grandchild header parent=child depth=2
PASS: header cwd delivered on child events
STEP-ONE-PROBE: DELIVERY CONFIRMED
```

Scope: the probe appends events to real sessions, so it proves the host
`session/event` hook delivers descendant `tool/call` and `turn/end` events
with the header lineage (`parentSession`, `origin`, `delegationDepth`,
`cwd`). It claims nothing about dispatch or file writes; the dispatch proof
is step two.

### Step two: real dispatched descendant (dispatch scope)

The probe mounts the built host services (`AgentLoop`, `SessionStore`,
`ToolRuntime`, `LocalFileSystem`, the real `tool-fs` `write` tool,
`SubagentRuntime`), runs one real parent turn, then dispatches a real child
through the host's `startInProcessRun` driver. The child's scripted model
emits a `write` tool call, which the host ToolRuntime executes against the
real filesystem. The probe never writes the child's file itself, so the
bytes on disk prove the dispatched tool call ran. No `workspaceChanges`
recorder is mounted, so the filing proves the credited path needs no
recorder entry.

```
PASS: child file written by the dispatched tool call
PASS: parent status files the child write
PASS: filed under the parent repository root
PASS: provenance names the dispatched child session
PASS: lineage marks the child delegated under the parent
PASS: no recorder service mounted (control)
STEP-TWO-PROBE: PARENT STATUS FILES DISPATCHED CHILD WRITE
```

The parent status files the dispatched child's write under the parent
repository, unclaimed, with the filed record naming the dispatched child
session as its writer. The child's observed events carry
`parentSession=<parent>`, `origin=subagent`, `delegationDepth=1`, and the
parent announces no `workspace/changes` record.

Limits: model text and tool-call generation come from the scripted adapter
(the same `StreamChunk` shape as the host's own `MockAdapter`), not from a
real model, because a hermetic proof cannot make a credentialed, networked,
non-deterministic model call. Everything else is real: the parent turn, the
child dispatch and session lineage, the `write` tool execution, the host
event delivery, and the gate status. The dispatch runs through
`startInProcessRun` directly (the driver's own entry point), not through a
parent model's `subagent` tool call, so the probe does not prove the
parent-model dispatch decision.
