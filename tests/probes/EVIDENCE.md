# Real session-store probes for ticket x9qb (finding 6)

`tests/chain-credit.test.mjs` drives the gate with synthetic session/event
payloads. That proves the gate's own logic but not host delivery. The two
probes below use the real host `SessionStore` from a built DeepSeek Harness
checkout, create real sessions through `ctx.sessions.create`, append real
events through `session.append()` (the agent loop's path), and observe what a
host-scope `session/event` listener receives. They are the host-delivery
proof for chain credit; nothing here is synthetic.

## Re-run commands

Requires a DeepSeek Harness checkout with built `vendor/cordis` and
`packages/core/session` output. `DSH_CHECKOUT` names it (default
`/home/wilder/git-repos/deepseek-harness-020`).

```
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-one-probe.mjs
DSH_CHECKOUT=/home/wilder/git-repos/deepseek-harness-020 node tests/probes/step-two-probe.mjs
```

Both exit 0 on success. The suite version of step two is
`tests/real-store.test.mjs` (run by `npm test`; it skips when no checkout
with a built SessionStore is present).

## Output (recorded 2026-11-15, after the x9qb fixes)

### Step one: delivery

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

Raw `tool/call` and `turn/end` events for descendant sessions reach the host
`session/event` hook with the header lineage (`parentSession`, `origin`,
`delegationDepth`, `cwd`) on each delivery.

### Step two: end to end through the real gate

The probe wires the real `CompletionGateService` to the same host dispatch,
appends a real child `write` turn (its recorder stub serves nothing, proving
the filing needs no parent recorder entry), and reads the parent status.
Relevant output (session ids and the temp repository path vary per run; the
probe creates a fresh git repository under `~/Trash/3t34-tests/`):

```
### cg-step2-*
Root: /home/wilder/Trash/3t34-tests/cg-step2-*
Catalog: /home/wilder/Trash/3t34-tests/cg-step2-*/.dsh/verification.json
No catalog exists yet. Register the verification items this repository needs with the register action.
- /home/wilder/Trash/3t34-tests/cg-step2-*/step2-child.js (unclaimed, unreviewed)
Attestation: missing
Status: unfinished
Problems:
- Unclaimed changed files: /home/wilder/Trash/3t34-tests/cg-step2-*/step2-child.js. Claim each as yours, or reject it.
- No current attestation for this repository.
STEP-TWO-PROBE: PARENT STATUS FILES CHILD WRITE
```

The parent status files the child's credited write under the parent
repository, unclaimed. No host-delivery claim rests on the synthetic tests.
