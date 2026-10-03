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
