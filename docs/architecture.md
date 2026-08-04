# アーキテクチャ設計判断

> データストレージ、データモデル、クラウド同期、インデックス最適化に関する設計判断とその根拠。

## ACTIVEポートtoken: ゲームイベントを最後に届けたタブだけを更新する

PokerChaseは排他的ログインであり、1セッションで実際に使われるゲームタブは常に1つである。
raw capture 415k handsでは2卓の同時配信は0件で、568件のhand preemptionは全て逐次的、
最短間隔も12秒だった。このゲーム側制約を前提に、WebSocket由来のgame eventを最後に
届けたportを唯一のACTIVE portとする。別portから次のeventが届けば即座にtokenを移し、
以前のportが後でeventを届ければ同じ手順でtokenを取り戻す。

statsとrealtime更新はACTIVE portだけへ送り、接続中の他port（relic）にはclearも更新も
送らない。したがってrelicのHUDは最後に描画した状態で凍結される。別tabまたは別document
世代へのhandoverでは、現在ハンドの`RealTimeStatsStream`とDEAL文脈をresetしてから
新しいeventを投入する。旧portが後でeventを届ければ同じ手順でtokenを取り戻す。一方、
`RuntimePortManager`による同一content scriptの一時切断は`tabId`と`documentId`が一致し、
500ms再接続を包含する2秒窓内に再接続した場合だけ同一世代と判定する。この場合は
transportの差し替えなので、進行中ハンド、DEAL、activity、accountを引き継ぐ。
ただしService Worker起動後にtoken世代がまだ一度も確定していない場合、background起点の
フィルター変更・再構築・インポート・auto-sync復元による集計更新は接続中のgame port
すべてへfallbackする。これはライブ配信ではなく、token不在を理由にユーザー操作や復元結果を
無音で捨てないための初期化時例外である。再接続候補の世代が残る切断猶予中は対象外となる。

集計statsへ添える席回転用DEALは、ACTIVE世代でDEALを観測済みの場合だけ
`liveEvtDeal`から読む。この値はbatch再計算時にも同じstats文脈へ再アンカーされるが、
世代の最初のDEALより前は前世代の残存値を抑止する。309はRaw Event Lakeへの保存と重複排除の後、
Zod検証より前に現在ハンドstream/cacheを消すため、破損payloadでも終了済みハンドの
SPR・ポットオッズが後のfilter再計算で復活しない。集計lineup自体は保持する。

replayのsession判定とaccount attributionにもACTIVE portの状態だけを使い、relicの状態は
参照しない。取得を許すのは現在世代が明示的にsession外と確定した場合だけで、Service
Worker再起動直後のtoken未生成はunknownとして遮断する。trusted WebSocketの生201/303/308は
進行中の取得を同一pageの常時注入hookが直接見て自律中断する。クロスタブと
SW再起動境界だけは、保存・dedup後の新規開始（raw保存失敗時はfail-closed開始）を見たSWが
request非依存の一括cancelを全game portへ送る補助線を残す。content scriptはSW port切断時にも
そのSWが所有していた未送信・queued・実行中依頼を一括失効させる。
replay RESULTは生イベントと同じ取り込みキューへ通し、
Dexie transaction内の最初のread（競合write lock待ちを含む）が終わった後、最初の
write直前にも現在activityを再評価する。
10秒未満で別tabからeventが届いた場合はaxiom違反の検出として
`console.warn`を記録する。同一tabのF5 reload候補は警告対象外とし、複数sessionを扱う分岐は
追加しない。

## 0. Raw Event Lake: `apiEvents` は生ログ、バリデーションは保存を左右しない

### 設計原則
`apiEvents`テーブルは**受信した生イベントの完全なログ**であり、Zodスキーマ検証の
成否やアプリケーションイベントか否かに関わらず、数値の`timestamp`+`ApiTypeId`を
持つイベントは全て保存する。バリデーションが左右するのはリアルタイム処理
パイプライン（`handLogStream`/`handAggregateStream`/ACTIVE tokenに束縛した単一`realTimeStatsStream`と
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

`timestamp`はWebSocket message decode直後の`Date.now()`なので、異なるevent typeが
同一millisecondになる。主キー・exportはApiTypeId順へ並べるため、stateful readerは
同時刻groupをpage境界で分断しない。groupが303/305/313のstate snapshotと304だけの
2-event pairで、phase、NextActionSeat、actor stack、Potの差分が全て一致するときだけ
snapshotを先へ戻す。3件以上の複合groupは、局所的に証明できるpairがあっても無関係なeventを
跨いで動かさず、group全体を主キー順に維持する。201/308や306/309を含むsession/hand
lifecycleは、MTT table moveやtable間interleaveを前状態なしに区別できないため推論しない。
このstrict resolverはlegacy/futureの双方に同じ規則を適用し、
IndexedDB/Firestore schemaやdedup identityへ一時的な受信順metadataを追加しない。
resolverはvalidation前のraw group全体へ適用し、その後でapplication/schema filterを行う。
filterを先に行うとnoise除去で複合groupが偽の2-event pairへ縮むため、順序を逆転してはならない。

実raw 393,830 eventsにあるcross-type同時刻210 groupを監査し、このpredicateが変更するのは
313→304が2件と305→304が1件だけだった。別rawの18 groupに変更対象はなかった。

IndexedDBは既存object storeの主キーを直接変更できないため、v3→v6はv4で全行を
一時storeへ`sequence: 0`付きでコピーし、v5で旧storeを削除、v6で新主キーのstoreへ
戻す。versionchange transaction内で完結し、旧主キー下では既存行が一意なので
機械的な移行である。`hands`/`phases`/`actions`のキーや導出結果は変わらないため、
`REBUILD_ADVISORY_VERSION`は3のままで追加再構築を要求しない。

### リビルド = 復旧経路
`rebuildAllData`（`src/background/import-export.ts`）は`apiEvents`の全行を
`orderAndFilterApplicationEventsForReplay()`（`src/utils/database-utils.ts`）でraw groupの
順序判定後に**再検証**してから`EntityConverter`へ渡す。これにより、PokerChase側のペイロード変更で
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

### v8: 永続統計台帳

HUD集計は`statHandContributions`に「1プレイヤー・1完成ハンド」の寄与を、
`statPlayerAggregates`にプレイヤー単位の累積値を保存する。寄与は対戦種別・卓人数層・
ポジション・時刻と、既存18数値指標の分子／分母を持つ。完成ハンドではcanonicalな
`hands`/`phases`/`actions`と同じtransactionで寄与と累積値を更新し、通常のHUD更新で
全履歴を読み直さない。表示時は保存したcounterを既存指標の値・書式へ射影するため、
統計定義と表示結果は変えない。

全履歴のcounterはaggregateに保持する一方、per-hand行は各プレイヤーの
「対戦種別×卓人数層」cellごとに最新500件までとする。HUDが入力できる
latest windowの上限も500件であり、任意のfilter後の最新500件は、対象cellそれぞれの
最新500件の和集合に必ず含まれる。これによりlatestの厳密性を保ったまま、cold baselineの
永続化行数とlive中の保持量を全履歴件数から切り離す。
外部入力などで500を超える契約外`handLimit`が保存されていた場合は、台帳内部でだけ無言に
丸めず、optionsの保存・読込境界で500へ永続マイグレーションする。これによりPopup表示、
Service Workerの実フィルター、寄与windowの契約が同じ値になる。

フィルター付きの最新N件は、プレイヤーごとに「対戦種別 → 卓人数層 → 全ポジションを
横断した最新N件 → ポジション別集計」の順で選ぶ。N件制限がない場合は累積bucketを読み、
N件制限がある場合だけハンド寄与を複合インデックスから新しい順に読む。したがって
ポジション別画面も、各ポジションからN件ずつ取るのではなく通常HUDと同じ母集団を使う。

v8へのupgradeは空の台帳storeを追加するだけで、versionchange transaction内では既存履歴を
計算しない。プレイヤーが初めて必要になった時に、そのプレイヤーのcanonical entityだけから
baselineを一度作る。`EVT_PLAYER_SEAT_ASSIGNED`（313）はこの処理を非同期に先読みする
性能上のヒントであり、313が欠落しても`EVT_DEAL`（303）の実lineupとHUD読取り時のlazy
baselineが正しさを担保する。

HUDは`meta`が指すactive generationだけを読む。クラウドダウンロード後の分割再構築では、
staging generation自体は空のまま保ち、markerをcanonical表がdirtyであることのフェンスとして
使う。分割中は旧active headのready値を読めるが、dirty canonicalから新baselineは作らない。
完了時はcanonicalの最終commitと同じ短いtransactionで空の新headへ切り替え、以後のHUD読みが
表示lineupのみをlazy baselineする。これにより全プレイヤー分の巨大な二重世代を作らない。

markerにはService Worker起動ごとのownerを記録する。中断markerを次の起動が見つけた場合は、
認証状態やcloudの`lastSyncTime`に依存せず、ローカルRaw Event Lakeからcanonical再構築を再開する。
import/cloud downloadが新しいraw rowを追加する場合は、その追加transactionと同じcommitで
canonical dirty markerも置く。したがってraw保存直後・再構築開始前・cloud page間のどこで
Service Workerが終了しても、次回起動はstaleな派生表を成功状態として扱わない。

liveの`EVT_HAND_RESULTS`（306）は、Raw Lakeの主キー`[timestamp+ApiTypeId+sequence]`ごとの
pending derivation fenceをraw rowと同じtransactionで保存する。完了ハンドのcanonical entityと
統計台帳のcommitが成功した時、またはschema不適合・DEAL欠落・cross-generation/
chimera判定で意図的に派生しないと確定した時に、対応するexact fenceだけを消す。
同じ起動ownerの未完了fenceは通常のin-flightとして扱い、別owner・失敗済み・壊れたfenceは
中断復旧とbaseline構築拒否の対象とする。cloud分割再構築は開始時に回収対象のexact IDを固定し、
完了commitでそのIDだけを消すため、再構築中に到着したlive fenceを巻き込まない。
手動の全再構築は`apiEvents`のRW lock下でLake全体の一致snapshotを再生し、その最終commitで
pending fence全件を回収する。

cloud履歴のsession eventはreplay専用の`SessionState`へ適用し、live singletonを走査中に
書き換えない。再構築開始時のACTIVE port generation/activity、session、playerId、DEAL文脈が
完了時まで不変で、かつACTIVE状態でない場合だけ履歴文脈を公開する。対局中または途中でlive
eventを観測した場合は現在文脈を保持し、履歴末尾の古いDEALへ巻き戻さない。

非active世代の削除は250行単位の短いtransactionへ分割し、各chunkでactive/stagingを再確認する。
起動時にもこのGCを再開し、前workerのタイマー発火前に残った旧世代を回収する。

これは既存canonical entityから作る読取り用索引の追加であり、`hands`/`phases`/`actions`の
導出規則は変わらない。既存DBはlazy baselineで自動的に埋まるため、
`REBUILD_ADVISORY_VERSION`は更新しない。

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
2. 長期保存のためのイベント圧縮

## 参考文献
- [Dexie.js Documentation](https://dexie.org/)
- [Dexie.js Indexing Best Practices](https://dexie.org/docs/Indexing)
- [Firebase Firestore Pricing](https://firebase.google.com/pricing)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)

## 6. 試験機能: リプレイ詳細の取得層

`experimentalReplayImportEnabled` を `chrome.storage.sync` で `true` にした
開発ビルドだけが有効化する、既定OFFの検証機能。目的は「`/replay/*` から
何がどこまで取得できるか」を、スキーマ変更を伴わずに実データで確かめること。

Service Workerのポート受信遅延・取り込みキュー深さ・リプレイドレイン判定を
調べる診断ログは、別の同期キー `swIngestionDiagnosticsEnabled` で切り替える。
このキーはリプレイ取得を有効化せず、`experimentalReplayImportEnabled` も診断を
有効化しない。リプレイ取得を停止したまま計測する場合はService Workerの
DevToolsコンソールで次を実行する。

```javascript
await chrome.storage.sync.set({ swIngestionDiagnosticsEnabled: true })
```

無効化は同じキーを `false` に戻す。ログはpayload、HandId、playerIdを含まない。

**リプレイ本体（`/replay/detail`）は保存しない。** セッション境界を見て自動で
取りに行く取り込み層は別途。ただし後述の台帳監査だけは、その結果を `meta`
テーブルの1行（`replayLedgerAudit`）へ書く ―― MV3のService Workerは数十秒で
落ちるので、メモリ上に置くとユーザーが結果を読む前に消えるため。書かれるのは
台帳と突き合わせた**件数と HandId の一覧、チップ差分、エンベロープの期限値**
（`CardOpenEndDate`）で、リプレイのハンド内容は含まない。新しいDexieの
バージョンは消費しない。

ページ自身の通常API通信（fetch / XMLHttpRequest）をmain worldで傍受して
認証エンベロープ（`session` / `platform` / `appVer` / `dataVer` /
`masterVer`）を得る。新しいhost permissionは追加しない。エンベロープは
main world のクロージャ内だけに保持し、content script へ渡す前に
レスポンスから `session` / `requestKey` を再帰的に除去する
（`sanitizeReplayDetail`）。

### 注入モデル: 有効時のみ傍受コードを載せる

fetch / XMLHttpRequest の傍受と認証エンベロープ捕獲は `replay_bridge.ts`
（main world の WAR スクリプト）に分離してある。中核の WebSocket 傍受
（`web_accessible_resource.ts`、HUD全機能の土台）は全ユーザーで常時注入
されるが、`replay_bridge.js` は `content_script.ts` が
`experimentalReplayImportEnabled` を有効に読んだときにだけ `<script>` として
注入する。無効ユーザーの実行環境にはリプレイ傍受コードが一切載らず、
fetch / XHR は素のまま・エンベロープ捕獲も行われない。

- **注入は有効化の遷移より後**: `content_script.ts` は `storage.onChanged` を
  受けたその場で注入するので、ページ再読み込みは要らない。ただし有効化する前に
  ページが出していた通信は捕獲できない。捕獲機会は1回きりではなく、ロード後の
  任意の通常API通信で捕まる（`/replay/list`・`/replay/detail` はユーザー操作・
  セッション終了後に飛ぶので間に合う）。
- **`<script>` は取り消せない**: 一度注入したスクリプトは、フラグを無効に戻しても
  DOM から消せない。`content_script.ts` は `replayBridgeInjected` で注入を1回に
  冪等化し、無効化は `REPLAY_BRIDGE_CONFIG` の `enabled: false` を送ってブリッジ側
  でランタイムに no-op 化する（傍受を素通しに戻し、捕獲済みエンベロープを破棄）。
台帳（`REPLAY_BRIDGE_LEDGER`）の転送は `content_script.ts` 側でも実験フラグを
確認する。この経路は同一オリジンの `postMessage` なので、ブリッジを一度も注入
していない無効ユーザーでも、ページ側スクリプトが台帳を偽装して送れてしまう
（ブリッジ側のゲートだけでは、ブリッジを経由しない偽装を塞げない）。

- **ページ側からの偽装は残存**: main world と content script は同一オリジンの
  `window.postMessage` を共有するため、ページ側の任意のスクリプトがブリッジへ
  設定と取得依頼を偽装できる。これは有効化したユーザーにのみ露出する残存リスクで、
  この分離では解消しない（`window.postMessage` では main world から content
  script を認証できないため）。この分離が扱うのは「無効時に不要な傍受を
  行わない」ことに限る。

フラグを `storage.local` ではなく `storage.sync` に置いているのは、
`firebase-auth-service` が起動時に `setAccessLevel('TRUSTED_CONTEXTS')` で
local を content script から遮断しているため（#274）。local に置くと
content script 側の読み取りが必ず失敗し、機能が永久にOFFのまま固定される。

取得は1件ずつ逐次で、1件あたり15秒でタイムアウトし、2件目以降は前の応答が
返ってから1.5秒空ける（ゲーム本体のリプレイ閲覧は人間の操作速度で1件ずつ
発生するため、無間隔の連続取得はサーバから見て異質な流量になる）。
1リクエストの HandId は最大100件。依頼元のバッチ上限は件数から導出する
（`replayFetchBatchTimeoutMs`）―― 固定値にすると、間隔待ちの合計が上限を
超えた瞬間に**必ず**先に切れる。しかもページ側はバッチ完了時に一括で結果を
返すので、切れた場合に得られるのは部分結果ではなく空配列になる。

### 台帳の受動取得

ユーザーがゲーム内でリプレイ一覧を開くと、ゲーム自身が `/replay/list` を
出す。その応答を同じフックで読むだけの経路があり、**拡張は追加の
リクエストを1本も出さない**。応答から取り出すのは許可リスト方式で、
HandId・開始時刻・`ChipDiff`・`CardOpenEndDate`・`IsExpiredCardOpen` のみ
（除外リストでは、応答の全フィールドを列挙できていない以上「`session` と
`requestKey` さえ落とせば安全」という前提が置けない）。

台帳はサーバ自身が持つ「ヒーローが打ったハンド」の記録なので、WebSocket
キャプチャに対する独立した観測チャネルになる。ローカルと突き合わせて
3通りに分類する:

- **ローカル不在**: `hands` にも `apiEvents` にも無い
- **派生欠落**: `apiEvents` にはあるが `hands` が無い ＝ 受信できていて派生側で
  落ちたもの（キメラハンドの意図的な棄却、検証に通らないpayload、
  書き込み途中）
- **チップ不一致**: `ChipDiff` と `playerChipAccounting[hero].netChips` の食い違い

**確定できることの範囲を取り違えない。** 台帳が証明するのは「このアカウントの
ハンドとしてサーバに記録がある」ことだけで、該当のWebSocketイベントをサーバが
この接続へ送ったかどうかは観測していない。したがって「ローカル不在」から確定
するのは**このクライアントに残っていないことだけ**で、別デバイス／別セッション
でのプレイ、拡張が動いていなかった、フックの取りこぼし、保存失敗、サーバが
送らなかった、は区別できない。「サーバは送ったのに取り逃した」と読んではならない。
一方チップ照合は因果の推定を含まない直接比較なので、外部検証として成立する。

派生テーブルの不在だけで欠損と断定してはならない。Raw Event Lake を必ず
確認する。加えて次の3点を守る:

- **取り込みキューの決着を待つ**。台帳の突き合わせはキューに載せない（ライブ
  イベントを待たせるため）が、直前の `EVT_HAND_RESULTS` の書き込みが済む前に
  照会すると、受信済みのハンドを未キャプチャに分類する。載せないことと待つ
  ことは両立する ―― 読み手側で解決する
- **状態復元を待ってから `playerId` を読む**。コールドスタート直後は
  `undefined` のことがあり、その値で固定すると全ハンドが照合不能に落ちて
  チップ不一致の検出が丸ごと失われる
- **時間検索の空振りを非到着の証拠にしない**。`StartTime` はサーバ時刻、
  `apiEvents.timestamp` はクライアントの `Date.now()` なので、端末時計が
  ずれていれば生行が実在しても範囲外に落ちる。欠損と断定しかけた HandId
  だけ、範囲を捨てた全走査で確かめる

**Service Worker の停止をまたいでも取りこぼさない。** 全走査を伴う突き合わせは
MV3の非アクティブ期限をまたぎうるが、ポートのハンドラは既に同期的に返っており、
直列化キューも走査の進捗もモジュールスコープにしかない。workerが落ちれば受け
取った台帳ごと消えて再開もできず、欠損検出が無通知で終わる。そこで受け取った
台帳を `meta` の `replayLedgerAuditPending` へ控えてからキューへ積み、完了
（見送り・失敗を含む）で控えを外す。次回のSW起動時に控えが残っていればそこから
再開する。全走査の位置（`apiEvents` 主キーのカーソル・確認済みHandId・
控えた時点の行数）も一緒に控えるので、1回のworker寿命で走査し切れないLakeでも試行を重ねるだけ
前へ進む。打ち切りの数え方は「**前進しないまま終わった試行**」で、走査が
進んだ試行は数えない ―― 総試行数で打ち切ると、進んでいるのに捨てられる。
上限（3回）に達したら破棄する（次にリプレイ一覧を開けばまた積まれる）。
停止中にLakeの行数が変わっていたらカーソルは捨てて先頭から走査し直す ――
インポートやクラウド復元が**過去の主キーを持つ行**を足すと、カーソルより前に
挿入された行が二度と読まれず、実在するrawを「ローカル不在」と誤分類するため。

**観測開始より前のハンドは判定しない。** 新規インストール直後・実験フラグを
初めて有効にした直後・全データ削除後は、台帳に過去3日分が載る一方でローカルに
無いのが正常で、これを欠損に数えると初回だけで最大100件の偽陽性を永続化する。
下限はローカル最古のハンドの時刻を使う。観測期間の**途中**の空白（拡張を一時的に
切っていた等）は依然として欠損として報告される ―― そこは本当に区別が付かない。

起動口は Service Worker のグローバルに生やした
`pokerChaseReplayFetch()` のみ（`background/replay-fetch-bridge.ts`）。
`chrome.runtime.sendMessage` を使わないのは、**送信元自身の `onMessage` には
配送されない**ため ―― SWのDevToolsコンソールから叩くと
"Could not establish connection. Receiving end does not exist." になる。
取り込み層が入ればそちらが依頼主体になるので、このモジュールは役目を終える。

開発時の使い方:

```javascript
// 1. Service WorkerのDevToolsで有効化し、ゲームタブを再読み込みする
await chrome.storage.sync.set({ experimentalReplayImportEnabled: true })

// 2. ページが通常API通信を1回すればエンベロープが捕まる。
//    その後、Service WorkerのDevToolsコンソールで:
await pokerChaseReplayFetch([258411144, 258411368])
```

応答は `{ success: true, results: [...] }`。各要素は
`{ handId, ok: true, detail }` か `{ handId, ok: false, error, retryable }`。
`detail` は sanitize 済みで、資格情報は含まれない。無効化は同じキーを
`false` に戻す（同期設定なので他端末にも伝播する）。

既定OFF、権限追加なし、ユーザー操作中のゲーム通信を起点とする設計とする。
公開ビルドへ載せる場合は、プライバシーポリシーとデータ利用開示へこの機能を
明記すること。

## 7. 試験機能: リプレイ詳細の取り込み層

取得層（セクション6）の上に載る依頼主体。既定OFF。詳細は
[replay-api.md](replay-api.md) の「取り込み層」節、実装は
`src/background/replay-import.ts`。

**セッション中は `/replay/detail` を1本も発行しない。** セッションの進行中に
過去ハンドの詳細が取れると、まだ伏せられている情報がセッション内で参照
可能になる。セッション中にできるのは HandId をキューへ積むことだけで、
取得はセッション終了後に走る。判定は1箇所（`canFetchNow`）に集約し、ACTIVE portが
無いか、ACTIVE portのセッション三値が`inactive`のときだけ許可する。`active`と
`unknown`は取得を止める。Service Workerはいつでも落ちうるので、再起動直後や
handover直後の`unknown`は「セッション中かもしれない」が正しく、そこで撃つと
不変条件を破りうる。実際の依頼先も、キューに保存したaccountと一致する現在の
ACTIVE portだけである。

キューは `meta` の1行（`replayImportQueue`）。MV3 の Service Worker は
数十秒で落ちるためメモリには置けない。専用ストアを作らないのは、高々100件
規模の待ち行列にDexieのバージョンを消費する理由が無いため。

### 保存形式: 合成イベント（私用ApiTypeId）

取得結果は Raw Event Lake へ **ApiTypeId 90001**（`REPLAY_HAND_DETAIL`）の
合成イベントとして保存し、`replayDetails`（v7、`handId` 主キー）へ射影する。
Lake に載せることで NDJSON のエクスポート／インポート・Firestore の増分同期・
その先の取り込みが**無改修で**この行を運ぶ ―― 輸送経路をもう1本作るより、
既に信頼されている1本に相乗りするほうが壊れる箇所が少ない。

`replayDetails` は Lake からの射影であって正ではない。Lake は生ログなので
同じ HandId の行を複数持ちうる（別端末のエクスポートを取り込めば重複する）が、
射影は先勝ちで1件に畳む ―― payload はサーバ側で不変なので、どれを採っても
同じ。インポートと再構築の双方で射影を走らせるので、索引側だけが欠けた
状態は次の再構築で埋まる。

90001 は保存・同期の対象だが、`EntityConverter` / `WriteEntityStream` /
統計 / `verify-stats` からは見えない。いずれも既知の対局 ApiTypeId だけを
分岐するので、どの case にも該当せず素通りする。**これは実装の偶然ではなく
仕様**として `src/replay/synthetic-event-invisibility.test.ts` で固定して
あり、実測でも 492,901 イベントのキャプチャに 561 件の 90001 を混ぜた
`verify-stats` の出力が、件数以外は1文字も変わらないことを確認している。
