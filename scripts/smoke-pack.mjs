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

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
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

  const requiredByPackage = {
    '@noice-tech/pi-changelog': [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/extensions/changelog/index.ts',
      'package/extensions/changelog/rules.md',
      'package/extensions/changelog/worker-prompt.md',
      'package/prompts/release-notes.md',
      'package/prompts/setup-release-notes-style.md',
      'package/prompts/unreleased.md'
    ]
  }
  const required = requiredByPackage[packageName] ?? ['package/package.json']

  for (const path of required) {
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

  if (packageName === '@noice-tech/pi-changelog') {
    const unexpected = entries.filter(
      (entry) =>
        entry !== 'package' &&
        !required.includes(entry) &&
        !required.some((path) => path.startsWith(`${entry}/`))
    )
    if (unexpected.length > 0) {
      fail(`Packed archive contains unexpected paths: ${unexpected.join(', ')}`)
    }

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

  if (packageName === '@noice-tech/pi-changelog') {
    const extensionPaths = manifest.pi?.extensions
    const promptPaths = manifest.pi?.prompts
    if (
      !Array.isArray(extensionPaths) ||
      !extensionPaths.includes('./extensions/changelog/index.ts')
    ) {
      fail('Packed manifest is missing the Pi extension resource path')
    }
    if (
      !Array.isArray(promptPaths) ||
      !promptPaths.includes('./prompts/*.md')
    ) {
      fail('Packed manifest is missing the Pi prompt resource path')
    }
  }

  console.log(
    `Smoke-tested ${archives[0]} as ${packageName} (${required.length} required files)`
  )
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}
