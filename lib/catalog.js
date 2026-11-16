import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitRootOf } from './repositories.js'

const execFileP = promisify(execFile)

// The verification catalog of one repository: the items a session commits to run, each with a comment on what passing it
// proves. The file is knowledge for the next session to read. Nothing in this module runs an item's command.
export const CATALOG_VERSION = 1
const DIRECTORY = '.dsh'
const EXCLUDE_LINE = '.dsh/'
const BOUNDS = { name: 120, proves: 1000, command: 1000 }
const SLUG_MAX = 60
const GIT_TIMEOUT_MS = 5000
const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

// A refusal or a catalog problem. The message names what was wrong, so the caller can show it as it is.
export class CatalogError extends Error {}

export function catalogPathOf(root) { return path.join(root, DIRECTORY, 'verification.json') }

export function archivePathOf(root) { return path.join(root, DIRECTORY, 'verification-archive.json') }

// Reads the catalog of one repository and never throws. A missing file is "absent". A file that cannot be read or parsed is
// "unreadable" and carries its problem. Callers show the problem and never treat an unreadable catalog as an empty one.
export function readCatalog(root) {
  const file = catalogPathOf(root)
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') return { path: file, state: 'absent', items: [], problem: null }
    return { path: file, state: 'unreadable', items: [], problem: `the file cannot be read: ${error?.message || error}` }
  }
  try { return { path: file, state: 'readable', items: parseCatalog(text).items, problem: null } }
  catch (error) { return { path: file, state: 'unreadable', items: [], problem: error.message } }
}

// Reads the archive of one repository and never throws, mirroring readCatalog: a missing file is "absent" and a file that
// cannot be read or parsed is "unreadable" with its problem. The archive uses the same `{version, items}` shape.
export function readArchive(root) {
  const file = archivePathOf(root)
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') return { path: file, state: 'absent', items: [], problem: null }
    return { path: file, state: 'unreadable', items: [], problem: `the file cannot be read: ${error?.message || error}` }
  }
  try { return { path: file, state: 'readable', items: parseCatalog(text).items, problem: null } }
  catch (error) { return { path: file, state: 'unreadable', items: [], problem: error.message } }
}

// True when the item has a parseable updatedAt more than 2 days before `now` (a Date, a millisecond number, or a date
// string; the current time when omitted). Exactly 2 days is not stale, and an unparseable updatedAt is never stale.
export function isStale(item, now) {
  const updated = Date.parse(item?.updatedAt)
  if (Number.isNaN(updated)) return false
  const moment = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : now === undefined ? Date.now() : Date.parse(now)
  if (Number.isNaN(moment)) return false
  return moment - updated > STALE_AFTER_MS
}

function parseCatalog(text) {
  let data
  try { data = JSON.parse(text) }
  catch (error) { throw new CatalogError(`the file is not valid JSON: ${error.message}`) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CatalogError('the top level is not an object')
  if (data.version !== CATALOG_VERSION) throw new CatalogError(`the version is ${JSON.stringify(data.version)}, and this plugin reads version ${CATALOG_VERSION}`)
  if (!Array.isArray(data.items)) throw new CatalogError('items is not an array')
  data.items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CatalogError(`items[${index}] is not an object`)
    for (const key of ['id', 'name', 'proves', 'addedAt', 'updatedAt']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) throw new CatalogError(`items[${index}].${key} is missing or empty`)
    }
    if (item.command !== undefined && typeof item.command !== 'string') throw new CatalogError(`items[${index}].command is not a string`)
  })
  return data
}

// Trims one text field and refuses it when it is required and empty, or longer than its bound. The text is otherwise kept
// as entered, line breaks included; the status report flattens them where it lists an item. Text past its bound is refused.
function textField(value, label, bound, required) {
  if (value === undefined || value === null) {
    if (required) throw new CatalogError(`${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new CatalogError(`${label} must be a string.`)
  const text = value.trim()
  if (!text) {
    if (required) throw new CatalogError(`${label} is required, and it is empty.`)
    return undefined
  }
  if (text.length > bound) throw new CatalogError(`${label} is ${text.length} characters, over the limit of ${bound} characters.`)
  return text
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new CatalogError('items must be a non-empty array of objects with name, proves, and an optional command.')
  return items.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CatalogError(`items[${index}] must be an object.`)
    return {
      name: textField(input.name, `items[${index}].name`, BOUNDS.name, true),
      proves: textField(input.proves, `items[${index}].proves`, BOUNDS.proves, true),
      command: textField(input.command, `items[${index}].command`, BOUNDS.command, false),
    }
  })
}

// The id of a new item: the lowercase name with each run of non-alphanumeric characters as one dash, at most SLUG_MAX
// characters. A name with no ASCII letter or digit gets the id "item".
export function slugOf(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '') || 'item'
}

// The base id with a numeric suffix when the base is taken, so two names that share a slug still get distinct ids.
function uniqueId(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

function serializeCatalog(items) {
  return `${JSON.stringify({ version: CATALOG_VERSION, items }, null, 2)}\n`
}

function writeCatalogFile(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomically(file, serializeCatalog(items))
}

// Two parsed items are the same item when every field matches, whatever the key order the JSON carried.
function sameItem(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

// Writes items into the catalog of one repository root and returns what was written. Input is checked and an unreadable
// catalog is refused before anything is written. The archive pass then runs first, archive-first: duplicates between the
// two files are compared and reconciled, stale items are written to the archive, and only then are they removed from the
// active catalog, so a crash between those writes leaves a duplicate the next pass reconciles rather than a lost item. An
// archive read or write failure, or a failed write during the pass, RETURNS a refusal carrying `archive.problem` (path and
// cause) with no incoming items written, and never throws. The `.dsh/` exclude line is added before the catalog is written,
// so a catalog that exists is never missing its exclude line.
export async function registerItems(root, items) {
  const incoming = normalizeItems(items)
  const file = catalogPathOf(root)
  const archiveFile = archivePathOf(root)
  const current = readCatalog(root)
  if (current.state === 'unreadable') throw new CatalogError(`${file} cannot be used, so register will not overwrite it: ${current.problem}.`)
  const refusal = problem => ({ path: file, items: [], exclusion: { applied: false, reason: problem }, archive: { path: archiveFile, moved: [], problem } })
  const archive = readArchive(root)
  if (archive.state === 'unreadable') return refusal(`${archiveFile} cannot be used, so register will not write to it: ${archive.problem}.`)

  let active = current.items.map(item => ({ ...item }))
  let archived = archive.items.map(item => ({ ...item }))
  const now = Date.now()

  // Reconcile duplicates before any archive write. Every duplicate is compared first, so a conflict anywhere refuses the
  // pass with both files byte-equal to what they were.
  const dropArchive = new Set()
  const dropActive = new Set()
  for (const activeItem of active) {
    const archivedItem = archived.find(item => item.id === activeItem.id)
    if (!archivedItem) continue
    const activeTime = Date.parse(activeItem.updatedAt)
    const archivedTime = Date.parse(archivedItem.updatedAt)
    if (Number.isNaN(activeTime) || Number.isNaN(archivedTime)) {
      return refusal(`${archiveFile} and ${file} both hold item "${activeItem.id}" with an unparseable updatedAt, so register will not write to either file.`)
    }
    if (activeTime > archivedTime) dropArchive.add(activeItem.id)
    else if (archivedTime > activeTime) dropActive.add(activeItem.id)
    else if (sameItem(activeItem, archivedItem)) dropActive.add(activeItem.id)
    else return refusal(`${archiveFile} and ${file} both hold item "${activeItem.id}" with the same updatedAt but different contents, so register will not write to either file.`)
  }

  // Apply the reconciliation, archive first. Each removal touches only the file whose copy the other file already durably
  // holds, so a failure here leaves the duplicate for the next pass to reconcile again.
  if (dropArchive.size) {
    archived = archived.filter(item => !dropArchive.has(item.id))
    try { writeCatalogFile(archiveFile, archived) }
    catch (error) { return refusal(`${archiveFile} could not be written: ${error?.message || error}.`) }
  }
  if (dropActive.size) {
    active = active.filter(item => !dropActive.has(item.id))
    try { writeCatalogFile(file, active) }
    catch (error) { return refusal(`${file} could not be written: ${error?.message || error}.`) }
  }

  // Move the stale items, archive first, then out of the active catalog.
  const stale = active.filter(item => isStale(item, now))
  if (stale.length) {
    for (const item of stale) {
      const index = archived.findIndex(entry => entry.id === item.id)
      if (index === -1) archived.push({ ...item })
      else archived[index] = { ...item }
    }
    try { writeCatalogFile(archiveFile, archived) }
    catch (error) { return refusal(`${archiveFile} could not be written: ${error?.message || error}.`) }
    const staleIds = new Set(stale.map(item => item.id))
    active = active.filter(item => !staleIds.has(item.id))
    try { writeCatalogFile(file, active) }
    catch (error) { return refusal(`${file} could not be written: ${error?.message || error}.`) }
  }

  const stamp = new Date(now).toISOString()
  const next = active.map(item => ({ ...item }))
  // Ids are reserved across both files, so a new name never takes an id the archive already holds.
  const taken = new Set([...next.map(item => item.id), ...archived.map(item => item.id)])
  const written = []
  for (const input of incoming) {
    const existing = next.find(item => item.name === input.name)
    if (existing) {
      existing.proves = input.proves
      if (input.command === undefined) delete existing.command
      else existing.command = input.command
      existing.updatedAt = stamp
      written.push({ id: existing.id, name: existing.name, created: false })
      continue
    }
    const id = uniqueId(slugOf(input.name), taken)
    taken.add(id)
    next.push({ id, name: input.name, proves: input.proves, ...(input.command === undefined ? {} : { command: input.command }), addedAt: stamp, updatedAt: stamp })
    written.push({ id, name: input.name, created: true })
  }
  const exclusion = await excludeCatalog(root)
  try { writeCatalogFile(file, next) }
  catch (error) { return refusal(`${file} could not be written: ${error?.message || error}.`) }
  return { path: file, items: written, exclusion, archive: { path: archiveFile, moved: stale.map(item => item.id), problem: null } }
}

// Adds the `.dsh/` line to the local exclude file of the git repository that holds this root, once. That file is git's
// per-clone ignore list, so the tracked .gitignore is never edited. A root outside every repository gets no line and no
// error. A root inside a work tree is not always the work tree's top: a session working in a subdirectory files its
// outside-repository changes under that directory, and a folder holding an empty `.git` entry inside another repository is
// a root to the scanner. Git resolves the repository that owns the path either way, so the line goes into that
// repository's exclude file and git ignores the catalog there.
export async function excludeCatalog(root) {
  if ((await gitRootOf(root)) === null) return { applied: false, reason: 'the root is not a git repository' }
  let excludeFile
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true })
    excludeFile = stdout.split('\n')[0]
  } catch (error) {
    return { applied: false, reason: `git could not resolve the exclude file: ${String(error?.stderr || error?.message || error).trim()}` }
  }
  if (!excludeFile) return { applied: false, reason: 'git resolved no exclude file for this root' }
  let text = ''
  try { text = fs.readFileSync(excludeFile, 'utf8') }
  catch (error) { if (error?.code !== 'ENOENT') return { applied: false, reason: `the exclude file cannot be read: ${error.message}` } }
  if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return { applied: true, added: false, file: excludeFile }
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`)
  return { applied: true, added: true, file: excludeFile }
}

// Writes a temporary file beside the catalog, then renames it over the catalog, so a failed write never leaves a part-written
// catalog behind.
function writeAtomically(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, text, { flag: 'wx' })
  try { fs.renameSync(temp, file) }
  catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}
