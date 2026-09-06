# src/ の開発・レビュー規約

[root 規約](../AGENTS.md) に加えて `src/` 全体へ適用する。
境界をまたぐ変更は呼び出し側も含めて次の契約を確認する。
統計・派生の定義は [statistics.md](../docs/statistics.md)、ワイヤの事実は
[api-events.md](../docs/api-events.md)、設計根拠は [architecture.md](../docs/architecture.md)。

## Raw Event Lake と再生

- 数値の `timestamp` と `ApiTypeId` を持つイベントは Zod / application 判定より先に
  `apiEvents` へ保存する（MUST）。未知 type・noise・現 schema で parse できない行も保存
  対象。修復経路が raw 行を削除したり、validation を保存条件に戻したりしない（MUST NOT）。
- 型・schema の正本は `types/api.ts`。未知 field は `passthrough()` で保持し、pipeline
  入口では型 assertion の代わりに既存の parse / type guard を使う。新 payload variant は
  `schema-diff` で証拠を取り schema を広げ、受信時に捨てない。
- ローカル主キー・ページ cursor は `[timestamp+ApiTypeId+sequence]` 全体を使う（MUST）。
  同じ timestamp/type の異なる payload は別行、storage 用 sequence を除いた canonical
  content が同じ再送は重複。`processInChunks()` には Table を渡し、ページごとに fresh
  query を作る。Dexie Collection の `.offset()` / `.limit()` を使い回さない（MUST NOT）。
  ローカル sequence を cloud identity とみなさない。cloud の内容IDは
  [同期契約](services/AGENTS.md#cloud-identity) を参照する。
- stateful replay は完全な raw 等時刻グループを確保して並べ替え、その後に現在の schema
  で検証する（MUST）。unpaged は `orderAndFilterApplicationEventsForReplay()`、paged は
  `processInReplayChunks()` → `filterValidApplicationEvents()`。noise の除去で複合群を
  偽の2行 pair にしない。反転できるのは phase/actor/stack/Pot 差分で証明された孤立 pair
  のみ。主キー順・NDJSON 行順から元の到着順や lifecycle を推定しない（MUST NOT）。
- `EntityConverter` / `HandLogProcessor` に未検証 raw を渡さない（MUST NOT）。
  `convertEventsToEntities()` の1呼出し内に hand 境界状態があるため、全イベントを1回で
  渡す（MUST）。I/O の chunk 化を converter の任意 chunk 分割へ広げない。

## 派生データ・統計の変更

- live (`streams/write-entity-stream.ts`) と import/rebuild (`entity-converter.ts`) の
  entity 導出を一致させる（MUST）。stat 固有の action context だけで決まる flag は
  `detectActionDetails` に置く。構造・結果依存の `ALL_IN` / `RIVER_CALL_WON` 等は例外で、
  両 write path に揃える。stat の一時状態は自分の `handState.statStates[id]` だけを使う。
- 既存データの write-time 導出が変わるときは `REBUILD_ADVISORY_VERSION` を上げる（MUST）。
  読取り専用の統計追加・索引追加だけなら機械的に上げない。判定と実走方法は
  [CONTRIBUTING](../CONTRIBUTING.md#applying-your-statistic-to-existing-data-rebuild)。
- 導出・統計変更では cross-path parity と `verify-stats` を実行する（MUST）。oracle は
  raw から独立再計算し、実装側の helper を共有させない。`verify-stats` 単独は live writer
  を検証しない。入口・fixture・既知差分は CONTRIBUTING の検証節を使う。
- clear / delete-then-put 等の派生置換は単一 Dexie RW transaction または staging swap
  で commit する（MUST）。途中失敗で従前よりデータを減らさず、完了状態は全 Lake からの
  再構築と一致させる。非空 DB への新 raw 行 import は全再構築、純重複は no-op。
  raw commit 後の再構築失敗は raw を残したまま失敗として報告する。
- 座席・勝者・FLOP/SHOWDOWN・chip accounting の変更は statistics 正本の「派生契約」
  を確認する（MUST）。保存用の original seat と hero を0に回転した表示座標を混ぜない。
  ALL_IN の CHECK 権を CALL にせず、3bet 機会は確定したレイズ不能だけを除外する。
  menu 不明と実 RAISE の扱い、3betfold への非適用も同じ正本に従う（MUST）。

## 永続統計台帳

- live raw `EVT_HAND_RESULTS` 保存と、exact 三要素主キーによる pending-derivation fence
  作成を atomic に行う（MUST）。canonical entities と ledger の同時 commit、または
  文書化された非導出 terminal 判定まで、その fence を維持する。
- 現 SW boot 所有の fence は通常の進行中処理。別 owner・failed・不正 fence は lazy
  baseline を止めて Lake 復旧へ進める（MUST）。canonical transaction 失敗後は failed
  状態の保存自体が失敗しても exact ID をメモリ上の根拠として非同期復旧へ渡す。
- cloud chunk rebuild は開始時に捕捉した exact fence ID だけを activation で消す。
  手動全再構築が全件を消せるのは `apiEvents` RW lock 下の完全 snapshot を再生した
  commit のみ（MUST）。新しい live fence を一括消去しない。
- ledger は canonical entities の読取り索引。all-history counters と filter 別 latest-N
  の正確さ、lazy baseline / generation activation の契約は architecture の「v8」を参照。

## 対局・ポート・replay の共通境界

- 最後に WebSocket ゲームイベントを届けた port を唯一の ACTIVE とし、live stats と
  realtime をそこだけへ送る（MUST）。relic port を参照・clear しない。別 tab/document
  世代への移行は current-hand stream を event 投入前に reset、同じ tabId/documentId の
  bounded reconnect は stream・DEAL・activity・account を保持する。
- aggregate stats と席回転 DEAL は同じ ACTIVE 世代に属させる（MUST）。SW 起動後に
  token 世代が未生成のときだけ、background 起点の aggregate refresh を全接続 game port
  へ fallback する。reconnect-pending はこの例外ではない。保存済み非重複 raw 309 は
  Zod 成否によらず current-hand stream/cache を clear し、aggregate を残す。
- page hook、content keepalive、SW activity の境界を揃える（MUST）。開始は201（数値の非0 Codeを
  除く。Code欠落は安全側のACTIVE）、hero-seated 303、308、終了は309と `Code === 0` の203。spectator DEAL は開始にせず、
  失敗・不正203は終了にしない。keepalive は対局中だけ有効にする。
- replay HTTP は現在の ACTIVE 世代が明示的に inactive のときだけ開始する（MUST）。
  token 未生成・unknown・reconnect-pending は止める。queue に入れた HandId の account
  を保持し、取得先もその account の ACTIVE に限定する。
- 常時注入 WebSocket hook は page の activity を保持し、start を直接見て in-flight
  replay を中断する（MUST）。SW の新規 start 後（raw 保存失敗も含む）の全 port cancel、
  content port 切断時の unsent/queued/in-flight 失効、SW epoch は補助の所有権ガード。
  request 別 controller map や保存可否の判断をこれらの補助経路へ持たせない。
- replay 応答は ingestion queue を通し、synthetic transaction の最初の read による
  lock 待ちが済んだ後、最初の90001 write 直前に activity を再検証する（MUST）。
- 公開 replay import は session-safe `/replay/list` が `IsExpiredCardOpen === false`
  と未来の `CardOpenEndDate` を証明するまで無効、各 cycle でも再検証する（MUST）。
  DevTools の `experimentalReplayImportEnabled` は entitlement 検証を bypass するが、
  対局中の取得禁止は共通。無効化・失効で既存 Lake 行や projection を削除しない。
- private 90000 系の synthetic event は application 保存・同期に含め、entity / stats /
  oracle の対局処理には影響させない（MUST）。新 type は
  `replay/synthetic-event-invisibility.test.ts` へ追加する。`session` / `requestKey` を
  synthetic event や projection に残さない（MUST NOT）。
- 同一 account の同時多卓はゲーム機能として扱わない。別 tab の10秒未満の配信は診断
  warning のみ、同一 tab の F5 候補は除外。正当な対象は逐次 handover・reconnect・観戦。

## 実行環境と表示側への境界

- `background.ts` と `background/` は MV3 SW。`window` を使わず global timer を使い、
  任意の await で停止し得る前提で durable state と復旧を設計する。
- `chrome.storage.local` の `TRUSTED_CONTEXTS` を維持する（MUST）。content script の
  layout・直近ハンド設定・last-table は固定 runtime message で background を経由する。
  表示側の定数から Dexie / background module を bundle に引き込まない。
- hero `playerId` / `latestEvtDeal` は session 状態ではない。spectator DEAL と
  `SessionState.reset()` で消さず、hero-seated DEAL で更新する（MUST）。
- 表示・履歴の読取りを変える場合は [UI契約](components/AGENTS.md) と
  [履歴サービス契約](services/AGENTS.md#recent-hands) の対象節も確認する。
