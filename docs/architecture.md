# アーキテクチャ設計判断

> データストレージ、データモデル、クラウド同期、インデックス最適化に関する設計判断とその根拠。

## 0. Raw Event Lake: `apiEvents` は生ログ、バリデーションは保存を左右しない

### 設計原則
`apiEvents`テーブルは**受信した生イベントの完全なログ**であり、Zodスキーマ検証の
成否やアプリケーションイベントか否かに関わらず、数値の`timestamp`+`ApiTypeId`を
持つイベントは全て保存する。バリデーションが左右するのはリアルタイム処理
パイプライン（`handLogStream`/`handAggregateStream`/`realTimeStatsStream`と
`EntityConverter`/`HandLogProcessor`への投入可否）だけであり、保存そのものを
左右しない。

### 経緯（設計のドリフトと復元）
- **2024年（初期実装、コミット5f7d60c/fce0343）**: 当初から「APIイベントの生ログを
  保存」する設計だった（`src/db/poker-chase-db.ts`のクラスdocコメントに今も残る文言）。
- **2025-07-24（コミットa6480ff）**: `apiEvents`テーブルに`creating`/`reading`の
  Dexieフックを追加し、非アプリケーションイベントを自動フィルタリングする実装に
  リファクタ。意図は「フィルタリングをDB層に一元化する」ことだったが、副作用として:
  - `creating`フックは`this.onsuccess = null`しか行っておらず、配下の
    `IDBObjectStore.add()`自体は既に発行済みのため**実際には書き込みを止められて
    いなかった**（非アプリケーションイベントは静かに物理保存されたまま、
    `reading`フックが読み取り結果からnullとして除外することで見えなくしていた）。
  - より深刻な問題: `event-ingestion.ts`/`import-export.ts`側で
    Zodパース失敗時にraw保存処理を呼ぶ前に`return`していたため、
    **パースに失敗したイベントはそもそも保存されていなかった**。PokerChase側の
    ペイロード仕様変更でスキーマ検証が壊れた場合（2026年シーズン3の
    `EVT_SESSION_RESULTS`）、そのイベント種別のデータは月単位で完全に失われ、
    データ再構築でも復旧不能だった。
- **本バージョン（2026年、feat/restore-raw-event-lake）**: `creating`/`reading`
  フックを完全に撤廃し、`event-ingestion.ts`/`import-export.ts`の保存判定を
  「`validateMessage()`が通る（timestamp/ApiTypeIdが数値）」だけに緩和。元々の
  設計意図を復元しつつ、実際のデータ損失の原因（パース失敗イベントが保存前に
  discardされていたこと）を修正した。

### 保存とパイプライン投入の分離
| 判定 | 保存（content dedup + sequence採番） | パイプライン投入（ストリーム/EntityConverter） |
|---|---|---|
| `timestamp`/`ApiTypeId`が数値でない | ✗ 不可（キーが作れない） | ✗ |
| 数値だがZodパース失敗（未知の`ApiTypeId`含む） | ✓ 生のまま保存 | ✗（`console.warn`のみ） |
| パース成功・非アプリケーションイベント（202/205等） | ✓ 保存 | ✗（`console.info`のみ） |
| パース成功・アプリケーションイベント | ✓ 保存 | ✓ |

### `apiEvents` sequence key と重複判定

主キーは`[timestamp+ApiTypeId+sequence]`（DB v6）。`Date.now()`由来の
`timestamp`とイベント種別が同一でも、payloadが異なるイベントには同じ組内で
0から単調増加する`sequence`を割り当て、全行を保持する。`[timestamp+ApiTypeId]`は
重複し得る二次インデックスとして残し、content dedupとsequence採番を一つのDexie
transactionで行う。reconnect resendの判定はトップレベルの`sequence`を除く
canonical payload全体の一致であり、時刻と種別だけでは重複とみなさない。

この主キーは保存・ページング順であって、異なる`ApiTypeId`間の受信順ではない。
異種イベントが同一millisecondなら主キーは`ApiTypeId`順に並び、`sequence`も同じ
`timestamp+ApiTypeId`組の内部にしか意味を持たない。ライブ処理は直列キューの到着順を使い、
保存済みイベントから状態を再生・監査するconsumerはsession/hand境界の因果関係を別途扱う。

IndexedDBは既存object storeの主キーを直接変更できないため、v3→v6はv4で全行を
一時storeへ`sequence: 0`付きでコピーし、v5で旧storeを削除、v6で新主キーのstoreへ
戻す。versionchange transaction内で完結し、旧主キー下では既存行が一意なので
機械的な移行である。`hands`/`phases`/`actions`のキーや導出結果は変わらないため、
`REBUILD_ADVISORY_VERSION`は3のままで追加再構築を要求しない。

### リビルド = 復旧経路
`rebuildAllData`（`src/background/import-export.ts`）は`apiEvents`の全行を
`filterValidApplicationEvents()`（`src/utils/database-utils.ts`）で**再検証**して
から`EntityConverter`に渡す。これにより、PokerChase側のペイロード変更で
一時的にパースできなくなったイベント種別も、後日スキーマ側を修正して
データ再構築を実行するだけで自動的に復旧する。dead-letterテーブルや
プロモーション処理のような別機構は不要——同じ生の行を、直近のスキーマで
再解釈するだけで済む。同じ再検証は`AutoSyncService.rebuildLocalEntities`
（クラウドダウンロード後の再構築）と`HandLogExporter`（PokerStarsエクスポート）
でも行っている。`EntityConverter`/`HandLogProcessor`は`switch (event.ApiTypeId)`
で必須フィールド（例: `EVT_DEAL.Game.SmallBlind`）を無検証で読むため、
未検証の生の行を直接渡すとクラッシュしうる。

### クラウド同期は対象外
Firestoreへのアップロードはアプリケーションイベントのみに限定する
（`AutoSyncService.syncToCloud()`の`isApplicationApiEvent`フィルタ）。
これはコスト上の判断（Firestore書き込み/ストレージ課金）であり、データ損失の
懸念ではない——非アプリケーションイベントや未検証イベントはローカルの
Raw Event Lakeに既に生のまま残っている。

### ストレージ増加とプルーニング
`apiEvents`は非アプリケーションノイズ（202/205のキープアライブ/タイマー等、
セッションあたりアプリケーションイベントとほぼ同程度の件数）も恒久的に保存する
ため行数は増加するが、IndexedDBのクォータはブラウザ管理でGB級が一般的であり、
実務上問題になる可能性は低いと想定している。**現時点で`apiEvents`の自動
プルーニングは実装していない**（`src/services/poker-chase-service.ts`の
`cleanupOldStorageData`は`chrome.storage.local`のサービス状態用、
`src/utils/database-utils.ts`の`withTransaction`の`QuotaExceededError`分岐は
ログのみで能動的なクリーンアップは行わない）。将来的に問題が顕在化した場合の
フォローアップ候補（詳細な設計は本バージョンでは意図的に見送り）。

## 1. データストレージ: Dexie.js (IndexedDB)

### 採用理由
- 複合主キー（`[timestamp+ApiTypeId+sequence]`）、複合インデックス（`[timestamp+ApiTypeId]`）とマルチエントリインデックス（`*seatUserIds`）のネイティブサポート
- 効率的なバルク操作（`bulkPut`、`bulkAdd`）
- TypeScript型安全性
- バージョンは`package-lock.json`で固定（実装上の正本）

### 却下した選択肢
| 選択肢 | 却下理由 |
|---|---|
| 生 IndexedDB | 冗長な API、複合インデックスの手動実装、トランザクション管理が困難 |
| idb (12KB) | 複合インデックス非対応、マルチエントリクエリの手動実装が必要 |
| PouchDB | ドキュメント指向でリレーショナルデータに不適合 |
| LocalForage | KV のみ、複雑なクエリ不可 |
| RxDB | 200KB+ で過剰 |

## 2. データモデル: 正規化エンティティ

### 構造
- `hands`: ハンドレベルデータ
- `phases`: ストリートごとの情報
- `actions`: 個々のプレイヤーアクション（統計マーカー付き）

### 採用理由
- マルチエントリインデックスによるプレイヤーベースクエリの効率化
- データ重複なし、新統計の追加に柔軟

### 却下: 非正規化単一テーブル
大規模なデータ重複、個別アクションのクエリ困難、スケールでの性能低下。

## 3. クラウド同期: Firestore + 生イベントのみ

> ローカルの`apiEvents`（Raw Event Lake、セクション0参照）とは異なり、Firestoreへの
> 同期対象はアプリケーションイベントのみ（コスト最適化。データ損失の懸念ではない）。

### データ構造
```
/users/{userId}/apiEvents/{timestamp_ApiTypeId}            # sequence 0
/users/{userId}/apiEvents/{timestamp_ApiTypeId_sequence}   # sequence > 0
```

### 採用理由
- シンプルな単一コレクション、タイムスタンプによる増分同期
- BigQuery 直接エクスポート対応
- 処理ロジックをローカルで自由に更新可能

sequence 0が従来のdocument IDを維持するため、既にアップロード済みの履歴を
別documentとして再送しない。新クライアントは旧ID document（`sequence`なし）を
`sequence: 0`として取り込み、新ID documentはsuffixと保存フィールドのsequenceで
別行として取り込む。移行期間中の旧クライアントは新ID document自体のdecodeでは
例外にならないが、旧ローカル主キーでは同一timestamp/typeの二行を表現できず、
download時に片方だけが残る。旧クライアントがsequence>0 documentを上書きすることは
ないものの、そのローカル表示・派生データは欠落し得る。remote min-version gate / Forced
Updateで併存期間を短くするが、この一時的な旧クライアント側欠落が残余リスクである。

### 却下した選択肢
| 選択肢 | 却下理由 |
|---|---|
| Firestore に正規化エンティティ | ストレージ +40%、書き込み 4 倍、処理の柔軟性喪失 |
| Cloud Storage (ファイル) | クエリ不可、同時実行問題、BigQuery 自動エクスポート不可 |

## 4. 同期戦略: イベント駆動

- セッション終了時（309）に100+新規イベントで自動アップロード
- セッション開始時（201/308）にも同じ閾値を確認し、終了イベント欠落時のフォールバックとする
- 手動同期 UI（上り/下り選択可）
- 定期同期なし（Firestoreの読み書き・ストレージ負荷を抑えるため）

### 却下: リアルタイム同期 (onSnapshot)
10k イベント = 10k 読み取り、Service Worker 30 秒タイムアウト問題、単一デバイス利用では不要。

## 5. インデックス最適化 (v3 マイグレーション)

### 追加インデックス

| テーブル | インデックス | 用途 |
|---|---|---|
| `apiEvents` | `[ApiTypeId+timestamp]` | 特定イベントタイプの時系列クエリ |
| `hands` | `approxTimestamp` | 最近のハンドの効率的取得 |
| `actions` | `[playerId+phase]` | プレイヤーの特定ストリートアクション |
| `actions` | `[playerId+actionType]` | アクションタイプ別集計 |
| `meta` | `updatedAt` | キャッシュ有効期限管理 |

### パフォーマンス改善例

```javascript
// Before: 全 EVT_DEAL 取得 → フィルタ + ソート (O(n))
// After: 複合インデックスで直接取得 (O(log n))
await db.apiEvents.where('[ApiTypeId+timestamp]')
  .between([ApiType.EVT_DEAL, 0], [ApiType.EVT_DEAL, Infinity])
  .reverse().first()

// Before: 全アクション取得 → メモリ内フィルタ
// After: 複合インデックスで直接フィルタ
await db.actions.where('[playerId+phase]')
  .equals([playerId, PhaseType.FLOP]).toArray()
```

### メタテーブル汎用化
`ImportMeta` → `MetaRecord` に拡張。インポート追跡、統計キャッシュ、同期状態、アプリケーション設定に対応。

### ストレージ影響
インデックス追加で約 10-15% 増加。クエリ性能向上がコストを上回る。

## 将来の検討事項
1. 30-90 日後の古いデータを Cloud Storage にアーカイブ
2. 頻繁にアクセスされる統計のサマリーテーブル
3. 長期保存のためのイベント圧縮

## 参考文献
- [Dexie.js Documentation](https://dexie.org/)
- [Dexie.js Indexing Best Practices](https://dexie.org/docs/Indexing)
- [Firebase Firestore Pricing](https://firebase.google.com/pricing)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
