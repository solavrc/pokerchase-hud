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

**捕獲の唯一の機会はユーザーがゲーム内リプレイ画面を開いたとき**。対局中の
通信はWebSocketなので、このオリジンへのHTTPは1本も飛ばない。一覧を開けば
`/replay/list` が同じエンベロープを載せて飛ぶので、再生まで行う必要はない。

Unity WebGLは `fetch` ではなく `XMLHttpRequest` を使う経路があるため、
取得層は両方をフックしている。

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
