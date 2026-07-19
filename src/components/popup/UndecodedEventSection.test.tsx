import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UndecodedEventSection } from './UndecodedEventSection'
import { ApiType } from '../../types'

describe('UndecodedEventSection', () => {
  let mockSendMessage: jest.Mock

  beforeEach(() => {
    mockSendMessage = jest.fn()
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
      },
    } as any
  })

  it('N=0のときは何も表示しない', async () => {
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({ undecodedEventStats: { total: 0, perApiTypeId: {} } })
    })

    const { container } = render(<UndecodedEventSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'getUndecodedEventStats' },
        expect.any(Function)
      )
    })

    expect(container).toBeEmptyDOMElement()
  })

  it('app-typeパース失敗を含む場合は警告表示(warning)になる', async () => {
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({
        undecodedEventStats: {
          total: 15,
          perApiTypeId: {
            [ApiType.EVT_SESSION_RESULTS]: { count: 12, lastSeen: new Date('2026-07-20T14:32:00').getTime() },
            9999: { count: 3, lastSeen: new Date('2026-07-19T10:00:00').getTime() }
          }
        }
      })
    })

    render(<UndecodedEventSection />)

    await waitFor(() => {
      expect(screen.getByText(/未解釈イベント: 15件/)).toBeInTheDocument()
    })

    expect(screen.getByText(/309×12/)).toBeInTheDocument()
    expect(screen.getByText(/9999×3/)).toBeInTheDocument()
    expect(screen.getByText(/07-20 14:32/)).toBeInTheDocument()

    // MUI Alert severity="warning" renders role="alert" with a warning-flavored class
    const alert = screen.getByRole('alert')
    expect(alert.className).toMatch(/colorWarning|standardWarning/)
  })

  it('unknownApiTypeのみの場合は危険クラスなし(info)になる', async () => {
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({
        undecodedEventStats: {
          total: 3,
          perApiTypeId: {
            9999: { count: 3, lastSeen: new Date('2026-07-19T10:00:00').getTime() }
          }
        }
      })
    })

    render(<UndecodedEventSection />)

    await waitFor(() => {
      expect(screen.getByText(/未解釈イベント: 3件/)).toBeInTheDocument()
    })

    const alert = screen.getByRole('alert')
    expect(alert.className).toMatch(/colorInfo|standardInfo/)
  })

  it('確認済みにするボタンでリセットメッセージを送り、表示を消す', async () => {
    mockSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getUndecodedEventStats') {
        callback({
          undecodedEventStats: {
            total: 5,
            perApiTypeId: { 9999: { count: 5, lastSeen: 1000 } }
          }
        })
      }
    })

    render(<UndecodedEventSection />)

    await waitFor(() => {
      expect(screen.getByText(/未解釈イベント: 5件/)).toBeInTheDocument()
    })

    const dismissButton = screen.getByLabelText('確認済みにする')
    await userEvent.click(dismissButton)

    expect(mockSendMessage).toHaveBeenCalledWith({ action: 'acknowledgeUndecodedEventStats' })
    expect(screen.queryByText(/未解釈イベント/)).not.toBeInTheDocument()
  })
})
