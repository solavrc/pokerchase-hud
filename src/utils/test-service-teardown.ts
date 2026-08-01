/**
 * テスト専用ユーティリティ: PokerChaseService の保留中 persistState() タイマーを
 * テスト終了時にまとめて取り消す。
 *
 * ## なぜ必要か
 *
 * `service.playerId = ...` / `service.latestEvtDeal = ...` / `service.session.*`
 * のミューテーションは 500ms デバウンスの persistState() タイマーを仕込む
 * （poker-chase-service.ts）。テストが終わってもこのタイマーは生きており、
 * **後続テストの beforeEach 窓** — test-setup.ts のルート beforeEach による
 * ストレージリセット後、そのテスト自身の `await service.ready`
 * （restoreState() の読み出し）より前 — で発火すると、破棄済みインスタンスの
 * playerId/latestEvtDeal/session が共有の chrome.storage.local モック
 * （test-setup.ts のモジュールスコープ単一オブジェクト）へ書き込まれ、
 * 後続テストがそれを「復元」してしまう。CIで実際にフレークとして観測された
 * （message-router.spectator-filter-refresh.test.ts）。
 *
 * ## 使い方
 *
 * テスト内で `new PokerChaseService(...)` した戻り値をそのまま包む。
 * beforeEach でも、テスト本体でも、ヘルパー関数の中でも構わない:
 *
 * ```ts
 * import { trackServiceForTeardown } from '../utils/test-service-teardown'
 *
 * service = trackServiceForTeardown(new PokerChaseService({ db }))
 * ```
 *
 * このモジュールを import したテストファイルには、ルートスコープの afterEach
 * （下部で登録）が自動で追加される。ルートスコープの afterEach は describe 内の
 * afterEach より **後** に走るため、ファイル側の teardown が最後に何か persist を
 * 誘発しても取りこぼさない。
 *
 * ## 規約
 *
 * - テストが PokerChaseService を生成する場合、そのインスタンスは
 *   trackServiceForTeardown() で包まなければならない（MUST）。
 *   `jest.useFakeTimers()` を使うファイルでも同様（包んでも無害であり、
 *   「生成箇所は必ず包む」という一様な規約の方が監査より安上がりだから）。
 * - `(service as any)._persistStateTimer` を直接 clearTimeout する旧来の
 *   その場しのぎを新たに書いてはならない（MUST NOT）。private フィールド名の
 *   変更を型検査が捕まえられないため、取り消しは公開 API
 *   `cancelPendingPersist()` 経由に一本化する。
 * - 1つのテスト内で複数インスタンスを順に使い捨てる場合（cross-path-parity.test.ts
 *   の replay()、import-export.full-rebuild.test.ts の withService()）は、
 *   用済みの時点で `service.cancelPendingPersist()` を直接呼んでよい（MAY）。
 *   ルート afterEach はテスト終了時にしか走らないため、それだけでは同一テスト内の
 *   次のインスタンスの restoreState() に間に合わない。
 */
import type PokerChaseService from '../services/poker-chase-service'

/**
 * 追跡中のインスタンス。
 *
 * 意図的に afterEach でクリアしない: beforeAll やモジュールスコープで生成され、
 * 複数テストにまたがって使い回されるインスタンスも、以降すべてのテスト終了時に
 * 取り消され続ける必要があるため。1ファイル内の生成数はたかだか十数個で、
 * 保持コストは無視できる。
 */
const trackedServices = new Set<Pick<PokerChaseService, 'cancelPendingPersist'>>()

/**
 * `service` をテスト終了時のタイマー取り消し対象として登録し、そのまま返す。
 * 同じインスタンスを複数回渡しても安全（Set による冪等）。
 */
export const trackServiceForTeardown = <T extends Pick<PokerChaseService, 'cancelPendingPersist'>>(service: T): T => {
  trackedServices.add(service)
  return service
}

afterEach(() => {
  for (const service of trackedServices) {
    service.cancelPendingPersist()
  }
})
