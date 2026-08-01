/**
 * web accessible resource: JavaScript Context にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
 */
import { decode } from '@msgpack/msgpack'
import {
  POKER_CHASE_INVALID_API_EVENT,
  POKER_CHASE_ORIGIN
} from './constants/runtime'
/** !!! BACKGROUND、CONTENT_SCRIPTSからインポートしないこと !!! */
/**
 * このファイルはWebSocket傍受のみ（HUD全機能の土台）。全ユーザーで常時注入
 * される。リプレイ関連の fetch / XMLHttpRequest 傍受と認証エンベロープ捕獲は
 * `replay_bridge.ts` へ分離し、`content_script.ts` が実験フラグ有効時にだけ
 * 別の WAR `<script>` として注入する（無効ユーザーにはリプレイ傍受コードを
 * 一切載せないため）。
 */

const OriginalWebSocket = window.WebSocket
const MAX_PENDING_UNCLASSIFIED_PAYLOADS = 5
const POKER_CHASE_API_DOMAIN = 'api-poker-chase.com'

interface PendingPayload {
  payload: Record<string, unknown>
  hasSafeApiTypeId: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isPokerChaseApiSocketUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url, window.location.href)
    return (
      (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') &&
      (
        parsed.hostname === POKER_CHASE_API_DOMAIN ||
        parsed.hostname.endsWith(`.${POKER_CHASE_API_DOMAIN}`)
      )
    )
  } catch {
    return false
  }
}

const hasIntegerInRange = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): boolean =>
  Number.isSafeInteger(payload[key]) &&
  (payload[key] as number) >= minimum &&
  (payload[key] as number) <= maximum

const hasArrayLength = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): boolean =>
  Array.isArray(payload[key]) &&
  payload[key].length >= minimum &&
  payload[key].length <= maximum

const hasRecord = (
  payload: Record<string, unknown>,
  key: string
): boolean => isRecord(payload[key])

const hasNestedIntegerInRange = (
  payload: Record<string, unknown>,
  parentKey: string,
  key: string,
  minimum: number,
  maximum: number
): boolean => {
  const parent = payload[parentKey]
  return isRecord(parent) &&
    hasIntegerInRange(parent, key, minimum, maximum)
}

const hasChatMessage = (
  payload: Record<string, unknown>,
  key: string
): boolean => {
  const message = payload[key]
  if (
    !isRecord(message) ||
    !hasIntegerInRange(message, 'Id', 0, Number.MAX_SAFE_INTEGER) ||
    !hasIntegerInRange(message, 'Ti', 0, Number.MAX_SAFE_INTEGER) ||
    typeof message.Ms !== 'string' ||
    !isRecord(message.Us)
  ) {
    return false
  }
  const user = message.Us
  return hasIntegerInRange(user, 'Id', 0, Number.MAX_SAFE_INTEGER) &&
    typeof user.Na === 'string' &&
    isRecord(user.Ic) &&
    typeof user.Ic.Co === 'string' &&
    typeof user.Ic.Fr === 'string'
}

/**
 * Positive, page-world-safe proof that a socket speaks the PokerChase
 * protocol. Importing the full Zod union here would add roughly 140 KB of
 * minified schema code to the injected main-world hook, so use distinctive
 * required-field fingerprints from frequent known events. This predicate is
 * only for latching socket identity; background remains the schema authority.
 */
const isPokerChaseProtocolAnchor = (
  payload: Record<string, unknown>
): boolean => {
  switch (payload.ApiTypeId) {
    case 201:
      return hasIntegerInRange(payload, 'BattleType', 0, 6) &&
        payload.BattleType !== 3 &&
        hasIntegerInRange(payload, 'Code', 0, Number.MAX_SAFE_INTEGER) &&
        typeof payload.Id === 'string' &&
        typeof payload.IsRetire === 'boolean'
    case 303:
      return hasRecord(payload, 'Game') &&
        hasNestedIntegerInRange(
          payload,
          'Game',
          'BigBlind',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasArrayLength(payload, 'OtherPlayers', 1, 6) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 0, 0) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasArrayLength(payload, 'SeatUserIds', 4, 6)
    case 304:
      return hasIntegerInRange(payload, 'ActionType', 0, 5) &&
        hasIntegerInRange(payload, 'BetChip', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'Chip', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'SeatIndex', 0, 5) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 0, 3) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        )
    case 305:
      return hasArrayLength(payload, 'CommunityCards', 1, 3) &&
        hasArrayLength(payload, 'OtherPlayers', 1, 6) &&
        hasRecord(payload, 'Progress') &&
        hasNestedIntegerInRange(payload, 'Progress', 'Phase', 1, 3) &&
        hasNestedIntegerInRange(
          payload,
          'Progress',
          'Pot',
          0,
          Number.MAX_SAFE_INTEGER
        ) &&
        hasNestedIntegerInRange(payload, 'Progress', 'NextActionSeat', 0, 5)
    case 306:
      return hasArrayLength(payload, 'CommunityCards', 0, 5) &&
        hasIntegerInRange(payload, 'DefeatStatus', 0, 1) &&
        hasIntegerInRange(payload, 'HandId', 0, Number.MAX_SAFE_INTEGER) &&
        hasIntegerInRange(payload, 'Pot', 0, Number.MAX_SAFE_INTEGER) &&
        hasArrayLength(payload, 'Results', 1, 6) &&
        hasIntegerInRange(payload, 'ResultType', 0, 4) &&
        hasArrayLength(payload, 'SidePot', 0, 4)
    case 308:
      return hasIntegerInRange(
        payload,
        'DefaultChip',
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      ) &&
        hasArrayLength(payload, 'BlindStructures', 1, 100) &&
        hasIntegerInRange(
          payload,
          'CoinNum',
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER
        ) &&
        typeof payload.IsReplay === 'boolean' &&
        typeof payload.Name === 'string' &&
        typeof payload.Name2 === 'string' &&
        hasIntegerInRange(payload, 'LimitSeconds', 0, Number.MAX_SAFE_INTEGER)
    case 309:
      return hasIntegerInRange(
        payload,
        'Ranking',
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      ) &&
        Array.isArray(payload.Items) &&
        Array.isArray(payload.Rewards) &&
        Array.isArray(payload.Charas) &&
        hasRecord(payload, 'Money')
    case 313:
      return hasIntegerInRange(payload, 'ProcessType', 0, 4) &&
        typeof payload.IsLeave === 'boolean' &&
        typeof payload.IsRetire === 'boolean' &&
        hasArrayLength(payload, 'SeatUserIds', 4, 6) &&
        hasArrayLength(payload, 'TableUsers', 1, 6)
    case 1201:
      return hasIntegerInRange(payload, 'chatType', 0, 3) &&
        payload.Code === 0 &&
        hasArrayLength(payload, 'OnlineStatus', 0, 2) &&
        hasArrayLength(payload, 'OnlineUserIds', 0, 2) &&
        hasArrayLength(payload, 'PrevMessage', 0, 50)
    case 1301:
      return hasChatMessage(payload, 'Message')
    case 1303:
      return hasIntegerInRange(payload, 'BattleType', 0, 6) &&
        payload.BattleType !== 3 &&
        hasIntegerInRange(payload, 'RoomId', 0, Number.MAX_SAFE_INTEGER) &&
        hasChatMessage(payload, 'Message')
    default:
      return false
  }
}

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  // The production client currently connects through the official
  // *.api-poker-chase.com family. Trusting that endpoint independently of the
  // decoded body is what keeps a global ApiTypeId removal/rename observable
  // from the very first event. Protocol fingerprints below remain a fallback
  // if PokerChase moves the WebSocket endpoint in a future client release.
  let isPokerChaseApiSocket = isPokerChaseApiSocketUrl(instance.url)
  const pendingUnclassifiedPayloads: PendingPayload[] = []

  const forwardInvalidPayload = (payload: Record<string, unknown>): void => {
    window.postMessage({
      type: POKER_CHASE_INVALID_API_EVENT,
      payload
    }, POKER_CHASE_ORIGIN)
  }

  const forwardPayload = ({
    payload,
    hasSafeApiTypeId
  }: PendingPayload): void => {
    if (hasSafeApiTypeId) {
      window.postMessage(payload, POKER_CHASE_ORIGIN)
    } else {
      forwardInvalidPayload(payload)
    }
  }

  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      try {
        const decoded = decode(data)

        if (decoded && typeof decoded === 'object') {
          const payload = {
            ...decoded,
            timestamp: Date.now()
          }
          const hasSafeApiTypeId =
            'ApiTypeId' in decoded &&
            Number.isSafeInteger(
              (decoded as { ApiTypeId: unknown }).ApiTypeId
            )
          const pendingPayload = { payload, hasSafeApiTypeId }

          if (isPokerChaseApiSocket) {
            forwardPayload(pendingPayload)
            return
          }

          // A numeric field name is not socket identity. Establish trust only
          // after this connection produces a distinctive known PokerChase
          // fingerprint. Schema-drift and invalid-ID payloads received before
          // that proof stay bounded and are flushed in arrival order.
          if (isPokerChaseProtocolAnchor(decoded as Record<string, unknown>)) {
            isPokerChaseApiSocket = true
            for (const bufferedPayload of pendingUnclassifiedPayloads) {
              forwardPayload(bufferedPayload)
            }
            pendingUnclassifiedPayloads.length = 0
            forwardPayload(pendingPayload)
          } else if (
            pendingUnclassifiedPayloads.length <
              MAX_PENDING_UNCLASSIFIED_PAYLOADS
          ) {
            pendingUnclassifiedPayloads.push(pendingPayload)
          }
        }
      } catch (error) {
        // デコードエラーは静かに無視（ログも最小限に）
        console.warn('[WebSocket] Failed to decode message')
      }
    }
  })

  // 再接続はゲームクライアント自身に任せる。
  // 拡張側で new WebSocket() しても参照を保持できず、ゲームが関知しない接続が増えるだけのため行わない。

  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket
