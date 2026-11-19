import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readArchive } from './catalog.js'
import { contentKey, gitHistoryFacts, isDocumentationPath, isTrackedFile, readGitPathStates } from './changes.js'
import { absoluteOf, owningRoot, realPathOf } from './repositories.js'

// The grammar of one group value, decided by the string alone. A trailing `*` is
// a pattern (match paths starting with its stem), a trailing path separator is a
// prefix (match paths starting with it), and any other bare value is exact (match
// the one path it resolves to). The exact-versus-prefix discriminator is the form,
// never the filed-path set: a bare value that also happens to be a string prefix
// of another filed path stays exact and must not silently widen to that path.
export function groupKindOf(value) {
  const raw = String(value ?? '')
  if (raw.endsWith('*')) return 'pattern'
  if (raw.endsWith('/') || raw.endsWith('\\')) return 'prefix'
  return 'exact'
}

// The per-session, in-memory record of what each repository holds for one session. One repository entry per root. Each
// repository keeps its changed files (each with a claim and two evidence states, reviewed and demonstrated), the catalog
// item states the model reported, and one attestation bound to a digest of the files. Every file starts unclaimed and
// unreviewed. Nothing is written to disk, and session disposal forgets the session (see the session/disposed listener in
// lib/index.js).
export class RepositoryTracker {
  constructor() { this.sessions = new Map() }

  session(sessionId, create = false) {
    const id = String(sessionId ?? '')
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { repos: new Map(), merged: new Map() })
    return entry ?? null
  }

  // Merge one turn's changed-file list into the session. A (turn, sequence) pair is merged once, so a later
  // evaluation of the same record changes nothing. The caller passes only a record that was read. The pair's filing
  // is stored under its key before the first await. An evaluation that finds a filing still in flight waits for it,
  // so every read returns with the turn's repositories already filed.
  // Returns true when this call filed the record, false when the record was filed before this call.
  async merge(sessionId, { turn, seq, base, files, fileToolPaths, fallback }) {
    const entry = this.session(sessionId, true)
    const key = `${Number(turn)}:${Number(seq)}`
    const inFlight = entry.merged.get(key)
    if (inFlight) { await inFlight; return false }
    const filing = this.fileTurn(entry, { base, files, fileToolPaths, fallback })
    entry.merged.set(key, filing)
    try { await filing } catch (error) { entry.merged.delete(key); throw error }
    return true
  }

  // Resolves the repository of every changed file the session's own file tools named, then files them all. A recorder
  // path no root-session file-tool call names is a shell command's change or another writer's change, so it is not this
  // session's obligation and is skipped. The guarantee is path overlap, not authorship: the record carries no author, so
  // a path both sets name is filed even when another writer changed it too. A failed lookup throws before any file is
  // filed, so a failed turn leaves nothing behind and the next read files it again.
  async fileTurn(entry, { base, files, fileToolPaths, fallback }) {
    const fallbackRoot = path.resolve(String(fallback))
    const recordBase = base ? String(base) : fallbackRoot
    // The recorder reports an inside-workspace path relative to the canonical working directory, so resolving it against
    // the canonical base files the same absolute path its own canonicalization produced. Without that step a session
    // whose working directory is a symlink would name every path twice, under two spellings, and track nothing.
    const lookupBase = await realPathOf(recordBase)
    const named = new Set(fileToolPaths)
    const resolved = []
    for (const file of files) {
      const durable = String(file)
      const absolute = absoluteOf(lookupBase, durable)
      if (!named.has(absolute)) continue
      resolved.push({ durable, absolute, root: await owningRoot(absolute, fallbackRoot) })
    }
    for (const { durable, absolute, root } of resolved) {
      let repo = entry.repos.get(root)
      if (!repo) entry.repos.set(root, repo = newRepo(root))
      let record = repo.files.get(absolute)
      if (!record) repo.files.set(absolute, record = { absolute, claim: 'unclaimed', reviewed: false, demonstrated: null, key: null, path: durable, base: lookupBase, writerId: null, adopted: false, provenance: [], adoptedFor: [] })
      // The latest durable path and base win, so a later turn's record describes the file as it was last reported.
      record.path = durable
      record.base = lookupBase
    }
  }

  // Files credited operations directly: each operation (an absolute path with
  // its writer and turn) is resolved to the repository that owns it and filed
  // unclaimed, with no recorder entry needed. The provenance of every credited
  // operation (`writerId#turn`) is retained on the record, and the latest
  // writer wins the displayed writerId, so a claim over another writer's bytes
  // needs a recorded adoption covering that provenance (see planAttest and
  // adoptionCovers). A path already filed keeps its claim and its earlier
  // provenance. A failed lookup throws before any file is filed, so a failed
  // call leaves nothing behind.
  async fileCreditedOps(sessionId, ops, fallback) {
    const entry = this.session(sessionId, true)
    const resolved = []
    const seen = new Set()
    for (const op of ops) {
      const absolute = String(typeof op === 'string' ? op : op?.absolute ?? '')
      const writerId = typeof op === 'string' ? null : (typeof op?.writerId === 'string' ? op.writerId : null)
      const turn = typeof op === 'string' ? null : (Number.isInteger(op?.turn) ? op.turn : null)
      // One op per (path, provenance) per call: successive writers on one path
      // each keep their provenance, while an exact repeat files once.
      const provenance = writerId ? `${writerId}#${turn ?? '?'}` : null
      const dedupe = `${absolute}\u0000${provenance ?? ''}`
      if (!absolute || seen.has(dedupe)) continue
      seen.add(dedupe)
      resolved.push({ absolute, writerId, root: await owningRoot(absolute, String(fallback)), provenance })
    }
    for (const { absolute, writerId, root, provenance } of resolved) {
      let repo = entry.repos.get(root)
      if (!repo) entry.repos.set(root, repo = newRepo(root))
      let record = repo.files.get(absolute)
      if (!record) repo.files.set(absolute, record = { absolute, claim: 'unclaimed', reviewed: false, demonstrated: null, key: null, path: absolute, base: path.dirname(absolute), writerId, adopted: false, provenance: [], adoptedFor: [] })
      if (writerId) record.writerId = writerId
      if (provenance && !record.provenance.includes(provenance)) record.provenance.push(provenance)
      record.path = absolute
      record.base = path.dirname(absolute)
    }
  }

  // Files a model-claimed path with no record entry, under the repository that owns it. The absolute path is
  // canonicalized through its longest existing ancestor, and the owning root is validated through the git lookup
  // (fallback to the session working directory). A root with no entry is admitted explicitly here, so the staged
  // copy carries it when the caller adopts it. A path already filed keeps its claim and its credited provenance.
  // The caller checks the path exists on disk first, or is a tracked deletion, so a typo name stays refused as not a changed file.
  async fileClaim(sessionId, absolute, fallback) {
    const entry = this.session(sessionId, true)
    const canonical = (await realPathOf(path.resolve(String(absolute)))) ?? path.resolve(String(absolute))
    const root = await owningRoot(canonical, String(fallback))
    let repo = entry.repos.get(root)
    if (!repo) entry.repos.set(root, repo = newRepo(root))
    if (!repo.files.has(canonical)) repo.files.set(canonical, { absolute: canonical, claim: 'unclaimed', reviewed: false, demonstrated: null, key: null, path: canonical, base: path.dirname(canonical), writerId: null, adopted: false, provenance: [], adoptedFor: [] })
    return { root, absolute: canonical }
  }

  // Recompute the content key of every known file. The key covers the file's bytes now, so a later edit shows up
  // as a new key on the next evaluation.
  async refresh(sessionId, nested = { heads: new Map(), unreadable: [], unresolved: [] }) {
    const entry = this.session(sessionId)
    if (!entry) return
    for (const repo of entry.repos.values()) {
      for (const file of repo.files.values()) file.key = await contentKey(file.base, file.path, nested)
    }
  }

  // Moves every known file to the repository that owns it now. A nested repository created after a file was filed owns
  // that file from then on. The file keeps its claim unless it is unclaimed under the new root, and it is unreviewed and
  // undemonstrated there, because both belong to the attestation of the repository the file was in. A repository this pass emptied,
  // with no item state and no attestation, is dropped.
  async reroot(sessionId, fallback) {
    const entry = this.session(sessionId)
    if (!entry) return
    const fallbackRoot = path.resolve(String(fallback))
    for (const repo of [...entry.repos.values()]) {
      let moved = false
      for (const file of [...repo.files.values()]) {
        const root = await owningRoot(file.absolute, fallbackRoot)
        if (root === repo.root) continue
        if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
        const target = entry.repos.get(root)
        const existing = target.files.get(file.absolute)
        if (existing) { if (existing.claim === 'unclaimed') existing.claim = file.claim }
        else target.files.set(file.absolute, { ...file, reviewed: false, demonstrated: null, provenance: [...(file.provenance ?? [])], adoptedFor: [...(file.adoptedFor ?? [])] })
        repo.files.delete(file.absolute)
        moved = true
      }
      if (moved && repo.files.size === 0 && repo.items.size === 0 && !repo.attestation) entry.repos.delete(repo.root)
    }
  }

  // Whether this session holds a repository entry for the root, that is, whether the session has seen that repository.
  has(sessionId, root) { return Boolean(this.session(sessionId)?.repos.has(root)) }

  // Adds an entry for a root with no changed file, so status lists a repository the register action wrote a catalog into.
  addRepository(sessionId, root) {
    const entry = this.session(sessionId, true)
    if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
  }

  // Binds an attestation to the repository's current digest and marks the files it covers reviewed, and the files it
  // reports demonstrated with the note given. The claims and item states of the plan are merged in: a claim changes only
  // the paths it names, and an item changes only the ids it names. The attestation itself replaces the earlier one, and
  // every file's reviewed and demonstrated state is recomputed from it alone, so a file the latest attestation does not
  // cover is unreviewed and undemonstrated (see reviewedBy and demonstratedBy).
  applyAttest(sessionId, root, plan, createdAt) {
    const entry = this.session(sessionId, true)
    if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
    const repo = entry.repos.get(root)
    for (const claim of plan.claims) repo.files.get(claim.absolute).claim = claim.decision
    const explicitAdopted = plan.adopted ?? new Set()
    const childIds = plan.adoptedChildIds ?? new Set()
    // A not-mine rejection never adopts, even when its writer is a named child.
    // An explicit adoption covers the whole file; a named child adopts only the
    // provenance entries that child wrote, so another writer on the same path
    // still needs that writer's own adoption.
    for (const file of repo.files.values()) {
      if (file.claim === 'not-mine') continue
      const useExplicit = explicitAdopted.has(file.absolute)
      const added = childAdoptionEntries(file, childIds)
      if (!useExplicit && !added.length) continue
      const covered = new Set(file.adoptedFor ?? [])
      if (useExplicit) for (const entry of file.provenance ?? []) covered.add(entry)
      else for (const entry of added) covered.add(entry)
      file.adopted = true
      file.adoptedFor = [...covered]
    }
    for (const item of plan.items) repo.items.set(item.id, { state: item.state, reason: item.reason })
    repo.attestation = { digest: repositoryDigest(repo), summary: plan.summary ?? '', createdAt }
    for (const file of repo.files.values()) {
      file.reviewed = reviewedBy(plan, file)
      file.demonstrated = demonstratedBy(plan, file)
    }
    repo.stale = false
  }

  // Reopens every repository whose files no longer match the digest its attestation was bound to. A reopened repository has
  // every claim set back to unclaimed and every reviewed and demonstrated state cleared, its attestation dropped, and every item state
  // cleared except an unrelated mark: that mark is a statement about the session, not about the change set, so a later
  // change does not touch it. Returns the reopened roots, sorted. A repository with no attestation is never reopened here.
  reopenChanged(sessionId) {
    const entry = this.session(sessionId)
    if (!entry) return []
    const roots = []
    for (const repo of entry.repos.values()) {
      if (!repo.attestation || repo.attestation.digest === repositoryDigest(repo)) continue
      for (const file of repo.files.values()) { file.claim = 'unclaimed'; file.reviewed = false; file.demonstrated = null; file.adopted = false; file.adoptedFor = [] }
      for (const [id, item] of repo.items) if (item.state !== 'unrelated') repo.items.delete(id)
      repo.attestation = null
      repo.stale = true
      roots.push(repo.root)
    }
    return roots.sort()
  }

  // Whether this session holds an unrelated mark for a repository, which a reopen keeps (see reopenChanged). The advisory
  // notice asks this instead of reading the repository snapshot, so the fact comes from the tracker that stores it.
  hasUnrelatedMark(sessionId, root) {
    const repo = this.session(sessionId)?.repos.get(root)
    return Boolean(repo) && [...repo.items.values()].some(item => item.state === 'unrelated')
  }

  // The repositories of one session, sorted by root, each with its files sorted by absolute path.
  repositories(sessionId) {
    const entry = this.session(sessionId)
    if (!entry) return []
    return [...entry.repos.keys()].sort().map(root => {
      const repo = entry.repos.get(root)
      return {
        root,
        label: path.basename(root) || root,
        catalogPath: path.join(root, '.dsh', 'verification.json'),
        files: [...repo.files.keys()].sort().map(absolute => {
          const file = repo.files.get(absolute)
          return { path: file.path, absolute: file.absolute, claim: file.claim, reviewed: file.reviewed, demonstrated: file.demonstrated, key: file.key, documentation: isDocumentationPath(file.path), writerId: file.writerId ?? null, adopted: file.adopted === true, provenance: [...(file.provenance ?? [])], adoptedFor: [...(file.adoptedFor ?? [])] }
        }),
        itemStates: [...repo.items].map(([id, item]) => ({ id, state: item.state, reason: item.reason })),
        attestation: repo.attestation,
        introduced: repo.introduced,
        stale: repo.stale,
      }
    })
  }

  // Records that the session has been shown this repository's introduction, so a later message does not repeat it.
  markIntroduced(sessionId, root) {
    const repo = this.session(sessionId)?.repos.get(root)
    if (repo) repo.introduced = true
  }

  forget(sessionId) { this.sessions.delete(String(sessionId ?? '')) }

  // A copy of one session's entry, for an attest call to change and then hand to adopt. Nothing in the copy is shared with
  // this tracker, so a call that refuses drops its copy and leaves this tracker as it was. The copy starts with no merged
  // turns: a filing still in flight writes into this tracker's entry, not the copy, so a copy that inherited it would
  // count that turn as filed while its files were missing. Re-filing a turn is idempotent, so the copy files it again.
  stage(sessionId) {
    const copy = new RepositoryTracker()
    const entry = this.session(sessionId)
    if (!entry) return copy
    const repos = new Map([...entry.repos].map(([root, repo]) => [root, {
      root: repo.root,
      files: new Map([...repo.files].map(([absolute, file]) => [absolute, { ...file, provenance: [...(file.provenance ?? [])], adoptedFor: [...(file.adoptedFor ?? [])] }])),
      items: new Map([...repo.items].map(([id, item]) => [id, { ...item }])),
      attestation: repo.attestation ? { ...repo.attestation } : null,
      introduced: repo.introduced,
      stale: repo.stale,
    }]))
    copy.sessions.set(String(sessionId ?? ''), { repos, merged: new Map() })
    return copy
  }

  // Replaces this tracker's entry for the session with the staged copy's entry, when the copy has one.
  adopt(sessionId, staged) {
    const entry = staged.session(sessionId)
    if (entry) this.sessions.set(String(sessionId ?? ''), entry)
  }
}

// `introduced` is set once the session has been shown this repository's introduction (see markIntroduced). `stale` is set when
// a change after the attestation reopened the repository, and cleared by the next attestation.
function newRepo(root) { return { root, files: new Map(), items: new Map(), attestation: null, introduced: false, stale: false } }

// The digest an attestation is bound to: the sorted absolute paths of the repository's files, each with its content key and
// its credited provenance (`writerId#turn` per operation). The claims, the reviewed states, and the item states are not part
// of it, so a claim, a review, or a catalog item can change without reopening the repository. Provenance is part of it, so a
// new writer on unchanged bytes reopens the repository instead of riding the earlier adoption.
function digestOf(entries) {
  const hash = crypto.createHash('sha256')
  for (const { absolute, key, provenance } of [...entries].sort((a, b) => a.absolute < b.absolute ? -1 : 1)) hash.update(`${absolute}\u0000${key ?? ''}\u0000${(provenance ?? []).join(',')}\n`)
  return hash.digest('hex')
}

export function repositoryDigest(repo) {
  return digestOf([...repo.files.keys()].map(absolute => ({ absolute, key: repo.files.get(absolute).key ?? null, provenance: repo.files.get(absolute).provenance ?? [] })))
}

// The digest of a repository snapshot (an entry of repositories): the current
// digest the disposal coverage check compares against the attestation digest.
export function snapshotDigest(snapshot) {
  return digestOf(snapshot.files.map(file => ({ absolute: file.absolute, key: file.key ?? null, provenance: file.provenance ?? [] })))
}

// Whether a recorded adoption covers a file's credited provenance: every
// `writerId#turn` operation on the file is in the adopted-for set. A file with
// no credited provenance is covered by its adopted flag. A new writer's
// operation is never in an earlier adopted-for set, so it needs its own adoption.
export function adoptionCovers(file) {
  const provenance = Array.isArray(file.provenance) ? file.provenance : []
  if (provenance.length === 0) return file.adopted === true
  const covered = Array.isArray(file.adoptedFor) ? file.adoptedFor : []
  return file.adopted === true && provenance.every(entry => covered.includes(entry))
}

// The credited provenance entries of one file written by any named child. One
// entry is one `writerId#turn` operation, so matching on the writer id alone
// covers every turn of a named child, while an unnamed writer's entry is left
// for that writer's own adoption. The writer is everything before the last '#',
// so a writer id that itself contains '#' is matched exactly.
function childAdoptionEntries(file, childIds) {
  const entries = []
  for (const entry of file.provenance ?? []) {
    const raw = String(entry)
    const hash = raw.lastIndexOf('#')
    const writer = hash < 0 ? raw : raw.slice(0, hash)
    if (childIds.has(writer)) entries.push(entry)
  }
  return entries
}

// Whether one attestation covers a changed file's review: a documentation file is reviewed by a true documentation check,
// and a code file by its path in the reviewed list. Only the latest attestation is asked, so a file it does not cover is
// unreviewed (see applyAttest and reopenChanged).
function reviewedBy(plan, file) {
  return isDocumentationPath(file.path) ? plan.docsChecked === true : plan.reviewed.includes(file.absolute)
}

// What a demonstration entry must say when its note is empty. The refusal names the path, so the model knows which one.
export const DEMONSTRATION_PROBLEM = 'has a blank note, so nothing is demonstrated. Say what you ran, where it ran, and what it showed.'

// Every adoption refusal and the unadopted report line name both recorded
// routes, so a model is never steered back to per-path enumeration when naming
// the writing child suffices. The old wording stays a literal prefix here, so
// callers that matched "requires listing it in adopted_files" still match.
const ADOPTION_ROUTES = 'listing it in adopted_files or naming its writer in adoptedChildIds'

// Whether one attestation covers a changed file's demonstration. It covers a path listed with a note, and only for a file
// the same attestation covers as reviewed, because a demonstration of code nobody read is not evidence about the code a
// reviewer read. A rejected file keeps no state, because the obligation leaves with the claim (see evaluateRepository).
function demonstratedBy(plan, file) {
  return file.reviewed ? plan.demonstrated.get(file.absolute) ?? null : null
}

// A refused attest call. Nothing is stored when it is thrown. The message lists every error, so one call shows all of them.
export class AttestRefusal extends Error {
  constructor(errors) {
    super(`attest refused. Nothing was changed.\n${errors.map(error => `- ${error}`).join('\n')}`)
    this.name = 'AttestRefusal'
    this.errors = errors
  }
}

const CLAIM_KEYS = new Set(['path', 'decision', 'before_commit'])
const DEMONSTRATION_KEYS = new Set(['path', 'note'])
const ITEM_KEYS = new Set(['id', 'state', 'reason'])
const DECISIONS = new Set(['mine', 'not-mine'])

// Evaluates every before_commit entry of one attest from the git facts owned by lib/changes.js. This module still
// owns the decision: only the strictly-before paths become not-mine claims, every named failure refuses the whole
// batch, and the caller writes nothing when any error is present. A later entry that fails refuses an earlier
// entry's clearings too, because the plan carrying them is discarded before application.
async function beforeCommitClaims(root, entries, files) {
  const claims = []
  const failures = []
  const paths = files.map(file => file.absolute)
  // Status and last commits do not depend on the entry's commit, so read them once for the whole batch.
  const states = await readGitPathStates(root, paths)
  for (const entry of entries) {
    const facts = await gitHistoryFacts(root, entry.before_commit, paths, states)
    if (facts.failure) { failures.push(facts.failure); continue }
    for (const absolute of facts.before) claims.push({ absolute, decision: 'not-mine' })
  }
  return { failures, claims }
}
// A catalog item is passed in a run, assumed without one, or unrelated to this session. The unrelated mark is a statement
// about the session, not about the change set, so reopening keeps it (see reopenChanged). The tool schema reads this list,
// so the states a model may report and the states the handler accepts are one contract.
export const ITEM_STATES = new Set(['passed', 'assumed', 'unrelated'])
const text = value => typeof value === 'string' && value.trim() !== ''

// One descriptor per path argument. Everything that treats path arguments alike reads this
// list: schema validation, expansion, per-argument overlap refusal, and the applied sets in
// the plan. A path argument added to the schema needs one row here, so it cannot silently skip
// overlap refusal or the applied sets. `parse` folds one raw value into an entry carrying its
// kind, value, paths and any argument-specific fields; `apply` folds the entries into the plan.
const PATH_ARGUMENTS = [
  {
    key: 'claims',
    arrayShape: '{path, decision} objects',
    validate(items, errors) {
      const seen = new Set()
      items.forEach((claim, index) => {
        if (!claim || typeof claim !== 'object' || Array.isArray(claim)) { errors.push(`claims[${index}] must be an object.`); return }
        for (const key of Object.keys(claim)) if (!CLAIM_KEYS.has(key)) errors.push(`claims[${index}] has an unknown key: ${key}.`)
        // Key presence, not a truthy value, decides the exactly-one rule: a stray empty or non-string key is an
        // error rather than a silent switch between the path and batch routes. This is the published oneOf contract.
        const hasPath = Object.prototype.hasOwnProperty.call(claim, 'path')
        const hasCommit = Object.prototype.hasOwnProperty.call(claim, 'before_commit')
        if (hasPath === hasCommit) errors.push(`claims[${index}] must name exactly one of path or before_commit.`)
        if (hasPath && !text(claim.path)) errors.push(`claims[${index}].path must be a non-empty string.`)
        if (hasCommit && !text(claim.before_commit)) errors.push(`claims[${index}].before_commit must be a non-empty string.`)
        const name = hasPath && typeof claim.path === 'string' && claim.path.trim() !== '' ? claim.path : null
        if (name && seen.has(name)) errors.push(`claims[${index}].path repeats ${name}.`)
        else if (name) seen.add(name)
        // Quote the received value so the fixed wording "not-mine" cannot satisfy an assertion about it.
        if (hasCommit && claim.decision !== 'not-mine') errors.push(`claims[${index}].decision must be not-mine for a before_commit entry (got ${JSON.stringify(String(claim.decision))}).`)
        if (!DECISIONS.has(claim.decision)) errors.push(`claims[${index}].decision must be mine or not-mine.`)
      })
    },
    parse: (raw, expand) => expand(raw.path, true).then(entry => ({ decision: raw.decision, ...entry })),
    apply(plan, entries) { plan.claims = entries.flatMap(entry => entry.paths.map(absolute => ({ absolute, decision: entry.decision }))) },
  },
  {
    key: 'reviewed_code_files',
    arrayShape: 'non-empty paths',
    validate(items, errors) { if (items.some(p => !text(p))) errors.push('reviewed_code_files must be an array of non-empty paths.') },
    parse: (raw, expand) => expand(raw),
    apply(plan, entries) { plan.reviewed = [...new Set(entries.flatMap(entry => entry.paths))] },
  },
  {
    key: 'adopted_files',
    arrayShape: 'non-empty paths',
    validate(items, errors) { if (items.some(p => !text(p))) errors.push('adopted_files must be an array of non-empty paths.') },
    parse: (raw, expand) => expand(raw),
    apply(plan, entries) { plan.adopted = new Set(entries.flatMap(entry => entry.paths)) },
  },
  {
    key: 'demonstrated_files',
    arrayShape: '{path, note} objects',
    validate(items, errors) {
      const seen = new Set()
      items.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`demonstrated_files[${index}] must be an object.`); return }
        for (const key of Object.keys(entry)) if (!DEMONSTRATION_KEYS.has(key)) errors.push(`demonstrated_files[${index}] has an unknown key: ${key}.`)
        if (!text(entry.path)) errors.push(`demonstrated_files[${index}].path is required.`)
        else if (seen.has(entry.path)) errors.push(`demonstrated_files[${index}].path repeats ${entry.path}.`)
        else seen.add(entry.path)
        if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`demonstrated_files[${index}].note must be a string.`)
        else if (!text(entry.note)) errors.push(`demonstrated_files[${index}].note is required: say what you ran, where it ran, and what it showed.`)
      })
    },
    parse: async (raw, expand) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'exact', value: '', paths: [], note: '', invalid: true }
      return { ...await expand(raw.path), note: raw.note }
    },
    apply(plan, entries, error) {
      const demonstrated = []
      for (const entry of entries) {
        if (entry.invalid) continue
        if (!text(entry.note)) error(`${entry.value} ${DEMONSTRATION_PROBLEM}`)
        demonstrated.push(...entry.paths.map(absolute => ({ absolute, note: text(entry.note) ? entry.note.trim() : '' })))
      }
      plan.demonstrated = demonstrated
    },
  },
]
const ATTEST_KEYS = new Set([...PATH_ARGUMENTS.map(arg => arg.key), 'action', 'repository_root', 'docs_checked', 'items', 'summary', 'adoptedChildIds'])

// The schema errors of one attest call, with no repository state read. An empty list means the shape is valid. A key the
// call does not allow is an error, so a retired argument is refused instead of ignored. An omitted array field counts as
// empty; an explicit null is refused like any other value of the wrong type.
export function attestSchemaErrors(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['attest takes one object of arguments.']
  const errors = []
  for (const key of Object.keys(args)) if (!ATTEST_KEYS.has(key)) errors.push(`Unknown argument: ${key}.`)
  if (!text(args.repository_root)) errors.push('repository_root is required: the path of a repository this session changed.')
  for (const arg of PATH_ARGUMENTS) {
    const values = args[arg.key] === undefined ? [] : args[arg.key]
    if (!Array.isArray(values)) errors.push(`${arg.key} must be an array of ${arg.arrayShape}.`)
    else arg.validate(values, errors)
  }
  if (args.docs_checked !== undefined && typeof args.docs_checked !== 'boolean') errors.push('docs_checked must be true or false.')
  if (args.summary !== undefined && typeof args.summary !== 'string') errors.push('summary must be a string.')
  if (args.adoptedChildIds !== undefined) {
    const ids = args.adoptedChildIds
    if (!Array.isArray(ids) || ids.some(id => !text(id))) errors.push('adoptedChildIds must be an array of non-empty child session ids.')
  }
  const items = args.items === undefined ? [] : args.items
  if (!Array.isArray(items)) errors.push('items must be an array of {id, state, reason} objects.')
  else {
    const ids = new Set()
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`items[${index}] must be an object.`); return }
      for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) errors.push(`items[${index}] has an unknown key: ${key}.`)
      if (!text(item.id)) errors.push(`items[${index}].id is required.`)
      else if (ids.has(item.id)) errors.push(`items[${index}].id repeats ${item.id}.`)
      else ids.add(item.id)
      if (!ITEM_STATES.has(item.state)) errors.push(`items[${index}].state must be passed, assumed, or unrelated.`)
      if (item.reason !== undefined && typeof item.reason !== 'string') errors.push(`items[${index}].reason must be a string.`)
      if ((item.state === 'passed' || item.state === 'unrelated') && item.reason !== undefined) errors.push(`items[${index}] is ${item.state}, so it takes no reason.`)
    })
  }
  return errors
}

// The docs_checked adoption errors of one attest call: every documentation
// file claimed mine (the snapshot claim overridden by this call's claims)
// whose credited provenance is not adopted. A `not-mine` doc needs no check
// and no adoption, like a rejected code file.
function docsAdoptionErrors(snapshot, claims, unadopted) {
  const errors = []
  const effectiveClaim = new Map(snapshot.files.map(file => [file.absolute, file.claim]))
  for (const claim of claims) effectiveClaim.set(claim.absolute, claim.decision)
  for (const file of snapshot.files) {
    if (!file.documentation || effectiveClaim.get(file.absolute) !== 'mine') continue
    if (unadopted(file.absolute)) errors.push(`${file.absolute} was written by ${file.writerId}, so covering it with docs_checked requires ${ADOPTION_ROUTES} to record that adoption.`)
  }
  return errors
}

// Resolves catalog item ids against the active catalog first, then the archive, as a map from id to the winning copy
// with its `archived` state. A duplicate id (the transient crash window) resolves to the copy with the newer
// updatedAt; equal timestamps, or two unparseable ones, resolve to the archived copy, and a parseable updatedAt beats
// an unparseable one. An unreadable archive reads as absent here; the caller reports its problem separately, so an
// archived item is never treated as absent without a visible reason.
function resolveItems(activeItems, archiveItems) {
  const resolved = new Map()
  for (const item of activeItems ?? []) resolved.set(item.id, { ...item, archived: false })
  for (const item of archiveItems ?? []) {
    const existing = resolved.get(item.id)
    if (!existing) { resolved.set(item.id, { ...item, archived: true }); continue }
    const activeTime = Date.parse(existing.updatedAt)
    const archivedTime = Date.parse(item.updatedAt)
    const activeParses = !Number.isNaN(activeTime)
    const archivedParses = !Number.isNaN(archivedTime)
    if ((archivedParses && (!activeParses || archivedTime >= activeTime)) || (!archivedParses && !activeParses)) {
      resolved.set(item.id, { ...item, archived: true })
    }
  }
  return resolved
}

// The absolute string a group value is matched against. A pattern drops its
// trailing `*`, a prefix keeps its trailing separator, and both match every
// filed path starting with the result. Only a trailing separator normalizes to
// the host separator, so a trailing `\` works on POSIX just like `/`; separators
// inside the stem stay literal and are out of scope under settled U1. The stem
// is canonicalized the same way exact values are (through `realPathOf`, with its
// ancestor-plus-leaf handling), so a symlink in the root or stem reaches the
// canonical filed path. Keeping the separator in a directory prefix stops `lib/`
// from also reaching a sibling like `library`.
async function groupStem(value, root) {
  const raw = String(value)
  const core = raw.endsWith('*') ? raw.slice(0, -1) : raw
  const separator = /[\\/]$/.test(core)
  const stem = separator ? core.slice(0, -1) : core
  const lexical = path.resolve(root, stem)
  let resolved = lexical
  try { resolved = (await realPathOf(lexical)) ?? lexical } catch { resolved = lexical }
  return separator ? resolved + path.sep : resolved
}

const overlapMessage = (shared, first, second) => `${shared} is named by both ${first} and ${second}, so this attest is ambiguous. Use one entry for that path.`

// A group and an exact entry naming one filed path are ambiguous. The refusal
// names the shared absolute path; the caller writes nothing because the plan is
// never returned. Kept separate from group-group so each rule pins independently.
function groupExactOverlap(groups, exacts) {
  for (const group of groups) for (const exact of exacts) {
    const shared = group.paths.find(candidate => exact.paths.includes(candidate))
    if (shared) return overlapMessage(shared, group.value, exact.value)
  }
  return null
}

// Two groups naming one filed path are ambiguous too.
function groupGroupOverlap(groups) {
  for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
    const shared = groups[i].paths.find(candidate => groups[j].paths.includes(candidate))
    if (shared) return overlapMessage(shared, groups[i].value, groups[j].value)
  }
  return null
}

// Two different spellings that resolve to the same filed path are one path named
// twice. Identical raw spellings are the same entry repeated and resolve to the
// same path idempotently, so they are allowed (the schema never refused them);
// refusing them would report `X is named by both X and X`.
function exactExactOverlap(exacts) {
  for (let i = 0; i < exacts.length; i += 1) for (let j = i + 1; j < exacts.length; j += 1) {
    if (exacts[i].value === exacts[j].value) continue
    const shared = exacts[i].paths.find(candidate => exacts[j].paths.includes(candidate))
    if (shared) return overlapMessage(shared, exacts[i].value, exacts[j].value)
  }
  return null
}

// Resolves the paths of one attest call against the repository's changed files and checks the item ids against the
// catalog and the archive. It returns the plan to apply, or throws AttestRefusal listing every error. It reads no file content and stores
// nothing; an unfiled path is statted (and, when absent, checked against git's tracked names) only to choose which
// wording its refusal takes. Evidence paths are canonicalized the same way filed paths are, so a symlink spelling of a
// filed file resolves to the filed file instead of refusing it as not a changed file. A missing leaf keeps its name
// under its canonical ancestor, so a tracked deletion resolves the same way its filing did.
export async function planAttest(snapshot, args, catalogState, fallbackCwd = snapshot.root) {
  const errors = []
  const childIds = new Set((Array.isArray(args.adoptedChildIds) ? args.adoptedChildIds : []).map(id => String(id)))
  const known = new Set(snapshot.files.map(file => file.absolute))
  // A before_commit entry is a batch claim with no path. It is judged against git history here and never goes through
  // the claim route that files an exact path. Its claims are collected before the plan is built; a refusal is added
  // to the same error list, so any clearing it found is discarded with the plan instead of written.
  const claimEntries = Array.isArray(args.claims) ? args.claims : []
  const batchEntries = claimEntries.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && text(entry.before_commit))
  const pathClaimEntries = claimEntries.filter(entry => !batchEntries.includes(entry))
  const batch = batchEntries.length ? await beforeCommitClaims(snapshot.root, batchEntries, snapshot.files) : { failures: [], claims: [] }
  if (batch.failures.length) errors.push(...batch.failures)
  // A claims entry already went through the claim route before this plan ran, so its refusal states that no action
  // on the path helps. Any other entry (a review, a demonstration, an adoption) has not tried it. The claim route
  // files a path that still exists on disk, or a tracked deletion; a typo name has neither, so the claim route
  // refuses it too and the no-action wording applies to it instead of the claim-route promise.
  // An entry the claims also name already tried the route, so it keeps the claims wording either way.
  // The claim route files under the effective owning root (see fileClaim in this file and stagedAttest in lib/index.js), not
  // under the selected root, so the promise is made only when the effective owning root is the selected root. A path owned
  // by another root names that root as the correct target instead. The effective owning root is the git root when one
  // exists, and otherwise the fallback cwd, exactly as fileClaim files it: a null git root is not "never foreign", it
  // files under the session working directory, which differs from the selected root whenever the two differ.
  const claimedAbsolutes = new Set()
  const absoluteFor = async (raw, claimEntry = false) => {
    const lexical = path.resolve(snapshot.root, String(raw))
    let absolute = lexical
    try { absolute = (await realPathOf(lexical)) ?? lexical } catch { absolute = lexical }
    if (claimEntry) claimedAbsolutes.add(absolute)
    if (!known.has(absolute)) {
      const owner = await owningRoot(absolute, fallbackCwd)
      // Both roots use the same convention: a git root canonicalized, and otherwise the fallback cwd as written
      // (path.resolve, lexically). snapshot.root is a repository key filed under that convention by fileClaim /
      // fileTurn / seenRoot, and owner is produced by owningRoot under it, so comparing the two directly keeps
      // one logical root one root. Canonicalizing only the selected root would treat a symlinked session cwd
      // selected as the repository as foreign to itself, while the claim route files under the lexical root.
      const foreign = owner !== snapshot.root
      // The tracked-deletion check runs against the owning root, so a deletion in another repository is claimable
      // there even though it lies outside the selected root.
      let claimable = true
      try { await fs.promises.lstat(absolute) }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') claimable = await isTrackedFile(absolute, owner)
        else throw error
      }
      if (foreign && claimable) {
        if (claimEntry || claimedAbsolutes.has(absolute)) errors.push(`${raw} is not a changed file of this repository. No filed record names it, so this claim cannot file it under this repository. It belongs to ${owner}, so attest against ${owner} instead. Check the spelling and the path; editing the file will not create a filed record.`)
        else errors.push(`${raw} is not a changed file of this repository. No filed record names it. It belongs to ${owner}, so a claim against this repository cannot file it; attest against ${owner} instead, with the claim there. Check the spelling and the path; editing the file will not create a filed record.`)
      }
      else if (claimEntry || claimedAbsolutes.has(absolute)) errors.push(`${raw} is not a changed file of this repository. No filed record names it, so this claim cannot file it. Check the spelling and the path; editing the file will not create a filed record, and no action on this path helps.`)
      else if (claimable) errors.push(`${raw} is not a changed file of this repository. No filed record names it. Add it to claims instead, with a decision of mine or not-mine, to file it; a claim is the route that files it. Check the spelling and the path; editing the file will not create a filed record.`)
      else errors.push(`${raw} is not a changed file of this repository. No filed record names it, and a claim cannot file it either: the path does not exist and no tracked file names it. Check the spelling and the path; editing the file will not create a filed record, and no action on this path helps.`)
    }
    return absolute
  }
  // One value -> the filed absolute paths it names. Exact values go through the
  // same route as before, so typo wording and symlink canonicalization stay
  // identical. Group values expand over the filed set only (C1): a value naming
  // nothing is refused with its own name rather than silently doing nothing.
  const expandValue = async (raw, claimEntry = false) => {
    const kind = groupKindOf(raw)
    if (kind === 'exact') return { kind, value: raw, paths: [await absoluteFor(raw, claimEntry)] }
    const stem = await groupStem(raw, snapshot.root)
    const paths = [...known].filter(absolute => absolute.startsWith(stem))
    if (!paths.length) {
      // A group claim is skipped by the claim route (stagedAttest files only exact values),
      // but an exact claim of the concrete path would file it. Both branches must name that
      // action: telling the model no action helps, or to add the group to claims, is false.
      const action = 'name the concrete path with an exact value (no trailing * or separator) in claims, with a decision of mine or not-mine; a group value is skipped by the claim route and files nothing. Check the spelling and the path.'
      const next = claimEntry ? `so this grouped claim files nothing; ${action}` : action
      errors.push(`${raw} names no filed changed file of this repository, ${next}`)
    }
    if (claimEntry) for (const absolute of paths) claimedAbsolutes.add(absolute)
    return { kind, value: raw, paths }
  }
  // Expansion, per-argument overlap refusal and the applied sets all iterate the one
  // path-argument descriptor, so a path argument cannot skip any of them. Expansion
  // runs first, in argument order, because an earlier claim entry decides the wording
  // a later entry gets for an unfiled path (see claimedAbsolutes in absoluteFor).
  const expanded = new Map()
  for (const arg of PATH_ARGUMENTS) {
    const values = arg.key === 'claims' ? pathClaimEntries : (Array.isArray(args[arg.key]) ? args[arg.key] : [])
    expanded.set(arg.key, await Promise.all(values.map(raw => arg.parse(raw, expandValue))))
  }
  const plan = { claims: [], reviewed: [], adopted: new Set(), demonstrated: [] }
  for (const arg of PATH_ARGUMENTS) {
    const entries = expanded.get(arg.key)
    // Overlap is checked within each path argument, never across arguments. A group
    // and an exact entry, or two groups, naming one filed path are refused by name
    // and the plan is never returned, so nothing is stored. One value repeated in
    // different arguments is not an overlap.
    const groups = entries.filter(entry => entry.kind !== 'exact')
    const exacts = entries.filter(entry => entry.kind === 'exact')
    const problem = groupExactOverlap(groups, exacts) ?? groupGroupOverlap(groups) ?? exactExactOverlap(exacts)
    if (problem) errors.push(problem)
    arg.apply(plan, entries, error => errors.push(error))
  }
  // The claims apply step replaces the claims array, so the batch claims are added after it. A refusal above throws
  // before this plan is applied, so a batch that named an unresolvable name still writes none of its clearings.
  // One call cannot both set a path's decision explicitly and decide it from a batch: last-write-wins would silently
  // drop the explicit claim (and its review and demonstration obligations), so every shared path is named as
  // ambiguous and the existing errors.length throw keeps the write atomic.
  const explicitAbsolutes = new Set(plan.claims.map(claim => claim.absolute))
  for (const batchClaim of batch.claims) {
    if (explicitAbsolutes.has(batchClaim.absolute)) errors.push(overlapMessage(batchClaim.absolute, 'a before_commit batch', 'a path claim'))
  }
  plan.claims.push(...batch.claims)
  // Adoption of another writer's bytes is explicit and recorded: claiming a
  // credited file mine, or covering it with a review/demonstration, without
  // naming it in adopted_files (or a recorded adoption from an earlier
  // attestation) is refused. `not-mine` needs no adoption.
  const byAbsolute = new Map(snapshot.files.map(file => [file.absolute, file]))
  const unadopted = absolute => {
    const file = byAbsolute.get(absolute)
    if (!file?.writerId) return false
    if (plan.adopted.has(absolute)) return false
    const childEntries = childAdoptionEntries(file, childIds)
    if (!childEntries.length) return !adoptionCovers(file)
    // A child id adopts the named child's entries in this call, in every turn.
    // Earlier recorded adoptions stay, and every provenance entry still needs
    // coverage, so another writer on the same path remains unadopted.
    const covered = new Set([...(file.adoptedFor ?? []), ...childEntries])
    return !(file.provenance ?? []).every(entry => covered.has(entry))
  }
  for (const claim of plan.claims) if (claim.decision === 'mine' && unadopted(claim.absolute)) errors.push(`${claim.absolute} was written by ${byAbsolute.get(claim.absolute).writerId}, so claiming it mine requires ${ADOPTION_ROUTES} to record that adoption.`)
  for (const absolute of plan.reviewed) if (unadopted(absolute)) errors.push(`${absolute} was written by ${byAbsolute.get(absolute).writerId}, so covering it with a review requires ${ADOPTION_ROUTES} to record that adoption.`)
  // docs_checked reviews every documentation file claimed mine, so it needs
  // adoption for a child-written doc exactly like a code review does.
  if (args.docs_checked === true) errors.push(...docsAdoptionErrors(snapshot, plan.claims, unadopted))
  for (const entry of plan.demonstrated) if (unadopted(entry.absolute)) errors.push(`${entry.absolute} was written by ${byAbsolute.get(entry.absolute).writerId}, so covering it with a demonstration requires ${ADOPTION_ROUTES} to record that adoption.`)
  const items = args.items ?? []
  // Item ids resolve against the active catalog first, then the archive. An unreadable archive is reported as a
  // problem for an id the active catalog does not hold, instead of treating a possibly archived item as absent.
  const archiveState = readArchive(snapshot.root)
  const resolvedItems = resolveItems(catalogState.items, archiveState.state === 'readable' ? archiveState.items : [])
  if (items.length && catalogState.state === 'unreadable') errors.push(`The catalog cannot be read: ${catalogState.problem}.`)
  else for (const item of items) {
    if (resolvedItems.has(item.id)) continue
    if (archiveState.state === 'unreadable') errors.push(`The archive at ${archiveState.path} cannot be read: ${archiveState.problem}. ${item.id} is not in the active catalog, so it cannot be checked against the archive.`)
    else errors.push(`${item.id} is not an item in this repository's catalog.`)
  }
  // An unreadable file keeps the same content key whatever its bytes become, so an attestation over it would not reopen
  // when the file changes. Such a file is refused instead.
  for (const file of snapshot.files) {
    if (file.key.startsWith('unreadable:')) errors.push(`${file.absolute} cannot be read (${file.key.slice('unreadable:'.length)}), so nothing is attested. Make it readable, then attest again.`)
  }
  if (errors.length) throw new AttestRefusal(errors)
  return {
    ...plan,
    adoptedChildIds: childIds,
    docsChecked: args.docs_checked === true,
    demonstrated: new Map(plan.demonstrated.map(entry => [entry.absolute, entry.note])),
    // An assumed item with no reason is unreported: it stays in the plan with no state, so applying it clears any earlier state.
    items: items.map(item => (item.state === 'assumed' && !text(item.reason)
      ? { id: item.id, state: null }
      : { id: item.id, state: item.state, ...(item.state === 'assumed' ? { reason: item.reason } : {}) })),
    summary: args.summary,
  }
}

// The obligations of one repository, from its snapshot (an entry of repositories) and its catalog as read from disk (the
// archive too, so a stated item keeps its obligation wherever it lives). Every problem is a sentence the report prints
// as it is. The repository is complete when no problem is left. A catalog item the
// session does not state is history: it obligates nothing and is only counted, for the report's one summary line. A file's
// reviewed state is the one the tracker stored (see reviewedBy), so this reads state instead of deriving it again.
export function evaluateRepository(snapshot, catalogState) {
  const problems = []
  const attestation = snapshot.attestation
  const unclaimed = snapshot.files.filter(file => file.claim === 'unclaimed').map(file => file.absolute)
  if (unclaimed.length) problems.push(`Unclaimed changed files: ${unclaimed.join(', ')}. Claim each as yours, or reject it.`)
  const unadopted = snapshot.files.filter(file => file.claim === 'mine' && file.writerId && !adoptionCovers(file)).map(file => file.absolute)
  if (unadopted.length) problems.push(`Changed files written by another session and not adopted: ${unadopted.join(', ')}. List each in adopted_files or name its writer in adoptedChildIds to record that you adopt it, or reject it.`)
  const unreviewed = snapshot.files.filter(file => file.claim === 'mine' && !file.documentation && !file.reviewed).map(file => file.absolute)
  if (unreviewed.length) problems.push(`Claimed code files not reviewed: ${unreviewed.join(', ')}.`)
  const docsUnchecked = snapshot.files.filter(file => file.documentation && file.claim !== 'not-mine' && !file.reviewed).map(file => file.absolute)
  if (docsUnchecked.length) problems.push(`Changed documentation not checked: ${docsUnchecked.join(', ')}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`)
  const undemonstrated = snapshot.files.filter(file => file.claim === 'mine' && file.reviewed && !file.demonstrated).map(file => file.absolute)
  if (undemonstrated.length) problems.push(`Claimed files reviewed but not demonstrated: ${undemonstrated.join(', ')}. A review is only a reading, so show the change working in the place it serves, then attest with demonstrated_files listing each path with the command it ran and that command's output.`)
  if (catalogState.state === 'unreadable') problems.push(`The catalog cannot be read: ${catalogState.problem}.`)
  // An unreadable archive is a reported problem, never a silent drop of the items it may hold.
  const archiveState = readArchive(snapshot.root)
  if (archiveState.state === 'unreadable') problems.push(`The archive at ${archiveState.path} cannot be read: ${archiveState.problem}.`)
  // A stated item keeps its obligation wherever it lives: the active catalog first, then the archive, duplicates
  // resolved to the newer copy (see resolveItems). The unstated count counts active items only; an archived item is
  // history without a count.
  const resolvedItems = resolveItems(catalogState.items, archiveState.state === 'readable' ? archiveState.items : [])
  const stated = new Map(snapshot.itemStates.map(item => [item.id, item]))
  // An absent item-state entry is unstated history and gets no line. A present entry with a null state is an assumed item
  // with no reason, and this evaluator is the only place that names it as a problem.
  const items = [...resolvedItems.values()].filter(item => stated.has(item.id)).map(item => ({ id: item.id, name: item.name, state: stated.get(item.id).state ?? null, reason: stated.get(item.id).reason, archived: item.archived }))
  const unstatedCount = catalogState.items.length - catalogState.items.filter(item => stated.has(item.id)).length
  for (const item of items) if (item.state === null) problems.push(`${item.id} is marked assumed but has no reason, so it stays unfinished. Attest it again with a reason, or mark it passed once it has run.`)
  // A repository with no changed file and no stated item has nothing to attest, so a missing attestation is no problem.
  if (!attestation && (snapshot.files.length || items.length)) problems.push('No current attestation for this repository.')
  // The same obligations as structured lists of absolute paths, for the advisory message. `problems` is the report's own text.
  return { ...snapshot, catalog: catalogState, items, unstatedCount, unclaimed, unreviewed, docsUnchecked, undemonstrated, problems, complete: problems.length === 0 }
}
