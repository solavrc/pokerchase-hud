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

サーバはショーダウンに到達したプレイヤーの `HoleCardList` だけを返す。
途中でフォールドした相手は空配列。

WebSocket 側（`EVT_HAND_RESULTS.Results[].HoleCards`）との差は1点だけで、
`RankType` が `SHOWDOWN_MUCK`（11）の行に、こちらは値が入る。WebSocket は
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
  HoleCardList: number[]        // 非ショーダウン参加者は空
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

## 取り込み層（既定OFF）

`experimentalReplayImportEnabled` を有効にしたときだけ動く。実装は
`src/background/replay-import.ts`。

**この層にユーザー向けのUIは無い。** 取得層（セクション上部）と同じく、
フラグはService WorkerのDevToolsコンソールから `chrome.storage.sync` を
直接書いて切り替える。ポップアップに操作を出すのは、開示（プライバシー
ポリシー・ストア掲載情報）を伴う公開時点まで行わない。

### いつ取得するか

**セッション中は1本も発行しない。** セッションの進行中に過去ハンドの詳細を
取れてしまうと、まだ伏せられている情報がセッション内で参照可能になる。
セッション中にできるのは HandId をキューへ積むことだけで、取得は
セッション終了後（`EVT_SESSION_RESULTS` / `EVT_ENTRY_CANCELLED`）に走る。

**依頼は1件ずつ**行い、次の1本を撃つ直前に毎回この判定をやり直す。100件を
1バッチで渡すと、ページ側が1.5秒間隔で撃ち切るまで数分かかり、その間に次の
対局が始まっても残りが撃たれ続けて不変条件を破るため。逐次取得の間隔も
取り込み層が空ける（ページ側の間隔はバッチ内でしか効かない）。同じ理由で、
実験フラグと長時間操作（インポート/再構築/エクスポート）の有無も毎回確認し、
いずれかが変わった時点で中断してキューに残す。

判定は、WebSocket由来のgame eventを最後に届けた唯一のACTIVE portの
セッション三値（`unknown` / `active` / `inactive`）だけを見る。ACTIVE portが
**`inactive`** のとき、またはACTIVE port自体が無いときにgateを許可する。
`active`と`unknown`は対局中扱いである。tokenが無い状態ではgateを通っても
実際のHTTP依頼先が無いため、キューはそのまま残る。Service Worker再起動直後や
handover直後の`unknown`は「セッション中かもしれない」が正しく、そこで撃つと
不変条件を破りうる。接続中の他portはrelicなので、その状態を集合演算へ混ぜず、
切断後の再接続猶予も持たない。

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

「直近ハンド」パネルで、ショーダウンでマックした行のホールカードを埋める
（`src/replay/hole-cards.ts`）。WebSocket の `EVT_HAND_RESULTS` は
`RankType: 11`（SHOWDOWN_MUCK）の `HoleCards` を空で送るが、リプレイは実際の
手札を返す。ゲーム自身のリプレイ画面も同じものを表示するので、サーバは
ショーダウンに到達した手を公開情報として扱っている。ショーダウンに到達して
いない行（`NO_CALL` / `FOLD_OPEN`）は埋めない。
