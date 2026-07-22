import type PokerChaseService from '../services/poker-chase-service'
import type { HandLogEvent } from '../types/hand-log'
import { registerStreamSubscriptions } from './ports'

describe('ports.ts hand-log delivery', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('consumes a missing content-script receiver rejection', async () => {
    const listeners: Record<string, (value: unknown) => void> = {}
    const stream = (name: string) => ({
      on: jest.fn((_event: 'data', listener: (value: unknown) => void) => {
        listeners[name] = listener
      })
    })
    const service = {
      realTimeStatsStream: stream('realTimeStats'),
      statsOutputStream: stream('statsOutput'),
      writeEntityStream: stream('writeEntity'),
      handLogStream: stream('handLog')
    } as unknown as PokerChaseService

    const missingReceiver = new Error('Could not establish connection. Receiving end does not exist.')
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([{ id: 42 }]))
    ;(chrome.tabs.sendMessage as jest.Mock).mockRejectedValue(missingReceiver)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    registerStreamSubscriptions(service, 'https://game.poker-chase.com/*')
    listeners.handLog!({ type: 'clear' } satisfies HandLogEvent)
    await Promise.resolve()

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      action: 'handLogEvent',
      event: { type: 'clear' }
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('reports unexpected delivery failures without leaving a rejected Promise', async () => {
    const listeners: Record<string, (value: unknown) => void> = {}
    const stream = (name: string) => ({
      on: jest.fn((_event: 'data', listener: (value: unknown) => void) => {
        listeners[name] = listener
      })
    })
    const service = {
      realTimeStatsStream: stream('realTimeStats'),
      statsOutputStream: stream('statsOutput'),
      writeEntityStream: stream('writeEntity'),
      handLogStream: stream('handLog')
    } as unknown as PokerChaseService

    const unexpectedError = new Error('Unexpected delivery failure')
    ;(chrome.tabs.query as jest.Mock).mockImplementation((_query, callback) => callback([{ id: 7 }]))
    ;(chrome.tabs.sendMessage as jest.Mock).mockRejectedValue(unexpectedError)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    registerStreamSubscriptions(service, 'https://game.poker-chase.com/*')
    listeners.handLog!({ type: 'clear' } satisfies HandLogEvent)
    await Promise.resolve()

    expect(warnSpy).toHaveBeenCalledWith(
      '[background] Failed to deliver hand log event to tab 7:',
      unexpectedError
    )
  })
})
