import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_COMMIT_CONFIG,
  getChangeTypes,
  loadCommitConfig,
  parseCommitConfig,
  serializeCommitConfig,
  writeCommitConfigFile
} from '../extensions/commit/config.ts'

const customFormat = {
  changeTypes: [
    { name: 'docs', description: 'Documentation', public: true },
    { name: 'chore', description: 'Maintenance', public: false }
  ],
  instructions: 'Use type(scope): description.'
}

test('config defaults and precedence are deterministic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-config-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(agentDir, { recursive: true })

  assert.deepEqual(
    await loadCommitConfig({ cwd, agentDir, projectTrusted: true }),
    DEFAULT_COMMIT_CONFIG
  )

  await writeFile(
    join(agentDir, 'pi-commit.json'),
    JSON.stringify({ pullRequest: 'never', format: customFormat })
  )
  await writeFile(
    join(cwd, '.pi', 'pi-commit.json'),
    JSON.stringify({ pullRequest: 'auto' })
  )

  const trusted = await loadCommitConfig({
    cwd,
    agentDir,
    projectTrusted: true
  })
  assert.equal(trusted.pullRequest, 'auto')
  assert.deepEqual(trusted.format, customFormat)

  const untrusted = await loadCommitConfig({
    cwd,
    agentDir,
    projectTrusted: false
  })
  assert.equal(untrusted.pullRequest, 'never')

  await writeFile(
    join(cwd, '.pi', 'pi-commit.json'),
    JSON.stringify({ format: 'opinionated' })
  )
  const replaced = await loadCommitConfig({
    cwd,
    agentDir,
    projectTrusted: true
  })
  assert.equal(replaced.format, 'opinionated')
  assert.deepEqual(
    getChangeTypes(replaced).map(({ name }) => name),
    ['feat', 'fix', 'improve', 'internal']
  )
})

test('config validation rejects ambiguous or unsafe shapes', () => {
  assert.throws(
    () => parseCommitConfig('{', '/tmp/pi-commit.json'),
    /Invalid JSON in \/tmp\/pi-commit\.json/
  )
  assert.throws(
    () => parseCommitConfig('{"pullRequests":"never"}'),
    /unknown key/
  )
  assert.throws(() => parseCommitConfig('{"pullRequest":false}'), /auto.*never/)
  assert.throws(
    () =>
      parseCommitConfig(
        JSON.stringify({
          format: {
            changeTypes: [
              { name: 'auto', description: 'Reserved', public: true }
            ],
            instructions: 'Use it.'
          }
        })
      ),
    /reserved name/
  )
  assert.throws(
    () =>
      parseCommitConfig(
        JSON.stringify({
          format: {
            changeTypes: [
              { name: 'docs', description: 'One', public: true },
              { name: 'docs', description: 'Two', public: false }
            ],
            instructions: 'Use it.'
          }
        })
      ),
    /duplicate name/
  )
  assert.throws(
    () =>
      parseCommitConfig(
        JSON.stringify({
          format: {
            changeTypes: [
              { name: 'Docs', description: 'Bad name', public: true }
            ],
            instructions: 'Use it.'
          }
        })
      ),
    /must match/
  )
  assert.throws(
    () =>
      parseCommitConfig(
        JSON.stringify({
          format: {
            changeTypes: [{ name: 'docs', description: '', public: 'yes' }],
            instructions: ''
          }
        })
      ),
    /instructions must be a nonempty string/
  )
})

test('config writes atomically with stable normalized JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-write-'))
  const path = join(root, 'nested', 'pi-commit.json')
  await writeCommitConfigFile(
    path,
    JSON.stringify({ format: customFormat, pullRequest: 'never' })
  )

  const actual = await readFile(path, 'utf8')
  assert.equal(
    actual,
    serializeCommitConfig({ format: customFormat, pullRequest: 'never' })
  )
  assert.ok(actual.endsWith('\n'))
})
