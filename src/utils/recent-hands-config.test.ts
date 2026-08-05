/**
 * recent-hands-config tests (#341)
 *
 * 「直近ハンド」パネルの件数設定。読み書きが常にフェイルオープンすること
 * （不正値・未設定・応答なしで既定値へ倒れ、例外を投げない）と、
 * 他パネル／他タブの変更を購読できることを固定する。
 *
 * 読み書きはbackground経由（getRecentHandsPanelConfig/
 * setRecentHandsPanelConfig）: `storage.local`は
 * `setAccessLevel('TRUSTED_CONTEXTS')`でcontent scriptから遮断されている
 * ため、このモジュールのcontent script向け関数が`chrome.storage.local`を
 * 直接触ってはならない（回帰テストで固定）。
 */
import { MESSAGE_ACTIONS } from '../types/messages'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  MAX_RECENT_HANDS_LIMIT,
  RECENT_HANDS_CONFIG_MESSAGE_TIMEOUT_MS,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_PANEL_CONFIG_EVENT,
  isValidRecentHandsLimit,
  resolveRecentHandsLimit,
  saveRecentHandsLimit,
  DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
  DEFAULT_RECENT_HANDS_PANEL_CONFIG,
  loadRecentHandsPanelConfig,
  resolveRecentHandsParticipationOnly,
  sanitizeRecentHandsPanelConfigPatch,
  saveRecentHandsParticipationOnly,
  subscribeRecentHandsPanelConfig,
} from './recent-hands-config'

describe('recent-hands-config', () => {
  let sendMessage: jest.Mock

  beforeEach(() => {
    sendMessage = chrome.runtime.sendMessage as jest.Mock
    sendMessage.mockReset()
  })

  describe('選択肢の整合性', () => {
    test('既定値と最大値は選択肢に含まれる', () => {
      expect(RECENT_HANDS_LIMIT_OPTIONS).toContain(DEFAULT_RECENT_HANDS_LIMIT)
      expect(RECENT_HANDS_LIMIT_OPTIONS).toContain(MAX_RECENT_HANDS_LIMIT)
      expect(MAX_RECENT_HANDS_LIMIT).toBe(Math.max(...RECENT_HANDS_LIMIT_OPTIONS))
    })

    test('選択肢は昇順で重複しない', () => {
      const sorted = [...RECENT_HANDS_LIMIT_OPTIONS].sort((a, b) => a - b)
      expect(RECENT_HANDS_LIMIT_OPTIONS).toEqual(sorted)
      expect(new Set(RECENT_HANDS_LIMIT_OPTIONS).size).toBe(RECENT_HANDS_LIMIT_OPTIONS.length)
    })

    test('broadcastのwindowイベント名はメッセージのaction名と一致する', () => {
      // content_script.tsはEVENTS（=MESSAGE_ACTIONS）でdispatchし、購読側は
      // このモジュールの定数でlistenする。二つの文字列が乖離すると同期が
      // 静かに死ぬので、ここで固定する。
      expect(RECENT_HANDS_PANEL_CONFIG_EVENT).toBe(MESSAGE_ACTIONS.UPDATE_RECENT_HANDS_PANEL_CONFIG)
    })
  })

  describe('検証', () => {
    test('選択肢の値だけを受け付ける', () => {
      RECENT_HANDS_LIMIT_OPTIONS.forEach(option => {
        expect(isValidRecentHandsLimit(option)).toBe(true)
      })
      expect(isValidRecentHandsLimit(7)).toBe(false)
      expect(isValidRecentHandsLimit(0)).toBe(false)
      expect(isValidRecentHandsLimit(-25)).toBe(false)
      expect(isValidRecentHandsLimit('25')).toBe(false)
      expect(isValidRecentHandsLimit(null)).toBe(false)
      expect(isValidRecentHandsLimit(undefined)).toBe(false)
      expect(isValidRecentHandsLimit(Number.NaN)).toBe(false)
    })

    test('不正値は既定値へ倒す', () => {
      expect(resolveRecentHandsLimit(50)).toBe(50)
      expect(resolveRecentHandsLimit(7)).toBe(DEFAULT_RECENT_HANDS_LIMIT)
      expect(resolveRecentHandsLimit(undefined)).toBe(DEFAULT_RECENT_HANDS_LIMIT)
    })

    test('boolean以外は既定値へ倒す', () => {
      expect(resolveRecentHandsParticipationOnly(false)).toBe(false)
      expect(resolveRecentHandsParticipationOnly(true)).toBe(true)
      expect(resolveRecentHandsParticipationOnly('false')).toBe(DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY)
      expect(resolveRecentHandsParticipationOnly(undefined)).toBe(DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY)
      expect(resolveRecentHandsParticipationOnly(0)).toBe(DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY)
    })

    test('既定はON（sola意図: 参加しなかったハンドは既定で消えていてほしい）', () => {
      expect(DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY).toBe(true)
      expect(DEFAULT_RECENT_HANDS_PANEL_CONFIG.participationOnly).toBe(true)
    })
  })

  describe('patchの検証（sanitizeRecentHandsPanelConfigPatch）', () => {
    test('有効なキーだけを残す', () => {
      expect(sanitizeRecentHandsPanelConfigPatch({ limit: 50 })).toEqual({ limit: 50 })
      expect(sanitizeRecentHandsPanelConfigPatch({ participationOnly: false }))
        .toEqual({ participationOnly: false })
      expect(sanitizeRecentHandsPanelConfigPatch({ limit: 100, participationOnly: true }))
        .toEqual({ limit: 100, participationOnly: true })
      // 不正な値は既定値へ読み替えず落とす。
      expect(sanitizeRecentHandsPanelConfigPatch({ limit: 7, participationOnly: false }))
        .toEqual({ participationOnly: false })
    })

    test('有効なキーが無ければnull', () => {
      expect(sanitizeRecentHandsPanelConfigPatch(undefined)).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch(null)).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch('50')).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch({})).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch({ limit: 7 })).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch({ participationOnly: 'yes' })).toBeNull()
      expect(sanitizeRecentHandsPanelConfigPatch({ unrelated: true })).toBeNull()
    })
  })

  describe('読み取り（background経由）', () => {
    test('backgroundの応答をそのまま返す', async () => {
      sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, config: { limit: 50, participationOnly: false } })
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual({ limit: 50, participationOnly: false })
      expect(sendMessage).toHaveBeenCalledWith(
        { action: 'getRecentHandsPanelConfig' },
        expect.any(Function)
      )
    })

    test('応答の壊れた値は既定値へ倒す（多層防御）', async () => {
      sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true, config: { limit: 7, participationOnly: 'yes' } })
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
    })

    test('success:falseやconfig欠落は既定値', async () => {
      sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: false, error: 'boom' })
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)

      sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        callback(undefined)
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
    })

    test('chrome.runtime.lastErrorが立っていても既定値へ倒れる（例外を投げない）', async () => {
      sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
        ;(global.chrome.runtime as any).lastError = { message: 'no receiving end' }
        callback(undefined)
        delete (global.chrome.runtime as any).lastError
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
    })

    test('応答が来なければタイムアウトで既定値へ倒れる（SW不在でパネルを止めない）', async () => {
      jest.useFakeTimers()
      try {
        sendMessage.mockImplementation(() => { })
        const pending = loadRecentHandsPanelConfig()
        await jest.advanceTimersByTimeAsync(RECENT_HANDS_CONFIG_MESSAGE_TIMEOUT_MS)
        await expect(pending).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
      } finally {
        jest.useRealTimers()
      }
    })

    test('sendMessageが例外を投げても既定値（拡張コンテキスト外）', async () => {
      sendMessage.mockImplementation(() => {
        throw new Error('Extension context invalidated')
      })
      await expect(loadRecentHandsPanelConfig()).resolves.toEqual(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
    })
  })

  describe('保存（background経由）', () => {
    test('件数はpatchとしてbackgroundへ送る', () => {
      saveRecentHandsLimit(100)
      expect(sendMessage).toHaveBeenCalledWith(
        { action: 'setRecentHandsPanelConfig', patch: { limit: 100 } },
        expect.any(Function)
      )
    })

    test('「参加のみ」はpatchとしてbackgroundへ送る', () => {
      saveRecentHandsParticipationOnly(false)
      expect(sendMessage).toHaveBeenCalledWith(
        { action: 'setRecentHandsPanelConfig', patch: { participationOnly: false } },
        expect.any(Function)
      )
    })

    test('選択肢にない値は送らない', () => {
      saveRecentHandsLimit(7)
      expect(sendMessage).not.toHaveBeenCalled()
    })

    test('送信が失敗しても例外を投げない', () => {
      sendMessage.mockImplementation(() => {
        throw new Error('Extension context invalidated')
      })
      expect(() => saveRecentHandsLimit(50)).not.toThrow()
      expect(() => saveRecentHandsParticipationOnly(false)).not.toThrow()
    })
  })

  describe('購読（broadcast由来のwindowイベント）', () => {
    const dispatchPatch = (detail: unknown) => {
      window.dispatchEvent(new CustomEvent(RECENT_HANDS_PANEL_CONFIG_EVENT, { detail }))
    }

    test('patchを通知し、解除できる', () => {
      const onChange = jest.fn()
      const unsubscribe = subscribeRecentHandsPanelConfig(onChange)

      dispatchPatch({ limit: 50 })
      expect(onChange).toHaveBeenCalledWith({ limit: 50 })

      onChange.mockClear()
      dispatchPatch({ participationOnly: false })
      expect(onChange).toHaveBeenCalledWith({ participationOnly: false })

      onChange.mockClear()
      unsubscribe()
      dispatchPatch({ limit: 10 })
      expect(onChange).not.toHaveBeenCalled()
    })

    test('壊れたdetailは通知しない（detailは外部入力として検証する）', () => {
      const onChange = jest.fn()
      const unsubscribe = subscribeRecentHandsPanelConfig(onChange)

      dispatchPatch(undefined)
      dispatchPatch('x')
      dispatchPatch({ limit: 7 })
      dispatchPatch({ unrelated: true })
      expect(onChange).not.toHaveBeenCalled()

      // 不正なキーだけ落とし、有効なキーは通す。
      dispatchPatch({ limit: 7, participationOnly: false })
      expect(onChange).toHaveBeenCalledWith({ participationOnly: false })
      unsubscribe()
    })
  })

  // #341/#353の回帰テスト: content script向け関数が`chrome.storage.local`を
  // 直接触らないこと。localエリアは`setAccessLevel('TRUSTED_CONTEXTS')`で
  // content scriptから遮断されており（#274）、直接アクセスは実ブラウザでは
  // 必ずrejectされる（unitテストのchromeモックはアクセスレベルを強制しない
  // ので、ここでは「呼ばないこと」自体を固定する）。
  describe('content scriptからchrome.storage.localを直接触らない（#274回帰）', () => {
    test('load/save/subscribeのいずれもstorage APIを呼ばない', async () => {
      const localGet = jest.spyOn(chrome.storage.local, 'get')
      const localSet = jest.spyOn(chrome.storage.local, 'set')
      const onChangedAdd = jest.spyOn(chrome.storage.onChanged, 'addListener')
      try {
        sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
          callback({ success: true, config: DEFAULT_RECENT_HANDS_PANEL_CONFIG })
        })

        await loadRecentHandsPanelConfig()
        saveRecentHandsLimit(100)
        saveRecentHandsParticipationOnly(false)
        const unsubscribe = subscribeRecentHandsPanelConfig(() => { })
        unsubscribe()

        expect(localGet).not.toHaveBeenCalled()
        expect(localSet).not.toHaveBeenCalled()
        expect(onChangedAdd).not.toHaveBeenCalled()
      } finally {
        localGet.mockRestore()
        localSet.mockRestore()
        onChangedAdd.mockRestore()
      }
    })
  })
})
