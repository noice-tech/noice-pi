import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  executeCommitWorkflow,
  isCurrentGeneratedBody,
  mergePullRequestBody,
  resolveBaseBranch,
  selectOpenPullRequest,
  validateCommitProse,
  WorkflowFailure
} from '../extensions/changelog/commit-workflow.ts'

const execFileAsync = promisify(execFile)

const modelProse = (overrides = {}) => ({
  commitType: 'internal',
  commitMessage: 'internal: make commit handling deterministic',
  prType: 'internal',
  prHeadline: 'make commit handling deterministic',
  summary: ['Move repository inspection and mutation into the extension.'],
  publicSummary: 'None.',
  context: ['The model now supplies prose only.'],
  ...overrides
})
const prose = validateCommitProse(modelProse(), 'internal', 'changelog')

function ok(stdout = '') {
  return { stdout, stderr: '', code: 0, killed: false }
}

async function git(cwd, ...args) {
  const response = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return response.stdout.trim()
}

async function repositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'noice-commit-test-'))
  const remote = join(directory, 'remote.git')
  const repo = join(directory, 'repo')
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await git(repo, 'config', 'user.name', 'Test User')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'switch', '-c', 'main')
  await writeFile(join(repo, 'package.json'), '{"private":true}\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'internal: initialize')
  await git(repo, 'push', '-u', 'origin', 'main')

  const prs = []
  const calls = []
  const ctx = {
    cwd: repo,
    async exec(command, args, options = {}) {
      calls.push({ command, args: [...args], cwd: options.cwd })
      if (command === 'git' || command === 'env') {
        try {
          const response = await execFileAsync(command, args, {
            cwd: options.cwd,
            encoding: 'utf8'
          })
          return ok(response.stdout)
        } catch (error) {
          return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? String(error),
            code: error.code ?? 1,
            killed: false
          }
        }
      }
      const line = args.join(' ')
      if (line.startsWith('repo view ')) {
        return ok(
          JSON.stringify({
            nameWithOwner: 'owner/repo',
            defaultBranchRef: { name: 'main' }
          })
        )
      }
      if (line.startsWith('pr list ')) {
        const head = args[args.indexOf('--head') + 1]
        return ok(JSON.stringify(prs.filter((pr) => pr.headRefName === head)))
      }
      if (line.startsWith('pr create ')) {
        const head = args[args.indexOf('--head') + 1]
        const base = args[args.indexOf('--base') + 1]
        const title = args[args.indexOf('--title') + 1]
        const body = await readFile(
          args[args.indexOf('--body-file') + 1],
          'utf8'
        )
        prs.push({
          number: prs.length + 1,
          title,
          body,
          baseRefName: base,
          headRefName: head,
          headRepositoryOwner: { login: 'owner' },
          state: 'OPEN',
          url: `https://example/${prs.length + 1}`
        })
        return ok('https://example/new\n')
      }
      if (line.startsWith('api ')) {
        const number = Number(args[1].split('/').at(-1))
        const payload = JSON.parse(
          await readFile(args[args.indexOf('--input') + 1], 'utf8')
        )
        const pr = prs.find((item) => item.number === number)
        Object.assign(pr, payload)
        return ok()
      }
      throw new Error(`unexpected gh command: ${line}`)
    }
  }
  return {
    directory,
    repo,
    prs,
    calls,
    ctx,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

test('strict prose validation separates current commit type from cumulative PR type', () => {
  const generated = validateCommitProse(
    modelProse({
      commitType: 'internal',
      commitMessage: 'internal: add regression coverage',
      prType: 'fix',
      prHeadline: 'prevent duplicate changelog entries',
      publicSummary: 'Duplicate changelog entries are no longer emitted.'
    }),
    'internal',
    'changelog'
  )
  assert.equal(generated.commitType, 'internal')
  assert.equal(generated.prType, 'fix')
  assert.equal(
    generated.prTitle,
    'fix(changelog): prevent duplicate changelog entries'
  )
})

test('strict prose validation rejects extras, prefixed headlines, and selected-type changes', () => {
  assert.throws(
    () =>
      validateCommitProse(
        { ...modelProse(), command: 'git push' },
        'internal',
        'changelog'
      ),
    /keys must be exactly/
  )
  assert.throws(
    () =>
      validateCommitProse(
        modelProse({ prHeadline: 'internal: wrong' }),
        'internal',
        'changelog'
      ),
    /must not include/
  )
  assert.throws(
    () =>
      validateCommitProse(
        modelProse({ commitType: 'fix', commitMessage: 'fix: x' }),
        'internal',
        'changelog'
      ),
    /changed the selected commit type/
  )
})

test('PR body ownership is deterministic while manual sections are preserved', () => {
  const existing = `Intro that should stay.\n\n## Summary\n\n- stale\n\n## Reviewer notes\n\n- Keep this checklist\n\n## Changelog\n\nPublic summary:\n\n- stale\n\n## Screenshots\n\n![demo](demo.png)\n\n## Verification\n\n- stale`
  const body = mergePullRequestBody(existing, prose, 'Not run')

  assert.match(body, /## Summary\n\n- Move repository inspection/)
  assert.match(body, /Public summary:\n\n- None\./)
  assert.match(body, /## Verification\n\n- Not run/)
  assert.match(body, /Intro that should stay\./)
  assert.match(body, /## Reviewer notes\n\n- Keep this checklist/)
  assert.match(body, /## Screenshots\n\n!\[demo\]/)
  assert.doesNotMatch(body, /- stale/)
  assert.equal(mergePullRequestBody(body, prose, 'Not run'), body)
})

test('generated PR bodies carry a deterministic rerun marker', () => {
  const body = mergePullRequestBody('', prose, 'Not run', 'abc123')
  assert.equal(isCurrentGeneratedBody(body, 'abc123'), true)
  assert.equal(isCurrentGeneratedBody(body, 'def456'), false)
  assert.equal(
    isCurrentGeneratedBody(body.replace('Not run', 'npm test'), 'abc123'),
    false
  )
})

test('configured base uses noice-base before gh-merge-base', async () => {
  const calls = []
  const ctx = {
    cwd: '/repo',
    async exec(command, args) {
      const line = `${command} ${args.join(' ')}`
      calls.push(line)
      if (line === 'git config --get branch.work.noice-base')
        return ok('staging\n')
      if (line === 'git show-ref --verify --quiet refs/remotes/origin/staging')
        return ok()
      if (line === 'git rev-parse --verify origin/staging') return ok('abc')
      throw new Error(`unexpected command: ${line}`)
    }
  }

  assert.equal(await resolveBaseBranch(ctx, 'work', 'main'), 'staging')
  assert.equal(
    calls.some((line) => line.includes('gh-merge-base')),
    false
  )
})

test('base inference evaluates non-preferred refs and chooses the newest ancestor', async () => {
  const ctx = {
    cwd: '/repo',
    async exec(command, args) {
      const line = `${command} ${args.join(' ')}`
      if (line.startsWith('git config --get ')) return { ...ok(), code: 1 }
      if (line.startsWith('git for-each-ref '))
        return ok('origin/main\norigin/topic-base\n')
      if (line === 'git merge-base HEAD origin/main') return ok('aaa')
      if (line === 'git merge-base HEAD origin/topic-base') return ok('bbb')
      if (line === 'git show -s --format=%ct aaa') return ok('100')
      if (line === 'git show -s --format=%ct bbb') return ok('200')
      throw new Error(`unexpected command: ${line}`)
    }
  }
  assert.equal(await resolveBaseBranch(ctx, 'work', 'main'), 'topic-base')
})

test('base inference fails when equally recent candidates are ambiguous', async () => {
  const ctx = {
    cwd: '/repo',
    async exec(command, args) {
      const line = `${command} ${args.join(' ')}`
      if (line.startsWith('git config --get ')) return { ...ok(), code: 1 }
      if (line.startsWith('git for-each-ref '))
        return ok('origin/main\norigin/staging\n')
      if (line === 'git merge-base HEAD origin/main') return ok('abc')
      if (line === 'git merge-base HEAD origin/staging') return ok('abc')
      if (line === 'git show -s --format=%ct abc') return ok('100')
      throw new Error(`unexpected command: ${line}`)
    }
  }

  await assert.rejects(
    resolveBaseBranch(ctx, 'work', 'main'),
    /Ambiguous PR base \(main, staging\)/
  )
})

test('dirty default branch is forked, includes untracked content, and runs from Git top-level', async () => {
  const fixture = await repositoryFixture()
  try {
    await mkdir(join(fixture.repo, 'nested'))
    await writeFile(join(fixture.repo, 'new file.txt'), 'untracked evidence\n')
    fixture.prs.push({
      number: 99,
      title: 'internal: historical default-branch PR',
      body: '',
      baseRefName: 'main',
      headRefName: 'main',
      headRepositoryOwner: { login: 'owner' },
      state: 'MERGED',
      url: 'https://example/99'
    })
    fixture.ctx.cwd = join(fixture.repo, 'nested')
    let input
    const workflow = await executeCommitWorkflow(
      fixture.ctx,
      'internal',
      'cover untracked state',
      {
        async generateProse(value) {
          input = value
          return modelProse({
            commitMessage: 'internal: cover untracked state',
            prHeadline: 'cover untracked state'
          })
        }
      }
    )
    assert.equal(workflow.status, 'committed')
    assert.match(
      await git(fixture.repo, 'branch', '--show-current'),
      /^internal\//
    )
    assert.match(input.status, /^\?\? new file\.txt$/m)
    assert.match(input.untrackedMaterial, /untracked evidence/)
    assert.equal(fixture.prs.length, 2)
    assert.ok(
      fixture.prs.some(
        (pr) => pr.state === 'OPEN' && pr.headRefName.startsWith('internal/')
      )
    )
    assert.equal(
      fixture.calls.some(
        ({ command, args }) =>
          command === 'gh' &&
          args[0] === 'pr' &&
          args[1] === 'list' &&
          args[args.indexOf('--head') + 1] === 'main'
      ),
      false,
      'historical default-branch PRs must not be queried'
    )
    const discoveredRoot = await git(
      fixture.repo,
      'rev-parse',
      '--show-toplevel'
    )
    assert.ok(
      fixture.calls
        .slice(1)
        .every((call) => !call.cwd || call.cwd === discoveredRoot),
      'all operations after top-level discovery use the repository root'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('clean-ahead default branch is forked before push without creating another commit', async () => {
  const fixture = await repositoryFixture()
  try {
    await writeFile(
      join(fixture.repo, 'package.json'),
      '{"private":true,"description":"ahead"}\n'
    )
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: local ahead')
    const head = await git(fixture.repo, 'rev-parse', 'HEAD')
    const workflow = await executeCommitWorkflow(fixture.ctx, 'internal', '', {
      generateProse: async () =>
        modelProse({
          commitMessage: 'internal: local ahead',
          prHeadline: 'local ahead'
        })
    })
    assert.equal(workflow.commit, null)
    assert.notEqual(await git(fixture.repo, 'branch', '--show-current'), 'main')
    assert.equal(await git(fixture.repo, 'rev-parse', 'HEAD'), head)
    assert.equal(fixture.prs.length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('repository drift during prose generation aborts before branch, stage, commit, or push', async () => {
  const fixture = await repositoryFixture()
  try {
    await writeFile(join(fixture.repo, 'package.json'), '{"dirty":true}\n')
    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        async generateProse() {
          await writeFile(
            join(fixture.repo, 'package.json'),
            '{"drifted":true}\n'
          )
          return modelProse()
        }
      }),
      (error) =>
        error instanceof WorkflowFailure &&
        /Repository changed/.test(error.message)
    )
    assert.equal(await git(fixture.repo, 'branch', '--show-current'), 'main')
    assert.equal(await git(fixture.repo, 'diff', '--cached'), '')
    assert.equal(
      fixture.calls.some(({ args }) => args[0] === 'push'),
      false
    )
  } finally {
    await fixture.cleanup()
  }
})

test('unmerged repository status is rejected before prose generation', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'conflicting')
    await writeFile(join(fixture.repo, 'package.json'), '{"side":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: side change')
    await git(fixture.repo, 'switch', 'main')
    await writeFile(join(fixture.repo, 'package.json'), '{"main":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: main change')
    await assert.rejects(
      execFileAsync('git', ['merge', 'conflicting'], {
        cwd: fixture.repo,
        encoding: 'utf8'
      })
    )
    let generated = false

    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        async generateProse() {
          generated = true
          return modelProse()
        }
      }),
      /Unmerged repository status/
    )
    assert.equal(generated, false)
  } finally {
    await fixture.cleanup()
  }
})

test('a change arriving after snapshot revalidation but before staging is never committed or pushed', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"dirty":true}\n')
    const originalHead = await git(fixture.repo, 'rev-parse', 'HEAD')
    const originalExec = fixture.ctx.exec.bind(fixture.ctx)
    let injected = false
    fixture.ctx.exec = async (command, args, options) => {
      if (!injected && command === 'git' && args.join(' ') === 'add -A') {
        injected = true
        await writeFile(
          join(fixture.repo, 'package.json'),
          '{"arrivedAfterRevalidation":true}\n'
        )
      }
      return originalExec(command, args, options)
    }

    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        generateProse: async () => modelProse()
      }),
      (error) =>
        error instanceof WorkflowFailure &&
        /changed before staging/.test(error.message)
    )
    assert.equal(injected, true)
    assert.equal(await git(fixture.repo, 'rev-parse', 'HEAD'), originalHead)
    assert.equal(
      fixture.calls.some(({ args }) => args[0] === 'push'),
      false
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a concurrent commit created after validation is never pushed', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"dirty":true}\n')
    const originalExec = fixture.ctx.exec.bind(fixture.ctx)
    let injected = false
    fixture.ctx.exec = async (command, args, options) => {
      if (
        !injected &&
        command === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--short' &&
        typeof args[2] === 'string'
      ) {
        injected = true
        await git(
          fixture.repo,
          'commit',
          '--allow-empty',
          '-m',
          'internal: concurrent unreviewed commit'
        )
      }
      return originalExec(command, args, options)
    }

    const workflow = await executeCommitWorkflow(fixture.ctx, 'internal', '', {
      generateProse: async () => modelProse()
    })
    assert.equal(workflow.status, 'committed')
    assert.equal(injected, true)
    const localHead = await git(fixture.repo, 'rev-parse', 'HEAD')
    const reviewedCommit = await git(fixture.repo, 'rev-parse', 'HEAD^')
    const branch = await git(fixture.repo, 'branch', '--show-current')
    const remoteLine = await git(
      fixture.repo,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`
    )
    assert.equal(remoteLine.split(/\s+/, 1)[0], reviewedCommit)
    assert.notEqual(localHead, reviewedCommit)
  } finally {
    await fixture.cleanup()
  }
})

test('post-commit worktree changes are reported and never pushed', async () => {
  const fixture = await repositoryFixture()
  try {
    await writeFile(join(fixture.repo, 'package.json'), '{"dirty":true}\n')
    await writeFile(
      join(fixture.repo, '.git', 'hooks', 'post-commit'),
      '#!/bin/sh\nprintf "hook drift\\n" > hook.txt\n',
      { mode: 0o755 }
    )
    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        generateProse: async () => modelProse()
      }),
      (error) =>
        error instanceof WorkflowFailure &&
        error.workflow.commit !== null &&
        /not clean after commit/.test(error.message)
    )
    assert.equal(
      fixture.calls.some(({ args }) => args[0] === 'push'),
      false,
      'post-commit drift must prevent push'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('clean rerun refreshes explicit metadata and stale PR title, then verifies PATCH state', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"work":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'fix: correct behavior')
    await git(fixture.repo, 'push', '-u', 'origin', 'work')
    fixture.prs.push({
      number: 7,
      title: 'fix: stale title',
      body: 'Manual introduction.\n',
      baseRefName: 'main',
      headRefName: 'work',
      headRepositoryOwner: { login: 'owner' },
      state: 'OPEN',
      url: 'https://example/7'
    })
    let receivedContext
    const workflow = await executeCommitWorkflow(
      fixture.ctx,
      'internal',
      'refresh release metadata',
      {
        async generateProse(input) {
          receivedContext = input.userContext
          return modelProse({
            commitMessage: 'internal: refresh release metadata',
            prType: 'fix',
            prHeadline: 'correct cumulative behavior',
            publicSummary: 'The behavior is now correct.'
          })
        }
      }
    )
    assert.equal(receivedContext, 'refresh release metadata')
    assert.equal(workflow.status, 'updated_pr')
    assert.equal(fixture.prs[0].title, 'fix: correct cumulative behavior')
    assert.match(fixture.prs[0].body, /Manual introduction\./)
    const listCalls = fixture.calls.filter(
      ({ command, args }) =>
        command === 'gh' && args[0] === 'pr' && args[1] === 'list'
    )
    assert.ok(
      listCalls.length >= 3,
      'inspection, pre-update, and post-PATCH queries are required'
    )
  } finally {
    await fixture.cleanup()
  }
})

test('fork PRs with the same branch name are excluded by repository owner', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"work":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: local work')
    await git(fixture.repo, 'push', '-u', 'origin', 'work')
    fixture.prs.push(
      {
        number: 7,
        title: 'internal: stale local title',
        body: 'Local manual notes.\n',
        baseRefName: 'main',
        headRefName: 'work',
        headRepositoryOwner: { login: 'owner' },
        state: 'OPEN',
        url: 'https://example/7'
      },
      {
        number: 8,
        title: 'fix: unrelated fork title',
        body: 'Fork body must remain untouched.\n',
        baseRefName: 'main',
        headRefName: 'work',
        headRepositoryOwner: { login: 'fork-owner' },
        state: 'OPEN',
        url: 'https://example/8'
      }
    )

    const workflow = await executeCommitWorkflow(fixture.ctx, 'internal', '', {
      generateProse: async () =>
        modelProse({
          commitMessage: 'internal: local work',
          prHeadline: 'update only the local pull request'
        })
    })

    assert.equal(workflow.pr.number, 7)
    assert.equal(fixture.prs[1].title, 'fix: unrelated fork title')
    assert.equal(fixture.prs[1].body, 'Fork body must remain untouched.\n')
    assert.ok(
      fixture.calls
        .filter(
          ({ command, args }) =>
            command === 'gh' && args[0] === 'pr' && args[1] === 'list'
        )
        .every(({ args }) =>
          args[args.indexOf('--json') + 1].includes('headRepositoryOwner')
        )
    )
  } finally {
    await fixture.cleanup()
  }
})

test('PR body drift during prose generation aborts before PATCH', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"work":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: local work')
    await git(fixture.repo, 'push', '-u', 'origin', 'work')
    fixture.prs.push({
      number: 7,
      title: 'internal: existing title',
      body: 'Original manual notes.\n',
      baseRefName: 'main',
      headRefName: 'work',
      headRepositoryOwner: { login: 'owner' },
      state: 'OPEN',
      url: 'https://example/7'
    })

    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        async generateProse() {
          fixture.prs[0].body = 'Concurrent manual edit.\n'
          return modelProse({ prHeadline: 'generated title' })
        }
      }),
      (error) =>
        error instanceof WorkflowFailure &&
        /Pull request snapshot changed/.test(error.message)
    )
    assert.equal(fixture.prs[0].body, 'Concurrent manual edit.\n')
    assert.equal(
      fixture.calls.some(
        ({ command, args }) => command === 'gh' && args[0] === 'api'
      ),
      false
    )
  } finally {
    await fixture.cleanup()
  }
})

test('PR title drift immediately before PATCH aborts without overwriting it', async () => {
  const fixture = await repositoryFixture()
  try {
    await git(fixture.repo, 'switch', '-c', 'work')
    await writeFile(join(fixture.repo, 'package.json'), '{"work":true}\n')
    await git(fixture.repo, 'add', '.')
    await git(fixture.repo, 'commit', '-m', 'internal: local work')
    await git(fixture.repo, 'push', '-u', 'origin', 'work')
    fixture.prs.push({
      number: 7,
      title: 'internal: existing title',
      body: 'Manual notes.\n',
      baseRefName: 'main',
      headRefName: 'work',
      headRepositoryOwner: { login: 'owner' },
      state: 'OPEN',
      url: 'https://example/7'
    })
    const originalExec = fixture.ctx.exec.bind(fixture.ctx)
    let listCount = 0
    fixture.ctx.exec = async (command, args, options) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        listCount += 1
        if (listCount === 3) {
          fixture.prs[0].title = 'internal: concurrent title edit'
        }
      }
      return originalExec(command, args, options)
    }

    await assert.rejects(
      executeCommitWorkflow(fixture.ctx, 'internal', '', {
        generateProse: async () =>
          modelProse({ prHeadline: 'generated replacement title' })
      }),
      (error) =>
        error instanceof WorkflowFailure &&
        /immediately before update/.test(error.message)
    )
    assert.equal(fixture.prs[0].title, 'internal: concurrent title edit')
    assert.equal(
      fixture.calls.some(
        ({ command, args }) => command === 'gh' && args[0] === 'api'
      ),
      false
    )
  } finally {
    await fixture.cleanup()
  }
})

test('PR matching fails closed for closed, merged, or multiple matches', () => {
  const open = {
    number: 1,
    title: 'x',
    body: '',
    baseRefName: 'main',
    headRefName: 'work',
    headRepositoryOwner: { login: 'owner' },
    state: 'OPEN',
    url: 'https://example/1'
  }
  assert.deepEqual(selectOpenPullRequest([open]), open)
  assert.equal(selectOpenPullRequest([]), null)
  for (const state of ['CLOSED', 'MERGED']) {
    assert.throws(
      () => selectOpenPullRequest([{ ...open, state }]),
      /refusing to create or update/
    )
  }
  assert.throws(
    () => selectOpenPullRequest([open, { ...open, number: 2 }]),
    /Multiple pull requests/
  )
})
