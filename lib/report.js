import path from 'node:path'

// The Repositories section of the status action. It renders the repository report it is given and reads no file
// and runs no command, so status stays a read of state the gate already holds.
export function repositoriesMarkdown({ turn, notices = [], repositories = [] } = {}) {
  const lines = ['## Repositories', '']
  if (turn !== undefined && turn !== null) lines.push(`Turn: ${turn}`)
  for (const notice of notices) lines.push(`Notice: ${notice}`)
  // The filed set is always qualified, because a record loss the gate cannot detect may be present even when every
  // observable record reads clean. This is a plain notice, not a warning: the ordinary no-work case carries it too.
  lines.push('Notice: A record loss the gate cannot detect may be present, so nothing here proves coverage is complete.')
  if (!repositories.length) {
    lines.push('No changed file is attributed to a repository in this session yet.')
    return lines.join('\n')
  }
  for (const repo of repositories) {
    lines.push('', `### ${repo.label}`, `Root: ${repo.root}`, `Catalog: ${repo.catalogPath}`)
    // The summary comes before the catalog section, so a reader learns that the unstated items are history without
    // passing the section first. The section names where to read to adopt, instead of listing the items.
    if (repo.unstatedCount > 0) lines.push(unstatedLine(repo.unstatedCount))
    lines.push(...catalogLines(repo.catalog, repo.catalogPath))
    for (const file of repo.files) lines.push(`- ${file.absolute} (${file.claim}, ${stateText(file)})`)
    for (const item of repo.items) lines.push(`- ${item.id}: ${oneLine(item.name)} | ${itemStateText(item)}`)
    lines.push(`Attestation: ${repo.stale ? 'stale' : repo.attestation ? 'current' : 'missing'}`, `Status: ${repo.complete ? 'complete' : 'unfinished'}`, 'Problems:')
    if (repo.problems.length) for (const problem of repo.problems) lines.push(`- ${oneLine(problem)}`)
    else lines.push('- none')
  }
  return lines.join('\n')
}

// One changed file's two evidence states. A review is a reading; a demonstration is a run in which the change did what it
// claims, so "reviewed and demonstrated" is the strongest state a file reaches. A demonstrated file prints what the run
// showed, and a rejected file prints only its claim, because no obligation is left with it.
function stateText(file) {
  if (file.claim === 'not-mine') return 'rejected, so no review or demonstration is owed'
  if (file.reviewed && file.demonstrated) return `reviewed and demonstrated: ${oneLine(file.demonstrated)}`
  return file.reviewed ? 'reviewed, not demonstrated' : 'unreviewed'
}

// The state of one catalog item the session stated, as the report prints it: passed, assumed with the reason the model
// gave, unrelated to this session, or a stated entry with no state (an assumed item with no reason). A stated archived
// item is reported under its archived state, so the state carries an `(archived)` tag.
function itemStateText(item) {
  let base
  if (item.state === 'passed') base = 'passed'
  else if (item.state === 'assumed') base = `assumed, not run: ${oneLine(item.reason)}`
  else if (item.state === 'unrelated') base = 'unrelated to this session'
  else base = 'not stated'
  return item.archived ? `${base} (archived)` : base
}

// One line of report text. A line break or other control character becomes a space, so the text cannot start a line of
// the report of its own. The catalog keeps its text as entered; only the report and the panel flatten it, and the panel
// imports this one function so the two always render a note the same way.
export function oneLine(text) { return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ') }

// The one line that carries the catalog items this session never stated. They are history: the session owes nothing for
// them unless it adopts one, and the catalog path below says where to read to adopt one.
function unstatedLine(count) { return `Unstated catalog items: ${count} (history; no action required unless adopted).` }

// The archive path, derived from the catalog path: both live in the repository's `.dsh/` directory, so the report
// computes it here instead of needing a new input threaded through the caller.
function archivePathOf(catalogPath) {
  if (!catalogPath) return null
  return path.join(path.dirname(catalogPath), 'verification-archive.json')
}

// The catalog lines of one repository: where to read to adopt, plus the active count. No item is listed here, so no
// unstated item's name, proves, or command text can reach the report; items the session stated keep their own lines
// elsewhere in the report. An unreadable catalog is named with its problem and counts nothing, because a count of
// zero would read as a repository with nothing to verify.
function catalogLines(catalog, catalogPath) {
  const resolvedPath = catalogPath ?? catalog?.path ?? null
  const archivePath = archivePathOf(resolvedPath)
  const pathLines = []
  if (resolvedPath) pathLines.push(`Catalog path: ${oneLine(resolvedPath)}`)
  if (archivePath) pathLines.push(`Archive path: ${oneLine(archivePath)}`)
  if (catalog.state === 'absent') return [...pathLines, 'Active catalog items: 0', 'No catalog exists yet. Register the verification items this repository needs with the register action.']
  if (catalog.state === 'unreadable') return [...pathLines, `Catalog unreadable, so its items are not listed: ${oneLine(catalog.problem)}. Register will not overwrite it.`]
  if (!catalog.items.length) return [...pathLines, 'Active catalog items: 0', 'Catalog readable, with no items yet.']
  return [...pathLines, `Active catalog items: ${catalog.items.length}`]
}

// The result of the register action: where the catalog was written, where the archive lives, which items it now
// holds, and whether git will ignore it. When the register was refused by an archive problem, the markdown names the
// archive path and the problem and lists no items, so it carries no success indication.
export function registerMarkdown(result) {
  const archive = result.archive ?? {}
  const archivePath = archive.path ?? archivePathOf(result.path)
  const lines = ['# Completion Gate register', '', `Catalog: ${result.path}`]
  if (archivePath) lines.push(`Archive: ${oneLine(archivePath)}`)
  if (archive.problem) {
    lines.push(`Archive problem: ${oneLine(archive.problem)}`)
    return lines.join('\n')
  }
  for (const item of result.items ?? []) lines.push(`- ${item.id}: ${oneLine(item.name)} (${item.created ? 'registered' : 'updated'})`)
  if (result.exclusion) lines.push(exclusionLine(result.exclusion))
  return lines.join('\n')
}

function exclusionLine(exclusion) {
  if (exclusion.applied && exclusion.added) return `Exclusion: .dsh/ was added to ${exclusion.file}, so git ignores the catalog.`
  if (exclusion.applied) return `Exclusion: .dsh/ was already listed in ${exclusion.file}, so git ignores the catalog.`
  return `Exclusion: not applied. Reason: ${exclusion.reason}.`
}

// The advisory message of a stop: one text for everything the session still has open. It says nothing is stopped and that
// no project verification check ran, and it never uses blocking wording or claims a check failed. It returns null when there
// is nothing to say. `undetermined` is the reason the change set could not be read, if it could not. `notices` are plain
// facts the gate could not check at this stop. `repositories` are the open repositories, which the caller selects (see
// evaluateRepository), and each one is listed. `credentials` are scanSecurity hits, of which only the rule message is
// written, never the matched text. `diffGaps` lists the changed files whose added lines were not read.
export function advisoryMessage({ undetermined = null, notices = [], repositories = [], credentials = [], diffGaps = [] } = {}) {
  const credentialLines = credentialSection(credentials, diffGaps)
  if (!undetermined && !notices.length && !repositories.length && !credentialLines.length) return null
  const parts = ['Completion Gate advisory. Nothing is stopped, and no project verification check ran.']
  if (undetermined) parts.push(`${oneLine(undetermined)} Check which files you changed yourself, then attest each repository you changed.`)
  if (notices.length) parts.push(notices.map(notice => oneLine(notice)).join('\n'))
  for (const repo of repositories) parts.push(repositorySection(repo))
  if (credentialLines.length) parts.push(credentialLines.join('\n'))
  return parts.join('\n\n')
}

function repositorySection(repo) {
  const lines = [`Repository: ${oneLine(repo.label)}`, `Root: ${oneLine(repo.root)}`]
  // The two path lines, so the reader can find the catalog and the archive without a full listing. The stated items
  // below keep their list; unstated items are only counted, never named.
  const catalogPath = repo.catalogPath ?? repo.catalog?.path ?? null
  const archivePath = archivePathOf(catalogPath)
  if (catalogPath) lines.push(`Catalog path: ${oneLine(catalogPath)}`)
  if (archivePath) lines.push(`Archive path: ${oneLine(archivePath)}`)
  // The active count, independently of the unstated count below: the adoption signal on every advisory. An unreadable
  // catalog prints no count, as the status report does, because a zero would read as a repository with nothing to verify.
  if (repo.catalog.state === 'absent') lines.push('Active catalog items: 0')
  else if (repo.catalog.state !== 'unreadable') lines.push(`Active catalog items: ${repo.catalog.items.length}`)
  if (!repo.introduced) lines.push(introLine(repo))
  const claimed = repo.files.filter(file => file.claim === 'mine').map(file => file.absolute)
  const rejected = repo.files.filter(file => file.claim === 'not-mine').map(file => file.absolute)
  lines.push(...listLines('Changed files not claimed yet (claim each as yours, or reject it):', repo.unclaimed))
  lines.push(...listLines('Claimed as yours:', claimed))
  lines.push(...listLines('Rejected as not yours:', rejected))
  lines.push(...listLines('Changed code not reviewed yet:', repo.unreviewed))
  lines.push(...listLines('Changed documentation not checked yet:', repo.docsUnchecked))
  lines.push(...listLines('Reviewed as a reading but not demonstrated yet (a review is not a run; show the change working in the place it serves):', repo.undemonstrated))
  if (repo.catalog.state === 'unreadable') lines.push(`Catalog unreadable, so its items cannot be checked: ${oneLine(repo.catalog.problem)}. Register will not overwrite it.`)
  // The unreadable archive is an unfinished obligation, not a silent drop: its problem names the archive path and the
  // cause, and the repair guidance says to fix the archive before any registration, which would refuse against it.
  for (const problem of repo.problems ?? []) {
    if (typeof problem !== 'string' || !problem.startsWith('The archive at ')) continue
    lines.push(`- ${oneLine(problem)} Repair the archive at ${oneLine(archivePath ?? problem)} so it reads again, and do not register items until then.`)
  }
  // Only the items the session stated are listed, and an item marked unrelated is left out entirely: the mark says the
  // item does not bear on this work, so listing it would ask again for what the session already silenced. The status
  // report still lists the mark. Items the session never stated are not per-item lines here either; one summary line
  // carries their count below.
  const items = repo.items.filter(item => item.state !== 'unrelated')
  if (items.length) lines.push('Verification items:', ...items.map(item => `- ${oneLine(item.name)} (${oneLine(item.id)}): ${advisoryItemText(item)}`))
  if (repo.unstatedCount > 0) lines.push(unstatedLine(repo.unstatedCount))
  lines.push(attestationLine(repo), nextLine(repo))
  return lines.join('\n')
}

// The introduction, shown until the message that carries it is delivered. It is not repeated after that. An unreadable
// catalog is not offered for reading or registration, because registration refuses it until it is repaired.
function introLine(repo) {
  if (repo.catalog.state === 'unreadable') return `This repository is new to this session. Its verification catalog at ${oneLine(repo.catalogPath)} cannot be read. Repair it so it reads again, and do not register items until then.`
  return `This repository is new to this session. Its verification catalog is at ${oneLine(repo.catalogPath)}. Read it, adopt the items that fit this work by attesting to them, and register the items you will run. Each item says what passing it proves.`
}

// One heading and every one of its paths. Nothing is listed under a heading with no path.
function listLines(heading, paths) {
  if (!paths.length) return []
  return [heading, ...paths.map(item => `- ${oneLine(item)}`)]
}

// An item's state as the advisory states it. An assumed item is a promise with its reason, never a pass or a run. An item
// marked unrelated never reaches this line, because repositorySection leaves it out of the list. A stated archived item
// is reported under its archived state, marked with an `(archived)` tag like the status report.
function advisoryItemText(item) {
  let base
  if (item.state === 'passed') base = 'passed'
  else if (item.state === 'assumed') base = `assumed, not run. This is a promise, not a pass. Reason: ${oneLine(item.reason ?? '')}`
  else base = 'unfinished, no state reported yet'
  return item.archived ? `${base} (archived)` : base
}

function attestationLine(repo) {
  if (repo.attestation) return 'Attestation: current.'
  if (repo.stale) return 'Attestation: stale (files changed after the last attestation, so it was dropped).'
  return 'Attestation: missing.'
}

// The one call to action of a repository, once per repository block. An unreadable catalog or archive is repaired
// first, because registration refuses either.
function nextLine(repo) {
  const archiveProblem = (repo.problems ?? []).find(problem => typeof problem === 'string' && problem.startsWith('The archive at '))
  let first
  if (repo.catalog.state === 'unreadable') first = `repair the verification catalog at ${oneLine(repo.catalogPath)} so it reads again, then register`
  else if (archiveProblem) first = `repair the verification archive at ${oneLine(archivePathOf(repo.catalogPath ?? repo.catalog?.path ?? null) ?? archiveProblem)} so it reads again, then register`
  else first = 'register'
  return `Next: ${first} the verification you will run, run it yourself, claim or reject each changed file, review each changed code file you claim, check each changed document you did not reject, demonstrate the change in real use, then honestly attest by calling completion_gate with action=attest, demonstrated_files naming each path with the command it ran and that command's output, and repository_root set to ${oneLine(repo.root)}.`
}

// The credential hits of this turn's added lines, grouped by rule with a count per rule. The matched text is not written.
// An unread file gets its own line whether or not a hit exists, because the scan may then be incomplete.
function credentialSection(credentials, diffGaps) {
  const lines = []
  if (credentials.length) {
    const byRule = new Map()
    for (const hit of credentials) byRule.set(hit.message, (byRule.get(hit.message) ?? 0) + 1)
    lines.push('Possible credentials in this turn\'s added lines, by rule (the matched text is not shown):')
    for (const [message, count] of byRule) lines.push(`- ${oneLine(message)}: ${count} ${count === 1 ? 'line' : 'lines'}`)
  }
  if (diffGaps.length) {
    lines.push(`${diffGaps.length} changed ${diffGaps.length === 1 ? 'file' : 'files'} could not be read for this scan, so the scan may be incomplete.`)
    // A gap names the file by its path, so the file can be had checked; an older gap carries only its one-line text.
    for (const gap of diffGaps) lines.push(`- ${oneLine(gap.path === undefined ? gap.text ?? String(gap) : `${gap.path}: ${gap.reason}`)}`)
  }
  return lines
}
