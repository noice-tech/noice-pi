#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createJiti } from 'jiti'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync
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
      'package/prompts/release-notes.md',
      'package/prompts/setup-release-notes-style.md',
      'package/prompts/unreleased.md',
      'package/node_modules/@noice-tech/pi-commit/package.json',
      'package/node_modules/@noice-tech/pi-commit/README.md',
      'package/node_modules/@noice-tech/pi-commit/LICENSE',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/command.ts',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/config.ts',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/index.ts',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/opinionated-format.md',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/register.ts',
      'package/node_modules/@noice-tech/pi-commit/extensions/commit/worker-prompt.md'
    ],
    allowedForbiddenPrefixes: ['package/node_modules/@noice-tech/pi-commit/'],
    piResources: {
      extensions: [
        './node_modules/@noice-tech/pi-commit/extensions/commit/index.ts'
      ],
      prompts: ['./prompts/*.md']
    },
    exactArchive: true,
    dogfoodLocally: true
  },
  '@noice-tech/pi-commit': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/commit/command.ts',
      'package/extensions/commit/config.ts',
      'package/extensions/commit/index.ts',
      'package/extensions/commit/opinionated-format.md',
      'package/extensions/commit/register.ts',
      'package/extensions/commit/worker-prompt.md'
    ],
    piResources: {
      extensions: ['./extensions/commit/index.ts']
    },
    exactArchive: true,
    dogfoodLocally: true
  },
  '@noice-tech/pi-cutover': {
    required: [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/cutover/index.ts'
    ],
    piResources: {
      extensions: ['./extensions/cutover/index.ts']
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

function statOrUndefined(path) {
  try {
    return statSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
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
    const explicitlyAllowed = specification.allowedForbiddenPrefixes?.some(
      (prefix) => entry.startsWith(prefix)
    )
    if (forbidden && !explicitlyAllowed) {
      fail(`Packed archive contains forbidden path: ${entry}`)
    }
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

  const exportedPaths = Object.values(manifest.exports ?? {}).filter(
    (value) => typeof value === 'string'
  )
  for (const exportedPath of exportedPaths) {
    const archivePath = `package/${exportedPath.replace(/^\.\//, '')}`
    if (!entries.includes(archivePath)) {
      fail(`Packed manifest export is missing from archive: ${exportedPath}`)
    }
  }

  if (packageName === '@noice-tech/pi-changelog') {
    if (manifest.dependencies?.['@noice-tech/pi-commit'] !== manifest.version) {
      fail(
        'Packed changelog manifest must use its lockstep @noice-tech/pi-commit version'
      )
    }
    if (!manifest.bundledDependencies?.includes('@noice-tech/pi-commit')) {
      fail('Packed changelog manifest must bundle @noice-tech/pi-commit')
    }
  }

  const extractedPackage = join(tempDirectory, 'package')
  const extractedNodeModules = join(extractedPackage, 'node_modules')
  mkdirSync(extractedNodeModules, { recursive: true })
  const peerScope = join(extractedNodeModules, '@earendil-works')
  if (!statOrUndefined(peerScope)) {
    symlinkSync(
      join(repositoryRoot, 'node_modules', '@earendil-works'),
      peerScope,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false })
  for (const extensionPath of manifest.pi?.extensions ?? []) {
    if (extensionPath.includes('*')) continue
    const entryPath = join(extractedPackage, extensionPath.replace(/^\.\//, ''))
    const loaded = await jiti.import(entryPath)
    if (typeof loaded.default !== 'function') {
      fail(
        `Packed Pi extension has no default function export: ${extensionPath}`
      )
    }
  }

  console.log(
    `Smoke-tested ${archives[0]} as ${packageName} (${specification.required.length} required files)`
  )
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}
