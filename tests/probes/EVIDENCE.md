# Real host probes for ticket x9qb

`tests/chain-credit.test.mjs` drives the gate with synthetic session/event
payloads. That proves the gate's own logic but not host delivery or real
dispatch. The probes below use the real host services from a built DeepSeek
Harness checkout. Their scopes differ and are stated on each block: step one
claims delivery only, step two claims a real dispatched child write filed by
the parent's gate status.

## Re-run commands

Requires a DeepSeek Harness checkout with the built `vendor/cordis`,
`packages/core/session`, agent-loop, tool-fs, subagent, spawn-provider,
tool-subagent, commands, and webserver output.
`DSH_CHECKOUT` names it (default `/home/wilder/git-repos/deepseek-harness-020`).

```
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-one-probe.mjs
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
npm test
```

Both probes exit 0 on success. The suite version of step two is
`tests/real-store.test.mjs` (run by `npm test`; it skips when no checkout
with the built services is present). The shared dispatch assembly lives in
`tests/probes/dispatch-harness.mjs`.

## Output (recorded 2026-11-15, after the x9qb round-4 fix)

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
`SubagentRuntime`, the in-process spawn subagent provider, and the
registered `subagent` tool), mounts the real completion-gate plugin
(`lib/index.js` `apply`, whose service `start()` installs the gate's own
`session/event` listener and registers the `completion_gate` tool), and runs
one real parent turn whose scripted model calls the registered `subagent`
tool. The host ToolRuntime executes that tool and dispatches a real child
through the spawn provider (the host `startInProcessRun` driver). The
child's scripted model emits a `write` tool call, which the host ToolRuntime
executes against the real filesystem. The probe then runs the registered
`completion_gate` tool with action `status` for the parent and asserts on
that output. A stranger top-level session writes its own file in a real turn
of its own as the negative control. The probe never writes either file
itself, so the bytes on disk prove the dispatched tool calls ran. No
`workspaceChanges` recorder is mounted, so the filing proves the credited
path needs no recorder entry.

The parent status output files the child write:

```
# Completion Gate

## Repositories

Turn: 1
Notice: The host change recorder (workspaceChanges) is not available, so the files this turn changed cannot be determined.

### cg-step2-<id>
Root: /home/wilder/Trash/3t34-tests/cg-step2-<id>
Catalog: /home/wilder/Trash/3t34-tests/cg-step2-<id>/.dsh/verification.json
No catalog exists yet. Register the verification items this repository needs with the register action.
- /home/wilder/Trash/3t34-tests/cg-step2-<id>/dispatch-child.js (unclaimed, unreviewed)
Attestation: missing
Status: unfinished
Problems:
- Unclaimed changed files: /home/wilder/Trash/3t34-tests/cg-step2-<id>/dispatch-child.js. Claim each as yours, or reject it.
- No current attestation for this repository.
```

```
PASS: status action ran without error
PASS: child file written by the dispatched tool call
PASS: status output files the child write
PASS: status output files it under the parent repository root
PASS: child events carry the dispatch lineage
PASS: stranger file written by its own tool call (control is real)
PASS: status output leaves the stranger write unfiled (negative control)
PASS: parent announces no workspace/changes record
STEP-TWO-PROBE: PARENT STATUS FILES DISPATCHED CHILD WRITE
```

The parent status files the dispatched child's write under the parent
repository, unclaimed. The child's observed events carry
`parentSession=<parent>`, `origin=subagent`, `delegationDepth=1`, the
stranger's write stays out of the parent status, and the parent announces
no `workspace/changes` record.

### Suite

`npm test` passes the whole suite: 318 tests, 318 pass, 0 fail, 0 skipped,
including `tests/real-store.test.mjs` (the step-two proof as a suite test,
test 102 in the recorded run) and every other `tests/*.test.mjs` file. The
real-store test also exits cleanly on its own: the assembly mounts a
listening WebServer service, so the harness returns `dispose`
(`ctx.fiber.dispose()`, which unloads every mounted plugin) and the test
calls it in a `finally` block; without it the test passed but its process
never exited, which wedged `npm test` at 0% CPU. The probe never showed
this because it ends with `process.exit`. Complexity on the changed files
(`cccc`/`lizard`): the largest function touched is `realDispatch` at
cognitive 2; file peaks are 13 (step-two probe), 11 (dispatch harness), and
4 (real-store test), all far under the cognitive 36 cap.

## What this fix replaced

Round 3's proof was partial in three places, and each is gone:

- The hand-installed gate listener (`dispatch-harness.mjs` used to construct
  `CompletionGateService` directly and feed it with the test's own
  `session/event` callback) is replaced by mounting the real gate plugin:
  `ctx.plugin(GatePlugin)` runs the plugin's `apply`, which constructs the
  service and calls `start()`, installing the gate's own listener, the
  `completion_gate` tool, the `/gate` commands, and the web route. The only
  `session/event` listener the harness still installs is a passive observer
  that records events for assertions and never feeds the gate.
- The direct `startInProcessRun` call (which ended the parent turn first and
  drove the child from test code) is replaced by a real parent turn: the
  parent's scripted model emits a `subagent` tool call, the host ToolRuntime
  executes the registered tool, and the spawn provider dispatches the child
  through the host driver inside that execution. The child's `write` is
  still a real tool execution against the real filesystem.
- The direct `repositoryReport` call in `tests/real-store.test.mjs` is
  replaced by executing the registered `completion_gate` tool with action
  `status` for the parent and asserting on its rendered output. The internal
  assertions that only the direct call could reach (the filed record's
  `writerId`, the tracker's lineage map, `changeService() === null`) are
  retired with it; the status output plus the observed child lineage events
  carry the same proof at the observable surface. Writer provenance and
  lineage internals remain covered by `tests/chain-credit.test.mjs`.

A stranger-session negative control is new: a second top-level session
writes `stranger-write.js` in its own real turn, the file lands on disk,
and the parent status output must not name it. That proves the filing is
lineage-scoped, not "any write in the repository directory".

## Limits (genuinely unavoidable)

- Model text and tool-call generation come from the scripted adapter
  (the same `StreamChunk` shape as the host's own `MockAdapter`), not from a
  real model, because a hermetic proof cannot make a credentialed, networked,
  non-deterministic model call. The subagent tool name and arguments are the
  script's; everything downstream of the script is real: the parent turn,
  the tool execution, the child dispatch and session lineage, the `write`
  tool execution, the host event delivery, the gate plugin start, and the
  `completion_gate` status action. The parent-model dispatch decision (a
  real model choosing to delegate) is therefore still unproven, exactly as
  before; what is proven now is the full tool path a parent model's call
  takes once made.
- No `workspaceChanges` recorder is mounted, so the parent status carries the
  notice that the turn's own change set cannot be determined. That absence
  is the control: with no recorder event naming the child's file, only the
  credited path can have filed it.
- The gate plugin's settings path comes from `DSH_STATE_HOME` at `apply`
  time, so the harness points that variable at the caller's fresh settings
  directory for the mount and restores the caller's value afterwards.
