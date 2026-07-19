#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [packageName, version] = process.argv.slice(2)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function git(args, options = {}) {
  const output = execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
  return typeof output === 'string' ? output.trim() : ''
}

if (!packageName || !version) {
  fail('Usage: pnpm release:prepare <workspace-package-name> <X.Y.Z>')
}

const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseVersion(value) {
  const match = canonicalVersionPattern.exec(value)
  return match ? match.slice(1).map((part) => BigInt(part)) : undefined
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1
    if (left[index] < right[index]) return -1
  }
  return 0
}

const requestedVersion = parseVersion(version)
if (!requestedVersion) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('Release preparation must run from main')
}

if (git(['status', '--porcelain'])) {
  fail('Working tree must be clean before preparing a release')
}

try {
  git(['fetch', 'origin', 'main'], { stdio: 'inherit' })
} catch {
  fail('Could not fetch origin/main; release preparation stopped')
}

const localHead = git(['rev-parse', 'HEAD'])
const remoteHead = git(['rev-parse', 'refs/remotes/origin/main'])
if (localHead !== remoteHead) {
  fail('Local main must exactly match origin/main before preparing a release')
}

const packageCandidates = readdirSync('packages')
  .map((entry) => join('packages', entry))
  .filter((directory) => statSync(directory).isDirectory())
  .map((directory) => ({
    directory,
    manifestPath: join(directory, 'package.json')
  }))
  .filter(({ manifestPath }) => {
    try {
      return statSync(manifestPath).isFile()
    } catch {
      return false
    }
  })
  .map((candidate) => ({
    ...candidate,
    manifest: JSON.parse(readFileSync(candidate.manifestPath, 'utf8'))
  }))
  .filter(({ manifest }) => manifest.private !== true)
  .filter(({ manifest }) => manifest.name === packageName)

if (packageCandidates.length !== 1) {
  fail(
    `Expected exactly one publishable packages/* workspace named ${packageName}; found ${packageCandidates.length}`
  )
}

const selected = packageCandidates[0]
const currentVersion = parseVersion(selected.manifest.version)
if (!currentVersion) {
  fail(
    `${packageName} has a non-canonical current version: ${selected.manifest.version}`
  )
}
if (compareVersions(requestedVersion, currentVersion) <= 0) {
  fail(
    `Requested version ${version} must be greater than current version ${selected.manifest.version}`
  )
}

const tag = `${packageName}@${version}`

try {
  git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
  fail(`Tag already exists locally: ${tag}`)
} catch (error) {
  if (error.status !== 1) throw error
}

try {
  git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])
  fail(`Tag already exists on origin: ${tag}`)
} catch (error) {
  if (error.status !== 2) throw error
}

selected.manifest.version = version
writeFileSync(
  selected.manifestPath,
  `${JSON.stringify(selected.manifest, null, 2)}\n`
)

try {
  execFileSync('pnpm', ['check'], { stdio: 'inherit' })
} catch {
  fail(
    `Repository checks failed. ${selected.manifestPath} remains updated to ${version}; fix the failure or restore it before retrying.`
  )
}

const changedFiles = git(['diff', '--name-only']).split('\n').filter(Boolean)
if (changedFiles.length !== 1 || changedFiles[0] !== selected.manifestPath) {
  fail(
    `Release preparation expected only ${selected.manifestPath} to change after checks; found: ${changedFiles.join(', ') || 'none'}`
  )
}

git(['add', '--', selected.manifestPath])
git(['commit', '-m', `Release ${packageName} ${version}`], {
  stdio: 'inherit'
})
git(['tag', '-a', tag, '-m', `Release ${packageName} ${version}`])

try {
  git(['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' })
} catch {
  fail(
    `Atomic push failed; GitHub cannot have published only main or only ${tag}, but a transport error can leave the all-or-nothing remote outcome unknown. The release commit and tag remain local. Inspect origin, then retry \`git push --atomic origin main ${tag}\` if needed, or remove the local tag and release commit before rerunning release preparation.`
  )
}

console.log(
  `Prepared ${tag} with an atomic GitHub push. Publish to npm separately after reviewing the pushed release.`
)
