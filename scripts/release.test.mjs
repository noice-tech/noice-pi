import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const prepareScript = join(scriptsDirectory, 'prepare-release.mjs')
const publishScript = join(scriptsDirectory, 'publish-release.mjs')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env
  })

  if (!options.allowFailure && result.status !== 0) {
    assert.fail(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
    )
  }

  return result
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeExecutable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function createRepository(t, versions) {
  const root = mkdtempSync(join(tmpdir(), 'noice-release-test-'))
  const remote = join(root, 'remote.git')
  const worktree = join(root, 'worktree')
  const bin = join(root, 'bin')

  t.after(() => rmSync(root, { recursive: true, force: true }))

  mkdirSync(worktree)
  mkdirSync(bin)
  run('git', ['init', '--bare', remote])
  run('git', ['init', '--initial-branch=main'], { cwd: worktree })
  git(worktree, ['config', 'user.name', 'Release Test'])
  git(worktree, ['config', 'user.email', 'release-test@example.com'])

  for (const [directoryName, name, version] of versions) {
    const packageDirectory = join(worktree, 'packages', directoryName)
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name, version }, null, 2)}\n`
    )
  }

  git(worktree, ['add', '.'])
  git(worktree, ['commit', '-m', 'Initial'])
  git(worktree, ['remote', 'add', 'origin', remote])
  git(worktree, ['push', '-u', 'origin', 'main'])

  return { bin, remote, root, worktree }
}

function testEnvironment(bin, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${bin}:${process.env.PATH}`
  }
}

test('prepare releases every publishable package under one version and tag', (t) => {
  const repository = createRepository(t, [
    ['a', '@test/a', '1.0.0'],
    ['b', '@test/b', '1.2.0']
  ])
  const pnpmLog = join(repository.root, 'pnpm.log')

  writeExecutable(
    join(repository.bin, 'pnpm'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.PNPM_LOG, process.argv.slice(2).join(' ') + '\\n')
if (process.argv.slice(2).join(' ') !== 'check') process.exit(2)
`
  )

  const result = run('node', [prepareScript, '1.3.0'], {
    cwd: repository.worktree,
    env: testEnvironment(repository.bin, { PNPM_LOG: pnpmLog })
  })

  for (const directoryName of ['a', 'b']) {
    const manifest = JSON.parse(
      readFileSync(
        join(repository.worktree, 'packages', directoryName, 'package.json'),
        'utf8'
      )
    )
    assert.equal(manifest.version, '1.3.0')
  }
  assert.equal(
    git(repository.worktree, ['log', '-1', '--pretty=%s']),
    'Release 1.3.0'
  )
  assert.equal(
    git(repository.worktree, ['rev-list', '-n', '1', 'v1.3.0']),
    git(repository.worktree, ['rev-parse', 'HEAD'])
  )
  assert.match(
    git(repository.root, [
      '--git-dir',
      repository.remote,
      'show-ref',
      '--verify',
      'refs/tags/v1.3.0'
    ]),
    /refs\/tags\/v1\.3\.0$/
  )
  assert.equal(readFileSync(pnpmLog, 'utf8'), 'check\n')
  assert.match(result.stdout, /Nothing has been published to npm/)
  assert.match(result.stdout, /pnpm release:publish 1\.3\.0/)
})

test('prepare refuses files created by repository checks', (t) => {
  const repository = createRepository(t, [['a', '@test/a', '1.0.0']])

  writeExecutable(
    join(repository.bin, 'pnpm'),
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync('unexpected.txt', 'generated')
`
  )

  const result = run('node', [prepareScript, '1.1.0'], {
    allowFailure: true,
    cwd: repository.worktree,
    env: testEnvironment(repository.bin)
  })

  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /Found: packages\/a\/package\.json, unexpected\.txt/
  )
  assert.equal(git(repository.worktree, ['tag']), '')
})

test('publish validates the release and resumes a partial npm publication', (t) => {
  const version = '1.3.0'
  const repository = createRepository(t, [
    ['a', '@test/a', version],
    ['b', '@test/b', version]
  ])
  const npmState = join(repository.root, 'npm-state.txt')
  const commandLog = join(repository.root, 'commands.log')

  git(repository.worktree, [
    'commit',
    '--allow-empty',
    '-m',
    `Release ${version}`
  ])
  git(repository.worktree, [
    'tag',
    '-a',
    `v${version}`,
    '-m',
    `Release ${version}`
  ])
  git(repository.worktree, [
    'push',
    '--atomic',
    'origin',
    'main',
    `v${version}`
  ])
  const canonicalOrigin = 'git@github.com:noice-tech/noice-pi.git'
  git(repository.worktree, [
    'config',
    `url.${pathToFileURL(repository.remote).href}.insteadOf`,
    canonicalOrigin
  ])
  git(repository.worktree, ['remote', 'set-url', 'origin', canonicalOrigin])
  writeFileSync(npmState, `@test/a@${version}\n`)

  writeExecutable(
    join(repository.bin, 'gh'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, 'gh ' + args.join(' ') + '\\n')
if (!args.includes('--repo') || !args.includes('noice-tech/noice-pi')) process.exit(2)
console.log(JSON.stringify({ isDraft: false, isPrerelease: false, tagName: 'v${version}', url: 'https://github.com/noice-tech/noice-pi/releases/tag/v${version}' }))
`
  )
  writeExecutable(
    join(repository.bin, 'npm'),
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, 'npm ' + args.join(' ') + '\\n')
if (args[0] === 'whoami') {
  console.log('release-test')
  process.exit(0)
}
if (args[0] === 'view') {
  const versions = readFileSync(process.env.NPM_STATE, 'utf8').trim().split('\\n')
  if (versions.includes(args[1])) {
    console.log(JSON.stringify(args[1].slice(args[1].lastIndexOf('@') + 1)))
    process.exit(0)
  }
  console.error('npm error code E404')
  process.exit(1)
}
process.exit(2)
`
  )
  writeExecutable(
    join(repository.bin, 'pnpm'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, 'pnpm ' + args.join(' ') + '\\n')
if (args.length === 1 && args[0] === 'check') process.exit(0)
const filterIndex = args.indexOf('--filter')
if (filterIndex !== -1 && args.includes('publish')) {
  appendFileSync(process.env.NPM_STATE, args[filterIndex + 1] + '@${version}\\n')
  process.exit(0)
}
process.exit(2)
`
  )

  const env = testEnvironment(repository.bin, {
    COMMAND_LOG: commandLog,
    NPM_STATE: npmState
  })
  const firstRun = run('node', [publishScript, version], {
    cwd: repository.worktree,
    env
  })

  assert.match(firstRun.stdout, /Skipping @test\/a@1\.3\.0/)
  assert.match(firstRun.stdout, /Publishing @test\/b@1\.3\.0/)
  assert.deepEqual(readFileSync(npmState, 'utf8').trim().split('\n').sort(), [
    '@test/a@1.3.0',
    '@test/b@1.3.0'
  ])

  const logAfterFirstRun = readFileSync(commandLog, 'utf8')
  assert.doesNotMatch(logAfterFirstRun, /--filter @test\/a publish/)
  assert.match(
    logAfterFirstRun,
    /--filter @test\/b publish --access public --tag latest --publish-branch main/
  )

  const secondRun = run('node', [publishScript, version], {
    cwd: repository.worktree,
    env
  })
  const newLog = readFileSync(commandLog, 'utf8').slice(logAfterFirstRun.length)

  assert.match(
    secondRun.stdout,
    /Every package in v1\.3\.0 was already published/
  )
  assert.match(newLog, /npm whoami/)
  assert.match(newLog, /pnpm check/)
  assert.doesNotMatch(newLog, /pnpm --filter/)
})
