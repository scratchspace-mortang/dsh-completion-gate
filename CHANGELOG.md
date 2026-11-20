# Changelog

## Unreleased

Hourly advisory throttle: at most one non-credential advisory per session per hour, with held-facts delivery.

- A non-credential advisory speaks at most once per session per hour. The first advisory speaks at once and starts the hour; a later prompt inside the hour stays silent and holds its advisory facts (the latest throttled facts replace older ones), which speak at the first prompt-eligible stop at or after the hour. The one-per-prompt bound still applies first.
- A credential-carrying advisory bypasses the hour and speaks at once, restarting the hour for later non-credential advisories. Credential hits seen at a prompt-silenced stop keep their existing hold-and-carry behavior.
- A stop whose only content is an unread file or a credential hit never overwrites held advisory facts, and the unread file still rides held gaps to the next spoken advisory.
- Held facts that speak after their repository completed are labelled historical, not present unfinished work, and held notices are marked as hold-time unless the speaking stop re-observed the same fact, in which case the fact prints once with the current wording. A historical held snapshot never marks its repository introduced.

## 0.5.0

Attest scope, grouping, and the compact report. A shared group form, a batch claim by commit, all-turn child adoption, and a compact report make a large attestation cheaper to write and read, and the catalog hidden files are narrowed to the two exact paths.

- One group form is accepted in `claims`, `adopted_files`, and `demonstrated_files` (and `reviewed_code_files`): an exact path, a prefix ending in `/` or `\`, or a pattern ending in `*`. A group expands over filed paths, carries its own decision, and files nothing new. A group and an exact entry, or two groups, naming the same filed path are refused with that path named and nothing written.
- Add the `before_commit` claims batch entry with decision `not-mine`. It clears every filed path whose last committed change is strictly before the resolved commit, keeps paths that commit changed and paths with uncommitted changes, and refuses an unresolvable commit name or unreadable history by name with nothing written. The compact report counts the batch as `N paths rejected by before_commit <name>`.
- Add the `adoptedChildIds` attest argument. Naming a child adopts every path it wrote in any turn; explicit `adopted_files` still work, a path another session also wrote still needs that session's adoption, and a `not-mine` rejection never adopts. The tool schema description and the system-prompt adoption paragraph both state the rule.
- The status action, both report commands, and the attest result are compact by default. A group is counted as `N paths matched by <value>` and a batch as `N paths rejected by before_commit <name>`; one hint line says to call `completion_gate` with `action attest` and `verbose true` for the full list. `verbose` on `attest` restores the per-path list; the other call sites take no verbose and stay compact.
- `items` accepts `name`, `proves`, and `command` alongside `id`, `state`, and `reason`. Only the relevant fields are used, and the call still goes through with a warning naming the ignored fields; other unknown keys stay refused.
- Raise the catalog `command` bound to 4000 characters.
- Hide only the two exact catalog paths `.dsh/verification.json` and `.dsh/verification-archive.json` in the local exclude file, removing the older whole-directory `.dsh/` line so other `.dsh/` files stay visible. The tracked `.gitignore` is never edited.
- Bump the package version to 0.5.0 and update the version test in the same commit.

## 0.4.0

Catalog items are adoption-only, and the gate tracks only paths a root-session file tool names.

- An item obligates the session only when the session states it. An unstated item is history: the status report and the advisory print one summary line, `Unstated catalog items: N (history; no action required unless adopted).`, when the count is positive, and omit it at zero. The status report keeps the full catalog reading list after the line.
- The evaluator no longer reports an unstated item as a problem. A stated item that is assumed without a reason stays unfinished and is named by exactly one problem.
- The `unrelated` mark stays in the tool contract and the report as an audit note, but the system prompt no longer asks for it.
- Track a changed path only when the host recorder lists it and a root-session `write`, `edit`, or mutating `str_replace_editor` call names it. A shell-only change, or a path no root-session file-tool call names, is not the session's obligation. The guarantee is path overlap, not authorship: a same-path change by another writer is tracked.
- Canonicalize the turn's base before resolving a file-tool path, so a session whose working directory is a symlink, or contains `symlink/..`, still overlaps the path the recorder lists.
- The system prompt says an item the session does not state is history, and keeps the adopt, register, attest, and demonstrate instructions.
- Bump the package version to 0.4.0.

## 0.3.0

Demonstration is the state above review. A review is a reading, so the gate no longer treats a read file as finished.

- Add the per-file demonstrated state. A claimed file, documentation included, must be demonstrated in real use after it is reviewed, and the report prints the file as "reviewed and demonstrated" with the note of the run beside it.
- Add the `demonstrated_files` attest argument, one `{path, note}` entry per file. A note says what was run, where it ran, and what it showed, and an empty note refuses the whole attest.
- A demonstration counts only for a file the same attestation covers as reviewed. A demonstration of code nobody read is not evidence about the code a reviewer read.
- Name reviewed but undemonstrated files as a problem in the status report, and list them in the advisory under their own heading, because a review is not a run.
- Clear the demonstrated state on a reopen along with the claims and reviews, and from a later attest that does not repeat it.
- Print a dropped attestation as `stale` in the status report, the same word the panel already used, instead of `missing`.
- Show the demonstrated state in the panel.
- Bump the package version to 0.3.0.

## 0.2.0

Advisory multi-repository completion tracker. The gate no longer runs verification. It attributes changed files to the repositories that own them, records the model's claims, and reminds the model once per user prompt.

- Resolve every changed file from the host's turn-scoped change record to the nearest repository that owns it, including nested repositories, with the session workspace as the fallback.
- Keep one in-memory completion ledger per session per repository, with the changed files, their content keys, claim decisions, reviewed states, catalog item states, and one attestation bound to a digest of the changed paths and contents.
- Add claims of `mine`, `not-mine`, and unclaimed. The gate believes either decision and never audits authorship.
- Add the per-repository verification catalog at `.dsh/verification.json`, with a required `proves` comment per item and an optional command for reproducibility. Register merges by name and keeps the item id. The catalog is ignored through the repository's local exclude file and is never executed.
- Add the `passed`, `assumed`, and `unrelated` item states. An assumed item requires a reason and is always reported as a promise, not a pass.
- Reopen a repository when a recorded path is added or a recorded file's content changes after its attestation, clearing claims, reviews, and item states except an unrelated mark.
- Send at most one batched advisory message per user prompt, with an introduction for each repository the session sees for the first time. The message advises, never says BLOCKED, and never claims a check failed.
- Keep the added-line security scan and report its hits with the rule and count, never the matched text.
- Keep the Premature Stop Guard and its continuation cap.
- Add the `register` tool action and keep `attest` and `status` with the advisory behavior. The `run`, `recipe`, and `temporary_verify` actions and the `/gate-override` command are removed.
- Reduce the settings to `enabled`, `gateSubagents`, `preventPrematureStops`, `prematureStopMaxContinuations`, `securityScan`, and `maxChangedFiles`. The settings schema becomes version 2.
- Retire the machine-check runner, check detection, recipes, the recipe runner, the temporary verifier, the verification ledger, custom checks, the acceptance-criteria field, the TODO scan, the mode switch, and the operator override.
- Rewrite the README, SECURITY.md, and the Completion section of the host AGENTS.md for the advisory workflow.
- Bump the package version to 0.2.0.

## 0.1.3

- Fix Premature Stop Guard recovery that could show a context injection and then immediately return the agent to idle.
- Premature-stop recovery now uses `agent.followup()` to schedule a fresh turn instead of same-turn `agent.steer()`.
- Keep Production Readiness blocking on `agent.steer()` because that path must veto the current completion boundary.
- Make the premature-stop continuation cap span the recovery chain across turns.
- Retry a bounded empty recovery turn instead of silently stopping immediately.
- Update Control Center wording and README to describe follow-up recovery semantics accurately.
- Revert the premature-stop guard widening that came out of the review loop. The guard matches its fixed pending-work phrases and work verbs again, so a first-person sentence whose verb is not on that list no longer blocks, for example "I will publish the release notes after review." The turn-event plumbing that lets the guard fire at all, and the three false-positive reductions (finished answers, advice in finished answers, reasoning-only turns with no tool call), are kept.

## 0.1.2

- Rewrite README as complete new-user documentation covering architecture, checks, attestation, commands, UI, installation, failover compatibility, limitations and security model.
- Turn Settings → Completion Gate into a real operator control center rather than a read-only status panel.
- Add live persistent configuration for behavior, machine evidence, completion evidence and execution limits.
- Add editable operator-defined custom checks.
- Add Save settings and Reset to profile defaults actions.
- Persist UI settings as a host-side overlay on profile configuration.
- Invalidate cached machine evidence, attestations and overrides whenever gate policy changes.
- Add `Gate · off` header state when the master switch is disabled.

## 0.1.1

- Add a bounded premature-stop guard for natural stops that clearly indicate unfinished work.
- Continue automatically when the latest assistant step contains explicit pending-action language (`now I need`, `next I will`, `let me inspect`, `in parallel start`, etc.).
- Continue automatically when a tool-using turn ends on reasoning-only output with no user-facing completion.
- Default to root-agent gating only (`gateSubagents: false`) so Completion Gate does not interfere with autonomous subagent lifecycles.
- Cap forced continuations per turn to prevent Stop-hook loops.

## 0.1.0

- Initial evidence-backed production-readiness completion barrier.
