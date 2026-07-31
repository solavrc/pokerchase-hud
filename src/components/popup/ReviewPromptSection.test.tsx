import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewPromptSection } from './ReviewPromptSection'
import { PENDING_UPDATE_STORAGE_KEY } from '../../constants/update'
import { MIN_VERSION_GATE_STORAGE_KEY } from '../../services/min-version-gate'
import { REBUILD_ADVISORY_STORAGE_KEY } from '../../background/rebuild-advisory'

const PROMPT_TEXT = 'PokerChase HUD は役に立っていますか？'

describe('ReviewPromptSection', () => {
  let mockSendMessage: jest.Mock
  let visible: boolean

  const findPrompt = () => waitFor(() => screen.getByText(PROMPT_TEXT))

  beforeEach(() => {
    visible = true
    mockSendMessage = jest.fn((message: any, callback?: (response: any) => void) => {
      if (message?.action === 'getReviewPrompt') {
        callback?.({ success: true, visible })
        return
      }
      callback?.({ success: true })
    })
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        id: 'ffkgffhokobiegbodhhbfannffpgakhi',
        sendMessage: mockSendMessage,
      },
    } as any
  })

  it('backgroundがvisible=trueを返したら依頼バナーを表示する', async () => {
    render(<ReviewPromptSection />)

    await findPrompt()
    expect(screen.getByText('評価する')).toBeInTheDocument()
    expect(screen.getByText('後で')).toBeInTheDocument()
    expect(screen.getByText('今後表示しない')).toBeInTheDocument()
  })

  it('visible=falseなら何も表示しない', async () => {
    visible = false

    const { container } = render(<ReviewPromptSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('backgroundが応答しない場合は表示しない（フェイルオープンで非表示側）', async () => {
    mockSendMessage.mockImplementation((_message: any, callback?: (response: any) => void) => {
      callback?.(undefined)
    })

    const { container } = render(<ReviewPromptSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['データ再構築アドバイザリ', REBUILD_ADVISORY_STORAGE_KEY, { pendingVersion: 2 }],
    ['保留中アップデート', PENDING_UPDATE_STORAGE_KEY, { pending: true, version: '5.5.0' }],
    ['サポート終了ゲート', MIN_VERSION_GATE_STORAGE_KEY, { supported: false, checkedAt: 1 }],
  ])('%sが出ている間は表示しない（優先順位）', async (_label, key, value) => {
    await chrome.storage.local.set({ [key]: value })

    const { container } = render(<ReviewPromptSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('優先度の高いバナーが解消済みなら表示する', async () => {
    await chrome.storage.local.set({
      [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: 2 },
      [PENDING_UPDATE_STORAGE_KEY]: { pending: false },
      [MIN_VERSION_GATE_STORAGE_KEY]: { supported: true, checkedAt: 1 },
    })

    render(<ReviewPromptSection />)

    await findPrompt()
  })

  it('「評価する」でresolveReviewPromptを記録してからストアのレビューページを開く', async () => {
    const user = userEvent.setup()
    render(<ReviewPromptSection />)
    await findPrompt()

    await user.click(screen.getByText('評価する'))

    await waitFor(() => {
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'https://chromewebstore.google.com/detail/ffkgffhokobiegbodhhbfannffpgakhi/reviews',
      })
    })
    expect(mockSendMessage).toHaveBeenCalledWith(
      { action: 'resolveReviewPrompt', choice: 'rated' },
      expect.any(Function)
    )
    // 記録の送信がタブを開くより先（Popupは新規タブで破棄されるため）
    const resolveCallOrder = mockSendMessage.mock.invocationCallOrder.at(-1)!
    expect(resolveCallOrder).toBeLessThan((chrome.tabs.create as jest.Mock).mock.invocationCallOrder[0]!)
    expect(screen.queryByText(PROMPT_TEXT)).not.toBeInTheDocument()
  })

  it.each([
    ['後で', 'later'],
    ['今後表示しない', 'dismissed'],
  ])('「%s」は選択を記録してバナーを閉じる（タブは開かない）', async (label, choice) => {
    const user = userEvent.setup()
    render(<ReviewPromptSection />)
    await findPrompt()

    await user.click(screen.getByText(label))

    expect(mockSendMessage).toHaveBeenCalledWith(
      { action: 'resolveReviewPrompt', choice },
      expect.any(Function)
    )
    expect(chrome.tabs.create).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText(PROMPT_TEXT)).not.toBeInTheDocument()
    })
  })

  it('chrome.runtime.idが取得できない異常系では表示しない', async () => {
    global.chrome = {
      ...global.chrome,
      runtime: { ...global.chrome.runtime, id: undefined, sendMessage: mockSendMessage },
    } as any

    const { container } = render(<ReviewPromptSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })
})
