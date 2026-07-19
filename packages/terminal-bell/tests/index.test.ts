import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  BELL,
  DEFAULT_MINIMUM_DURATION_MS,
  createTerminalBell,
  parseMinimumDuration,
  type BellOutput
} from '../extensions/terminal-bell/index.js'

type Handler = (event: never, context: ExtensionContext) => void | Promise<void>
type Mode = ExtensionContext['mode']

interface HarnessOptions {
  minimumDurationMs?: number
  isTTY?: boolean
  output?: BellOutput
}

function createHarness(options: HarnessOptions = {}) {
  let time = 0
  const writes: string[] = []
  const registrations: string[] = []
  const handlers = new Map<string, Handler>()
  const output =
    options.output ??
    ({
      isTTY: 'isTTY' in options ? options.isTTY : true,
      write(chunk: string) {
        writes.push(chunk)
      }
    } satisfies BellOutput)

  const pi = {
    on(event: string, handler: Handler) {
      registrations.push(event)
      handlers.set(event, handler)
    }
  } as unknown as ExtensionAPI

  createTerminalBell({
    output,
    now: () => time,
    minimumDurationMs: options.minimumDurationMs ?? DEFAULT_MINIMUM_DURATION_MS
  })(pi)

  async function emit(
    event: 'agent_start' | 'agent_settled',
    mode: Mode = 'tui'
  ) {
    const handler = handlers.get(event)
    if (!handler) throw new Error(`No handler registered for ${event}`)
    await handler({ type: event } as never, { mode } as ExtensionContext)
  }

  return {
    emit,
    registrations,
    setTime(value: number) {
      time = value
    },
    writes
  }
}

describe('terminal bell extension', () => {
  it('registers only the run lifecycle events it needs', () => {
    const { registrations } = createHarness()

    expect(registrations).toEqual(['agent_start', 'agent_settled'])
    expect(registrations).not.toContain('agent_end')
    expect(registrations).not.toContain('turn_end')
  })

  it('writes exactly one BEL when an eligible run settles', async () => {
    const harness = createHarness()
    harness.setTime(1_000)
    await harness.emit('agent_start')
    harness.setTime(11_000)
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([BELL])
    expect(Buffer.from(harness.writes[0] ?? '')).toEqual(Buffer.from([0x07]))
  })

  it('emits one bell for each eligible settled run', async () => {
    const harness = createHarness()

    for (const start of [0, 20_000]) {
      harness.setTime(start)
      await harness.emit('agent_start')
      harness.setTime(start + DEFAULT_MINIMUM_DURATION_MS)
      await harness.emit('agent_settled')
    }

    expect(harness.writes).toEqual([BELL, BELL])
  })

  it('does not reset elapsed time for retries before settlement', async () => {
    const harness = createHarness()
    harness.setTime(0)
    await harness.emit('agent_start')
    harness.setTime(9_000)
    await harness.emit('agent_start')
    harness.setTime(10_000)
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([BELL])
  })

  it('resets timing state after settlement', async () => {
    const harness = createHarness()
    harness.setTime(0)
    await harness.emit('agent_start')
    harness.setTime(10_000)
    await harness.emit('agent_settled')
    harness.setTime(11_000)
    await harness.emit('agent_start')
    harness.setTime(20_999)
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([BELL])
  })

  it('suppresses a run below the minimum duration', async () => {
    const harness = createHarness()
    harness.setTime(0)
    await harness.emit('agent_start')
    harness.setTime(DEFAULT_MINIMUM_DURATION_MS - 1)
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([])
  })

  it('rings when a run reaches the minimum duration exactly', async () => {
    const harness = createHarness()
    harness.setTime(0)
    await harness.emit('agent_start')
    harness.setTime(DEFAULT_MINIMUM_DURATION_MS)
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([BELL])
  })

  it('supports a zero threshold', async () => {
    const harness = createHarness({ minimumDurationMs: 0 })
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([BELL])
  })

  it('fails quietly when settlement has no start and the threshold is positive', async () => {
    const harness = createHarness()
    await harness.emit('agent_settled')

    expect(harness.writes).toEqual([])
  })

  it.each(['rpc', 'json', 'print'] satisfies Mode[])(
    'does not write in %s mode',
    async (mode) => {
      const harness = createHarness()
      harness.setTime(0)
      await harness.emit('agent_start', mode)
      harness.setTime(DEFAULT_MINIMUM_DURATION_MS)
      await harness.emit('agent_settled', mode)

      expect(harness.writes).toEqual([])
    }
  )

  it.each([false, undefined])(
    'does not write when isTTY is %s',
    async (isTTY) => {
      const harness = createHarness({ isTTY })
      harness.setTime(0)
      await harness.emit('agent_start')
      harness.setTime(DEFAULT_MINIMUM_DURATION_MS)
      await harness.emit('agent_settled')

      expect(harness.writes).toEqual([])
    }
  )

  it('swallows synchronous output failures', async () => {
    const harness = createHarness({
      minimumDurationMs: 0,
      output: {
        isTTY: true,
        write() {
          throw new Error('closed output')
        }
      }
    })

    await expect(harness.emit('agent_settled')).resolves.toBeUndefined()
  })
})

describe('parseMinimumDuration', () => {
  it.each([undefined, '', '   '])('uses the default for %s', (raw) => {
    expect(parseMinimumDuration(raw)).toBe(DEFAULT_MINIMUM_DURATION_MS)
  })

  it.each([
    ['0', 0],
    ['1', 1_000],
    ['1.5', 1_500],
    [' 2 ', 2_000]
  ])('parses %s seconds', (raw, expected) => {
    expect(parseMinimumDuration(raw)).toBe(expected)
  })

  it.each(['-1', 'nope', 'Infinity', 'NaN', '1e308'])(
    'uses the default for invalid value %s',
    (raw) => {
      expect(parseMinimumDuration(raw)).toBe(DEFAULT_MINIMUM_DURATION_MS)
    }
  )
})
