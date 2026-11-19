import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { defaultSettingsPath } from './settings.js'

const execFileP = promisify(execFile)
const GIT_OPTIONS = { timeout: 5000, maxBuffer: 4096, windowsHide: true }

// The git-history facts one before_commit batch needs, owned here because this module owns every process start.
// `paths` are the filed absolute paths. The three lists are disjoint: `before` are paths whose last committed change
// is strictly before the resolved commit, `at` are paths that commit itself last changed, and `uncommitted` are paths
// carrying an uncommitted change. A failure names the repository, the commit input, and the relative path when a git
// read cannot be trusted, and every list is empty on failure. M1 keeps the decision, refusal, and atomicity.
//
// `states`, when supplied, is the entry-independent read shared by a whole batch (see readGitPathStates). A single
// entry calls the three-argument form and reads its own states; a batch reads them once and reuses them for every
// entry, so the per-path status and log never repeat just because another entry was added.
const relativeOf = (root, absolute) => {
  const relative = path.relative(String(root), String(absolute))
  return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : relative
}
const literalGit = root => ['--literal-pathspecs', '-C', String(root)]

// Read the entry-independent git state for one set of filed paths: one history-readable check, then one status and
// one last-commit log per path. Both per-path reads use literal pathspecs, the same convention isTrackedFile uses, so
// a filed name with glob metacharacters never borrows another file's state. A failed read is carried on the state as
// 'status' or 'log' and named with the entry's own before_commit input when gitHistoryFacts consumes it.
export async function readGitPathStates(root, paths) {
  const states = new Map()
  let readable = true
  try { await execFileP('git', ['-C', String(root), 'rev-list', '--max-count=1', 'HEAD'], GIT_OPTIONS) }
  catch { readable = false }
  if (!readable) return { unreadable: true, states }
  for (const absolute of paths) {
    const relative = relativeOf(root, absolute)
    if (relative === null) continue
    let dirty
    try { dirty = (await execFileP('git', [...literalGit(root), 'status', '--porcelain=v1', '--', relative], GIT_OPTIONS)).stdout.trim() !== '' }
    catch { states.set(absolute, { relative, failure: 'status' }); continue }
    if (dirty) { states.set(absolute, { relative, failure: null, dirty: true, last: '' }); continue }
    let last
    try { last = (await execFileP('git', [...literalGit(root), 'log', '-1', '--format=%H', '--', relative], GIT_OPTIONS)).stdout.trim() }
    catch { states.set(absolute, { relative, failure: 'log' }); continue }
    states.set(absolute, { relative, failure: null, dirty: false, last })
  }
  return { unreadable: false, states }
}

// A git read that could not be trusted is named with its relative path, the repository, and the before_commit input
// that needed it. A merge-base rejection with status 1 is the normal "not an ancestor" answer and never reaches here.
function gitFailure(kind, relative, root, name) {
  if (kind === 'status') return `Cannot read the uncommitted state of ${relative} in ${root} for before_commit ${name}, so nothing is attested.`
  if (kind === 'log') return `Cannot read the history of ${relative} in ${root} for before_commit ${name}, so nothing is attested.`
  return `Cannot compare the history of ${relative} with before_commit ${name} in ${root}, so nothing is attested.`
}

export async function gitHistoryFacts(root, name, paths, states = null) {
  const empty = { failure: null, before: [], at: [], uncommitted: [] }
  const shared = states ?? await readGitPathStates(root, paths)
  if (shared.unreadable) return { ...empty, failure: `Cannot read the history of ${root} for before_commit ${name}, so nothing is attested.` }
  let commit
  try { commit = (await execFileP('git', ['-C', String(root), 'rev-parse', '--verify', `${String(name)}^{commit}`], GIT_OPTIONS)).stdout.trim() }
  catch { commit = null }
  if (!commit) return { ...empty, failure: `before_commit ${name} cannot be resolved to a commit in ${root}, so nothing is attested.` }
  const facts = { failure: null, before: [], at: [], uncommitted: [] }
  for (const absolute of paths) {
    const state = shared.states.get(absolute)
    if (!state) continue
    if (state.failure) return { ...empty, failure: gitFailure(state.failure, state.relative, root, name) }
    if (state.dirty) { facts.uncommitted.push(absolute); continue }
    const last = state.last
    if (!last) continue
    if (last === commit) { facts.at.push(absolute); continue }
    try { await execFileP('git', ['-C', String(root), 'merge-base', '--is-ancestor', last, commit], GIT_OPTIONS); facts.before.push(absolute) }
    catch (error) {
      // merge-base exits 1 for the ordinary "not an ancestor" answer, which is the keep signal, not a failure.
      if (Number(error?.code) === 1) continue
      return { ...empty, failure: gitFailure('merge-base', state.relative, root, name) }
    }
  }
  return facts
}

// Turn-scoped changed-file source for the completion gate.
//
// The host's `@deepseek-ai/dsh-workspace-changes` recorder snapshots the working tree
// at turn start and turn end through a private git index and diffs the two trees, so a
// file that was already dirty before the turn is part of the baseline and is NOT
// attributed to the turn, while a file written by any process inside the repository
// during the turn (including a shell command) IS. The gate reads that record instead of
// running its own `git status`, which could not separate pre-existing dirt from a session edit.
//
// The record is keyed by the sequence number of the `workspace/changes` Session event,
// never by the turn number, so the tracker keeps the highest sequence seen per turn.

const DOCUMENTATION_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.mdx', '.rst', '.txt', '.text', '.adoc', '.asciidoc', '.org', '.log', '.csv', '.tsv',
])
const DOCUMENTATION_BASENAMES = Object.freeze([
  'license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'codeowners',
])

export function isDocumentationPath(file) {
  const base = path.basename(String(file ?? ''))
  if (!base) return false
  if (DOCUMENTATION_EXTENSIONS.includes(path.extname(base).toLowerCase())) return true
  return path.extname(base) === '' && DOCUMENTATION_BASENAMES.includes(base.toLowerCase())
}

// Attestation identity and evidence freshness bind to what the turn changed: the listed files and
// each file's current contents (see contentKey). The record's sequence number is not part of the
// identity, so a later stop that re-records the same change set keeps a valid pass, while a real
// edit invalidates it. Touching a file without changing its bytes does not.
export function changeDigest(sessionId, turn, seq, files) {
  const hash = crypto.createHash('sha256')
  hash.update(String(sessionId ?? ''))
  hash.update(String(turn ?? ''))
  hash.update(String(seq ?? 'none'))
  for (const file of Array.isArray(files) ? [...files].map(String).sort() : []) hash.update(`\u0000${file}`)
  return hash.digest('hex')
}

// The HEAD commit of the nested repository or submodule at `absolute`. `head` is null when that directory is
// not its own repository root. `failed` is true when git could not read a HEAD: a timeout, git missing, or a
// HEAD that does not resolve, an unborn branch included. One git call.
async function nestedHead(absolute) {
  let stdout
  try {
    ({ stdout } = await execFileP('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: absolute, timeout: 5000, maxBuffer: 4096, windowsHide: true }))
  } catch {
    return { head: null, failed: true }
  }
  // git prints the top-level path, then the HEAD commit, one per line. A commit never contains a newline, but a
  // path may, so the commit is the last line and the path is everything before it. `rev-parse` has no NUL-separated
  // form, so the path is never split on newline.
  const text = String(stdout).replace(/\n$/, '')
  const cut = text.lastIndexOf('\n')
  const toplevel = cut < 0 ? '' : text.slice(0, cut)
  const head = text.slice(cut + 1).trim()
  if (!toplevel || !head) return { head: null, failed: true }
  try { return { head: path.resolve(toplevel) === fs.realpathSync(absolute) ? head.trim() : null, failed: false } }
  catch { return { head: null, failed: true } }
}

// The current content of one changed file, for the evidence identity. A regular file contributes a
// SHA-256 of its bytes. A deletion contributes a fixed marker, and so does a special file, which is
// never read because reading a FIFO can block. A symbolic link contributes its target text and is not
// followed. A directory is a nested repository or submodule (a moved pointer), so it contributes its
// child repository's HEAD: one git call per directory entry. A directory that is not its own repository
// root keeps the fixed `directory` marker. If the child's HEAD cannot be read, the last HEAD read for that
// path (in `nested.heads`) stands in, so the failed read does not change the identity. A path with no earlier
// read has no identity yet: it takes a placeholder, and is added to `nested.unresolved`. Every failed path is
// added to `nested.unreadable` for the caller to block on. `base` is the directory the recorder reports
// the path against.
export async function contentKey(base, file, nested = { heads: new Map(), unreadable: [], unresolved: [] }) {
  if (!base) return 'unresolved'
  const absolute = path.resolve(String(base), String(file ?? ''))
  let stat
  try { stat = await fs.promises.lstat(absolute) }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : `unreadable:${error?.code ?? 'error'}` }
  if (stat.isSymbolicLink()) {
    try { return `link:${await fs.promises.readlink(absolute)}` }
    catch (error) { return `unreadable:${error?.code ?? 'error'}` }
  }
  if (stat.isDirectory()) {
    const found = await nestedHead(absolute)
    if (found.failed) {
      // A failed read must not replace the identity this path already had: the last HEAD read for it stands in.
      nested.unreadable.push(String(file))
      const last = nested.heads.get(absolute)
      if (last) return `head:${last}`
      nested.unresolved.push(String(file))
      return 'unreadable-nested'
    }
    if (!found.head) return 'directory'
    nested.heads.set(absolute, found.head)
    return `head:${found.head}`
  }
  if (!stat.isFile()) return 'special'
  const hash = crypto.createHash('sha256')
  try { for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk) }
  catch (error) { return `unreadable:${error?.code ?? 'error'}` }
  return `file:${hash.digest('hex')}`
}

// Whether `absolute` names a file the repository at `root` tracks. A tracked file stays tracked after its bytes are
// deleted, so this admits a shell deletion while a typo name, which git never tracked, stays refused. The lookup is
// literal (`--literal-pathspecs`), so glob metacharacters in the path never match a tracked file by pattern. A file
// counts as tracked when git knows it in the index or at HEAD: a staged deletion (`git rm`) removes the index entry,
// so the index alone would refuse it. Any git failure (not a repository, git missing, unreadable) reads as not
// tracked, so the claim keeps the refusal it had.
export async function isTrackedFile(absolute, root) {
  const relative = path.relative(String(root), String(absolute))
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false
  const git = ['--literal-pathspecs', '-C', String(root)]
  const options = { timeout: 5000, maxBuffer: 4096, windowsHide: true }
  try {
    await execFileP('git', [...git, 'ls-files', '--error-unmatch', '--', relative], options)
    return true
  } catch {}
  try {
    const { stdout } = await execFileP('git', [...git, 'ls-tree', '-z', 'HEAD', '--', relative], options)
    // Each entry is `<mode> <type> <sha>\t<name>`; the path is tracked at HEAD only on an exact name
    // match. The name starts after the FIRST tab, so a tab inside the name stays part of it.
    return String(stdout).split('\0').some(entry => entry.slice(entry.indexOf('\t') + 1) === relative)
  } catch { return false }
}

// A non-blank string, or undefined.
const text = value => typeof value === 'string' && value.trim() !== '' ? value : undefined

// The path a first-party file-tool call is about to mutate: `write`, `edit`, and the editor's mutating commands, under
// the host recorder's own predicates (packages/deliverables/workspace-changes/src/capture.ts, mutationPath). Other
// tools, reads, and incomplete arguments yield undefined. `args` is the parsed call arguments.
export function mutationPath(name, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  switch (name) {
    case 'write': return typeof args.content === 'string' ? text(args.file_path) : undefined
    case 'edit': return typeof args.old_string === 'string' && typeof args.new_string === 'string' ? text(args.file_path) : undefined
    case 'str_replace_editor': return args.command === 'create' || args.command === 'str_replace' || args.command === 'insert' ? text(args.path) : undefined
    default: return undefined
  }
}

// A `tool/call` event carries its arguments as a raw JSON string, never as an object. A string that does not parse
// yields no arguments, so the call names no path.
function parsedArguments(raw) {
  if (typeof raw !== 'string') return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

// The canonical spelling of an absolute path, copied from the host recorder's `canonicalPath` (workspace-changes
// paths.ts): realpath the longest existing ancestor and append the missing suffix. A file created through a directory
// symlink therefore has the same spelling before and after it exists, which is the spelling the recorder lists it under.
async function canonicalPath(absolute) {
  const missing = []
  let head = absolute
  for (;;) {
    try { return path.join(await fs.promises.realpath(head), ...missing) }
    catch {
      // A missing or unreadable component is kept lexically under its nearest resolvable ancestor.
      const parent = path.dirname(head)
      if (parent === head || path.dirname(parent) === parent) return absolute
      missing.unshift(path.basename(head))
      head = parent
    }
  }
}

// Whether a session header marks a delegated (subagent) writer: the host stamps
// both `origin: 'subagent'` and `delegationDepth` on a dispatched child (see the
// subagent child's session metadata). A forked session also carries
// `parentSession`, but with neither marker, and it is not dispatched work.
function delegatedOf(header) {
  return header?.origin === 'subagent' || Number(header?.delegationDepth ?? 0) > 0
}

export class ChangeTracker {
  constructor(creditedDir = null) {
    this.sessions = new Map()
    // Claim ownership (which session delegated to which), learned from the session
    // header carried by every session/event. A session's own header is immutable, so
    // the first sight of a session fixes its claim.
    this.lineage = new Map()
    // Lineage entries restored from a retained-marker snapshot, not from a
    // live session header. A live header overwrites them; until it arrives
    // they still let a restarted tracker walk the chain.
    this.snapshotLineage = new Set()
    // Credited operations of dispatched writers: writer session id -> turn -> raw named
    // paths. Raw, because canonical resolution happens when the top parent files them.
    this.childOps = new Map()
    // Durable retained record for credited operations, one file per writer, so a host
    // restart cannot erase the child record silently. `loaded` bounds the startup scan
    // to once per tracker; `retentionLosses` names failed writes and corrupt markers.
    this.creditedDir = creditedDir ?? path.join(path.dirname(defaultSettingsPath()), 'completion-gate-credited')
    this.retention = { loaded: false, losses: [] }
  }

  entry(sessionId, create = false) {
    const id = String(sessionId ?? '')
    if (!id) return null
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { turns: new Map(), fileToolPaths: new Map(), lastTurn: 0, endedTurn: 0 })
    return entry ?? null
  }

  observe(session, event) {
    const id = String(session?.id ?? '')
    const type = event?.type
    if (!id || (type !== 'workspace/changes' && type !== 'turn/start' && type !== 'turn/end' && type !== 'tool/call')) return
    this.learnLineage(session)
    const turn = Number(event?.data?.turn)
    if (!Number.isInteger(turn)) return
    const entry = this.entry(id, true)
    // The host appends `turn/end` after the stop hook and after any steered continuation, so it is
    // the only event that closes a turn. Turns are numbered in order, so one end covers the earlier ones.
    if (type === 'turn/end') {
      if (turn > entry.endedTurn) entry.endedTurn = turn
      if (this.lineage.get(id)?.delegated) this.persistRetained(id)
      return
    }
    if (type === 'tool/call') {
      this.observeToolCall(entry, turn, event?.data)
      this.observeCredited(id, turn, event?.data)
      return
    }
    if (turn > entry.lastTurn) entry.lastTurn = turn
    if (type !== 'workspace/changes') return
    const seq = Number(event?.seq)
    if (!Number.isInteger(seq)) return
    const previous = entry.turns.get(turn)
    if (previous === undefined || seq > previous) entry.turns.set(turn, seq)
  }

  // Record one session's claim on its direct parent from the header the event
  // carries. The header is the dispatch chain: a child names its parent session,
  // and that parent's own header names the grandparent, so a walk to the top
  // follows the whole chain. Sessions without a header read as top-level roots.
  learnLineage(session) {
    const id = String(session?.id ?? '')
    if (!id) return
    const header = session?.header
    const existing = this.lineage.get(id)
    // A live header is authoritative over a marker snapshot placeholder, so a
    // late-arriving ancestor header replaces the snapshot entry (and the
    // persist loop below then completes its descendants' markers). A header
    // with no lineage signal never overwrites the snapshot entry.
    const carriesLineage = Boolean(header) && (typeof header.parentSession === 'string' || header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0 || typeof header.cwd === 'string')
    if (existing && !(this.snapshotLineage.has(id) && carriesLineage)) return
    this.snapshotLineage.delete(id)
    this.lineage.set(id, {
      parentId: typeof header?.parentSession === 'string' ? header.parentSession : null,
      cwd: typeof header?.cwd === 'string' ? header.cwd : '',
      delegated: delegatedOf(header),
    })
    // A late-arriving ancestor header can complete a descendant's chain after
    // the descendant already wrote: its retained marker still snapshots the
    // incomplete chain. Re-persist every writer whose chain now reaches a top,
    // so a restart recovers the completed chain from the marker.
    for (const writerId of this.childOps.keys()) {
      if (this.chainOf(writerId).top !== null) this.persistRetained(writerId)
    }
  }

  // A delegated writer's named write/edit path is a credited operation: it files
  // under the top parent once the writer's own turn has ended (see creditedPaths),
  // whether or not any recorder entry ever names it. The path is stored raw and is
  // resolved when filed, against the writer's working directory. Only a delegated
  // writer (a dispatched descendant) is credited; a stranger never is.
  observeCredited(writerId, turn, data) {
    if (!this.lineage.get(writerId)?.delegated) return
    const file = mutationPath(data?.name, parsedArguments(data?.arguments))
    if (file === undefined) return
    let byTurn = this.childOps.get(writerId)
    if (!byTurn) this.childOps.set(writerId, byTurn = new Map())
    let paths = byTurn.get(turn)
    if (!paths) byTurn.set(turn, paths = new Set())
    paths.add(file)
    this.persistRetained(writerId)
  }

  // The known chain from a writer to the top: the writer, its direct parent, and
  // so on while every link is a delegated step. `top` is the first ancestor that
  // is not delegated, or null while a link is missing, so a writer whose chain
  // cannot be walked resolves no top and files nothing.
  chainOf(writerId) {
    const chain = [writerId]
    const seen = new Set(chain)
    let current = writerId
    while (this.lineage.get(current)?.delegated) {
      const parentId = this.lineage.get(current)?.parentId
      if (!parentId || seen.has(parentId)) return { chain, top: null }
      seen.add(parentId)
      chain.push(parentId)
      current = parentId
      if (!this.lineage.has(current)) return { chain, top: null }
    }
    return { chain, top: this.lineage.has(current) ? current : null }
  }

  // The credited operations whose whole chain reaches `topId`: every ended writer
  // turn's named paths, canonicalized against the writer's working directory.
  // Returns the operations, whether any writer's chain is incomplete (unknown
  // coverage), and any retained-record problems. Unknown is named, never clean:
  // an orphaned writer cannot file, and filing must not claim the set is complete.
  async creditedPaths(topId, fallback) {
    const ops = []
    let unknown = false
    for (const writerId of [...this.childOps.keys()].sort()) {
      const { top } = this.chainOf(writerId)
      if (top === null) { unknown = true; continue }
      if (top !== String(topId)) continue
      const byTurn = this.childOps.get(writerId)
      const base = this.lineage.get(writerId)?.cwd || String(fallback ?? '')
      for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
        if (!this.hasEnded(writerId, turn)) continue
        const canonicalBase = await canonicalPath(path.isAbsolute(base) ? base : path.resolve(base))
        for (const raw of [...byTurn.get(turn)].sort()) {
          const absolute = await canonicalPath(path.resolve(canonicalBase, raw))
          // One operation per (writer, turn, path): successive writers and
          // successive turns on one path each keep their provenance, so the
          // filing and the disposal coverage see every exact operation.
          ops.push({ writerId, turn, absolute })
        }
      }
    }
    return { ops, unknown, retention: this.retentionProblems() }
  }

  // Retained-record problems, as report notice text: a failed write or an
  // unreadable marker. The status names each one with unknown coverage (see
  // creditedPaths), because the durable copy could not be trusted.
  retentionProblems() {
    return this.retention.losses.map(loss => `Retained credited-operation record ${loss}, so coverage is unknown for dispatched writes.`)
  }

  // Whether one writer has a credited turn that has not ended yet.
  hasUnendedTurn(writerId) {
    const byTurn = this.childOps.get(writerId)
    if (!byTurn) return false
    for (const turn of byTurn.keys()) {
      if (byTurn.get(turn).size && !this.hasEnded(writerId, turn)) return true
    }
    return false
  }

  // Whether any dispatched writer credited to `topId` has a still-open turn.
  hasUnendedCredited(topId) {
    for (const writerId of this.childOps.keys()) {
      if (this.chainOf(writerId).top === String(topId) && this.hasUnendedTurn(writerId)) return true
    }
    return false
  }

  // Name a preserved corrupt marker (see preserveCorruptMarker) as a loss on
  // the startup scan, so the unknown coverage survives the restart that
  // created it instead of living only in the first process's memory.
  notePreservedCorrupt(file) {
    if (this.retention.losses.some(loss => loss.includes(file))) return
    this.retention.losses.push(`${file} is a preserved corrupt marker whose operations were lost`)
  }

  // Write one writer's durable retained marker. The marker carries the writer's
  // operations, its direct parent link, and the chain known at write time, so a
  // restarted tracker can walk the same claim. A failed write is recorded as a
  // loss rather than thrown: event observers must not break the session.
  persistRetained(writerId) {
    try {
      // Merge this writer's durable record first: after a restart the in-memory
      // state is empty, so writing before the merge would overwrite a retained
      // marker with only what this process has seen since. The merge is per
      // writer and does not mark the full load done, so the later full scan
      // still reports a marker that became unreadable in the meantime.
      this.mergeRetainedWriter(writerId)
      const info = this.lineage.get(writerId)
      if (!info?.delegated) return
      const resolved = this.chainOf(writerId)
      const byTurn = this.childOps.get(writerId)
      const payload = JSON.stringify({
        version: 1,
        writerId,
        parentId: info.parentId,
        cwd: info.cwd,
        chain: resolved.chain,
        complete: resolved.top !== null,
        turns: [...(byTurn?.entries() ?? [])].map(([turn, paths]) => ({ turn, ended: this.hasEnded(writerId, turn), paths: [...paths].sort() })),
      }, null, 2) + '\n'
      fs.mkdirSync(this.creditedDir, { recursive: true })
      const file = path.join(this.creditedDir, markerName(writerId))
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temp, file)
    } catch (error) {
      try { if (error?.file) fs.unlinkSync(error.file) } catch {}
      this.retention.losses.push(`${writerId}: ${String(error?.message || error)}`)
    }
  }

  // Merge one writer's durable record before that writer is written again, so
  // a resumed writer keeps its earlier paths. A corrupt marker is renamed
  // aside with its bytes intact (see preserveCorruptMarker) before the new
  // record overwrites its name: overwriting it silently would erase the only
  // copy of a torn or damaged record, and the loss is named with unknown
  // coverage instead of vanishing.
  mergeRetainedWriter(writerId) {
    const file = path.join(this.creditedDir, markerName(writerId))
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.noteRetentionLoss(writerId, file, error)
      return
    }
    let data
    try {
      data = JSON.parse(raw)
      if (!data || typeof data !== 'object' || data.version !== 1 || data.writerId !== writerId || !Array.isArray(data.turns)) throw new Error('not a credited-operation marker')
    } catch (error) {
      this.preserveCorruptMarker(writerId, file, error)
      return
    }
    // Only the writer's own operations merge here: the chain links wait for
    // live headers (or the full load), so this writer's just-written marker
    // cannot plant a placeholder ancestor that blocks a live header.
    this.mergeRetainedMarker(data, false)
  }

  // Record one retention loss, without repeating an entry that already names
  // the same marker file.
  noteRetentionLoss(writerId, file, error) {
    if (this.retention.losses.some(loss => loss.includes(file))) return
    this.retention.losses.push(`${writerId}: ${String(error?.message || error)}`)
  }

  // Rename a corrupt marker aside so its bytes survive the overwrite that
  // follows, and name the loss. The preserved name never matches the marker
  // scan (no `.json` suffix), so the full load does not read it again. A
  // rename failure leaves the marker in place and is itself named as a loss.
  preserveCorruptMarker(writerId, file, error) {
    const preserved = `${file}.corrupt-${process.pid}-${Date.now()}`
    try {
      fs.renameSync(file, preserved)
      this.noteRetentionLoss(writerId, file, new Error(`${file} cannot be read (${String(error?.message || error)}), so its bytes are preserved at ${preserved}`))
    } catch (renameError) {
      this.noteRetentionLoss(writerId, file, new Error(`${String(error?.message || error)}; preserving ${file} failed: ${String(renameError?.message || renameError)}`))
    }
  }

  // Merge one readable marker into the in-memory credited operations and
  // lineage. Live knowledge wins over the marker snapshot.
  mergeRetainedMarker(data, restoreChain = true) {
    const writerId = data.writerId
    if (!this.lineage.has(writerId)) {
      this.lineage.set(writerId, { parentId: typeof data.parentId === 'string' ? data.parentId : null, cwd: typeof data.cwd === 'string' ? data.cwd : '', delegated: true })
      this.snapshotLineage.add(writerId)
    }
    if (restoreChain) this.restoreChainLinks(data)
    this.mergeSavedTurns(writerId, data.turns)
  }

  // Restore the chain links a marker snapshot carries. A complete snapshot ends
  // at the top (not delegated); an incomplete one ends at the last known step,
  // which is still delegated with its own parent unknown. Live knowledge wins.
  restoreChainLinks(data) {
    const writerId = data.writerId
    const chain = Array.isArray(data.chain) && data.chain.length ? data.chain.map(String) : [writerId, ...(typeof data.parentId === 'string' ? [data.parentId] : [])]
    const complete = data.complete === true
    for (let index = 0; index < chain.length; index += 1) {
      const id = chain[index]
      if (this.lineage.has(id) && id !== writerId) continue
      this.lineage.set(id, {
        parentId: chain[index + 1] ?? null,
        cwd: typeof data.cwd === 'string' ? data.cwd : '',
        delegated: complete ? index < chain.length - 1 : true,
      })
      this.snapshotLineage.add(id)
    }
  }

  // Union one marker's saved turns into the writer's in-memory operations.
  mergeSavedTurns(writerId, turns) {
    const entry = this.entry(writerId, true)
    let byTurn = this.childOps.get(writerId)
    if (!byTurn) this.childOps.set(writerId, byTurn = new Map())
    for (const saved of turns) {
      const turn = Number(saved?.turn)
      if (!Number.isInteger(turn)) continue
      if (saved.ended === true && turn > entry.endedTurn) entry.endedTurn = turn
      let paths = byTurn.get(turn)
      if (!paths) byTurn.set(turn, paths = new Set())
      for (const raw of Array.isArray(saved.paths) ? saved.paths : []) if (typeof raw === 'string' && raw) paths.add(raw)
    }
  }

  // Recover retained markers once per tracker: merge every readable marker into
  // the in-memory credited operations and lineage, and name each unreadable one.
  loadRetained() {
    if (this.retention.loaded) return
    this.retention.loaded = true
    let names
    try {
      names = fs.readdirSync(this.creditedDir).sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return
      this.retention.losses.push(`directory ${this.creditedDir}: ${String(error?.message || error)}`)
      return
    }
    for (const name of names) {
      const file = path.join(this.creditedDir, name)
      if (name.startsWith('completion-gate-credited-') && name.includes('.json.corrupt-')) { this.notePreservedCorrupt(file); continue }
      if (!name.startsWith('completion-gate-credited-') || !name.endsWith('.json')) continue
      let data
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!data || typeof data !== 'object' || data.version !== 1 || typeof data.writerId !== 'string' || !Array.isArray(data.turns)) {
          throw new Error('not a credited-operation marker')
        }
      } catch (error) {
        this.retention.losses.push(`${file} cannot be read (${String(error?.message || error)})`)
        continue
      }
      this.mergeRetainedMarker(data)
    }
  }

  // The path a `tool/call` names is stored raw, under the call's own turn: it is the model-facing path, and resolving it
  // happens when the turn is read (see fileToolPaths), against the base the recorder reports its paths from.
  observeToolCall(entry, turn, data) {
    const file = mutationPath(data?.name, parsedArguments(data?.arguments))
    if (file === undefined) return
    let paths = entry.fileToolPaths.get(turn)
    if (!paths) entry.fileToolPaths.set(turn, paths = new Set())
    paths.add(file)
  }

  seqFor(sessionId, turn) { return this.entry(sessionId)?.turns.get(Number(turn)) }

  // The turn's file-tool paths as absolute paths the recorder can be compared against: each raw path resolved against
  // `base` (the turn's record base, or the session working directory), canonicalized like the host does it. The base is
  // canonicalized first, because the host resolves its working directory before it applies the path: realpath follows a
  // directory symlink before `..`, while resolving the raw base lexically would name the link's parent instead of the
  // parent of its target. Sorted, without duplicates. A turn that stored none returns an empty list.
  async fileToolPaths(sessionId, turn, base) {
    const paths = this.entry(sessionId)?.fileToolPaths.get(Number(turn))
    if (!paths || paths.size === 0) return []
    const raw = String(base ?? '')
    const canonicalBase = await canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(raw))
    const resolved = new Set()
    for (const file of paths) resolved.add(await canonicalPath(path.resolve(canonicalBase, file)))
    return [...resolved].sort()
  }

  lastTurn(sessionId) { return this.entry(sessionId)?.lastTurn ?? 0 }
  hasEnded(sessionId, turn) { return Number(turn) <= (this.entry(sessionId)?.endedTurn ?? 0) }

  // Disposal forgets one session's own recorder turns. A disposed delegated
  // writer keeps its credited operations, its turn ends, and its claim link:
  // the child record survives until the top parent is done with it. A disposed
  // top parent drops the in-memory operations credited to it only when the
  // parent's attestation covers them (`attested: true`, decided by the caller
  // after a refresh; see the session/disposed listener in lib/index.js). A
  // writer with a still-open turn is retained even then, because the open
  // turn never reaches the attestation comparison (see creditedPaths).
  // Without that proof the operations stay in memory as well as on disk: the
  // retained markers alone cannot serve a same-process report, because the
  // startup scan has already run (`retention.loaded`), so dropping the
  // in-memory copy would lose the unattested writes silently.
  forget(sessionId, { attested = false } = {}) {
    const id = String(sessionId ?? '')
    if (!id) return
    const entry = this.entry(id)
    if (entry) { entry.turns.clear(); entry.fileToolPaths.clear(); entry.lastTurn = 0 }
    if (this.lineage.get(id)?.delegated || !attested) return
    for (const writerId of [...this.childOps.keys()]) {
      if (this.chainOf(writerId).top !== id) continue
      if (this.hasUnendedTurn(writerId)) continue
      this.childOps.delete(writerId)
      try { fs.unlinkSync(path.join(this.creditedDir, markerName(writerId))) } catch {}
    }
  }
}

function markerName(writerId) {
  return `completion-gate-credited-${String(writerId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

// Resolve the changed files for one turn. Two outcomes:
//   determined true  -> the host summary was read, or the host announced none for this turn
//   determined false -> the source cannot be trusted (absent service, failed read, or a session
//                       the recorder never covers), so the gate says so rather than assuming the
//                       workspace did not change
//
// Announcing no summary is the recorder's normal silence for a turn that changed nothing:
// it skips the event when its changed-file list is empty. Measured on this host, turns that
// ran dozens of tool calls and changed nothing announced no event at all, so a missing
// record is not evidence of a broken source and must not block on its own.
//
// `recorded` says whether the recorder covers this session at all. It excludes subagent
// sessions entirely (its `eligible()` refuses origin `subagent` or delegationDepth > 0), and it
// also never records a working directory outside a git repository's snapshots. For such a
// session "no announcement" means the source is blind, not that the turn changed nothing, so the
// caller passes recorded=false and the gate reports the change set as undetermined.
//
// `inTurn` says the turn is still open: the call runs before its stop, or the host has not appended
// its `turn/end` yet. Then a missing record means the recorder has not written one yet, so nothing is
// known about this turn's changes: the set is undetermined. Once the turn has ended, a missing record
// means the turn changed nothing, which is what a stop-time call reads too.
export function readTurnChanges({ service, tracker, sessionId, turn, recorded = true, inTurn = false }) {
  if (!service || typeof service.summary !== 'function') {
    return {
      determined: false, files: [], seq: null, turn,
      reason: 'The host change recorder (workspaceChanges) is not available, so the files this turn changed cannot be determined.',
    }
  }
  const seq = tracker.seqFor(sessionId, turn)
  if (seq === undefined) {
    if (!recorded) {
      return {
        determined: false, files: [], seq: null, turn,
        reason: `The host change recorder does not record this session, so the files turn ${turn} changed cannot be determined.`,
      }
    }
    if (inTurn) {
      return {
        determined: false, files: [], seq: null, turn,
        reason: `The host change record for turn ${turn} has not been written yet, so the files this turn has changed cannot be determined until the turn stops.`,
      }
    }
    return { determined: true, files: [], seq: null, turn }
  }
  let summary
  try { summary = service.summary(sessionId, seq) }
  catch (error) {
    return {
      determined: false, files: [], seq, turn,
      reason: `Reading the host change record for turn ${turn} failed: ${String(error?.message || error)}.`,
    }
  }
  if (!summary) {
    return {
      determined: false, files: [], seq, turn,
      reason: `The host change record for turn ${turn} (sequence ${seq}) is no longer available, so the files this turn changed cannot be determined.`,
    }
  }
  // The recorder reports each path relative to the directory it recorded in, which is `base`.
  const base = typeof summary.cwd === 'string' ? summary.cwd : ''
  const files = (Array.isArray(summary.files) ? summary.files : []).map(file => String(file?.path ?? '')).filter(Boolean)
  // The recorder caps the list it carries but reports the complete count in `total`. When those
  // disagree, files this turn changed are absent from the record, so it cannot be treated as a
  // complete inventory: the gate must say the set is truncated rather than attest around the gap.
  const total = Number.isInteger(summary.total) ? summary.total : files.length
  if (total > files.length) {
    return {
      determined: false, files, seq, turn, total, truncated: true, base,
      reason: `This turn changed ${total} files and the host change record carries only ${files.length} of them, so the complete set of changed files cannot be determined.`,
    }
  }
  return { determined: true, files, seq, turn, total, base }
}
