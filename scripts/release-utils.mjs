import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function fail(message) {
  console.error(message)
  process.exit(1)
}

export function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
  if (typeof output !== 'string') return ''
  return options.trim === false ? output : output.trim()
}

export function git(args, options = {}) {
  return run('git', args, options)
}

export function parseVersion(value) {
  const match = canonicalVersionPattern.exec(value)
  return match ? match.slice(1).map((part) => BigInt(part)) : undefined
}

export function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1
    if (left[index] < right[index]) return -1
  }
  return 0
}

export function discoverPublishablePackages() {
  const packages = readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join('packages', entry.name)
      const manifestPath = join(directory, 'package.json')

      try {
        return {
          directory,
          manifestPath,
          manifest: JSON.parse(readFileSync(manifestPath, 'utf8'))
        }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    })
    .filter(Boolean)
    .filter(({ manifest }) => manifest.private !== true)

  if (packages.length === 0) {
    fail('Expected at least one publishable direct child of packages/')
  }

  const packageNames = new Set()
  for (const candidate of packages) {
    if (
      typeof candidate.manifest.name !== 'string' ||
      candidate.manifest.name.length === 0
    ) {
      fail(`${candidate.manifestPath} must define a package name`)
    }
    if (packageNames.has(candidate.manifest.name)) {
      fail(`Duplicate publishable package name: ${candidate.manifest.name}`)
    }
    packageNames.add(candidate.manifest.name)

    if (typeof candidate.manifest.version !== 'string') {
      fail(`${candidate.manifestPath} must define a package version`)
    }
  }

  return packages.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name)
  )
}
