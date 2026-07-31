import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type PullRequestBehavior = 'auto' | 'never'

export interface ChangeTypeDefinition {
  name: string
  description: string
  public: boolean
}

export interface CustomCommitFormat {
  changeTypes: ChangeTypeDefinition[]
  instructions: string
}

export type CommitFormat = 'opinionated' | CustomCommitFormat

export interface CommitConfigFile {
  pullRequest?: PullRequestBehavior
  format?: CommitFormat
}

export interface ResolvedCommitConfig {
  pullRequest: PullRequestBehavior
  format: CommitFormat
}

export interface CommitConfigPaths {
  user: string
  project: string
}

export const OPINIONATED_CHANGE_TYPES: readonly ChangeTypeDefinition[] = [
  {
    name: 'feat',
    description: 'New user-facing capability',
    public: true
  },
  { name: 'fix', description: 'User-facing bug fix', public: true },
  {
    name: 'improve',
    description: 'User-facing refinement/performance/reliability',
    public: true
  },
  {
    name: 'internal',
    description: 'Infra/tooling/tests/refactor/deps/logging',
    public: false
  }
]

export const DEFAULT_COMMIT_CONFIG: Readonly<ResolvedCommitConfig> = {
  pullRequest: 'auto',
  format: 'opinionated'
}

const CONFIG_KEYS = new Set(['pullRequest', 'format'])
const FORMAT_KEYS = new Set(['changeTypes', 'instructions'])
const CHANGE_TYPE_KEYS = new Set(['name', 'description', 'public'])
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const MAX_CHANGE_TYPES = 20
const MAX_TYPE_NAME_LENGTH = 32
const MAX_DESCRIPTION_LENGTH = 200
const MAX_INSTRUCTIONS_LENGTH = 8000

export function getCommitConfigPaths(
  cwd: string,
  agentDir = getAgentDir(),
  configDirectoryName = CONFIG_DIR_NAME
): CommitConfigPaths {
  return {
    user: join(agentDir, 'pi-commit.json'),
    project: join(cwd, configDirectoryName, 'pi-commit.json')
  }
}

export async function loadCommitConfig(options: {
  cwd: string
  projectTrusted: boolean
  agentDir?: string
  configDirectoryName?: string
}): Promise<ResolvedCommitConfig> {
  const paths = getCommitConfigPaths(
    options.cwd,
    options.agentDir,
    options.configDirectoryName
  )
  const user = await readCommitConfigFile(paths.user)
  const project = options.projectTrusted
    ? await readCommitConfigFile(paths.project)
    : undefined

  return mergeCommitConfigs(user, project)
}

export async function readCommitConfigFile(
  path: string
): Promise<CommitConfigFile | undefined> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`)
  }

  return parseCommitConfig(source, path)
}

export function parseCommitConfig(
  source: string,
  path = 'pi-commit.json'
): CommitConfigFile {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${errorMessage(error)}`)
  }

  return validateCommitConfig(value, path)
}

export function validateCommitConfig(
  value: unknown,
  path = 'pi-commit.json'
): CommitConfigFile {
  const object = requirePlainObject(value, path)
  rejectUnknownKeys(object, CONFIG_KEYS, path)

  const config: CommitConfigFile = {}
  if ('pullRequest' in object) {
    if (object.pullRequest !== 'auto' && object.pullRequest !== 'never') {
      throw new Error(`${path}: pullRequest must be exactly "auto" or "never"`)
    }
    config.pullRequest = object.pullRequest
  }

  if ('format' in object) {
    config.format = validateFormat(object.format, `${path}: format`)
  }

  return config
}

export function mergeCommitConfigs(
  user?: CommitConfigFile,
  project?: CommitConfigFile
): ResolvedCommitConfig {
  return {
    pullRequest:
      project?.pullRequest ??
      user?.pullRequest ??
      DEFAULT_COMMIT_CONFIG.pullRequest,
    format: project?.format ?? user?.format ?? DEFAULT_COMMIT_CONFIG.format
  }
}

export function getChangeTypes(
  config: ResolvedCommitConfig
): readonly ChangeTypeDefinition[] {
  return config.format === 'opinionated'
    ? OPINIONATED_CHANGE_TYPES
    : config.format.changeTypes
}

export function serializeCommitConfig(config: CommitConfigFile): string {
  const validated = validateCommitConfig(config)
  return `${JSON.stringify(validated, null, 2)}\n`
}

export async function writeCommitConfigFile(
  path: string,
  source: string
): Promise<CommitConfigFile> {
  const config = parseCommitConfig(source, path)
  const serialized = serializeCommitConfig(config)
  const parent = dirname(path)
  const temporaryPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  )

  await mkdir(parent, { recursive: true })
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }

  return config
}

export function defaultConfigSource(): string {
  return serializeCommitConfig({
    pullRequest: 'auto',
    format: 'opinionated'
  })
}

function validateFormat(value: unknown, path: string): CommitFormat {
  if (value === 'opinionated') return value

  const object = requirePlainObject(value, path)
  rejectUnknownKeys(object, FORMAT_KEYS, path)

  if (!Array.isArray(object.changeTypes) || object.changeTypes.length === 0) {
    throw new Error(`${path}.changeTypes must be a nonempty array`)
  }
  if (object.changeTypes.length > MAX_CHANGE_TYPES) {
    throw new Error(
      `${path}.changeTypes may contain at most ${MAX_CHANGE_TYPES} entries`
    )
  }

  if (
    typeof object.instructions !== 'string' ||
    object.instructions.trim().length === 0
  ) {
    throw new Error(`${path}.instructions must be a nonempty string`)
  }
  if (object.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(
      `${path}.instructions may contain at most ${MAX_INSTRUCTIONS_LENGTH} characters`
    )
  }

  const names = new Set<string>()
  const changeTypes = object.changeTypes.map((candidate, index) => {
    const itemPath = `${path}.changeTypes[${index}]`
    const item = requirePlainObject(candidate, itemPath)
    rejectUnknownKeys(item, CHANGE_TYPE_KEYS, itemPath)

    if (typeof item.name !== 'string' || !TYPE_NAME_PATTERN.test(item.name)) {
      throw new Error(
        `${itemPath}.name must match ${TYPE_NAME_PATTERN.toString()}`
      )
    }
    if (item.name.length > MAX_TYPE_NAME_LENGTH) {
      throw new Error(
        `${itemPath}.name may contain at most ${MAX_TYPE_NAME_LENGTH} characters`
      )
    }
    if (item.name === 'auto' || item.name === 'stacked') {
      throw new Error(
        `${itemPath}.name cannot use the reserved name "${item.name}"`
      )
    }
    if (names.has(item.name)) {
      throw new Error(
        `${path}.changeTypes contains duplicate name "${item.name}"`
      )
    }
    names.add(item.name)

    if (
      typeof item.description !== 'string' ||
      item.description.trim().length === 0
    ) {
      throw new Error(`${itemPath}.description must be a nonempty string`)
    }
    if (item.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `${itemPath}.description may contain at most ${MAX_DESCRIPTION_LENGTH} characters`
      )
    }
    if (typeof item.public !== 'boolean') {
      throw new Error(`${itemPath}.public must be a boolean`)
    }

    return {
      name: item.name,
      description: item.description.trim(),
      public: item.public
    }
  })

  return {
    changeTypes,
    instructions: object.instructions.trim()
  }
}

function requirePlainObject(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  path: string
) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `${path}: unknown key${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`
    )
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
