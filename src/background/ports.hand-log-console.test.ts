import { HandLogEntryType, type HandLogEvent } from '../types/hand-log'
import { logCompletedHandToConsole } from './ports'

const completedHand: HandLogEvent = {
  type: 'update',
  handId: 123456,
  entries: [
    {
      id: 'header',
      handId: 123456,
      timestamp: 1,
      text: "PokerStars Hand #123456: Hold'em No Limit (100/200) - 2026/07/22 10:00:00 JST",
      type: HandLogEntryType.HEADER
    },
    {
      id: 'summary',
      handId: 123456,
      timestamp: 2,
      text: '*** SUMMARY ***',
      type: HandLogEntryType.SUMMARY
    }
  ]
}

describe('Service Worker completed-hand console log', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('logs the completed hand once in the same PokerStars line order as the HUD', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)

    logCompletedHandToConsole(completedHand)

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith([
      "PokerStars Hand #123456: Hold'em No Limit (100/200) - 2026/07/22 10:00:00 JST",
      '*** SUMMARY ***'
    ].join('\n'))
  })

  test.each<HandLogEvent>([
    { type: 'add', entries: completedHand.entries },
    { type: 'removeIncomplete' },
    { type: 'update', handId: 123456, entries: [] }
  ])('does not log incomplete or empty hand-log events: $type', event => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)

    logCompletedHandToConsole(event)

    expect(info).not.toHaveBeenCalled()
  })
})
