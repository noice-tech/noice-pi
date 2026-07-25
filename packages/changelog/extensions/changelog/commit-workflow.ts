import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

export const CHANGE_TYPES = [
  'auto',
  'feat',
  'fix',
  'improve',
  'internal'
] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]
type ResolvedChangeType = Exclude<ChangeType, 'auto'>

const RESOLVED_CHANGE_TYPES = ['feat', 'fix', 'improve', 'internal'] as const
const MAX_DIFF_PER_FILE = 20_000
const MAX_DIFF_TOTAL = 80_000
const MAX_UNTRACKED_PER_FILE = 16_000
const MAX_UNTRACKED_TOTAL = 40_000
const MAX_COMMIT_MESSAGE = 200
const MAX_PR_HEADLINE = 200
const MAX_PUBLIC_SUMMARY = 500
const MAX_PROSE_ITEMS = 12
const MAX_PROSE_ITEM = 500

type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface PullRequest {
  number: number
  title: string
  body: string
  baseRefName: string
  headRefName: string
  headRepositoryOwner: { login: string } | null
  state: PullRequestState
  url: string
}

export interface ChangeCandidate {
  id: string
  status: string
  paths: string[]
  display: string
}

export interface CommitProse {
  stageChangeIds: string[]
  ignoreChangeIds: string[]
  commitType: ResolvedChangeType
  commitMessage: string
  prType: ResolvedChangeType
  prHeadline: string
  prTitle: string
  summary: string[]
  publicSummary: string
  context: string[]
}

export interface ProseInput {
  selectedChangeType: ChangeType
  userContext: string
  changes: ChangeCandidate[]
  status: string
  diff: string
  untrackedMaterial: string
  commits: string
  existingPr: PullRequest | null
  baseBranch: string
  packageScope: string | null
}

export interface WorkflowResult {
  status: 'committed' | 'updated_pr' | 'no_changes' | 'failed'
  commit: string | null
  pr: PullRequest | null
  verification: string
  notes: string[]
}

export interface WorkflowDependencies {
  generateProse(input: ProseInput): Promise<unknown>
  onProgress?(message: string): void
}

export class WorkflowFailure extends Error {
  readonly workflow: WorkflowResult

  constructor(
    message: string,
    workflow: WorkflowResult,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'WorkflowFailure'
    this.workflow = workflow
  }
}

export interface WorkflowContext {
  cwd: string
  exec(
    command: string,
    args: string[],
    options?: ExecOptions
  ): Promise<ExecResult>
}

interface GitHubRepository {
  nameWithOwner: string
  defaultBranchRef: { name: string }
}

interface UntrackedMaterial {
  prose: string
  fingerprint: string
}

interface WorktreeSnapshot {
  branch: string
  headSha: string
  rawStatus: string
  trackedDiff: string
  untrackedFingerprint: string
  prospectiveTree: string | null
}

interface InspectedState {
  branch: string
  rawStatus: string
  displayStatus: string
  existingPr: PullRequest | null
  repository: GitHubRepository
  baseBranch: string
  aheadCount: number
  packageScope: string | null
  committedFiles: string[]
  changes: ChangeCandidate[]
  diff: string
  untrackedMaterial: string
  commits: string
  headSha: string
  snapshot: WorktreeSnapshot
}

const OWNED_SECTIONS = new Set(['summary', 'changelog', 'verification'])

export async function executeCommitWorkflow(
  suppliedContext: WorkflowContext,
  selectedChangeType: ChangeType,
  userContext: string,
  dependencies: WorkflowDependencies
): Promise<WorkflowResult> {
  dependencies.onProgress?.('Finding repository root')
  const root = await output(suppliedContext, 'git', [
    'rev-parse',
    '--show-toplevel'
  ])
  if (!root) throw new Error('Could not determine the Git repository root')
  const ctx = { ...suppliedContext, cwd: root }
  const notes: string[] = []
  dependencies.onProgress?.('Inspecting Git and GitHub state')
  let state = await inspectState(ctx)

  if (!state.rawStatus && state.aheadCount === 0 && !state.existingPr) {
    dependencies.onProgress?.('No changes to commit')
    return result('no_changes', null, null, notes)
  }

  let createdCommit: string | null = null
  let latestPr = state.existingPr
  let publishSha = state.headSha

  try {
    dependencies.onProgress?.('Generating commit and PR text')
    const prose = validateCommitProse(
      await dependencies.generateProse({
        selectedChangeType,
        userContext,
        changes: state.changes,
        status: state.displayStatus,
        diff: state.diff,
        untrackedMaterial: state.untrackedMaterial,
        commits: state.commits,
        existingPr: state.existingPr,
        baseBranch: state.baseBranch,
        packageScope: state.packageScope
      }),
      selectedChangeType,
      state.packageScope,
      state.changes
    )
    const selectedChanges = selectChanges(state.changes, prose.stageChangeIds)
    const ignoredChanges = selectChanges(state.changes, prose.ignoreChangeIds)
    const selectedPaths = candidatePaths(selectedChanges)
    const ignoredPaths = candidatePaths(ignoredChanges)
    const packageScope = await detectPackageScope(ctx, [
      ...state.committedFiles,
      ...selectedPaths
    ])
    prose.prTitle = formatPullRequestTitle(
      prose.prType,
      prose.prHeadline,
      packageScope
    )
    if (ignoredChanges.length) {
      notes.push(formatIgnoredChangesNote(ignoredChanges))
    }

    // The prose call is deliberately the only long-running operation between
    // inspection and mutation. Re-read every input that can affect the commit
    // immediately before changing either local or remote state.
    dependencies.onProgress?.('Rechecking repository state')
    await assertSnapshotUnchanged(ctx, state.snapshot)

    if (
      state.branch === state.repository.defaultBranchRef.name &&
      (selectedChanges.length > 0 || state.aheadCount > 0)
    ) {
      dependencies.onProgress?.('Creating a feature branch')
      const newBranch = await createBranch(
        ctx,
        prose.commitType,
        prose.commitMessage
      )
      notes.push(`created branch ${newBranch}`)
      state = {
        ...state,
        branch: newBranch,
        existingPr: null,
        snapshot: { ...state.snapshot, branch: newBranch }
      }
      latestPr = null
    }

    if (selectedChanges.length) {
      dependencies.onProgress?.(
        `Staging ${selectedChanges.length} selected ${selectedChanges.length === 1 ? 'change' : 'changes'}`
      )
      await commitSelectedChanges(
        ctx,
        state.headSha,
        state.snapshot,
        prose.commitMessage,
        selectedPaths,
        ignoredPaths,
        (committed) => {
          createdCommit = `${committed.shortSha} ${committed.subject}`
          publishSha = committed.sha
        }
      )
    } else if (state.rawStatus && state.aheadCount === 0 && !state.existingPr) {
      dependencies.onProgress?.('No relevant changes selected')
      return result('no_changes', null, null, notes)
    }

    dependencies.onProgress?.(`Pushing ${state.branch}`)
    await pushIfNeeded(ctx, state.branch, publishSha)

    // Re-query after pushing so concurrent PR creation and closed/merged state
    // transitions fail closed before any PR mutation.
    dependencies.onProgress?.('Checking pull request state')
    const matchingPrs = await queryPullRequests(
      ctx,
      state.branch,
      state.repository
    )
    const existingPr = selectPullRequestForSnapshot(
      matchingPrs,
      'during commit prose generation or push'
    )
    latestPr = existingPr
    assertPullRequestSnapshotUnchanged(
      state.existingPr,
      existingPr,
      'during commit prose generation or push'
    )
    const body = mergePullRequestBody(
      existingPr?.body ?? '',
      prose,
      'Not run',
      publishSha
    )

    let finalPr: PullRequest
    let prChanged = false
    if (!existingPr) {
      dependencies.onProgress?.('Creating pull request')
      finalPr = await createPullRequest(
        ctx,
        state.repository,
        state.baseBranch,
        prose.prTitle,
        body,
        state.branch
      )
      prChanged = true
    } else if (existingPr.title !== prose.prTitle || existingPr.body !== body) {
      dependencies.onProgress?.(`Updating pull request #${existingPr.number}`)
      finalPr = await updatePullRequest(
        ctx,
        state.repository,
        existingPr,
        prose.prTitle,
        body
      )
      prChanged = true
    } else {
      dependencies.onProgress?.(`Pull request #${existingPr.number} is current`)
      finalPr = existingPr
    }

    if (
      !state.existingPr &&
      state.baseBranch !== state.repository.defaultBranchRef.name
    ) {
      notes.push(`using inferred or configured base ${state.baseBranch}`)
    }

    latestPr = finalPr
    return result(
      createdCommit ? 'committed' : prChanged ? 'updated_pr' : 'no_changes',
      createdCommit,
      finalPr,
      notes
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WorkflowFailure(
      message,
      result('failed', createdCommit, latestPr, [...notes, message]),
      { cause: error }
    )
  }
}

async function inspectState(ctx: WorkflowContext): Promise<InspectedState> {
  const [branch, rawStatus, repositoryText] = await Promise.all([
    output(ctx, 'git', ['branch', '--show-current']),
    rawOutput(ctx, 'git', ['status', '--porcelain=v1', '-z', '-uall']),
    output(ctx, 'gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner,defaultBranchRef'
    ])
  ])
  if (!branch) throw new Error('Detached HEAD is not supported by /commit')

  const repository = parseJson<GitHubRepository>(
    repositoryText,
    'GitHub repository'
  )
  if (
    !repository.nameWithOwner ||
    !repositoryOwner(repository) ||
    !repository.defaultBranchRef?.name
  ) {
    throw new Error(
      'GitHub repository response did not include a valid owner or default branch'
    )
  }
  // Remote refresh, local tree inspection, and GitHub PR lookup are
  // independent network/disk operations. Run them together so startup time is
  // bounded by the slowest one rather than the sum of all three.
  const [, prospectiveTree, prs] = await Promise.all([
    run(ctx, 'git', ['fetch', '--prune', 'origin']),
    rawStatus
      ? (async () => {
          await assertNoUnmergedStatus(ctx)
          return computeProspectiveTree(ctx)
        })()
      : Promise.resolve(null),
    // A default branch name is routinely reused across the repository's entire
    // history. Never let an old PR whose head happened to have that name bind a
    // new run; default-branch work is forked below instead.
    branch === repository.defaultBranchRef.name
      ? Promise.resolve([])
      : queryPullRequests(ctx, branch, repository)
  ])
  const existingPr = selectOpenPullRequest(prs)
  const baseBranch =
    existingPr?.baseRefName ??
    (await resolveBaseBranch(ctx, branch, repository.defaultBranchRef.name))
  await ensureRemoteBranch(ctx, baseBranch)

  const [aheadText, headSha, trackedDiff, untrackedPaths] = await Promise.all([
    output(ctx, 'git', ['rev-list', '--count', `origin/${baseBranch}..HEAD`]),
    output(ctx, 'git', ['rev-parse', 'HEAD']),
    rawOutput(ctx, 'git', ['diff', '--no-ext-diff', '--binary', 'HEAD']),
    collectUntrackedPaths(ctx)
  ])
  const aheadCount = Number.parseInt(aheadText, 10)
  if (!Number.isFinite(aheadCount))
    throw new Error('Could not determine branch commit count')

  const [untracked, diff, commits, changedFiles] = await Promise.all([
    collectUntrackedMaterial(ctx.cwd, untrackedPaths),
    collectBoundedDiff(ctx, baseBranch),
    output(ctx, 'git', ['log', '--format=%h %s', `origin/${baseBranch}..HEAD`]),
    collectChangedFiles(ctx, baseBranch, untrackedPaths)
  ])
  const packageScope = await detectPackageScope(ctx, changedFiles)
  const changes = parsePorcelainChanges(rawStatus)
  const committedFiles = splitNul(
    await rawOutput(ctx, 'git', [
      'diff',
      '--name-only',
      '-z',
      `origin/${baseBranch}...HEAD`
    ])
  )

  return {
    branch,
    rawStatus,
    displayStatus: changes.map((change) => change.display).join('\n'),
    existingPr,
    repository,
    baseBranch,
    aheadCount,
    packageScope,
    committedFiles,
    changes,
    diff,
    untrackedMaterial: untracked.prose,
    commits,
    headSha,
    snapshot: {
      branch,
      headSha,
      rawStatus,
      trackedDiff,
      untrackedFingerprint: untracked.fingerprint,
      prospectiveTree
    }
  }
}

async function captureSnapshot(
  ctx: WorkflowContext
): Promise<WorktreeSnapshot> {
  const [branch, headSha, rawStatus, trackedDiff, untrackedPaths] =
    await Promise.all([
      output(ctx, 'git', ['branch', '--show-current']),
      output(ctx, 'git', ['rev-parse', 'HEAD']),
      rawOutput(ctx, 'git', ['status', '--porcelain=v1', '-z', '-uall']),
      rawOutput(ctx, 'git', ['diff', '--no-ext-diff', '--binary', 'HEAD']),
      collectUntrackedPaths(ctx)
    ])
  const [prospectiveTree, untracked] = await Promise.all([
    rawStatus
      ? (async () => {
          await assertNoUnmergedStatus(ctx)
          return computeProspectiveTree(ctx)
        })()
      : Promise.resolve(null),
    collectUntrackedMaterial(ctx.cwd, untrackedPaths)
  ])
  return {
    branch,
    headSha,
    rawStatus,
    trackedDiff,
    untrackedFingerprint: untracked.fingerprint,
    prospectiveTree
  }
}

async function assertSnapshotUnchanged(
  ctx: WorkflowContext,
  expected: WorktreeSnapshot
) {
  let actual: WorktreeSnapshot
  try {
    actual = await captureSnapshot(ctx)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Repository changed during commit prose generation (${detail}); rerun /commit`
    )
  }
  const changed = (
    [
      'branch',
      'headSha',
      'rawStatus',
      'trackedDiff',
      'untrackedFingerprint',
      'prospectiveTree'
    ] as const
  ).filter((key) => actual[key] !== expected[key])
  if (changed.length) {
    throw new Error(
      `Repository changed during commit prose generation (${changed.join(', ')}); rerun /commit`
    )
  }
}

async function assertNoUnmergedStatus(ctx: WorkflowContext) {
  const unmerged = await rawOutput(ctx, 'git', ['ls-files', '--unmerged', '-z'])
  if (unmerged) {
    throw new Error('Unmerged repository status is not supported by /commit')
  }
}

interface IgnoredSnapshot {
  indexEntries: string
  worktreeFingerprint: string
}

async function commitSelectedChanges(
  ctx: WorkflowContext,
  expectedParent: string,
  expectedSnapshot: WorktreeSnapshot,
  commitMessage: string,
  selectedPaths: string[],
  ignoredPaths: string[],
  onCommitted: (commit: {
    sha: string
    shortSha: string
    subject: string
  }) => void
) {
  const directory = await mkdtemp(join(tmpdir(), 'noice-changelog-commit-'))
  const indexFile = join(directory, 'index')
  const ignoredSnapshot = await captureIgnoredSnapshot(ctx, ignoredPaths)
  try {
    await runWithAlternateIndex(ctx, indexFile, ['read-tree', 'HEAD'])
    await runWithAlternateIndex(ctx, indexFile, [
      '--literal-pathspecs',
      'add',
      '-A',
      '--',
      ...selectedPaths
    ])
    const selectedTree = (
      await runWithAlternateIndex(ctx, indexFile, ['write-tree'])
    ).stdout.trim()
    // Close the race between the pre-mutation recheck and alternate-index
    // staging. The alternate index itself does not affect this snapshot.
    await assertSnapshotUnchanged(ctx, expectedSnapshot)

    await runWithAlternateIndex(ctx, indexFile, ['commit', '-m', commitMessage])
    const sha = await output(ctx, 'git', ['rev-parse', 'HEAD'])
    const [parent, tree, completeMessage] = await Promise.all([
      output(ctx, 'git', ['rev-parse', `${sha}^`]),
      output(ctx, 'git', ['rev-parse', `${sha}^{tree}`]),
      output(ctx, 'git', ['log', '-1', '--format=%B', sha])
    ])
    if (parent !== expectedParent) {
      throw new Error(
        'HEAD changed while creating the commit; refusing to push an uninspected commit'
      )
    }
    if (tree !== selectedTree) {
      throw new Error(
        'A commit hook changed the staged tree; refusing to push unreviewed content'
      )
    }
    if (completeMessage !== commitMessage) {
      throw new Error(
        'A commit hook changed the commit message; refusing to push unexpected metadata'
      )
    }
    // The real index was never used for the commit. Move only selected entries
    // to the new HEAD so ignored pre-staged entries retain their exact blobs.
    await run(ctx, 'git', [
      '--literal-pathspecs',
      'reset',
      '--quiet',
      'HEAD',
      '--',
      ...selectedPaths
    ])
    const committed = {
      sha,
      shortSha: await output(ctx, 'git', ['rev-parse', '--short', sha]),
      subject: commitMessage
    }
    onCommitted(committed)
    await assertIgnoredSnapshotUnchanged(ctx, ignoredPaths, ignoredSnapshot)
    const postCommitStatus = await rawOutput(ctx, 'git', [
      'status',
      '--porcelain=v1',
      '-z',
      '-uall'
    ])
    const allowedPaths = new Set(ignoredPaths)
    const unexpected = candidatePaths(
      parsePorcelainChanges(postCommitStatus)
    ).filter((path) => !allowedPaths.has(path))
    if (unexpected.length) {
      throw new Error(
        `Worktree changed outside the intentionally ignored selection after commit: ${unexpected.map(displayPath).join(', ')}`
      )
    }

    return committed
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function captureIgnoredSnapshot(
  ctx: WorkflowContext,
  paths: string[]
): Promise<IgnoredSnapshot> {
  if (!paths.length) return { indexEntries: '', worktreeFingerprint: '' }
  const [indexEntries, worktreeFingerprint] = await Promise.all([
    rawOutput(ctx, 'git', [
      '--literal-pathspecs',
      'ls-files',
      '--stage',
      '-z',
      '--',
      ...paths
    ]),
    fingerprintPaths(ctx.cwd, paths)
  ])
  return { indexEntries, worktreeFingerprint }
}

async function assertIgnoredSnapshotUnchanged(
  ctx: WorkflowContext,
  paths: string[],
  expected: IgnoredSnapshot
) {
  const actual = await captureIgnoredSnapshot(ctx, paths)
  if (
    actual.indexEntries !== expected.indexEntries ||
    actual.worktreeFingerprint !== expected.worktreeFingerprint
  ) {
    throw new Error(
      'An intentionally ignored change was modified while creating the commit; refusing to push'
    )
  }
}

async function fingerprintPaths(root: string, paths: string[]) {
  const fingerprints: string[] = []
  for (const relativePath of [...new Set(paths)].sort()) {
    const absolutePath = join(root, relativePath)
    try {
      const metadata = await lstat(absolutePath)
      let kind = 'other'
      let digest = ''
      if (metadata.isSymbolicLink()) {
        kind = 'symlink'
        digest = createHash('sha256')
          .update(await readlink(absolutePath))
          .digest('hex')
      } else if (metadata.isFile()) {
        kind = 'file'
        digest = (await hashAndReadPrefix(absolutePath, 0)).digest
      } else if (metadata.isDirectory()) {
        kind = 'directory'
      }
      fingerprints.push(
        JSON.stringify([
          relativePath,
          kind,
          metadata.mode,
          metadata.size,
          digest
        ])
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fingerprints.push(JSON.stringify([relativePath, 'missing']))
    }
  }
  return fingerprints.join('\n')
}

async function computeProspectiveTree(ctx: WorkflowContext) {
  const directory = await mkdtemp(join(tmpdir(), 'noice-changelog-index-'))
  const indexFile = join(directory, 'index')
  try {
    await runWithAlternateIndex(ctx, indexFile, ['read-tree', 'HEAD'])
    await runWithAlternateIndex(ctx, indexFile, ['add', '-A'])
    return (
      await runWithAlternateIndex(ctx, indexFile, ['write-tree'])
    ).stdout.trim()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runWithAlternateIndex(
  ctx: WorkflowContext,
  indexFile: string,
  args: string[]
) {
  return checked(
    await ctx.exec('env', [`GIT_INDEX_FILE=${indexFile}`, 'git', ...args], {
      cwd: ctx.cwd
    }),
    'git',
    args
  )
}

export async function resolveBaseBranch(
  ctx: WorkflowContext,
  branch: string,
  defaultBranch: string
): Promise<string> {
  for (const key of [
    `branch.${branch}.noice-base`,
    `branch.${branch}.gh-merge-base`
  ]) {
    const configured = await optionalOutput(ctx, 'git', [
      'config',
      '--get',
      key
    ])
    if (configured) {
      await ensureRemoteBranch(ctx, configured)
      return configured.replace(/^origin\//, '')
    }
  }

  if (branch === defaultBranch) return defaultBranch

  const candidates = (
    await output(ctx, 'git', [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin'
    ])
  )
    .split('\n')
    .map((ref) => ref.trim())
    .filter(
      (ref) =>
        ref &&
        ref !== 'origin' &&
        ref !== 'origin/HEAD' &&
        ref !== `origin/${branch}` &&
        !ref.startsWith('origin/pull/')
    )
  if (!candidates.length)
    throw new Error('No candidate PR base branches were found')

  // Every eligible remote ref participates. Preference by branch name can
  // discard the actual newest ancestor (for example a stacked feature base).
  const mergeBases: Array<{ candidate: string; timestamp: number }> = []
  for (const candidate of candidates) {
    const mergeBase = await optionalOutput(ctx, 'git', [
      'merge-base',
      'HEAD',
      candidate
    ])
    if (!mergeBase) continue
    const timestamp = Number.parseInt(
      await output(ctx, 'git', ['show', '-s', '--format=%ct', mergeBase]),
      10
    )
    if (Number.isFinite(timestamp)) mergeBases.push({ candidate, timestamp })
  }
  if (!mergeBases.length)
    throw new Error('Could not infer a PR base from branch ancestry')

  const newestTimestamp = Math.max(...mergeBases.map((item) => item.timestamp))
  const winners = mergeBases
    .filter((item) => item.timestamp === newestTimestamp)
    .map((item) => item.candidate)
  if (winners.length !== 1) {
    throw new Error(
      `Ambiguous PR base (${winners.map((ref) => ref.replace(/^origin\//, '')).join(', ')}). Configure branch.${branch}.noice-base and rerun.`
    )
  }
  return winners[0].replace(/^origin\//, '')
}

async function ensureRemoteBranch(ctx: WorkflowContext, branch: string) {
  const normalized = branch.replace(/^origin\//, '')
  const check = await ctx.exec(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${normalized}`],
    { cwd: ctx.cwd }
  )
  if (check.code !== 0) {
    await run(ctx, 'git', ['fetch', 'origin', normalized])
  }
  const verified = await ctx.exec(
    'git',
    ['rev-parse', '--verify', `origin/${normalized}`],
    { cwd: ctx.cwd }
  )
  if (verified.code !== 0)
    throw new Error(
      `Configured PR base does not exist on origin: ${normalized}`
    )
}

function repositoryOwner(repository: GitHubRepository) {
  return repository.nameWithOwner.match(/^([^/]+)\/[^/]+$/)?.[1] ?? ''
}

async function queryPullRequests(
  ctx: WorkflowContext,
  branch: string,
  repository: GitHubRepository
) {
  const value = parseJson<unknown>(
    await output(ctx, 'gh', [
      'pr',
      'list',
      '--repo',
      repository.nameWithOwner,
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,title,body,baseRefName,headRefName,headRepositoryOwner,state,url',
      '--limit',
      '100'
    ]),
    'pull request list'
  )
  if (!Array.isArray(value))
    throw new Error('GitHub pull request list was not an array')
  const owner = repositoryOwner(repository).toLowerCase()
  return value
    .map(validatePullRequest)
    .filter((pr) => pr.headRepositoryOwner?.login.toLowerCase() === owner)
}

export function selectOpenPullRequest(prs: PullRequest[]): PullRequest | null {
  if (prs.length > 1) {
    throw new Error(
      `Multiple pull requests match this branch (${prs.map((pr) => `#${pr.number}`).join(', ')})`
    )
  }
  if (!prs.length) return null
  if (prs[0].state !== 'OPEN') {
    throw new Error(
      `Matching pull request #${prs[0].number} is ${prs[0].state.toLowerCase()}; refusing to create or update a PR`
    )
  }
  return prs[0]
}

function selectPullRequestForSnapshot(
  prs: PullRequest[],
  timing: string
): PullRequest | null {
  try {
    return selectOpenPullRequest(prs)
  } catch (error) {
    throw new Error(`Pull request snapshot changed ${timing}; rerun /commit`, {
      cause: error
    })
  }
}

function assertPullRequestSnapshotUnchanged(
  expected: PullRequest | null,
  actual: PullRequest | null,
  timing: string
) {
  const keys = [
    'number',
    'title',
    'body',
    'baseRefName',
    'headRefName',
    'state',
    'url'
  ] as const
  const unchanged =
    expected === actual ||
    (expected !== null &&
      actual !== null &&
      keys.every((key) => expected[key] === actual[key]) &&
      expected.headRepositoryOwner?.login === actual.headRepositoryOwner?.login)
  if (!unchanged) {
    throw new Error(`Pull request snapshot changed ${timing}; rerun /commit`)
  }
}

function validatePullRequest(value: unknown): PullRequest {
  if (!isRecord(value)) throw new Error('Invalid pull request response')
  const requiredStrings = [
    'title',
    'body',
    'baseRefName',
    'headRefName',
    'state',
    'url'
  ] as const
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string')
      throw new Error(`Pull request ${key} was not a string`)
  }
  if (!Number.isInteger(value.number))
    throw new Error('Pull request number was invalid')
  if (
    value.headRepositoryOwner !== null &&
    (!isRecord(value.headRepositoryOwner) ||
      typeof value.headRepositoryOwner.login !== 'string' ||
      !value.headRepositoryOwner.login)
  ) {
    throw new Error('Pull request headRepositoryOwner was invalid')
  }
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(value.state))
    throw new Error(`Unknown pull request state: ${value.state}`)
  return value as unknown as PullRequest
}

export function validateCommitProse(
  value: unknown,
  selectedType: ChangeType,
  packageScope: string | null,
  changes: ChangeCandidate[] = []
): CommitProse {
  if (!isRecord(value)) throw new Error('Model response must be a JSON object')
  const expectedKeys = [
    'stageChangeIds',
    'ignoreChangeIds',
    'commitType',
    'commitMessage',
    'prType',
    'prHeadline',
    'summary',
    'publicSummary',
    'context'
  ]
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.join(',') !== [...expectedKeys].sort().join(',')) {
    throw new Error(
      `Model response keys must be exactly: ${expectedKeys.join(', ')}`
    )
  }
  const stageChangeIds = validateChangeIds(
    value.stageChangeIds,
    'stageChangeIds'
  )
  const ignoreChangeIds = validateChangeIds(
    value.ignoreChangeIds,
    'ignoreChangeIds'
  )
  const knownIds = new Set(changes.map((change) => change.id))
  const selectedIds = new Set([...stageChangeIds, ...ignoreChangeIds])
  if (
    selectedIds.size !== stageChangeIds.length + ignoreChangeIds.length ||
    [...selectedIds].some((id) => !knownIds.has(id)) ||
    selectedIds.size !== knownIds.size
  ) {
    throw new Error(
      'Model change selection must partition every supplied change ID exactly once'
    )
  }
  const stagePaths = candidatePaths(selectChanges(changes, stageChangeIds))
  const ignorePathSet = new Set(
    candidatePaths(selectChanges(changes, ignoreChangeIds))
  )
  const overlappingPaths = stagePaths.filter((path) => ignorePathSet.has(path))
  if (overlappingPaths.length) {
    throw new Error(
      `Model change selection split overlapping Git status entries (${overlappingPaths.map(displayPath).join(', ')}); entries sharing a path must be selected or ignored together`
    )
  }
  for (const key of ['commitType', 'prType'] as const) {
    if (!RESOLVED_CHANGE_TYPES.includes(value[key])) {
      throw new Error(`Model returned an invalid ${key}`)
    }
  }
  const commitType = value.commitType as ResolvedChangeType
  const prType = value.prType as ResolvedChangeType
  if (selectedType !== 'auto' && commitType !== selectedType) {
    throw new Error(
      `Model changed the selected commit type from ${selectedType} to ${commitType}`
    )
  }
  const stringLimits = {
    commitMessage: MAX_COMMIT_MESSAGE,
    prHeadline: MAX_PR_HEADLINE,
    publicSummary: MAX_PUBLIC_SUMMARY
  } as const
  for (const key of ['commitMessage', 'prHeadline', 'publicSummary'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !value[key].trim() ||
      value[key] !== value[key].trim() ||
      /[\x00-\x1f\x7f]/.test(value[key]) ||
      value[key].length > stringLimits[key]
    ) {
      throw new Error(
        `Model response ${key} must be a non-empty, trimmed single line of at most ${stringLimits[key]} characters`
      )
    }
  }
  for (const key of ['summary', 'context'] as const) {
    if (
      !Array.isArray(value[key]) ||
      !value[key].length ||
      value[key].length > MAX_PROSE_ITEMS ||
      value[key].some(
        (item) =>
          typeof item !== 'string' ||
          !item.trim() ||
          item !== item.trim() ||
          /[\x00-\x1f\x7f]/.test(item) ||
          item.length > MAX_PROSE_ITEM ||
          /^(?:[-*#]|\d+\.)\s/.test(item)
      )
    ) {
      throw new Error(
        `Model response ${key} must contain 1-${MAX_PROSE_ITEMS} plain single lines of at most ${MAX_PROSE_ITEM} characters`
      )
    }
  }
  const commitPrefix = `${commitType}: `
  if (
    !value.commitMessage.startsWith(commitPrefix) ||
    /^\w+\([^)]+\):/.test(value.commitMessage)
  ) {
    throw new Error(`Commit message must use unscoped ${commitPrefix}format`)
  }
  if (
    /^(?:feat|fix|improve|internal)(?:\([^)]+\))?:\s/.test(value.prHeadline)
  ) {
    throw new Error('PR headline must not include a conventional-commit prefix')
  }
  if (prType === 'internal' && value.publicSummary !== 'None.')
    throw new Error('Internal PRs must use publicSummary "None."')
  if (prType !== 'internal' && value.publicSummary === 'None.')
    throw new Error('User-facing PRs require a public summary')

  return {
    stageChangeIds,
    ignoreChangeIds,
    commitType,
    commitMessage: value.commitMessage,
    prType,
    prHeadline: value.prHeadline,
    prTitle: formatPullRequestTitle(prType, value.prHeadline, packageScope),
    summary: value.summary,
    publicSummary: value.publicSummary,
    context: value.context
  }
}

function validateChangeIds(value: unknown, key: string) {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || !id)
  ) {
    throw new Error(`Model response ${key} must be an array of change IDs`)
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Model response ${key} must not contain duplicate IDs`)
  }
  return value as string[]
}

function formatPullRequestTitle(
  type: ResolvedChangeType,
  headline: string,
  packageScope: string | null
) {
  const scope = packageScope ? `(${packageScope})` : ''
  return `${type}${scope}: ${headline}`
}

function selectChanges(changes: ChangeCandidate[], ids: string[]) {
  const selected = new Set(ids)
  return changes.filter((change) => selected.has(change.id))
}

function candidatePaths(changes: ChangeCandidate[]) {
  return [...new Set(changes.flatMap((change) => change.paths))]
}

function formatIgnoredChangesNote(changes: ChangeCandidate[]) {
  const visible = changes
    .slice(0, 8)
    .map((change) =>
      change.display.length > 120
        ? `${change.display.slice(0, 119)}…`
        : change.display
    )
  const omitted = changes.length - visible.length
  return `left ${changes.length} unrelated ${changes.length === 1 ? 'change' : 'changes'} untouched: ${visible.join(', ')}${omitted ? `, … ${omitted} more` : ''}`
}

export function mergePullRequestBody(
  existingBody: string,
  prose: CommitProse,
  verification: string,
  headSha?: string
): string {
  const owned = [
    '## Summary',
    '',
    ...prose.summary.map((line) => `- ${line}`),
    '',
    '## Changelog',
    '',
    'Public summary:',
    '',
    `- ${prose.publicSummary}`,
    '',
    'Context:',
    '',
    ...prose.context.map((line) => `- ${line}`),
    '',
    '## Verification',
    '',
    `- ${verification}`
  ].join('\n')
  const manual = extractManualBody(existingBody)
  const body = `${manual ? `${manual}\n\n` : ''}${owned}\n`
  if (!headSha) return body
  const digest = hashBody(body)
  return `${body.trimEnd()}\n\n<!-- noice-changelog: ${headSha}:${digest} -->\n`
}

export function isCurrentGeneratedBody(body: string, headSha: string) {
  const match = body.match(
    /\n?<!-- noice-changelog: ([0-9a-f]+):([0-9a-f]{16}) -->\s*$/
  )
  if (!match || match[1] !== headSha) return false
  const withoutMarker = body.slice(0, match.index).trimEnd() + '\n'
  return hashBody(withoutMarker) === match[2]
}

function hashBody(body: string) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

function extractManualBody(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const retained: string[] = []
  let keep = true
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) keep = !OWNED_SECTIONS.has(heading[1].trim().toLowerCase())
    if (keep) retained.push(line)
  }
  return retained.join('\n').trim()
}

function splitNul(value: string) {
  if (!value) return []
  const records = value.split('\0')
  if (records.at(-1) === '') records.pop()
  return records
}

export function parsePorcelainChanges(rawStatus: string) {
  const records = splitNul(rawStatus)
  const changes: ChangeCandidate[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 3) throw new Error('Invalid NUL-delimited Git status')
    const status = record.slice(0, 2)
    const path = record.slice(3)
    let paths = [path]
    let display = `${status} ${displayPath(path)}`
    if (status.includes('R') || status.includes('C')) {
      const original = records[index + 1]
      if (original === undefined)
        throw new Error('Invalid NUL-delimited Git rename status')
      paths = status.includes('R') ? [original, path] : [path]
      display = `${status} ${displayPath(original)} -> ${displayPath(path)}`
      index += 1
    }
    changes.push({
      id: `change-${changes.length + 1}`,
      status,
      paths,
      display
    })
  }
  return changes
}

function displayPath(path: string) {
  return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

async function collectUntrackedPaths(ctx: WorkflowContext) {
  return splitNul(
    await rawOutput(ctx, 'git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z'
    ])
  )
}

async function collectChangedFiles(
  ctx: WorkflowContext,
  base: string,
  untrackedPaths: string[]
) {
  const committed = splitNul(
    await rawOutput(ctx, 'git', [
      'diff',
      '--name-only',
      '-z',
      `origin/${base}...HEAD`
    ])
  )
  const worktree = splitNul(
    await rawOutput(ctx, 'git', ['diff', '--name-only', '-z', 'HEAD'])
  )
  return [...new Set([...committed, ...worktree, ...untrackedPaths])]
}

async function collectBoundedDiff(ctx: WorkflowContext, base: string) {
  const committed = splitNul(
    await rawOutput(ctx, 'git', [
      'diff',
      '--name-only',
      '-z',
      `origin/${base}...HEAD`
    ])
  )
  const worktree = splitNul(
    await rawOutput(ctx, 'git', ['diff', '--name-only', '-z', 'HEAD'])
  )
  const files = [...new Set([...committed, ...worktree])]
  const sections: string[] = []
  let remaining = MAX_DIFF_TOTAL
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const [committedPatch, worktreePatch] = await Promise.all([
      rawOutput(ctx, 'git', [
        'diff',
        '--no-ext-diff',
        `origin/${base}...HEAD`,
        '--',
        file
      ]),
      rawOutput(ctx, 'git', ['diff', '--no-ext-diff', 'HEAD', '--', file])
    ])
    const patch = [committedPatch, worktreePatch].filter(Boolean).join('\n')
    const perFile = truncateExplicitly(
      patch,
      MAX_DIFF_PER_FILE,
      `diff for ${JSON.stringify(file)}`
    )
    const section = `### File ${JSON.stringify(file)}\n${perFile}`
    if (section.length > remaining) {
      sections.push(
        truncateExplicitly(
          section,
          remaining,
          `global diff input (${files.length - index} file(s) omitted or partial)`
        )
      )
      remaining = 0
      break
    }
    sections.push(section)
    remaining -= section.length
  }
  return truncateExplicitly(
    sections.join('\n\n'),
    MAX_DIFF_TOTAL,
    'global diff input'
  )
}

function truncateExplicitly(value: string, limit: number, label: string) {
  if (value.length <= limit) return value
  if (limit <= 0) return ''
  const marker = `\n[TRUNCATED ${label}: ${value.length - limit} additional character(s)]`
  if (marker.length >= limit) return '[TRUNCATED]'.slice(0, limit)
  return `${value.slice(0, limit - marker.length)}${marker}`
}

async function collectUntrackedMaterial(
  root: string,
  paths: string[]
): Promise<UntrackedMaterial> {
  const fingerprints: string[] = []
  const sections: string[] = []
  let remaining = MAX_UNTRACKED_TOTAL
  for (let index = 0; index < paths.length; index += 1) {
    const relativePath = paths[index]
    const absolutePath = join(root, relativePath)
    const metadata = await lstat(absolutePath)
    let bytes: Buffer
    let digest: string
    let kind: string
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      bytes = Buffer.from(target)
      digest = createHash('sha256').update(bytes).digest('hex')
      kind = 'symlink'
    } else if (metadata.isFile()) {
      const collected = await hashAndReadPrefix(
        absolutePath,
        MAX_UNTRACKED_PER_FILE
      )
      bytes = collected.prefix
      digest = collected.digest
      kind = 'file'
    } else {
      bytes = Buffer.alloc(0)
      digest = createHash('sha256').update(bytes).digest('hex')
      kind = 'other'
    }
    fingerprints.push(
      JSON.stringify([relativePath, kind, metadata.mode, metadata.size, digest])
    )

    if (remaining <= 0) continue
    const binary = bytes.includes(0)
    const content = binary
      ? `[binary content omitted; sha256=${digest}]`
      : bytes.toString('utf8')
    const prefixWasTruncated = metadata.isFile() && metadata.size > bytes.length
    const bounded = prefixWasTruncated
      ? `${truncateExplicitly(
          content,
          Math.max(0, MAX_UNTRACKED_PER_FILE - 80),
          `untracked content for ${JSON.stringify(relativePath)}`
        )}\n[TRUNCATED untracked file after ${bytes.length} of ${metadata.size} bytes]`
      : truncateExplicitly(
          content,
          MAX_UNTRACKED_PER_FILE,
          `untracked content for ${JSON.stringify(relativePath)}`
        )
    const section = `### Untracked ${kind} ${JSON.stringify(relativePath)} (${metadata.size} bytes, sha256=${digest})\n${bounded}`
    if (section.length > remaining) {
      sections.push(
        truncateExplicitly(
          section,
          remaining,
          `global untracked input (${paths.length - index} file(s) omitted or partial)`
        )
      )
      remaining = 0
    } else {
      sections.push(section)
      remaining -= section.length
    }
  }
  return {
    prose: truncateExplicitly(
      sections.join('\n\n'),
      MAX_UNTRACKED_TOTAL,
      'global untracked input'
    ),
    fingerprint: fingerprints.join('\n')
  }
}

async function hashAndReadPrefix(path: string, prefixLimit: number) {
  const hash = createHash('sha256')
  const prefixParts: Buffer[] = []
  let prefixLength = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(bytes)
    if (prefixLength < prefixLimit) {
      const part = bytes.subarray(0, prefixLimit - prefixLength)
      prefixParts.push(part)
      prefixLength += part.length
    }
  }
  return { digest: hash.digest('hex'), prefix: Buffer.concat(prefixParts) }
}

async function detectPackageScope(
  ctx: WorkflowContext,
  changedFiles: string[]
): Promise<string | null> {
  let root: {
    private?: boolean
    workspaces?: string[] | { packages?: string[] }
  }
  try {
    root = JSON.parse(await readFile(join(ctx.cwd, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  let patterns = Array.isArray(root.workspaces)
    ? root.workspaces
    : root.workspaces?.packages
  if (!patterns?.length) {
    try {
      const pnpmWorkspace = await readFile(
        join(ctx.cwd, 'pnpm-workspace.yaml'),
        'utf8'
      )
      patterns = [
        ...pnpmWorkspace.matchAll(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/gm)
      ].map((match) => match[1].trim())
    } catch {
      patterns = undefined
    }
  }
  if (!patterns?.length) return null

  const manifests = splitNul(
    await rawOutput(ctx, 'git', ['ls-files', '-z', ':(glob)**/package.json'])
  )
  const roots = manifests
    .map((file) => file.replace(/\/package\.json$/, ''))
    .filter((dir) =>
      patterns.some((pattern) => workspacePatternMatches(pattern, dir))
    )
  if (roots.length < 2) return null

  const affected = roots.filter((rootDir) =>
    changedFiles.some(
      (file) => file === rootDir || file.startsWith(`${rootDir}/`)
    )
  )
  return affected.length === 1 ? basename(affected[0]) : 'monorepo'
}

function workspacePatternMatches(pattern: string, directory: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '___GLOBSTAR___')
    .replaceAll('*', '[^/]*')
    .replaceAll('___GLOBSTAR___', '.*')
  return new RegExp(`^${escaped.replace(/\/$/, '')}$`).test(directory)
}

async function createBranch(
  ctx: WorkflowContext,
  type: ResolvedChangeType,
  commitMessage: string
) {
  const description = commitMessage.slice(`${type}: `.length)
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  if (!slug)
    throw new Error('Could not derive a branch name from the commit message')
  const branch = `${type}/${slug}`
  const [localExists, remoteExists] = await Promise.all([
    ctx.exec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd: ctx.cwd }
    ),
    ctx.exec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      { cwd: ctx.cwd }
    )
  ])
  if (localExists.code === 0 || remoteExists.code === 0)
    throw new Error(`Branch already exists: ${branch}`)
  await run(ctx, 'git', ['switch', '-c', branch])
  return branch
}

async function pushIfNeeded(
  ctx: WorkflowContext,
  branch: string,
  publishSha: string
) {
  const remote = await optionalOutput(ctx, 'git', [
    'rev-parse',
    '--verify',
    `origin/${branch}`
  ])
  if (remote !== publishSha) {
    if (remote) {
      const behind = Number.parseInt(
        await output(ctx, 'git', [
          'rev-list',
          '--count',
          `${publishSha}..origin/${branch}`
        ]),
        10
      )
      if (behind > 0)
        throw new Error(
          `Remote branch origin/${branch} contains commits not present in the inspected commit`
        )
      await run(ctx, 'git', [
        'push',
        'origin',
        `${publishSha}:refs/heads/${branch}`
      ])
    } else {
      await run(ctx, 'git', [
        'push',
        '--set-upstream',
        'origin',
        `${publishSha}:refs/heads/${branch}`
      ])
    }
  }

  const published = (
    await output(ctx, 'git', [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`
    ])
  ).split(/\s+/, 1)[0]
  if (published !== publishSha) {
    throw new Error(
      `Remote branch origin/${branch} did not reach the inspected commit after push`
    )
  }
}

async function createPullRequest(
  ctx: WorkflowContext,
  repository: GitHubRepository,
  base: string,
  title: string,
  body: string,
  branch: string
) {
  return withBodyFile(body, async (bodyFile) => {
    await run(ctx, 'gh', [
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      title,
      '--body-file',
      bodyFile
    ])
    const prs = await queryPullRequests(ctx, branch, repository)
    const pr = selectOpenPullRequest(prs)
    if (!pr)
      throw new Error('GitHub did not return the newly created pull request')
    return pr
  })
}

async function updatePullRequest(
  ctx: WorkflowContext,
  repository: GitHubRepository,
  pr: PullRequest,
  title: string,
  body: string
) {
  const current = selectPullRequestForSnapshot(
    await queryPullRequests(ctx, pr.headRefName, repository),
    'immediately before update'
  )
  assertPullRequestSnapshotUnchanged(pr, current, 'immediately before update')

  const payload = JSON.stringify({ title, body })
  await run(
    ctx,
    'gh',
    [
      'api',
      `repos/${repository.nameWithOwner}/pulls/${pr.number}`,
      '-X',
      'PATCH',
      '--input',
      '-',
      '--silent'
    ],
    payload
  )
  const refreshed = selectOpenPullRequest(
    await queryPullRequests(ctx, pr.headRefName, repository)
  )
  if (
    !refreshed ||
    refreshed.number !== pr.number ||
    refreshed.title !== title ||
    refreshed.body !== body ||
    refreshed.baseRefName !== pr.baseRefName ||
    refreshed.headRefName !== pr.headRefName
  ) {
    throw new Error(
      `Pull request #${pr.number} did not match the requested final state after update`
    )
  }
  return refreshed
}

async function withBodyFile<T>(
  body: string,
  callback: (path: string) => Promise<T>
) {
  const directory = await mkdtemp(join(tmpdir(), 'noice-changelog-'))
  try {
    const path = join(directory, 'pr-body.md')
    await writeFile(path, body, 'utf8')
    return await callback(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function result(
  status: WorkflowResult['status'],
  commit: string | null,
  pr: PullRequest | null,
  notes: string[]
): WorkflowResult {
  return { status, commit, pr, verification: 'Not run', notes }
}

function parseJson<T>(text: string, description: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON returned for ${description}`)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function run(
  ctx: WorkflowContext,
  command: string,
  args: string[],
  stdin?: string
): Promise<ExecResult> {
  // pi.exec intentionally has no shell interpolation. For the one API call that
  // needs stdin, gh accepts a temporary payload file through --input instead.
  if (stdin !== undefined) {
    return withBodyFile(stdin, async (path) =>
      checked(
        await ctx.exec(
          command,
          args.map((arg) => (arg === '-' ? path : arg)),
          { cwd: ctx.cwd }
        ),
        command,
        args
      )
    )
  }
  return checked(await ctx.exec(command, args, { cwd: ctx.cwd }), command, args)
}

async function rawOutput(
  ctx: WorkflowContext,
  command: string,
  args: string[],
  stdin?: string
) {
  return (await run(ctx, command, args, stdin)).stdout
}

async function output(
  ctx: WorkflowContext,
  command: string,
  args: string[],
  stdin?: string
) {
  return (await rawOutput(ctx, command, args, stdin)).trim()
}

async function optionalOutput(
  ctx: WorkflowContext,
  command: string,
  args: string[]
) {
  const response = await ctx.exec(command, args, { cwd: ctx.cwd })
  if (response.code !== 0) return ''
  return response.stdout.trim()
}

function checked(response: ExecResult, command: string, args: string[]) {
  if (response.code !== 0) {
    const detail =
      response.stderr.trim() ||
      response.stdout.trim() ||
      `exit ${response.code}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return response
}
