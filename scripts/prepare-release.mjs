#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
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
  fail('Usage: pnpm release:prepare <X.Y.Z>')
}
const [version] = arguments_

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

const packages = discoverPublishablePackages()
for (const candidate of packages) {
  const currentVersion = parseVersion(candidate.manifest.version)
  if (!currentVersion) {
    fail(
      `${candidate.manifest.name} has a non-canonical current version: ${candidate.manifest.version}`
    )
  }
  if (compareVersions(requestedVersion, currentVersion) <= 0) {
    fail(
      `Requested version ${version} must be greater than ${candidate.manifest.name}'s current version ${candidate.manifest.version}`
    )
  }
}

const tag = `v${version}`

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

for (const candidate of packages) {
  candidate.manifest.version = version
  writeFileSync(
    candidate.manifestPath,
    `${JSON.stringify(candidate.manifest, null, 2)}\n`
  )
}

try {
  run('pnpm', ['check'], { stdio: 'inherit' })
} catch {
  fail(
    `Repository checks failed. Package manifests remain updated to ${version}; fix the failure or restore them before retrying.`
  )
}

const changedFiles = new Set([
  ...git(['diff', '--name-only']).split('\n').filter(Boolean),
  ...git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean),
  ...git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
])
const expectedFiles = packages.map(({ manifestPath }) => manifestPath).sort()
const actualFiles = [...changedFiles].sort()
if (
  actualFiles.length !== expectedFiles.length ||
  actualFiles.some((file, index) => file !== expectedFiles[index])
) {
  fail(
    `Release preparation expected only these package manifests to change: ${expectedFiles.join(', ')}. Found: ${actualFiles.join(', ') || 'none'}`
  )
}

git(['add', '--', ...expectedFiles])
git(['commit', '-m', `Release ${version}`], { stdio: 'inherit' })
git(['tag', '-a', tag, '-m', `Release ${version}`])

try {
  git(['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' })
} catch {
  fail(
    `Atomic push failed; GitHub cannot have accepted only main or only ${tag}, but a transport error can leave the all-or-nothing remote outcome unknown. The release commit and tag remain local. Inspect origin, then retry \`git push --atomic origin main ${tag}\` if needed, or remove the local tag and release commit before rerunning release preparation.`
  )
}

console.log(`\nPrepared and pushed ${tag}. Nothing has been published to npm.`)
console.log('\nNext:')
console.log(
  `  1. Create a published GitHub Release for ${tag} (not a draft or prerelease).`
)
console.log(`  2. Run: pnpm release:publish ${version}`)
