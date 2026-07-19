#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  compareVersions,
  discoverPublishablePackages,
  fail,
  git,
  parseVersion,
  run
} from './release-utils.mjs'

const arguments_ = process.argv.slice(2)
if (arguments_.length !== 1) {
  fail('Usage: pnpm release:publish <X.Y.Z>')
}
const [version] = arguments_

if (!parseVersion(version)) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

const tag = `v${version}`
const githubRepository = 'noice-tech/noice-pi'

function githubRepositoryFromUrl(url) {
  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  if (scpMatch) return scpMatch[1]

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.hostname !== 'github.com') return undefined
    return parsedUrl.pathname.replace(/^\//, '').replace(/\.git$/, '')
  } catch {
    return undefined
  }
}

const originUrl = git(['config', '--get', 'remote.origin.url'])
if (githubRepositoryFromUrl(originUrl) !== githubRepository) {
  fail(
    `origin must be the canonical ${githubRepository} GitHub repository; found ${originUrl}`
  )
}

if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('Release publication must run from main')
}

if (git(['status', '--porcelain'])) {
  fail('Working tree must be clean before publishing a release')
}

function verifyRemoteRelease() {
  try {
    git(['fetch', 'origin', 'main', '--tags'], { stdio: 'inherit' })
  } catch {
    fail('Could not fetch origin/main and its tags; publication stopped')
  }

  const localHead = git(['rev-parse', 'HEAD'])
  const remoteHead = git(['rev-parse', 'refs/remotes/origin/main'])
  if (localHead !== remoteHead) {
    fail(
      'Local main must exactly match origin/main before publishing a release'
    )
  }

  try {
    git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
  } catch (error) {
    if (error.status === 1) fail(`Tag does not exist locally: ${tag}`)
    throw error
  }

  const taggedCommit = git(['rev-list', '-n', '1', tag])
  if (taggedCommit !== localHead) {
    fail(`${tag} must point to the current main commit`)
  }

  const localTagObject = git(['rev-parse', `refs/tags/${tag}`])
  const remoteTagLine = git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`
  ])
    .split('\n')
    .find((line) => line.endsWith(`refs/tags/${tag}`))
  const remoteTagObject = remoteTagLine?.split(/\s+/)[0]
  if (!remoteTagObject) {
    fail(`Tag does not exist on origin: ${tag}`)
  }
  if (remoteTagObject !== localTagObject) {
    fail(`Local and origin tags differ: ${tag}`)
  }

  let release
  try {
    release = JSON.parse(
      run('gh', [
        'release',
        'view',
        tag,
        '--repo',
        githubRepository,
        '--json',
        'isDraft,isPrerelease,tagName,url'
      ])
    )
  } catch {
    fail(
      `Could not read the GitHub Release for ${tag} in ${githubRepository}. Create it and authenticate gh before publishing.`
    )
  }

  if (release.tagName !== tag) {
    fail(`GitHub Release tag is ${release.tagName}, expected ${tag}`)
  }
  if (release.isDraft) {
    fail(`GitHub Release ${tag} is still a draft`)
  }
  if (release.isPrerelease) {
    fail(
      `GitHub Release ${tag} is a prerelease, but ${version} is a stable npm version`
    )
  }

  return release
}

let release = verifyRemoteRelease()

const packages = discoverPublishablePackages()
for (const candidate of packages) {
  if (candidate.manifest.version !== version) {
    fail(
      `${candidate.manifest.name} is at ${candidate.manifest.version}, not release version ${version}`
    )
  }
}

function npmNotFound(result) {
  const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return /E404|404 Not Found|No match found for version/i.test(diagnostic)
}

function isPublished(packageName) {
  const spec = `${packageName}@${version}`
  const result = spawnSync('npm', ['view', spec, 'version', '--json'], {
    encoding: 'utf8'
  })

  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout) === version
    } catch {
      fail(`npm returned an unreadable version for ${spec}`)
    }
  }

  if (npmNotFound(result)) return false

  const diagnostic = result.error?.message ?? result.stderr ?? result.stdout
  fail(`Could not check whether ${spec} is published:\n${diagnostic.trim()}`)
}

function assertLatestWillNotMoveBackward(packageName) {
  if (isPublished(packageName)) return

  const result = spawnSync(
    'npm',
    ['view', packageName, 'dist-tags.latest', '--json'],
    { encoding: 'utf8' }
  )
  if (npmNotFound(result)) return
  if (result.status !== 0) {
    const diagnostic = result.error?.message ?? result.stderr ?? result.stdout
    fail(
      `Could not read npm's latest version for ${packageName}:\n${diagnostic.trim()}`
    )
  }

  let latestVersion
  try {
    latestVersion = JSON.parse(result.stdout)
  } catch {
    fail(`npm returned an unreadable latest version for ${packageName}`)
  }

  const parsedLatestVersion = parseVersion(latestVersion)
  const parsedReleaseVersion = parseVersion(version)
  if (!parsedLatestVersion) {
    fail(
      `${packageName}'s npm latest tag is ${latestVersion}, which is not a canonical stable version; inspect it before publishing`
    )
  }
  if (compareVersions(parsedReleaseVersion, parsedLatestVersion) < 0) {
    fail(
      `Publishing ${packageName}@${version} with tag latest would move latest backward from ${latestVersion}`
    )
  }
}

let npmUser
try {
  npmUser = run('npm', ['whoami'])
} catch {
  fail('npm authentication failed. Log in with `npm login`, then retry.')
}
console.log(`Authenticated to npm as ${npmUser}.`)

try {
  run('pnpm', ['check'], { stdio: 'inherit' })
} catch {
  fail('Repository checks failed; nothing was published by this run')
}

if (git(['status', '--porcelain'])) {
  fail('Repository checks changed the working tree; publication stopped')
}

release = verifyRemoteRelease()

let publishedAnyPackage = false
for (const candidate of packages) {
  const packageName = candidate.manifest.name
  if (isPublished(packageName)) {
    console.log(`Skipping ${packageName}@${version}: already published.`)
    continue
  }

  release = verifyRemoteRelease()
  assertLatestWillNotMoveBackward(packageName)
  if (git(['status', '--porcelain'])) {
    fail('Working tree changed before npm publication; publication stopped')
  }

  console.log(`Publishing ${packageName}@${version} to npm with tag latest...`)
  try {
    run(
      'pnpm',
      [
        '--filter',
        packageName,
        'publish',
        '--access',
        'public',
        '--tag',
        'latest',
        '--publish-branch',
        'main'
      ],
      { stdio: 'inherit' }
    )
    publishedAnyPackage = true
  } catch {
    fail(
      `Publishing stopped at ${packageName}@${version}. npm publication is not atomic: packages published earlier in this run remain published. Fix the problem and rerun \`pnpm release:publish ${version}\`; already-published package versions will be skipped.`
    )
  }
}

if (publishedAnyPackage) {
  console.log(`\nPublished every package in ${tag} to npm.`)
} else {
  console.log(`\nEvery package in ${tag} was already published to npm.`)
}
console.log(release.url)
