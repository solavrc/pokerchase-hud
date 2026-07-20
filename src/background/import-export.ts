/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import Dexie from 'dexie'
import PokerChaseService, {
  ApiType,
  PokerChaseDB,
  ApiEvent,
  PlayerStats,
  isApiEventType,
  parseApiEvent,
  validateApiEvent,
  validateMessage,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import { EntityConverter } from '../entity-converter'
import type { EntityBundle } from '../entity-converter'
import { saveEntities, findLatestPlayerDealEvent, filterValidApplicationEvents } from '../utils/database-utils'
import { DATABASE_CONSTANTS } from '../constants/database'
import type { Session } from '../types'
import type {
  ExportProgressMessage,
  ImportProgressMessage,
  RebuildProgressMessage
} from '../types/messages'
import { setOperationState } from './operation-state'
import { resolveAdvisory } from './rebuild-advisory'

const IMPORT_CHUNK_SIZE = DATABASE_CONSTANTS.IMPORT_CHUNK_SIZE

interface ImportSession {
  chunks: string[]
  totalChunks: number
  fileName: string
}
let currentImportSession: ImportSession | null = null

export const getCurrentImportSession = (): ImportSession | null => currentImportSession

export const startImportSession = (totalChunks: number, fileName: string): void => {
  currentImportSession = {
    chunks: [],
    totalChunks,
    fileName
  }
}

export const addImportChunk = (chunkIndex: number, chunkData: string): void => {
  if (!currentImportSession) return
  currentImportSession.chunks[chunkIndex] = chunkData
}

export const clearImportSession = (): void => {
  currentImportSession = null
}

type CompoundEventKey = [number, number]

interface PairedLakeHand {
  handId: number
  dealKey: CompoundEventKey
  resultKey: CompoundEventKey
  pairKey: string
  events: ApiEvent[]
}

interface OverlapRepairPlan {
  entities: EntityBundle
  /** 旧・新viewのいずれかで実際に影響を受けたHandIdだけ。 */
  affectedHandIds: number[]
  replayEventCount: number
  repairedHandCount: number
}

const eventKey = (event: ApiEvent): CompoundEventKey => [event.timestamp ?? 0, event.ApiTypeId]
const eventStorageKey = (event: ApiEvent): string => `${event.timestamp}-${event.ApiTypeId}`
const compareEventKeys = (left: CompoundEventKey, right: CompoundEventKey): number =>
  left[0] - right[0] || left[1] - right[1]
const pairStorageKey = (dealKey: CompoundEventKey, resultKey: CompoundEventKey): string =>
  `${dealKey[0]}-${dealKey[1]}:${resultKey[0]}-${resultKey[1]}`

const emptyImportSession = (): Session => ({
  id: undefined,
  battleType: undefined,
  name: undefined,
  players: new Map(),
  reset: () => { }
})

const copyImportSession = (session: Session): Session => ({
  id: session.id,
  battleType: session.battleType,
  name: session.name,
  players: new Map(session.players),
  reset: () => { }
})

/**
 * Overlap修復の不変条件（独立監査finding #7、PR #203 review pass 8）:
 *
 * 1. replay windowはconverter文脈の読取り範囲であり、書込み範囲ではない。
 *    新規行を含むraw hand span、旧/新viewでDEAL→306 pairingが変わるhand、
 *    または新規session rowによりLake由来sessionが変わるhandだけを
 *    affectedとする。その他のbystanderはconverter出力を捨て、deleteもputも
 *    しないためbyte-identicalに残る。
 * 2. session seedはrange単位でなくhand単位。各DEALより前で最新の検証済み
 *    201からid/battleTypeを、その201以後・DEAL以前で最新の308からnameを
 *    再構築する。201が無ければ空/rebuild-style。ただし全new rowが既存の
 *    valid application tailより後に付くincremental tail importで、かつ以前に
 *    派生していないhandだけはlive service.sessionをseedにする（#104）。
 * 3. 範囲境界・session候補は常に現行schemaで再検証する。上端探索はtimestamp
 *    だけでなく最大new [timestamp+ApiTypeId] keyから始めるため、同一msで
 *    [T,306]の後ろにある[T,308]/[T,313]を落とさない。
 * 4. Raw Event Lakeは読取り専用。affected HandIdのhands/phases/actionsだけを
 *    同一transactionでdelete-then-putし、消滅した旧pairやaction tailも除く。
 */
export const buildOverlapRepairPlan = async (
  db: PokerChaseDB,
  newEvents: ApiEvent[],
  liveSession: Session
): Promise<OverlapRepairPlan> => {
  const newEventKeys = new Set(newEvents.map(eventStorageKey))
  const isValidApplicationRow = (row: ApiEvent): boolean => {
    const parsed = parseApiEvent(row)
    return !!parsed && isApplicationApiEvent(parsed)
  }

  let minNewKey = eventKey(newEvents[0]!)
  let maxNewKey = minNewKey
  for (const event of newEvents.slice(1)) {
    const key = eventKey(event)
    if (compareEventKeys(key, minNewKey) < 0) minNewKey = key
    if (compareEventKeys(key, maxNewKey) > 0) maxNewKey = key
  }

  // 直前のvalid 306より後から読むと、new rowを含む旧handのopening DEALを
  // 保持しつつ、pure appendでは過去session全体を読み直さない。
  const previousResult = await db.apiEvents
    .where('[timestamp+ApiTypeId]')
    .below(minNewKey)
    .reverse()
    .filter(row => row.ApiTypeId === ApiType.EVT_HAND_RESULTS && isValidApplicationRow(row))
    .first()

  // 新viewの最初の306と、new rowを除いた旧viewの最初の306の遅い方まで読む。
  // 新306が旧pairを早く閉じるcapture-gap修復でも、旧pairの末尾を含められる。
  // 探索開始をmaxNewKeyそのものにするのがsame-ms tail inclusivityの要点。
  const firstPostResult = await db.apiEvents
    .where('[timestamp+ApiTypeId]')
    .aboveOrEqual(maxNewKey)
    .filter(row => row.ApiTypeId === ApiType.EVT_HAND_RESULTS && isValidApplicationRow(row))
    .first()
  const firstOldResult = await db.apiEvents
    .where('[timestamp+ApiTypeId]')
    .aboveOrEqual(maxNewKey)
    .filter(row =>
      row.ApiTypeId === ApiType.EVT_HAND_RESULTS &&
      !newEventKeys.has(eventStorageKey(row)) &&
      isValidApplicationRow(row)
    )
    .first()
  const upperEvent = [firstPostResult, firstOldResult]
    .filter((event): event is ApiEvent => event !== undefined)
    .sort((left, right) => compareEventKeys(eventKey(right), eventKey(left)))[0]

  const lowerKey = previousResult ? eventKey(previousResult) : undefined
  const upperKey = upperEvent ? eventKey(upperEvent) : undefined
  let rawRows: ApiEvent[]
  if (lowerKey && upperKey) {
    rawRows = await db.apiEvents.where('[timestamp+ApiTypeId]').between(lowerKey, upperKey, false, true).toArray()
  } else if (lowerKey) {
    rawRows = await db.apiEvents.where('[timestamp+ApiTypeId]').above(lowerKey).toArray()
  } else if (upperKey) {
    rawRows = await db.apiEvents.where('[timestamp+ApiTypeId]').belowOrEqual(upperKey).toArray()
  } else {
    rawRows = await db.apiEvents.orderBy('[timestamp+ApiTypeId]').toArray()
  }
  const events = await filterValidApplicationEvents(rawRows)
  const oldEvents = events.filter(event => !newEventKeys.has(eventStorageKey(event)))

  const collectPairedHands = (candidateEvents: ApiEvent[]): PairedLakeHand[] => {
    const hands: PairedLakeHand[] = []
    let openDealIndex: number | undefined
    for (let index = 0; index < candidateEvents.length; index++) {
      const event = candidateEvents[index]!
      if (isApiEventType(event, ApiType.EVT_DEAL)) {
        // EntityConverter同様、後続DEALは未完了bufferを捨てて置き換える。
        openDealIndex = index
      } else if (isApiEventType(event, ApiType.EVT_HAND_RESULTS)) {
        if (openDealIndex !== undefined) {
          const deal = candidateEvents[openDealIndex]!
          const dealKey = eventKey(deal)
          const resultKey = eventKey(event)
          hands.push({
            handId: event.HandId,
            dealKey,
            resultKey,
            pairKey: pairStorageKey(dealKey, resultKey),
            events: candidateEvents.slice(openDealIndex, index + 1)
          })
        }
        openDealIndex = undefined
      }
    }
    return hands
  }

  const oldHands = collectPairedHands(oldEvents)
  const postHands = collectPairedHands(events)
  const oldByPair = new Map(oldHands.map(hand => [hand.pairKey, hand]))
  const postByPair = new Map(postHands.map(hand => [hand.pairKey, hand]))

  type LakeSession = Pick<Session, 'id' | 'battleType' | 'name'>
  const sessionCache = new Map<string, LakeSession | undefined>()
  const lakeSessionBeforeDeal = async (
    dealKey: CompoundEventKey,
    excludeNewRows: boolean
  ): Promise<LakeSession | undefined> => {
    const cacheKey = `${excludeNewRows ? 'old' : 'post'}:${dealKey[0]}-${dealKey[1]}`
    if (sessionCache.has(cacheKey)) return sessionCache.get(cacheKey)

    const anchorRow = await db.apiEvents
      .where('[timestamp+ApiTypeId]')
      .below(dealKey)
      .reverse()
      .filter(row =>
        row.ApiTypeId === ApiType.EVT_ENTRY_QUEUED &&
        (!excludeNewRows || !newEventKeys.has(eventStorageKey(row))) &&
        isValidApplicationRow(row)
      )
      .first()
    const anchor = anchorRow ? parseApiEvent(anchorRow) : null
    if (!anchor || !isApiEventType(anchor, ApiType.EVT_ENTRY_QUEUED)) {
      sessionCache.set(cacheKey, undefined)
      return undefined
    }

    const contextRows = await db.apiEvents
      .where('[timestamp+ApiTypeId]')
      .between(eventKey(anchor), dealKey, true, false)
      .filter(row =>
        (!excludeNewRows || !newEventKeys.has(eventStorageKey(row))) &&
        isValidApplicationRow(row)
      )
      .toArray()
    let name: string | undefined
    for (const rawContext of contextRows) {
      const context = parseApiEvent(rawContext)
      if (context && isApiEventType(context, ApiType.EVT_SESSION_DETAILS)) name = context.Name
    }
    const session = { id: anchor.Id, battleType: anchor.BattleType, name }
    sessionCache.set(cacheKey, session)
    return session
  }

  const sessionsEqual = (left: LakeSession | undefined, right: LakeSession | undefined): boolean =>
    left?.id === right?.id && left?.battleType === right?.battleType && left?.name === right?.name
  const containsNewKey = (hand: PairedLakeHand): boolean => newEvents.some(event => {
    const key = eventKey(event)
    return compareEventKeys(key, hand.dealKey) >= 0 && compareEventKeys(key, hand.resultKey) <= 0
  })

  const affectedOldPairs = new Set<string>()
  const affectedPostPairs = new Set<string>()
  for (const oldHand of oldHands) {
    if (!postByPair.has(oldHand.pairKey) || containsNewKey(oldHand)) affectedOldPairs.add(oldHand.pairKey)
  }
  for (const postHand of postHands) {
    if (!oldByPair.has(postHand.pairKey) || containsNewKey(postHand)) affectedPostPairs.add(postHand.pairKey)
  }
  for (const postHand of postHands) {
    const oldHand = oldByPair.get(postHand.pairKey)
    if (!oldHand) continue
    const [oldSession, postSession] = await Promise.all([
      lakeSessionBeforeDeal(oldHand.dealKey, true),
      lakeSessionBeforeDeal(postHand.dealKey, false)
    ])
    if (!sessionsEqual(oldSession, postSession)) {
      affectedOldPairs.add(oldHand.pairKey)
      affectedPostPairs.add(postHand.pairKey)
    }
  }

  const affectedPostHands = postHands.filter(hand => affectedPostPairs.has(hand.pairKey))
  const affectedHandIds = Array.from(new Set([
    ...oldHands.filter(hand => affectedOldPairs.has(hand.pairKey)).map(hand => hand.handId),
    ...affectedPostHands.map(hand => hand.handId)
  ]))

  // Pure tail append = 今回の最古new application keyが、旧viewの最後のvalid
  // application keyより後。複数handを一度にappendしても同じ判定になる。
  const lastOldApplicationEvent = await db.apiEvents
    .orderBy('[timestamp+ApiTypeId]')
    .reverse()
    .filter(row => !newEventKeys.has(eventStorageKey(row)) && isValidApplicationRow(row))
    .first()
  const isTailAppend = !lastOldApplicationEvent || compareEventKeys(minNewKey, eventKey(lastOldApplicationEvent)) > 0
  const existingAffectedHands = affectedPostHands.length > 0
    ? await db.hands.bulkGet(affectedPostHands.map(hand => hand.handId))
    : []
  const previouslyDerivedIds = new Set(
    affectedPostHands
      .filter((_, index) => existingAffectedHands[index] !== undefined)
      .map(hand => hand.handId)
  )

  const entities: EntityBundle = { hands: [], phases: [], actions: [] }
  for (const hand of affectedPostHands) {
    const lakeSession = await lakeSessionBeforeDeal(hand.dealKey, false)
    const session = lakeSession
      ? { ...emptyImportSession(), ...lakeSession }
      : isTailAppend && !previouslyDerivedIds.has(hand.handId)
        ? copyImportSession(liveSession)
        : emptyImportSession()

    // SessionはDEAL時点のLake文脈で固定する。hand内に割り込む201/308を
    // converterへ渡すとclose時のcurrentSessionへ反映されるため、派生に必要な
    // 303/304/305/306だけをhandごとに変換する。
    const handEvents = hand.events.filter(event =>
      event.ApiTypeId === ApiType.EVT_DEAL ||
      event.ApiTypeId === ApiType.EVT_ACTION ||
      event.ApiTypeId === ApiType.EVT_DEAL_ROUND ||
      event.ApiTypeId === ApiType.EVT_HAND_RESULTS
    )
    const bundle = new EntityConverter(session).convertEventsToEntities(handEvents)
    entities.hands.push(...bundle.hands)
    entities.phases.push(...bundle.phases)
    entities.actions.push(...bundle.actions)
  }

  return {
    entities,
    affectedHandIds,
    replayEventCount: events.length,
    repairedHandCount: affectedPostHands.length
  }
}

/**
 * Import/Export/Rebuild関連のハンドラー群を初期化する。
 * `service`/`db`/`gameUrlPattern`をクロージャで捕捉し、message-router.tsから
 * 呼び出せる関数群を返す。
 */
export const createImportExportHandlers = (service: PokerChaseService, db: PokerChaseDB, gameUrlPattern: string) => {
  const exportData = async (format: string) => {
    if (format === 'json') {
      await exportJsonData(db)
    } else if (format === 'pokerstars') {
      await exportPokerStarsData()
    }
  }

  /**
   * Import data from JSONL file
   * @param jsonlData JSONL string containing API events (one JSON object per line)
   * @returns Object containing import statistics
   */
  const importData = async (jsonlData: string): Promise<{ successCount: number, totalLines: number, duplicateCount: number }> => {
    let batchModeEnabled = false
    try {
      setOperationState({ type: 'import', progress: 0 })
      console.log('[importData] Starting optimized import process with direct entity generation')
      const startTime = performance.now()

      // 既存キーを一括取得（最適化ポイント1）
      console.log('[importData] Loading existing keys...')
      const existingKeys = new Set<string>()
      await db.apiEvents
        .orderBy('[timestamp+ApiTypeId]')
        .keys(keys => {
          keys.forEach(key => {
            if (Array.isArray(key) && key.length === 2) {
              existingKeys.add(`${key[0]}-${key[1]}`)
            }
          })
        })
      console.log(`[importData] Loaded ${existingKeys.size} existing keys`)

      // 既存データが1件でもあるインポートは「差分インポート」: 新規イベントが
      // 既存ハンドの一部（欠落していた中間イベント等）を埋める可能性があり、
      // 新規イベント単体ではエンティティを再導出できない（独立監査finding #7、
      // buildOverlapRepairPlan()のdocコメント参照）。この判定は後続の
      // ループでexistingKeysへ新規キーを追記する前に確定させておく。
      const hadPreexistingEvents = existingKeys.size > 0

      // 行で分割し、空行をフィルタリング
      const lines = jsonlData.split('\n').filter(line => line.trim())
      console.log(`[importData] Processing ${lines.length} lines`)

      // バッチモードを有効化
      service.setBatchMode(true)
      batchModeEnabled = true

      // 直接エンティティ生成用のイベントを収集
      const allNewEvents: ApiEvent[] = []

      // メモリ問題を避けるためチャンク単位で処理
      let processed = 0
      let successCount = 0
      let duplicateCount = 0
      const errors: string[] = []

      for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
        const chunkLines = lines.slice(i, i + IMPORT_CHUNK_SIZE)
        // Raw Event Lake: 保存対象は「timestamp/ApiTypeIdが数値」の行すべて
        // （Zod検証の成否・アプリケーションイベントか否かは問わない）
        const rawEventsToStore: Array<Record<string, unknown> & { timestamp: number, ApiTypeId: number }> = []
        // エンティティ生成対象（検証済みアプリケーションイベントのみ）。
        // key（`${timestamp}-${ApiTypeId}`）で対応するrawEventsToStoreの要素と紐付ける
        const validAppEventsByKey = new Map<string, ApiEvent>()

        // チャンク内の各行をパース
        for (let j = 0; j < chunkLines.length; j++) {
          const lineNumber = i + j + 1
          const line = chunkLines[j]
          if (!line) continue

          try {
            const parsed = JSON.parse(line)

            // 保存条件のチェック（インポートでは必須）: timestamp/ApiTypeIdが数値であること
            if (!validateMessage(parsed).success) {
              errors.push(`Line ${lineNumber}: Missing/invalid timestamp or ApiTypeId`)
              continue
            }

            const key = `${parsed.timestamp}-${parsed.ApiTypeId}`

            // メモリ内で重複チェック（最適化ポイント2）
            if (existingKeys.has(key)) {
              duplicateCount++
              continue
            }

            rawEventsToStore.push(parsed)
            existingKeys.add(key) // 次の重複チェック用

            // Zodスキーマ検証（エンティティ生成対象かどうかの判定のみ。保存は上で確定済み）
            const event = parseApiEvent(parsed)
            if (!event) {
              const result = validateApiEvent(parsed)
              const errorDetails = result.error ? getValidationError(result.error)[0] : null
              errors.push(`Line ${lineNumber}: ${errorDetails?.message || 'Validation failed'} (保存済み・エンティティ生成対象外)`)
              continue
            }

            // アプリケーション用のイベントかチェック
            if (!isApplicationApiEvent(event)) {
              // 非アプリケーションイベント: 生ログとしては保存対象だがエンティティ生成対象外
              continue
            }

            validAppEventsByKey.set(key, event)
          } catch (parseError) {
            // 無効なJSON行をスキップ
            if (line.trim()) {
              errors.push(`Line ${lineNumber}: Invalid JSON`)
            }
          }
        }

        // 生イベントをbulkAddで一括保存（最適化ポイント3。検証可否に関わらず全件保存）
        if (rawEventsToStore.length > 0) {
          const storedKeys = new Set<string>()

          try {
            // apiEvents is the raw Lake (see docs/architecture.md): rows may not
            // conform to the ApiEvent union (non-application types, unknown
            // ApiTypeIds, or app-type payloads that fail the current schema) —
            // the assertion is intentional, mirroring the same pattern used in
            // event-ingestion.ts's real-time storage path.
            await db.apiEvents.bulkAdd(rawEventsToStore as ApiEvent[])
            successCount += rawEventsToStore.length
            rawEventsToStore.forEach(raw => storedKeys.add(`${raw.timestamp}-${raw.ApiTypeId}`))
          } catch (dbError) {
            // 部分的な失敗の場合、個別に保存を試みる
            console.warn(`Bulk add failed for chunk ${Math.floor(i / IMPORT_CHUNK_SIZE) + 1}, falling back to individual adds:`, dbError)

            // 明示的トランザクション外で呼んだbulkAdd()は、一部の行が失敗して
            // Dexie.BulkErrorをthrowしても、失敗しなかった行はその時点で既に
            // 永続化済み（IndexedDB側は各addリクエストの個別エラーを飲み込み、
            // トランザクション全体はabortしない実装のため）。BulkErrorの
            // `failuresByPos`は「失敗したインデックス」だけをErrorへ
            // マッピングするので、そこに含まれないインデックスは既に確実に
            // 保存されている（codexレビュー指摘, PR #199 finding #2）。
            // それらに対して個別add()を再度呼ぶと、今まさに正規に書き込んだ
            // 行自体に対するConstraintErrorとなり、以下の「重複」判定に
            // 落ちて誤ってスキップ扱いになる ―― successCountが実際の保存数
            // より少なく数えられるだけでなく、対応するアプリケーションイベント
            // がstoredKeysに入らずallNewEventsから漏れ、hands/phases/actions
            // が生成されないまま（次回の再構築まで）残ってしまう。
            // BulkError以外（例: QuotaExceededErrorでバッチ全体がabortされた
            // 場合など）はどの行も永続化されていないと分かっているため、
            // 全件を個別add()にかける従来の挙動のままでよい。
            const failuresByPos = dbError instanceof Dexie.BulkError ? dbError.failuresByPos : undefined

            for (let idx = 0; idx < rawEventsToStore.length; idx++) {
              const raw = rawEventsToStore[idx]!
              const key = `${raw.timestamp}-${raw.ApiTypeId}`

              if (failuresByPos && !(idx in failuresByPos)) {
                // bulkAdd()の失敗リストに載っていない = 既に永続化済み。
                // add()を再度呼ばず、そのまま成功として計上する。
                successCount++
                storedKeys.add(key)
                continue
              }

              try {
                await db.apiEvents.add(raw as ApiEvent)
                successCount++
                storedKeys.add(key)
              } catch (individualError) {
                // 個別エラーは重複以外の場合のみログ
                const errorMessage = individualError instanceof Error ? individualError.message : String(individualError)
                if (!errorMessage.includes('Key already exists')) {
                  errors.push(`Event at timestamp ${raw.timestamp}: ${errorMessage}`)
                } else {
                  // この行はbulkAdd失敗により個別add()にフォールバックした結果
                  // 重複と判明したもので、successCountはまだ加算されていない
                  // （加算は直上tryブロックの成功時のみ、11行下）。ここで
                  // successCount--するとまだ一度も加算されていないカウントを
                  // 減算することになり、重複が多いインポートでsuccessCountが
                  // 負数になり得た（codexレビュー指摘、監査finding #13）。
                  // duplicateCountのみ加算する。
                  duplicateCount++
                }
              }
            }
          }

          // エンティティ生成には、実際に保存が確認できたアプリケーションイベントのみを渡す
          for (const [key, event] of validAppEventsByKey) {
            if (storedKeys.has(key)) allNewEvents.push(event)
          }
        }

        processed += chunkLines.length

        // Send progress update
        const progress = Math.round((processed / lines.length) * 100)
        setOperationState({ type: 'import', progress, processed, total: lines.length })
        chrome.runtime.sendMessage<ImportProgressMessage>({
          action: 'importProgress',
          progress: progress,
          processed: processed,
          total: lines.length,
          duplicates: duplicateCount,
          imported: successCount
        })

        // Log progress every 10%
        if (progress % 10 === 0) {
          console.log(`[importData] Progress: ${progress}% (${processed}/${lines.length} lines)`)
        }

        // Allow browser to breathe between chunks
        await new Promise(resolve => setTimeout(resolve, 5))
      }

      if (errors.length > 0) {
        console.warn(`[importData] Failed to import ${errors.length} lines (${((errors.length / lines.length) * 100).toFixed(2)}%)`)
        if (errors.length <= 10) {
          console.warn('Errors:', errors)
        } else {
          console.warn('First 10 errors:', errors.slice(0, 10))
        }
      }

      const importTime = ((performance.now() - startTime) / 1000).toFixed(2)
      console.log(`[importData] Import completed in ${importTime}s - Success: ${successCount}, Duplicates: ${duplicateCount}`)

      // 直接エンティティ生成（Phase 2最適化）
      if (allNewEvents.length > 0) {
        console.log(`[importData] Generating entities from ${allNewEvents.length} new events...`)
        const entityStartTime = performance.now()

        // 新規イベントのtimestamp範囲。Math.maxでスプレッド演算子を使うと
        // スタックオーバーフローになるため、単一ループで両端を求める
        let minNewTimestamp = Number.POSITIVE_INFINITY
        let maxNewTimestamp = 0
        for (const event of allNewEvents) {
          const timestamp = event.timestamp || 0
          if (timestamp < minNewTimestamp) minNewTimestamp = timestamp
          if (timestamp > maxNewTimestamp) maxNewTimestamp = timestamp
        }

        try {
          // 空DBは従来どおりnew eventsを一括変換。既存Lakeへのimportだけは
          // old/post viewを比較し、影響handごとにLake sessionを決めたplanを使う。
          let entities: EntityBundle
          let repairPlan: Awaited<ReturnType<typeof buildOverlapRepairPlan>> | undefined
          if (hadPreexistingEvents) {
            repairPlan = await buildOverlapRepairPlan(db, allNewEvents, service.session)
            entities = repairPlan.entities
            console.log(`[importData] Overlap import detected - inspected ${repairPlan.replayEventCount} Lake events and re-derived ${repairPlan.repairedHandCount} affected hand(s)`)
          } else {
            entities = new EntityConverter(service.session).convertEventsToEntities(allNewEvents)
          }

          console.log(`[importData] Generated entities - Hands: ${entities.hands.length}, Phases: ${entities.phases.length}, Actions: ${entities.actions.length}`)

          const logSavedCounts = (counts: { hands: number, phases: number, actions: number }) => {
            console.log(`[importData] Saved/updated ${counts.hands} hands, ${counts.phases} phases, ${counts.actions} actions`)
          }

          if (repairPlan) {
            // putだけでは消滅した旧pair/action tailが残るため、affected IDsだけ
            // 同一transactionでdelete-then-putする。replay中のbystanderは
            // affectedHandIdsへ入らず、hands/phases/actions全て無変更。
            const { affectedHandIds } = repairPlan
            await db.transaction('rw', [db.hands, db.phases, db.actions], async () => {
              const existingAffectedHands = affectedHandIds.length > 0
                ? await db.hands.bulkGet(affectedHandIds)
                : []
              const staleHandIds = affectedHandIds.filter((_, index) => existingAffectedHands[index] !== undefined)
              if (staleHandIds.length > 0) {
                console.log(`[importData] Removing ${staleHandIds.length} affected derived hand(s) before re-deriving`)
                await db.hands.bulkDelete(staleHandIds)
                await db.phases.where('handId').anyOf(staleHandIds).delete()
                await db.actions.where('handId').anyOf(staleHandIds).delete()
              }
              // saveEntities()内のtransactionは同一テーブル集合の親トランザクションに合流する
              await saveEntities(db, entities, { onProgress: logSavedCounts })
            })
          } else {
            // Save entities using common utility
            await saveEntities(db, entities, { onProgress: logSavedCounts })
          }

          // Update metadata separately（lastProcessedTimestampは従来通り
          // 「今回のインポートで新規保存されたイベント」の最大timestamp。
          // overlap修復で再導出対象に含めた既存行は含めない）
          await db.meta.put({
            id: 'importStatus',
            value: {
              lastProcessedTimestamp: maxNewTimestamp,
              lastProcessedEventCount: allNewEvents.length,
              lastImportDate: new Date().toISOString()
            },
            updatedAt: Date.now()
          })
          console.log(`[importData] Updated metadata - lastTimestamp: ${maxNewTimestamp}`)

          const entityTime = ((performance.now() - entityStartTime) / 1000).toFixed(2)
          console.log(`[importData] Entity generation completed in ${entityTime}s`)

        } catch (entityError) {
          console.error('[importData] Entity generation error:', entityError)
          // エラーの詳細をログに記録するが、処理は継続
          // refreshDatabaseへのフォールバックは削除（トランザクション競合を避けるため）
          const errorMessage = entityError instanceof Error ? entityError.message : String(entityError)
          throw new Error(`Entity generation failed: ${errorMessage}`)
        }
      } else {
        // 新規イベントがない場合は増分処理も不要
        console.log('[importData] No new events to process')
      }

      // インポート後に統計を強制的に更新
      // 最新のEVT_DEALを取得して統計計算をトリガー
      const latestDealEvent = await findLatestPlayerDealEvent(db)

      if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
        // latestEvtDealを更新（findLatestPlayerDealEvent()はPlayer.SeatIndexが
        // 存在するdealだけを返すため、常にヒーロー在籍の文脈）。このsetterは
        // service.liveEvtDeal（ライブ配信文脈）も同時に同期する
        // （poker-chase-service.ts参照）ため、直後のwrite()による再
        // ブロードキャストが、インポート前に観戦モードで取り残されていたかも
        // しれない古いliveEvtDealではなく、この復元されたヒーロー在籍dealと
        // 正しくペアリングされる（codex #177 3巡目レビューP2）。
        service.latestEvtDeal = latestDealEvent

        // プレイヤーIDも更新（インポートデータからヒーローを特定）
        if (latestDealEvent.Player?.SeatIndex !== undefined) {
          service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
          console.log(`[importData] Updated playerId: ${service.playerId}`)
        }

        // 統計の再計算をトリガー
        const playerIds = latestDealEvent.SeatUserIds.filter(id => id !== -1)
        if (playerIds.length > 0) {
          console.log('[importData] Triggering stats recalculation for imported data')
          service.statsOutputStream.write(playerIds)

          // 現在開いているゲームタブに対しても統計更新を通知
          chrome.tabs.query({ url: gameUrlPattern }, tabs => {
            tabs.forEach(tab => {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  action: 'refreshStats'
                })
              }
            })
          })
        }
      }

      return { successCount, totalLines: lines.length, duplicateCount }

    } catch (error) {
      console.error('Import error:', error)
      throw error
    } finally {
      // Every exit path must restore live processing before advertising idle.
      if (batchModeEnabled) service.setBatchMode(false)
      setOperationState({ type: 'idle' })
    }
  }

  const exportJsonData = async (db: PokerChaseDB) => {
    const stopKeepAlive = await startKeepAlive()
    try {
      setOperationState({ type: 'export', format: 'json', progress: 0 })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'started',
        format: 'json',
        message: 'NDJSONエクスポート開始...'
      }).catch(() => {})

      const totalCount = await db.apiEvents.count()
      console.log(`[Export] Exporting ${totalCount} events...`)

      // Direct chunked export using primary key cursor to avoid Dexie Collection offset issues.
      // Dumps the full apiEvents Lake verbatim (raw fidelity, "a line is a line") — no
      // filtering by validity or application-type here; this is what feeds the warehouse
      // and offline schema-diff tooling (see docs/architecture.md "Raw Event Lake").
      const chunks: string[] = []
      let processedCount = 0
      let lastKey: any = undefined
      const chunkSize = DATABASE_CONSTANTS.EXPORT_CHUNK_SIZE

      while (true) {
        // Build fresh query each iteration using primary key range
        const chunk = lastKey !== undefined
          ? await db.apiEvents.where('[timestamp+ApiTypeId]').above(lastKey).limit(chunkSize).toArray()
          : await db.apiEvents.orderBy('[timestamp+ApiTypeId]').limit(chunkSize).toArray()

        if (chunk.length === 0) break

        chunks.push(chunk.map(event => JSON.stringify(event)).join('\n'))
        processedCount += chunk.length

        // Track last key for next iteration
        const lastEvent = chunk[chunk.length - 1]!
        lastKey = [lastEvent.timestamp, lastEvent.ApiTypeId]

        const progress = Math.round((processedCount / totalCount) * 100)
        const progressMessage = `エクスポート中... ${processedCount.toLocaleString()}/${totalCount.toLocaleString()} (${progress}%)`
        setOperationState({ type: 'export', format: 'json', progress, processed: processedCount, total: totalCount, message: progressMessage })
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'processing',
          format: 'json',
          progress,
          processed: processedCount,
          total: totalCount,
          message: progressMessage
        }).catch(() => {})

        if (processedCount % 50000 === 0 || processedCount >= totalCount) {
          console.log(`[Export] Processed ${processedCount}/${totalCount} events`)
        }

        if (chunk.length < chunkSize) break // Last chunk
      }

      const jsonlContent = chunks.join('\n')

      // ハンドオフ（chrome.tabs.query/sendMessage）の発行完了を待ってから
      // `setOperationState({ type: 'idle' })`を呼ぶ（codexレビュー指摘,
      // PR #150監査#2: 待たずに呼ぶとupdate-managerのoperation-idle
      // recheckがハンドオフ未発行のままchrome.runtime.reload()し、
      // ダウンロードが失われるレースがあった -- downloadFile()のコメント参照）
      await downloadFile(
        jsonlContent,
        'pokerchase_raw_data.ndjson',
        'application/x-ndjson'
      )

      console.log(`[Export] Export completed: ${processedCount} events (${(jsonlContent.length / 1024 / 1024).toFixed(1)}MB)`)

      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'completed',
        format: 'json',
        progress: 100,
        processed: processedCount,
        total: totalCount,
        message: `NDJSONエクスポート完了: ${processedCount.toLocaleString()}件`
      }).catch(() => {})
      stopKeepAlive()
    } catch (error) {
      stopKeepAlive()
      console.error('[Export] Export failed:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'error',
        format: 'json',
        message: `NDJSONエクスポート失敗: ${error}`
      }).catch(() => {})
      throw error
    }
  }

  const exportPokerStarsData = async () => {
    const stopKeepAlive = await startKeepAlive()
    try {
      setOperationState({ type: 'export', format: 'pokerstars', progress: 0 })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'started',
        format: 'pokerstars',
        message: 'PokerStarsエクスポート開始...'
      }).catch(() => {})

      // Get the last session's hand history
      const handHistory = await service.exportHandHistory(undefined, (processed, total) => {
        const progress = Math.round((processed / total) * 100)
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'processing',
          format: 'pokerstars',
          progress,
          processed,
          total,
          message: `ハンドヒストリー変換中... ${processed.toLocaleString()}/${total.toLocaleString()} (${progress}%)`
        }).catch(() => {})
        setOperationState({ type: 'export', format: 'pokerstars', progress, processed, total, message: `ハンドヒストリー変換中... ${processed}/${total} (${progress}%)` })
      })

      if (!handHistory) {
        console.error('No hands found to export')
        stopKeepAlive()
        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<ExportProgressMessage>({
          action: 'exportProgress',
          state: 'error',
          format: 'pokerstars',
          message: 'エクスポートするハンドが見つかりませんでした'
        }).catch(() => {})
        // Show notification to user
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
          title: 'エクスポートエラー',
          message: 'エクスポートするハンドが見つかりませんでした。ゲームをプレイしてから再度お試しください。'
        })
        return
      }

      // ハンドオフ発行完了を待ってからidleに戻す（上のexportJsonData内
      // downloadFile()呼び出しのコメント参照、codexレビュー指摘 PR #150監査#2）
      await downloadFile(
        handHistory,
        'pokerchase_hand_history.txt',
        'text/plain'
      )

      stopKeepAlive()
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'completed',
        format: 'pokerstars',
        message: 'PokerStarsハンドヒストリーエクスポート完了'
      }).catch(() => {})
    } catch (error) {
      stopKeepAlive()
      console.error('Error exporting PokerStars format:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<ExportProgressMessage>({
        action: 'exportProgress',
        state: 'error',
        format: 'pokerstars',
        message: `PokerStarsエクスポート失敗: ${error}`
      }).catch(() => {})
      // Show error notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon_48px.png'),
        title: 'エクスポートエラー',
        message: 'ハンドヒストリーのエクスポート中にエラーが発生しました。'
      })
      throw error
    }
  }

  /**
   * `chrome.tabs.sendMessage()`をコールバック形式で呼び、
   * `chrome.runtime.lastError`を確認してから解決/拒否するPromiseに包む
   * （codexレビュー指摘、監査finding #10）。
   *
   * `chrome.tabs.sendMessage(tabId, message)`（コールバック省略）はfire-and-
   * forgetで、コンテンツスクリプト不在・メッセージ拒否・受信側エラーの
   * いずれもここでは観測できない。コールバックを渡すことで
   * `chrome.runtime.lastError`（例: "Receiving end does not exist" ―
   * コンテンツスクリプト未注入、拡張機能リロード直後のタブなど）を検出し、
   * 呼び出し元（downloadFile）へ失敗として伝播できるようにする。
   *
   * 受信側（content_script.ts）は4種のdownload*メッセージ全てで明示的に
   * `sendResponse({ success: true/false })`を返す（PR #199レビュー指摘、
   * finding #1）ようになっている ―― Chromeのメッセージングは、受信側が
   * sendResponse()を呼ばず`true`もreturnしない場合、リスナーがreturnした
   * 時点でポートを閉じ、送信側コールバックに`chrome.runtime.lastError =
   * "message port closed before a response was received"`をセットする。
   * これは受信側の処理が実際に成功していても発生するため、修正前は
   * 正常に配信されたエクスポートまで失敗と誤判定していた。明示的なackが
   * 返るようになった今は、`lastError`（配信自体の失敗）に加えて
   * レスポンスの`success:false`（受信側で処理中に例外が起きた場合）も
   * 確認し、どちらの失敗も呼び出し元へ伝播する。
   */
  const sendTabMessageAsync = (tabId: number, message: Record<string, unknown>): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response?: { success?: boolean, error?: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (response && response.success === false) {
          reject(new Error(response.error || 'content script reported a download handoff failure'))
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * コンテンツスクリプトへのダウンロードハンドオフ（chrome.tabs.query→
   * chrome.tabs.sendMessage、大容量ファイルの場合は複数チャンク）の
   * 全チャンクが受信側に確実に届いたことを確認してから解決する
   * （codexレビュー指摘, PR #150監査#2 / 監査finding #10）。
   *
   * PR #150監査#2の修正では`chrome.tabs.query`のコールバックが実行される
   * までは待てるようになったが、その内側の`chrome.tabs.sendMessage()`自体は
   * 依然fire-and-forget（チャンクごとに投げっぱなし）で、`chrome.downloads`
   * フォールバックもコールバック/`downloads.lastError`を見る前に解決して
   * いた。コンテンツスクリプト不在・メッセージ拒否・64MiB境界超過・
   * downloads側のエラーのいずれが起きても`downloadFile()`は成功したかの
   * ように解決し、呼び出し元（exportJsonData/exportPokerStarsData）が直後に
   * `setOperationState({ type: 'idle' })`を呼んでしまう ――
   * `operation-state.ts`の`onOperationBecameIdle`購読経由で
   * `update-manager.ts`の`recheckPendingUpdate()`が発火し、保留中アップデート
   * が安全と誤判定されて`chrome.runtime.reload()`が先行し得るうえ、
   * ユーザーには「エクスポート完了」と表示されるのに実際のファイルは
   * 一切届かない。
   *
   * ここでは各ハンドオフ（単発送信・チャンク送信の全て）を`await`し、
   * いずれかが失敗（拒否）したら`downloadFile()`自体もreject、
   * `chrome.downloads`フォールバックも`downloads.lastError`を確認して
   * からでなければ解決しないようにする。呼び出し元は`await downloadFile()`
   * が投げた例外を既存のcatchブロックでそのまま処理する ―― `state: 'error'`
   * をpopupへ通知し、`idle`への遷移は「完了成功」としてではなく単に
   * 操作終了として行われる。
   */
  const downloadFile = (content: string, filename: string, contentType: string): Promise<void> => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

    const extensionMatch = filename.match(/\.[^.]+$/)
    const extension = extensionMatch ? extensionMatch[0] : ''

    const baseFilename = extension ? filename.slice(0, -extension.length) : filename

    const getFinalFilename = () => {
      if (contentType.includes('ndjson') || filename.endsWith('.jsonl') || filename.endsWith('.ndjson')) {
        return `${baseFilename}_${timestamp}.ndjson`
      } else if (contentType.includes('json')) {
        return `${baseFilename}_${timestamp}.json`
      } else if (contentType.includes('text')) {
        return `${baseFilename}_${timestamp}.txt`
      } else {
        return `${baseFilename}_${timestamp}${extension || '.dat'}`
      }
    }

    const finalFilename = getFinalFilename()

    // Send to content script for Blob-based download (avoids data URL size limits)
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.query({ url: gameUrlPattern }, async tabs => {
        const tab = tabs.find(t => t.id)
        if (tab?.id) {
          const tabId = tab.id
          try {
            const sizeMB = content.length / 1024 / 1024
            const MAX_CHUNK_MB = 50 // Under Chrome's 64MiB message limit
            const maxChunkSize = MAX_CHUNK_MB * 1024 * 1024

            if (content.length <= maxChunkSize) {
              await sendTabMessageAsync(tabId, { action: 'downloadFile', content, filename: finalFilename, contentType })
            } else {
              // Split into chunks for large files
              const totalChunks = Math.ceil(content.length / maxChunkSize)
              console.log(`[Export] Splitting ${sizeMB.toFixed(1)}MB into ${totalChunks} chunks...`)
              await sendTabMessageAsync(tabId, { action: 'downloadFileInit', filename: finalFilename, contentType, totalChunks })
              for (let i = 0; i < totalChunks; i++) {
                const chunk = content.slice(i * maxChunkSize, (i + 1) * maxChunkSize)
                await sendTabMessageAsync(tabId, { action: 'downloadFileChunk', chunkIndex: i, chunk, totalChunks })
              }
              await sendTabMessageAsync(tabId, { action: 'downloadFileFinish', filename: finalFilename, contentType })
            }
            console.log(`[Export] Download initiated via content script: ${finalFilename} (${sizeMB.toFixed(1)}MB)`)
            resolve()
          } catch (error) {
            console.error('[Export] Content script download handoff failed:', error)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        // Fallback: data URL via chrome.downloads (may fail for large files >2MB)
        console.warn('[Export] No game tab found, falling back to data URL download')
        try {
          await downloadViaDataUrl(content, finalFilename, contentType)
          resolve()
        } catch (error) {
          console.error('[Export] chrome.downloads fallback failed:', error)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  /**
   * Delete all data (logs only, not configuration)
   */
  const deleteAllData = async (): Promise<void> => {
    try {
      // データベースを完全に削除
      await db.delete()

      // データが無くなったので再構築アドバイザリも解消する（reloadより前に行う）
      await resolveAdvisory()

      // データベースの新しいインスタンスを確保するために拡張機能をリロード
      chrome.runtime.reload()
    } catch (error) {
      console.error('Error deleting data:', error)
      throw error
    }
  }

  /**
   * Get the latest session stats from the last known data or database.
   *
   * Pre-game hero stats fallback (`preGame: true`, sent only by
   * content_script.ts's mountApp() right at HUD mount): before the first
   * EVT_DEAL of a browser session establishes a live seat lineup, there is
   * nothing for the live pipeline (ReadEntityStream.transform, driven by
   * statsOutputStream.write) to compute yet -- the HUD would otherwise sit
   * on "Waiting for Hand..." for every seat, including the hero's own,
   * until the first hand is dealt. If the hero's identity is already known
   * (persisted `service.playerId`), compute the hero's stats via the exact
   * same `calcStats()` the live pipeline uses (respecting the service's
   * active battleType/tableSize/handLimit filters) for a hero-only lineup
   * of one, and pad the remaining 5 seats with the same empty-seat
   * sentinel (`{ playerId: -1 }`) App.tsx's `EMPTY_SEATS` default uses --
   * this keeps the returned array the same 6-element shape callers already
   * render (App.tsx keys HUD panels by seat index 0-5), so non-hero seats
   * keep showing "Waiting for Hand..." exactly as before, and the eventual
   * real EVT_DEAL swap-in reuses the same seat-0 key for the hero panel
   * (seamless takeover, no remount).
   *
   * `preGame: false/omitted` (the pre-existing post-import `refreshStats`
   * round-trip, see content_script.ts) keeps the original "always return
   * []" stub behavior verbatim -- import completion already triggers a
   * real recompute+broadcast (`service.statsOutputStream.write(playerIds)`)
   * moments before `refreshStats` is sent, so enabling the hero-only
   * fallback on that call site too would risk a stale hero-only response
   * arriving *after* that fresher full lineup and clobbering it back down
   * to one seat. Restricting the fallback to the mount-only `preGame: true`
   * request sidesteps that race entirely: a fresh mount can't already have
   * a fresher in-tab lineup to clobber.
   *
   * If hero identity isn't known in memory yet (`service.playerId` unset --
   * e.g. a freshly-loaded unpacked extension instance whose in-memory
   * service state starts empty, or a persisted state restored before any
   * live EVT_DEAL ever arrived this browser session), fall back to
   * `findLatestPlayerDealEvent(db)` before giving up: a cloud download or
   * NDJSON import may already have populated the local DB with hero deal
   * events, and there's no reason to sit dark until the next live EVT_DEAL
   * re-derives it. This mirrors the DB-recovery path
   * `PokerChaseService.recalculateAllStats()` already uses on batch-mode
   * exit (see poker-chase-service.ts) -- same `Player?.SeatIndex !==
   * undefined` derivation, same lack of extra re-validation beyond what
   * `findLatestPlayerDealEvent()` already does internally (it re-validates
   * each candidate row against the current Zod schema via
   * `isApiEventType()`, consistent with the Raw Event Lake rules in
   * docs/architecture.md). The derived id is assigned through the
   * `service.playerId` setter, so it persists via the service's normal
   * 500ms-debounced `chrome.storage.local` save and is visible to every
   * later feature exactly as if it had come from a live EVT_DEAL. Still
   * returns [] (send nothing, don't touch the caller's current state) if
   * the DB has no hero deal event either (true fresh install / never
   * played -- behavior stays unchanged for that case) or an import/rebuild
   * batch operation is in flight (`service.batchMode` -- don't fight that
   * refresh storm; it recomputes and broadcasts the real lineup itself
   * once the batch completes, see `importData`/`rebuildAllData` below).
   *
   * Also awaits `service.filtersRestored`: `service.ready` only covers
   * chrome.storage.local's playerId/session restore -- battleTypeFilter/
   * tableSizeFilter/handLimitFilter/statDisplayConfigs are restored
   * separately by background.ts's startup `loadOptions().then(...)`
   * (see beginFiltersRestore()/markFiltersRestored() on the service).
   * On a cold MV3 Service Worker start triggered by this very
   * `requestLatestStats` message, `calcStats()` below could otherwise run
   * before those saved filters are applied, computing an unfiltered
   * pre-game hero panel for users with non-default filters.
   */
  const getLatestSessionStats = async (preGame: boolean): Promise<PlayerStats[]> => {
    if (!preGame) return []

    await service.ready // guards the SW-just-woke-up race: playerId/session are only valid after restoreState() resolves
    await service.filtersRestored // guards the same race for battleType/tableSize/handLimit filters (see background.ts)

    if (service.batchMode) return []

    if (!service.playerId) {
      // In-memory hero identity is unknown -- see if the DB already knows it
      // (cloud download / NDJSON import ahead of the first live EVT_DEAL).
      const latestDealEvent = await findLatestPlayerDealEvent(db)
      // A live EVT_DEAL may have set service.playerId while the lookup above
      // was in flight -- that's fresher than anything the DB can tell us, so
      // don't clobber it with the (now possibly stale) DB-derived value.
      if (!service.playerId && latestDealEvent && latestDealEvent.Player?.SeatIndex !== undefined) {
        service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex] // setter persists via the normal debounced save
      }
    }
    if (!service.playerId) return []

    const heroStats = await service.statsOutputStream.calcStats([service.playerId])
    const heroStat = heroStats[0] ?? { playerId: service.playerId, statResults: [] }
    const emptySeats: PlayerStats[] = Array.from({ length: 5 }, () => ({ playerId: -1 }))
    return [heroStat, ...emptySeats]
  }

  /**
   * Rebuild all data from apiEvents using batch processing
   * Similar to download sync processing to avoid multiple HUD updates
   */
  const rebuildAllData = async (): Promise<void> => {
    try {
      console.log('[rebuildAllData] Starting batch rebuild of all data...')
      const startTime = performance.now()

      setOperationState({ type: 'rebuild', progress: 0, message: 'データ再構築開始...' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'started',
        message: 'データ再構築開始...'
      }).catch(() => {})

      // Clear all entity tables first
      await db.transaction('rw', [db.hands, db.phases, db.actions, db.meta], async () => {
        await db.hands.clear()
        await db.phases.clear()
        await db.actions.clear()
        await db.meta.delete('lastProcessed')
      })

      setOperationState({ type: 'rebuild', progress: 10, message: 'テーブルクリア完了、イベント読み込み中...' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'processing',
        progress: 10,
        message: 'テーブルクリア完了、イベント読み込み中...'
      }).catch(() => {})

      // Get total event count
      const totalCount = await db.apiEvents.count()
      console.log(`[rebuildAllData] Processing ${totalCount} events...`)

      if (totalCount === 0) {
        console.log('[rebuildAllData] No events to process')
        // 対象イベントが無い＝再構築の必要が無いため、保留中のアドバイザリも解消する
        await resolveAdvisory()
        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'completed',
          progress: 100,
          message: '処理対象のイベントがありません'
        }).catch(() => {})
        return
      }

      // Enable batch mode to prevent real-time updates
      service.setBatchMode(true)

      try {
        // Process in chunks to avoid memory issues
        let totalHands = 0
        let totalPhases = 0
        let totalActions = 0

        // Initialize EntityConverter
        const defaultSession = {
          id: undefined,
          battleType: undefined,
          name: undefined,
          players: new Map(),
          reset: () => { }
        }
        const converter = new EntityConverter(defaultSession)

        // Load all raw events and convert in one pass
        // (EntityConverter tracks hand state internally, so chunked conversion loses cross-chunk hands)
        console.log(`[rebuildAllData] Loading all events...`)
        const rawEvents = await db.apiEvents.orderBy('[timestamp+ApiTypeId]').toArray()

        // apiEvents is the raw Lake: it may contain non-application noise (202/205
        // keepalive/timer events), ApiTypeIds unknown to the current schema, or
        // application-type events whose payload doesn't match the current Zod schema
        // (either not-yet-fixed, or already fixed since the row was first stored).
        // Re-validating here — rather than trusting raw rows — is what makes this the
        // recovery path: any row a schema fix now makes parseable is automatically
        // picked up, no separate promotion mechanism required (docs/architecture.md
        // "Raw Event Lake"). It's also what keeps EntityConverter (which reads
        // required fields like EVT_DEAL.Game.SmallBlind without guards) from
        // throwing on a still-malformed row.
        const allEvents = await filterValidApplicationEvents(rawEvents)
        const skippedCount = rawEvents.length - allEvents.length
        console.log(`[rebuildAllData] Loaded ${rawEvents.length} raw events, ${allEvents.length} valid application events after re-validation${skippedCount > 0 ? ` (${skippedCount} non-application/unparseable rows skipped)` : ''}`)

        setOperationState({ type: 'rebuild', progress: 40, message: `${allEvents.length.toLocaleString()}件のイベントを変換中...` })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 40,
          message: `${allEvents.length.toLocaleString()}件のイベントを変換中...`
        }).catch(() => {})

        const entities = converter.convertEventsToEntities(allEvents)

        setOperationState({ type: 'rebuild', progress: 70, message: 'エンティティ保存中...' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 70,
          message: 'エンティティ保存中...'
        }).catch(() => {})

        const counts = await saveEntities(db, entities)
        totalHands += counts.hands
        totalPhases += counts.phases
        totalActions += counts.actions

        console.log(`[rebuildAllData] Generated entities - Hands: ${totalHands}, Phases: ${totalPhases}, Actions: ${totalActions}`)

        // Restore service state from latest events
        // (codex #177 3巡目レビューP2: このsetterはservice.liveEvtDealも同時に
        // 同期するため、下のsetBatchMode(false)がトリガーするrecalculateAllStats()
        // の再ブロードキャストは、再構築前のliveEvtDeal（観戦中に取り残された
        // 可能性がある）ではなく、この復元されたヒーロー在籍dealの座席文脈を使う)
        const latestDealEvent = await findLatestPlayerDealEvent(db)

        if (latestDealEvent && isApiEventType(latestDealEvent, ApiType.EVT_DEAL)) {
          service.latestEvtDeal = latestDealEvent
          if (latestDealEvent.Player?.SeatIndex !== undefined) {
            service.playerId = latestDealEvent.SeatUserIds[latestDealEvent.Player.SeatIndex]
          }
        }

        // Update metadata with rebuild info
        await db.meta.put({
          id: 'rebuildStatus',
          value: {
            lastRebuildDate: new Date().toISOString(),
            totalEvents: totalCount,
            totalHands: totalHands,
            totalPhases: totalPhases,
            totalActions: totalActions
          },
          updatedAt: Date.now()
        })

        const rebuildTime = ((performance.now() - startTime) / 1000).toFixed(2)
        console.log(`[rebuildAllData] Rebuild completed in ${rebuildTime}s`)

        setOperationState({ type: 'rebuild', progress: 90, message: '統計情報を再計算中...' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'processing',
          progress: 90,
          message: '統計情報を再計算中...'
        }).catch(() => {})

        // Trigger stats recalculation once at the end. NOTE: batchMode is still
        // true here (disabled in the `finally` block below via
        // service.setBatchMode(false)), so ReadEntityStream.transform() no-ops
        // this particular write() -- the real broadcast is the one
        // setBatchMode(false) triggers via PokerChaseService.recalculateAllStats(),
        // which reads the already-restored (hero-anchored) service.latestEvtDeal
        // above and keeps calling this again mostly harmless/redundant.
        if (service.latestEvtDeal && service.latestEvtDeal.SeatUserIds) {
          const playerIds = service.latestEvtDeal.SeatUserIds.filter(id => id !== -1)
          if (playerIds.length > 0) {
            console.log('[rebuildAllData] Triggering stats recalculation...')
            service.statsOutputStream.write(service.latestEvtDeal.SeatUserIds)
          }
        }

        // 再構築が完了したので、保留中の再構築アドバイザリがあれば解消する
        await resolveAdvisory()

        setOperationState({ type: 'idle' })
        chrome.runtime.sendMessage<RebuildProgressMessage>({
          action: 'rebuildProgress',
          state: 'completed',
          progress: 100,
          message: `データ再構築完了 (${rebuildTime}秒) - ハンド: ${totalHands.toLocaleString()}, フェーズ: ${totalPhases.toLocaleString()}, アクション: ${totalActions.toLocaleString()}`
        }).catch(() => {})

      } finally {
        // Disable batch mode
        service.setBatchMode(false)
      }

    } catch (error) {
      console.error('[rebuildAllData] Error:', error)
      setOperationState({ type: 'idle' })
      chrome.runtime.sendMessage<RebuildProgressMessage>({
        action: 'rebuildProgress',
        state: 'error',
        message: `データ再構築失敗: ${error}`
      }).catch(() => {})
      throw error
    }
  }

  return {
    exportData,
    importData,
    deleteAllData,
    getLatestSessionStats,
    rebuildAllData
  }
}

/**
 * Service Worker のアイドル停止を防止するキープアライブを開始する。
 * Chrome MV3 では 30 秒のアイドル後に Worker が停止されるため、
 * 長時間のバッチ処理中は30秒未満の間隔でExtension APIを呼び出す。
 * Chrome 110以降はExtension API呼び出しがService Workerのアイドル
 * タイマーをリセットする。manifestのminimum_chrome_versionは120。
 * @returns クリーンアップ関数
 */
export const startKeepAlive = async (): Promise<() => void> => {
  const id = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }, 25000)
  return () => clearInterval(id)
}

/**
 * `chrome.downloads.download()`のコールバック（および`downloads.lastError`）
 * を確認してから解決/拒否するPromiseを返す（codexレビュー指摘、監査
 * finding #10）。修正前はコールバック内で`lastError`をログするだけで
 * 呼び出し元（downloadFile）は待たずに解決していたため、ダウンロード自体が
 * 失敗（例: ユーザーがsaveAsダイアログをキャンセル、ディスク容量不足）
 * してもエクスポートは「完了」として扱われていた。
 */
const downloadViaDataUrl = (content: string, finalFilename: string, contentType: string): Promise<void> => {
  const base64Content = btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/g, (_match, p1) => String.fromCharCode(parseInt(p1, 16))))
  const dataUrl = `data:${contentType};base64,${base64Content}`

  return new Promise<void>((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: finalFilename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (downloadId === undefined) {
        reject(new Error('chrome.downloads.download failed: no downloadId returned'))
      } else {
        resolve()
      }
    })
  })
}
