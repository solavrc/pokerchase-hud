# リプレイAPI (`/replay/*`)

PokerChaseの「ハンドリプレイ」機能が使う **REST + MessagePack** のAPI。HUDが
普段傍受しているWebSocketイベント（[api-events.md](api-events.md)）とは
**別のプロトコル**で、エンベロープの形もエラーの表し方も共通点が無い。

実験機能（既定OFF）の取得層 `src/web_accessible_resource.ts` が叩く先であり、
この文書はその挙動の根拠。

> 観測日: 2026-07-22（初回偵察）/ 2026-08-01（境界の実測）
> 観測時のクライアント: `appVer 2.06` / `dataVer 2_06_0_s9j4r9vd` / `masterVer f5eb40de`

## エンドポイント

| パス | 用途 | `param` |
|---|---|---|
| `POST /replay/list` | カテゴリ別のハンド一覧 | `{ BattleType }` |
| `POST /replay/favorite_list` | お気に入り一覧 | なし |
| `POST /replay/detail` | ハンド1件の詳細 | `{ HandId }` |

ホストは `https://production.api-poker-chase.com`。`Content-Type` は
`application/msgpack`。応答も MessagePack だが、ヘッダー上は
`Content-Type: text/html; charset=UTF-8` で返る。

## リクエスト: 認証エンベロープ

```ts
type ReplayRequest = {
  param?: Record<string, unknown>
  session: string      // 認証資格情報。回転する（応答の session で更新される）
  platform: number     // 2
  appVer: string
  dataVer: string
  masterVer: string
  requestKey: string   // UUID形式。クライアント生成で受理される（実測）
}
```

`session` 以下5つは**推測で作れない**。取得層はゲーム本体が出した本物の
リクエストから受動キャプチャして流用する（`readAuthEnvelope()`）。

**ログインしてホーム画面に到達した時点で捕獲される**（実測 2026-08-01）。
リプレイ画面を開く必要はない。ゲームは起動からホーム表示までの間に、この
オリジンへ `fetch` で複数回アクセスする（`/login/sign_in_country_check`、
`/version`、`/login/index`、`/home/index`、`/home/index_delay`、
`/friend_chat/join`、`/stamp_customize/get` を観測）。

実測の内訳: タイトル画面の時点では `auth-envelope-unavailable`、ホーム画面へ
到達した後は同じ呼び出しがサーバ応答（`status 2302`）まで到達した。つまり
ホーム到達までの通信のいずれかが5フィールドを揃えて載せている。

`session` は応答ごとに回転するため、以後も通常通信の応答から追従し続ける。
ページをリロードしてもホームを経由するので再捕獲される。

対局中はWebSocketのみでこのオリジンへのHTTPは飛ばないが、**セッション開始
より前に捕獲が済んでいる**ため、セッション終了後の取得には影響しない。

Unity WebGLは `fetch` ではなく `XMLHttpRequest` を使う経路があるため、
取得層は両方をフックしている。上記の観測ではすべて `fetch` だった。

## 応答エンベロープ

```ts
type ApiResponse<T> = {
  session: string
  result: number    // 0 = 成功
  status: number    // エラーコード（成功時 0）
  date: number      // 応答時刻のUnix秒。ハンド開始時刻ではない
  dataVer: string
  appVer: string
  masterVer: string
  trace: string
  emsg: string
  behavior: string
  message: string   // 'text_error_message_code_<status>' 形式のローカライズキー
  param: T          // 拒否時は param 自体が存在しない
}
```

**拒否もHTTP 200で返る。** 成否は `result` / `status` で判定する。

> **WebSocket側の `Code` フィールドはこのAPIには存在しない。**
> `Code=0` 成功 / 非0エラーは 201・202 の作法（[api-events.md](api-events.md)）で、
> `/replay/*` とは無関係。実測ログ中に `Code` は一度も出現しない。
> 取得層は当初これを見ており、拒否応答が全て成功として通っていた。

### 観測した `status`

| `status` | 意味 | `param` |
|---|---|---|
| `0` | 成功 | あり |
| `2301` | 閲覧期限切れ（データはサーバに在る） | なし |
| `2302` | データ無し | なし |

## 取得可能な期間

**経過時間ではなく暦日（JST）で切られる。**

2026-08-01 13時頃に、ローカルの `apiEvents` から起こした既知HandIdを
実行順をシャッフルしながら1件ずつ（2秒間隔で）叩いて測定した結果:

| ハンドの開始時刻 | 結果 |
|---|---|
| 2026-07-29 00:00:03 以降 | `0`（成功） |
| 2026-07-28 00:00 〜 07-28 23:59:20 | `2301` |
| 2026-07-27 20:01 以前 | `2302` |

境界は **43秒の分解能**で 07-29 00:00 に一致した（23:59:20 が `2301`、
00:00:03 が成功）。測定日が 08-01 なので:

- **成功する条件: 開始時刻が「当日 − 3日」の 00:00 JST 以降**
- `2301` の帯はその1日前（「当日 − 4日」の 00:00 以降）
- それより前は `2302`

したがって**取得可能窓は固定72時間ではなく72〜96時間で変動し、深夜0時に
一斉に1日分が落ちる**。取り込みが遅延した場合（SW再起動・オフライン・
リトライbackoff）、次の 00:00 を跨いだ時点で恒久的に取得不能になる。
リトライ期限は固定TTLではなく暦日境界に合わせる必要がある。

`approxTimestamp`（EVT_DEAL受信時刻）がサーバの `StartTime` より数秒遅い
ため、深夜0時直後の数秒に受信したハンドは前日側に落ちる。実際 00:00:05
受信のハンドが `2302` を返した。

### 一覧の表示制限とは別物

画面には「3日以内・最新100ハンドが表示されます」と表示され、実測でも
両方が実在した（ランク戦は100件目が終端、リング戦は次に古いハンドが
3.78日前で3日ルールにより終端）。

ただし **`/replay/detail` は100件上限に縛られない**。順位で2000番目台の
ハンドが、暦日の条件さえ満たしていれば取得できる。一覧は表示制限、
detail の窓は暦日ルールだけ。

お気に入り登録したハンドは一覧に永続的に残る（登録上限100件）。detail が
同様に暦日ルールを免除されるかは未検証。

## `HoleCardList` の返却範囲

どの席の手札が入るかは、アカウントの〈手札公開機能〉（プレミアムパス。
`CardOpenEndDate` / `IsExpiredCardOpen` が示す有効期間）で決まる。

- **公開期間内**: リプレイに記録された全席の `HoleCardList` が返る。途中で
  フォールドして `EVT_HAND_RESULTS.Results[]` に行すら存在しない席も含む。
  ゲーム自身のリプレイ画面が表示するのと同じ範囲。
- **公開期間外**: 自席と、ショーダウンに到達したプレイヤーの `HoleCardList` だけ。
  途中でフォールドした相手は空配列。自席は自分がフォールドしていても入る。

両方とも実測済み（2026-08-20 時点）。prod BQ の 90001 payload 全数 9,005 fetch を
`fetchedAt` と `CardOpenEndDate` で層別すると、〈手札公開機能〉有効アカウントでの
取得が始まった 2026-08-05 以降の公開期間内 fetch 7,905 ハンドは全てで全席の
`HoleCardList` に有効な2枚が入り、うち 7,385 ハンドは `ResultList` に行が無い
相手フォールド席（計 22,010 席）を含んでいた。公開期間外 fetch 1,100 ハンドでは
相手フォールド席の公開は0件。自席は公開期間に関係なく全 9,005 fetch で入っていた
（公開期間外にフォールドした自席 772 件を含む）。読み出し側
（`src/replay/hole-cards.ts`）はどちらの形も同じ経路で扱う ―― 席の種別を判断せず、
値が2枚入っていれば読み、空配列・`-1` 埋めなら `null` を返す。

WebSocket 側（`EVT_HAND_RESULTS.Results[].HoleCards`）との差は、公開期間外でも
1点ある: `RankType` が `SHOWDOWN_MUCK`（11）の行に、こちらは値が入る。WebSocket は
同じ行を空で送る（`docs/api-events.md` の RankType 表を参照）。
逆に `FOLD_OPEN`（12）の行はリプレイ側に存在しない。

## `BattleType`

`/replay/list` のカテゴリ。`0` ランク戦 / `1` トーナメント / `2` フレンド戦 /
`4` リング戦 / `6` クラブマッチ。実測で `0` と `4` の取得を確認した。
`1` / `5` / `6` は手元の検体が全て暦日の境界より古く、除外されているのか
単に古いだけなのか未判定。

## 詳細応答の中身

```ts
type ReplayDetailParam = {
  CardOpenEndDate: number
  Game: {
    Name: string            // ローカライズキー
    PlayerNum: number
    Ante: number
    SmallBlind: number
    BigBlind: number
    ButtonSeat: number
    SmallBlindSeat: number
    BigBlindSeat: number
    CommunityCardList: number[]
    BlindPotList: number[]
    RakeList: number[]
    BackgroundDecoId: string
    TableDecoId: string
  }
  Player: ReplayPlayer          // ヒーロー
  OtherPlayerList: ReplayPlayer[]
  BlindList: { SeatIndex: number, BetBlind: number }[]
  PreflopActionList: ReplayAction[]
  FlopActionList: ReplayAction[]
  TurnActionList: ReplayAction[]
  RiverActionList: ReplayAction[]
  ResultList: {
    SeatIndex: number
    RankType: number
    HandList: number[]
    HandRanking: number
    RewardChip: number
  }[]
}

type ReplayPlayer = {
  SeatIndex: number
  UserId: number
  Name: string
  HoleCardList: number[]        // 公開されていない席は空（上記「返却範囲」参照）
  StartChip: number
  BetAnte: number
  CharaId: string
  CostumeId: string
  RankLvId: string
  ClassLvId: string
  EmblemId: string
  AllinDecoId: string
  ShowDownDecoId: string
  FrameDecoId: string
  IsOfficial: boolean
  IsCpu: boolean
}

type ReplayAction = {
  SeatIndex: number
  ActionType: number
  BetChip: number
  PotList: number[]
}
```

カードのエンコードはWebSocket側と同じ 0-51（`rank = card / 4`,
`suit = card % 4`）。

## 取得できないハンド

`seatUserIds` にヒーローが居ないハンド（バスト後の観戦モードで記録された
もの。[api-events.md](api-events.md) の `EVT_DEAL.Player` 欠落を参照）は、
暦日の条件を満たしていても `2302` を返す。リプレイは自分が参加したハンド
だけが対象。取り込み層はこれをローカルで除外できる。

## 取り込み層（既定OFF・公開オプトイン）

実効判定は `experimentalReplayImportEnabled`（DevTools用の開発者フラグ）
**または** `replayImportEnabled`（公開トグル）と課金検証済み状態の組み合わせ。
開発者フラグは検証を無条件にバイパスする。公開トグルは、セッション外で
`/replay/list`を1回送り、`IsExpiredCardOpen === false`かつ
`CardOpenEndDate`が未来であることを確認できた場合だけ有効になる。実装は
`src/background/replay-access.ts`と`src/background/replay-import.ts`。

UIはポップアップの「リプレイ取り込み」。検証中、対局終了待ち、認証
エンベロープ待ち、検証済み、失効を表示する。

公開にあたっての開示手順は
[chrome-web-store-release.md](chrome-web-store-release.md#replay-import-disclosurev60-公開時)
と [PRIVACY.md](../PRIVACY.md) の "Optional replay import" を参照。

### いつ取得するか

**セッション中は1本も発行しない。** セッションの進行中に過去ハンドの詳細を
取れてしまうと、まだ伏せられている情報がセッション内で参照可能になる。
公開トグルの検証にも同じgateを適用する。セッション中のONは通信せず保留し、
セッション終了後（`EVT_SESSION_RESULTS` / `Code=0`の
`EVT_ENTRY_CANCELLED`）に検証する。
認証エンベロープが無ければホーム画面の通常API通信で捕獲するまで保留する。

**依頼は1件ずつ**行い、次の1本を撃つ直前に毎回この判定をやり直す。100件を
1バッチで渡すと、ページ側が1.5秒間隔で撃ち切るまで数分かかり、その間に次の
対局が始まっても残りが撃たれ続けて不変条件を破るため。逐次取得の間隔も
取り込み層が空ける（ページ側の間隔はバッチ内でしか効かない）。同じ理由で、
実効フラグと長時間操作（インポート/再構築/エクスポート）の有無も毎回確認し、
いずれかが変わった時点で中断してキューに残す。

判定は、WebSocket由来のgame eventを最後に届けた唯一のACTIVE portの
セッション三値（`unknown` / `active` / `inactive`）だけを見る。現在世代が明示的に
**`inactive`** のときだけgateを許可する。`active`、`unknown`、Service Worker
再起動直後のtoken未生成、同一content scriptの再接続待ちはいずれも対局中扱いである。
再起動後は最初のdedup済みgame eventが世代とactivityを確立するまでHTTPを発行しない。
接続中の他portはrelicなので、その状態を集合演算へ混ぜない。

第一防衛線はpage側に置く。常時注入されるWebSocket hookが成功201・着席303・
308で`active`、309（および着席前に成功した`Code=0`の参加取消203）で
`inactive`をpage worldの`window`へ保持する。後から注入されるreplay bridgeは
`inactive`のときだけ取得を開始し、各await境界でも同じ状態を再確認する。実行中に
開始イベントを観測したら
自身の`AbortController`を止めるため、Service WorkerからCANCELが来なくても安全で
ある。`active`/`unknown`中の依頼にはHTTPを発行せず、空RESULTだけを返してSWの
pendingを解放する。

別タブのraw eventはpageだけでは新旧を識別できないため、クロスタブとSW再起動境界には
保存・dedup後の新規開始（raw保存失敗時はfail-closed開始）を見たService Workerから
全game portへ送る一括CANCELを補助線として残す。content scriptはCANCEL受信時だけでなく
SW port切断時にも未送信依頼を全破棄し、page queueはcancel世代でそれ以前の依頼を無効化する。
requestId別controller mapやCANCELのepoch照合は持たず、保存可否の根拠にも使わない。

第二防衛線として、pageから戻るRESULTも生イベントと同じService Worker取り込み
キューへ通す。先行する201/303/308のRaw Lake保存とactivity更新が完了するまで
RESULTは取得待ちを解放しない。その後も取り込み層は共通storage FIFO内、さらに
Dexie transaction内の最初のread（競合write lock待ちを含む）が終わった後、
最初のwrite直前に現在activityを再確認し、
90001を書き込まない。各依頼と応答の
Service Worker epochは公平性の主ゲートではなく、SW再起動時の所有権分離と旧応答
破棄を担う補助線として残す。

公開経路の検証（`/replay/list`）にも**この二重の防衛線をそのまま適用する**。
検証は`/replay/detail`と同じepochを載せ、同じcontent script経路・同じpage側
逐次キューを通り、同じpage activity gate（`unknown`もfail-closed）で止まる。
実行中のAbortControllerも詳細取得と同じ枠に載るので、WSが開始イベントを
観測した瞬間の自律abortが検証にも効く。対局中・状態不明で撃てなかった検証は
`pending-session`として記録し、次の取得サイクルの先頭で撃ち直す（エラーには
しない）。Service Worker側でも、`dispatchQueue`を待った後の実際の
`postMessage`直前にfairness gateを取り直し、依頼先を現在のACTIVE portだけに
限定する。

公開経路では各取り込みサイクルの先頭でも`/replay/list`を1回送り、期限を
自然に再検証する。この1本は取り込みサイクルの一部としてドレインの中で走る
（専用の経路を持たない）ので、取り込みキューのbarrier・長時間操作の判定・
keepalive・ドレインの直列化がそのまま掛かる。失効を検知したサイクルでは
`/replay/detail`を1本も送らず、キューと取り込み済みの90001行・
`replayDetails`索引を保持する。

キューは `meta` テーブルの1行（`replayImportQueue`）に持つ。MV3 の Service
Worker は数十秒で落ちるため、メモリには置けない。

取得の起点であるセッション終了は、**keepalive が解除される瞬間**でもある
（`event-ingestion.ts` のセッション状態追跡）。1件1.5秒間隔の逐次取得は
100件なら数分かかるので、取得の実行中だけ Service Worker を起こしておく
（`startKeepAlive`）。落ちても結果が失われるだけでキューは残るが、毎回
そうなると取得が一向に進まない。

キューの各エントリには、HandIdを受け取った時点の**ACTIVE portのヒーローの
UserId**も保存する。handover後も既存entryのaccountは書き換えない。依頼は
保存済みaccountと現在のACTIVE portのaccountが一致するときだけ出す。取得は
ページ側の認証エンベロープで行われるので、別accountのACTIVE portへ投げると
`2302`が返り、再試行不能として永久に捨てられてしまう。一致しないentryは
キューへ残り、そのaccountの旧portがeventを届けてtokenを取り戻したときに流れる。

繰り延べの再開契機は3つ: セッション終了（309 / 203）、ポート接続、そして
**認証エンベロープの捕獲**。対局中に機能を有効化した場合、その対局の終了直後は
必ずエンベロープを持っていない（対局中はHTTPが発生しない）ので、ホーム画面
到達時の通常通信で捕まった時点をブリッジが通知する（値は載せない）。

### 何を積むか

`EVT_HAND_RESULTS` のうち、生イベントに `Player` フィールドが在るもの
（＝ヒーローが配札を受けたハンド）の `HandId` だけ。観戦モードのハンドは
`Player` が undefined になる（[api-events.md](api-events.md)）ので積まない ――
積んでも `2302` が返るだけでリクエストを1本無駄にする。

### 期限切れの扱い

- 暦日の窓（当日 − 3日の 00:00 JST）を過ぎたものは、**リクエストする前に**
  破棄して件数を数える（`replayImportStatus`）
- サーバの `2301`（閲覧期限切れ）と `2302`（データ無し）は再試行しない。
  同じエンベロープで撃ち直しても状況が変わる根拠が無い
- 認証エンベロープ不在などの再試行可能な失敗は**キューに残す**。
  エンベロープはページ再読み込み後のホーム到達で捕まるので、次にセッション外で
  ページが繋いできた時点で再開する

### どこへ保存するか

取得結果は Raw Event Lake（`apiEvents`）へ**合成イベント**として保存し、
同じ内容を `replayDetails`（Dexie v7、`handId` 主キー）へ射影する。

```jsonc
{
  "timestamp": 1785555471000,   // 取得時刻（Lakeの主キー規約に従う）
  "ApiTypeId": 90001,           // ApiType.REPLAY_HAND_DETAIL（私用領域）
  "HandId": 533933335,          // 冪等キー
  "payload": { /* 応答の param をそのまま */ },
  "fetchedAt": 1785555471000,
  "clientMeta": { "appVer": "...", "dataVer": "...", "masterVer": "..." }
}
```

Lake に載せる理由は、NDJSON のエクスポート／インポート・Firestore の増分
同期・その先の取り込みが **無改修でこの行を運ぶ**ため。90001 は保存・同期の
対象だが、`EntityConverter` / `WriteEntityStream` / 統計 / `verify-stats`
からは見えない ―― いずれも既知の対局 ApiTypeId だけを分岐するので、
どの case にも該当せず素通りする。この不可視性は
`src/replay/synthetic-event-invisibility.test.ts` で固定してある。

`session`（応答ごとに回転するトークン）と `requestKey` は**保存も輸出も
しない**。ページ側の `sanitizeReplayDetail` が境界で落としており、保存物にも
含まれないことをテストで固定している。

Lakeの行と索引は**1つのDexieトランザクション**で確定する。別々にコミットすると、
間でquota超過やSW停止が起きたときにLakeだけが残り、次回は索引が無いので同じ
HandIdを取り直して別の90001をLakeへ足してしまう。

v7より前に取り込んだ 90001（別端末がクラウド経由で送ったもの）は、バージョン
移行が空のストアを作るだけなので索引に入らない。起動時に一度だけ走る掃き出し
（`backfillReplayDetailsFromLake`、`meta` の目印で冪等）で流し込む。移行の
`upgrade()` の中でやらないのは、Dexieのアップグレードトランザクションが
壊れやすく、失敗するとDBごと開かなくなるため ―― 掃き出しなら失敗しても
次回起動で再試行できる。

インポート経路（NDJSON）とクラウド復元でも同じ射影を走らせる。インポートは
検証前にそのままLakeへ入るので、**Lakeへ入れる前に**資格情報を落とす ――
ライブ取得の境界（`sanitizeReplayDetail`）だけでは塞げない経路で、放置すると
以後のエクスポートとFirestore同期にも流れる。

Dexie v7 は新ストアの追加だけで既存の派生（`hands`/`phases`/`actions`）を
変えないため、`REBUILD_ADVISORY_VERSION` は据え置き。

### 何に使うか

「直近ハンド」パネルで、WebSocket 経由では手札が取れない席のホールカードを
埋める（`src/replay/hole-cards.ts`）。埋める対象を席の種別で絞らないのが要点で、
リプレイ payload に値が入っている席は全て埋める:

- `RankType: 11`（SHOWDOWN_MUCK）の行 ―― WebSocket の `EVT_HAND_RESULTS` は
  この行の `HoleCards` を空で送るが、リプレイは実際の手札を返す。
- 途中でフォールドした席 ―― `Results[]` に**行そのものが無い**ため、RankType を
  見る実装では構造的に到達できない。〈手札公開機能〉の有効期間内はここに値が入る。

可視性の判断は payload に委ねる（上記「`HoleCardList` の返却範囲」）。公開されて
いない席は空配列・`-1` 埋めで返るので、読み出し側の2枚チェックで自然に落ちる。
表示は他の相手カードと同じ（ランクのみ4色表示、正確な表記はツールチップ）。

### ドレイン中の画面の追従

セッション終了後のドレインは1.5秒間隔で書き足していくので、開いたままの
「直近ハンド」パネルはその間ずっと古い（30秒キャッシュはハンド完了でしか
無効化されず、パネル側にも再フェッチの契機が無い）。詳細を1件保存するたびに
表示側へ2つの信号を出して追従させる（`src/background/replay-panel-refresh.ts`）:

- **キャッシュ無効化は1件ごと**。`Map.clear()`と世代のインクリメントだけで
  DBもポートも触らないので、間引く理由が無い。間引くと、その隙に手で開いた
  パネルが1件前のDB状態を最大30秒掴む。
- **パネルへの通知は間引く**。5件ごと、または前回通知から10秒経過のどちらか
  早いほう（取得間隔1.5秒なので実質7.5秒に1回）。通知1回につき開いている各
  パネルがhands/actions/phases/replayDetailsを読み直すため。**ドレインの
  終わりには必ず1回送る** ―― 最後の数件はどの閾値にも届かないので、これが
  無いと末尾のハンドが画面に出ない。中断した周回でも、そこまでの保存分は送る。

通知はACTIVE portにだけ届く（他のstats配信と同じ規約）。ドレインが走るのは
ACTIVE世代が明示的に`inactive`のときだけなので、その時のACTIVE portは
「直前まで対局していたタブ」＝パネルが開いているタブそのものになる。値は
ハンド完了の`handEpoch`とは別立てのカウンター（`replayEpoch`）で運ぶ:
リプレイ詳細が変えるのは直近ハンドのホールカード列だけで、ポジション別統計は
変わらないため、そちらのパネルは無駄に再フェッチしない。
