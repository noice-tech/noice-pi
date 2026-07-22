#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [packageName, workspacePath] = process.argv.slice(2)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (!packageName || !workspacePath) {
  throw new Error(
    'Usage: node scripts/smoke-pack.mjs <package-name> <workspace-path>'
  )
}

const packageDirectory = resolve(repositoryRoot, workspacePath)
const tempDirectory = mkdtempSync(join(tmpdir(), 'noice-pi-pack-'))

const packageSpecifications = {
  '@noice-tech/pi-changelog': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/changelog/index.ts',
      'package/extensions/changelog/rules.md',
      'package/extensions/changelog/worker-prompt.md',
      'package/prompts/release-notes.md',
      'package/prompts/setup-release-notes-style.md',
      'package/prompts/unreleased.md'
    ],
    piResources: {
      extensions: ['./extensions/changelog/index.ts'],
      prompts: ['./prompts/*.md']
    },
    exactArchive: true,
    dogfoodLocally: true
  },
  '@noice-tech/pi-github-issues': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/github-issues/index.ts'
    ],
    piResources: {
      extensions: ['./extensions/github-issues/index.ts']
    },
    exactArchive: true,
    dogfoodLocally: true
  },
  '@noice-tech/pi-terminal-bell': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/terminal-bell/index.ts'
    ],
    piResources: {
      extensions: ['./extensions/terminal-bell/index.ts']
    },
    exactArchive: true,
    dogfoodLocally: true
  },
  '@noice-tech/pi-work-context': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/work-context/index.ts'
    ],
    piResources: {
      extensions: ['./extensions/work-context/index.ts']
    },
    exactArchive: true,
    dogfoodLocally: true
  }
}

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function arraysEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

try {
  const sourceManifestPath = join(packageDirectory, 'package.json')
  if (!statSync(sourceManifestPath).isFile()) {
    fail(`Workspace path has no package.json: ${workspacePath}`)
  }

  const sourceManifest = readJson(sourceManifestPath)
  if (sourceManifest.name !== packageName) {
    fail(
      `Workspace package identity mismatch: expected ${packageName}, found ${sourceManifest.name}`
    )
  }

  const specification = packageSpecifications[packageName]
  if (!specification) {
    fail(`No smoke-pack specification configured for ${packageName}`)
  }

  execFileSync(
    'pnpm',
    ['--filter', packageName, 'pack', '--pack-destination', tempDirectory],
    { cwd: repositoryRoot, stdio: 'pipe' }
  )

  const archives = readdirSync(tempDirectory).filter((file) =>
    file.endsWith('.tgz')
  )
  if (archives.length !== 1) {
    fail(`Expected one packed archive, found ${archives.length}`)
  }

  const archive = join(tempDirectory, archives[0])
  const entries = execFileSync('tar', ['-tzf', archive], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ''))

  for (const path of specification.required) {
    if (!entries.includes(path)) fail(`Packed archive is missing ${path}`)
  }

  const forbiddenSegments = new Set([
    '.git',
    '.pi',
    '.pi-subagents',
    'node_modules',
    'scripts',
    'test',
    'tests'
  ])
  for (const entry of entries) {
    const segments = entry.split('/')
    const forbidden = segments.find((segment) => forbiddenSegments.has(segment))
    if (forbidden) fail(`Packed archive contains forbidden path: ${entry}`)
  }

  if (specification.exactArchive) {
    const unexpected = entries.filter(
      (entry) =>
        entry !== 'package' &&
        !specification.required.includes(entry) &&
        !specification.required.some((path) => path.startsWith(`${entry}/`))
    )
    if (unexpected.length > 0) {
      fail(`Packed archive contains unexpected paths: ${unexpected.join(', ')}`)
    }
  }

  if (specification.dogfoodLocally) {
    const settingsPath = join(repositoryRoot, '.pi', 'settings.json')
    const settings = readJson(settingsPath)
    const configuredPaths = Array.isArray(settings.packages)
      ? settings.packages.filter((entry) => typeof entry === 'string')
      : []
    const resolvesToSelectedPackage = configuredPaths.some(
      (entry) => resolve(dirname(settingsPath), entry) === packageDirectory
    )
    if (!resolvesToSelectedPackage) {
      fail(
        `${settingsPath} must reference ${workspacePath} relative to the settings file`
      )
    }
  }

  execFileSync('tar', ['-xzf', archive, '-C', tempDirectory])
  const manifest = readJson(join(tempDirectory, 'package', 'package.json'))

  if (manifest.name !== packageName) fail('Packed manifest has the wrong name')
  if (manifest.private === true) fail('Packed manifest must be publishable')
  if (manifest.publishConfig?.access !== 'public') {
    fail('Packed manifest must use public npm access')
  }

  const expectedResourceKeys = Object.keys(specification.piResources).sort()
  const actualResourceKeys = Object.keys(manifest.pi ?? {}).sort()
  if (!arraysEqual(actualResourceKeys, expectedResourceKeys)) {
    fail(
      `Packed manifest has unexpected Pi resource keys: ${actualResourceKeys.join(', ') || 'none'}`
    )
  }
  for (const [resourceType, expectedPaths] of Object.entries(
    specification.piResources
  )) {
    if (!arraysEqual(manifest.pi?.[resourceType], expectedPaths)) {
      fail(`Packed manifest has incorrect Pi ${resourceType} resource paths`)
    }
  }

  console.log(
    `Smoke-tested ${archives[0]} as ${packageName} (${specification.required.length} required files)`
  )
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}
