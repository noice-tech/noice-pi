import { performance } from 'node:perf_hooks'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export const BELL = '\x07'
export const DEFAULT_MINIMUM_DURATION_MS = 10_000

export interface BellOutput {
  readonly isTTY?: boolean
  write(chunk: string): unknown
}

export interface TerminalBellOptions {
  output?: BellOutput
  now?: () => number
  minimumDurationMs?: number
}

export function parseMinimumDuration(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MINIMUM_DURATION_MS
  }

  const milliseconds = Number(raw) * 1_000
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : DEFAULT_MINIMUM_DURATION_MS
}

export function createTerminalBell(
  options: TerminalBellOptions = {}
): ExtensionFactory {
  const output = options.output ?? process.stdout
  const now = options.now ?? (() => performance.now())
  const minimumDurationMs =
    options.minimumDurationMs ??
    parseMinimumDuration(process.env.PI_TERMINAL_BELL_MIN_DURATION)

  return (pi) => {
    let startedAt: number | undefined

    pi.on('agent_start', async () => {
      startedAt ??= now()
    })

    pi.on('agent_settled', async (_event, ctx) => {
      const runStartedAt = startedAt
      startedAt = undefined

      if (ctx.mode !== 'tui' || output.isTTY !== true) return
      if (runStartedAt === undefined && minimumDurationMs > 0) return
      if (
        runStartedAt !== undefined &&
        now() - runStartedAt < minimumDurationMs
      )
        return

      try {
        output.write(BELL)
      } catch {
        // A notification failure must never interrupt the agent session.
      }
    })
  }
}

export default createTerminalBell()
