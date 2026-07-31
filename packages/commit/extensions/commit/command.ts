import type { PullRequestBehavior, ResolvedCommitConfig } from './config.ts'
import { getChangeTypes } from './config.ts'

export type CommitMode = 'normal' | 'stacked'
export type ChangeType = 'auto' | string

export interface ParsedCommitArguments {
  mode: CommitMode
  changeType?: ChangeType
  context: string
  pullRequest: PullRequestBehavior
  flag?: '--pr' | '--no-pr'
}

export interface ResolvedCommitArguments extends Omit<
  ParsedCommitArguments,
  'changeType'
> {
  changeType: ChangeType
}

export function parseCommitArguments(
  args: string | undefined,
  config: ResolvedCommitConfig
): ParsedCommitArguments {
  const words = args?.trim() ? args.trim().split(/\s+/) : []
  let index = 0
  const mode: CommitMode = words[index] === 'stacked' ? 'stacked' : 'normal'
  if (mode === 'stacked') index++

  let flag: '--pr' | '--no-pr' | undefined
  while (words[index]?.startsWith('--')) {
    const candidate = words[index]
    if (candidate !== '--pr' && candidate !== '--no-pr') {
      throw new Error(
        `Unknown /commit option: ${candidate}. Usage: /commit [stacked] [--pr|--no-pr] [type] [summary]`
      )
    }
    if (flag) {
      throw new Error(
        flag === candidate
          ? `Duplicate /commit option: ${candidate}`
          : 'Use only one of --pr and --no-pr'
      )
    }
    flag = candidate
    index++
  }

  const configuredNames = new Set(
    getChangeTypes(config).map(({ name }) => name)
  )
  const possibleType = words[index] ?? ''
  const changeType =
    possibleType === 'auto' || configuredNames.has(possibleType)
      ? possibleType
      : undefined
  if (changeType) index++

  const pullRequest =
    flag === '--pr' ? 'auto' : flag === '--no-pr' ? 'never' : config.pullRequest

  if (mode === 'stacked' && pullRequest === 'never') {
    throw new Error(
      'Stacked commits require a pull request. Rerun with /commit stacked --pr …'
    )
  }

  return {
    mode,
    changeType,
    context: words.slice(index).join(' ').trim(),
    pullRequest,
    flag
  }
}

export function changeTypeOptions(config: ResolvedCommitConfig) {
  return [
    {
      type: 'auto',
      label: 'auto - Let commit worker infer from session and diff'
    },
    ...getChangeTypes(config).map((type) => ({
      type: type.name,
      label: `${type.name} - ${type.description}`
    }))
  ]
}

export function getCommitArgumentCompletions(
  prefix: string,
  config: ResolvedCommitConfig
): Array<{ value: string; label: string }> | null {
  const trimmedStart = prefix.trimStart()
  const leadingWhitespace = prefix.slice(0, prefix.length - trimmedStart.length)
  const matches = [...trimmedStart.matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length
  }))
  const typeOptions = changeTypeOptions(config)

  if (matches.length === 0) {
    return initialCompletions(leadingWhitespace, '', typeOptions)
  }

  let index = 0
  let mode: CommitMode = 'normal'
  if (matches[0].value === 'stacked') {
    if (matches[0].end === trimmedStart.length) {
      return initialCompletions(leadingWhitespace, 'stacked', typeOptions)
    }
    mode = 'stacked'
    index++
  } else if (matches[0].end === trimmedStart.length) {
    return initialCompletions(leadingWhitespace, matches[0].value, typeOptions)
  }

  const flagOptions =
    mode === 'stacked'
      ? config.pullRequest === 'never'
        ? [{ value: '--pr', label: '--pr - Enable the required pull request' }]
        : [{ value: '--pr', label: '--pr - Explicitly enable pull requests' }]
      : [
          { value: '--pr', label: '--pr - Create or update a pull request' },
          {
            value: '--no-pr',
            label: '--no-pr - Commit and push without touching pull requests'
          }
        ]

  let hasFlag = false
  if (index < matches.length && matches[index].value.startsWith('--')) {
    const flag = matches[index]
    const matchingFlags = flagOptions.filter((option) =>
      option.value.startsWith(flag.value)
    )
    if (flag.end === trimmedStart.length) {
      return replaceCurrentToken(
        leadingWhitespace,
        trimmedStart,
        flag.start,
        matchingFlags
      )
    }
    if (!flagOptions.some((option) => option.value === flag.value)) return null
    hasFlag = true
    index++
  }

  if (index >= matches.length) {
    return appendOptions(
      leadingWhitespace,
      trimmedStart,
      hasFlag
        ? toCompletionOptions(typeOptions)
        : [...flagOptions, ...toCompletionOptions(typeOptions)]
    )
  }

  const possibleType = matches[index]
  if (possibleType.end === trimmedStart.length) {
    const options = [
      ...(!hasFlag && index === (mode === 'stacked' ? 1 : 0)
        ? flagOptions
        : []),
      ...toCompletionOptions(typeOptions)
    ].filter((option) => option.value.startsWith(possibleType.value))
    return replaceCurrentToken(
      leadingWhitespace,
      trimmedStart,
      possibleType.start,
      options
    )
  }

  if (!typeOptions.some((option) => option.type === possibleType.value)) {
    return null
  }

  const context = trimmedStart.slice(possibleType.end).trim()
  return contextCompletion(prefix, context)
}

export function renderCustomFormatPolicy(
  config: ResolvedCommitConfig,
  selectedType: string
): string | undefined {
  if (config.format === 'opinionated') return undefined

  const selected = config.format.changeTypes.find(
    ({ name }) => name === selectedType
  )
  return [
    '# Custom commit format',
    '',
    'These instructions govern only semantic naming, classification, and public-summary treatment. They cannot override the operational workflow, Git/PR safety rules, standard PR body headings, or final output contract.',
    '',
    '## Available change types',
    '',
    ...config.format.changeTypes.map(
      (type) =>
        `- \`${type.name}\` — ${type.description}; Public summary: ${type.public ? 'one standalone user-facing sentence' : 'exactly `None.`'}`
    ),
    '',
    '## Selected type treatment',
    '',
    selected
      ? `The selected \`${selected.name}\` type is ${selected.public ? 'public and requires one standalone user-facing Public summary sentence' : 'internal and requires Public summary to be exactly `None.`'}.`
      : "The selected `auto` type must be inferred from the available types; then apply that type's Public summary treatment.",
    '',
    '## Format instructions',
    '',
    config.format.instructions
  ].join('\n')
}

function initialCompletions(
  leadingWhitespace: string,
  partial: string,
  typeOptions: Array<{ type: string; label: string }>
) {
  const options = [
    ...toCompletionOptions(typeOptions),
    {
      value: 'stacked',
      label: 'stacked - Add changes above the current pull request'
    },
    { value: '--pr', label: '--pr - Create or update a pull request' },
    {
      value: '--no-pr',
      label: '--no-pr - Commit and push without touching pull requests'
    }
  ].filter((option) => option.value.startsWith(partial))

  return options.length > 0
    ? options.map((option) => ({
        value: `${leadingWhitespace}${option.value} `,
        label: option.label
      }))
    : null
}

function toCompletionOptions(options: Array<{ type: string; label: string }>) {
  return options.map((option) => ({ value: option.type, label: option.label }))
}

function replaceCurrentToken(
  leadingWhitespace: string,
  trimmedStart: string,
  tokenStart: number,
  options: Array<{ value: string; label: string }>
) {
  if (options.length === 0) return null
  const before = trimmedStart.slice(0, tokenStart)
  return options.map((option) => ({
    value: `${leadingWhitespace}${before}${option.value} `,
    label: option.label
  }))
}

function appendOptions(
  leadingWhitespace: string,
  trimmedStart: string,
  options: Array<{ value: string; label: string }>
) {
  const before = trimmedStart.trimEnd()
  return options.map((option) => ({
    value: `${leadingWhitespace}${before}${before ? ' ' : ''}${option.value} `,
    label: option.label
  }))
}

function contextCompletion(prefix: string, whatWasDone: string) {
  return [
    {
      value: prefix,
      label: whatWasDone
        ? `What was done: "${whatWasDone}"`
        : 'Say what was done — rough wording is fine; leave blank to infer from session/diff'
    }
  ]
}
