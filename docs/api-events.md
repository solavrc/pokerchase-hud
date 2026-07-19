# API Events リファレンス

> PokerChase WebSocket API イベントの包括的リファレンス。

## 概要

API イベントは HUD の主要データソース。WebSocket 経由で論理的に保証された順序で到着するが、接続障害によりデータ欠損が発生する可能性がある。

**重要事項:**
- イベントスキーマは PokerChase API が管理しており、予告なく変更される可能性がある
- 全イベントに対応する Zod スキーマが `src/types/api.ts` に定義されている
- ランタイムバリデーションにより型安全性を確保
- 型ガード関数による安全なイベント処理を推奨

## イベントカテゴリ

### セッションイベント

ゲームのライフサイクルを管理するイベント。

| イベント | ID | 目的 | 主要フィールド |
|---------|-----|------|--------------|
| `EVT_ENTRY_QUEUED` | 201 | セッション開始、IDとバトルタイプの抽出 | `Id`, `BattleType` |
| `EVT_SESSION_DETAILS` | 308 | ゲーム設定と名前 | `Name`, `BlindStructures` |
| `EVT_SESSION_RESULTS` | 309 | セッション終了、クリーンアップ | `Results`, `Rankings` |

### プレイヤーイベント

着席、識別、途中参加を追跡するイベント。

| イベント | ID | 目的 | 主要フィールド |
|---------|-----|------|--------------|
| `EVT_PLAYER_SEAT_ASSIGNED` | 313 | 初期着席（名前・ランク付き） | `SeatUserIds[]`, `TableUsers[]` |
| `EVT_PLAYER_JOIN` | 301 | 途中参加 | `JoinPlayer`, `JoinUser` |
| `EVT_DEAL` | 303 | ハンド開始、ヒーロー識別 | `Player.SeatIndex`, `SeatUserIds[]`, `Player.HoleCards[]` |

### ゲームイベント

ポーカーアクションとハンド進行を表すイベント。

| イベント | ID | 目的 | 主要フィールド |
|---------|-----|------|--------------|
| `EVT_ACTION` | 304 | プレイヤーアクション（ベット/フォールド/レイズ） | `SeatIndex`, `ActionType`, `BetChip` |
| `EVT_DEAL_ROUND` | 305 | 新ストリート（フロップ/ターン/リバー） | `CommunityCards[]`, `Progress` |
| `EVT_HAND_RESULTS` | 306 | ハンド完了、勝者決定 | `HandId`, `Results[]`, `Pot` |

## 典型的なセッションのイベントシーケンス

セッション = 1ゲームの開始から終了まで（トーナメント1回分、リングゲーム1セッション分）。

```
1. EVT_ENTRY_QUEUED (201)        ── セッション開始（1回のみ）
   - BattleType でゲームタイプ確定（SNG/MTT/Ring 等）
   - セッション内の全ハンドが同じ BattleType を持つ

2. EVT_SESSION_DETAILS (308)     ── ゲーム設定（1回のみ）
   - Name, BlindStructures, DefaultChip 等

3. EVT_PLAYER_SEAT_ASSIGNED (313) ── 初期着席
   - TableUsers[] で全プレイヤーの名前・ランクを取得
   - MTT ではテーブル移動時に再発行される（セッション中に複数回）

4. EVT_PLAYER_JOIN (301)         ── 途中参加（0回以上）
   - ハンド間・ハンド中の両方で発生しうる
   - MTT ではテーブル移動による着席も含む

5. ┌─ ハンドループ（複数回繰り返し）─────────────────┐
   │  EVT_DEAL (303)           ── ハンド開始           │
   │  EVT_ACTION (304)         ── アクション [複数回]   │
   │  EVT_DEAL_ROUND (305)     ── 新ストリート [0-3回]  │
   │  EVT_HAND_RESULTS (306)   ── ハンド完了           │
   └──────────────────────────────────────────────────┘

6. EVT_SESSION_RESULTS (309)     ── セッション終了（1回のみ）
   - Ranking, RankReward 等
```

**ゲームタイプ別の特徴:**

| ゲームタイプ | 特徴 |
|---|---|
| SNG (BattleType=0,2,6) | テーブル移動なし。EVT_PLAYER_SEAT_ASSIGNED は1回。プレイヤー脱落で人数減少。 |
| MTT (BattleType=1) | テーブル移動あり。EVT_PLAYER_SEAT_ASSIGNED が複数回発行。EVT_PLAYER_JOIN が頻繁。 |
| Ring (BattleType=4,5) | プレイヤーが自由に出入り。EVT_PLAYER_JOIN で途中参加。 |

**重要**:
- `EVT_ENTRY_QUEUED` は「テーブルへの着席」ごとに発行される。SNG/Ring では1セッション1回だが、**MTT ではテーブル移動のたびに再発行**される（同一トーナメントで複数回）。
- `BattleType` はトーナメント/セッション内で不変。
- `AggregateEventsStream` はこのイベントで `resetSession()` を呼び、新セッションを開始する。

### セッション一意識別の方針（マルチプレイヤーデータ収集向け）

| ゲームタイプ | `EVT_ENTRY_QUEUED.Id` の性質 | セッション一意識別の方法 |
|---|---|---|
| SNG (0, 2, 6) | ルーム種別（`stage006_002` 等）。一意ではない。 | 最初の `HandId` をセッション識別子として使用。全プレイヤーが同一テーブルで開始するため、最初の HandId はプレイヤー間で共通。 |
| MTT (1) | トーナメント ID（`6078` 等）。同一トーナメント内のプレイヤーに共通。テーブル移動で複数回発行。 | `Id`（トーナメント ID）でトーナメントを識別。同一テーブルのハンドは `HandId` で突合可能。 |
| Ring (4, 5) | ルーム種別（`50_100_0002` 等）。一意ではない。 | セッションの一意識別は不要。ハンド単位で `HandId` により突合。 |

**`EVT_SESSION_DETAILS`（308）の境界値としての性質（poker-warehouse SNG継続性監査、2026-07測定）**: `EVT_ENTRY_QUEUED`（201）と `EVT_SESSION_RESULTS`（309）だけをセッション境界にすると、309が欠落したまま同一ルームへ再入室したケース（切断・キャプチャ欠落等）を1セッションに誤って融合してしまう。308は**同一SNG/Ringインスタンスにつき厳密に1回だけ発行される**（2026-07-04キャプチャの旧ルールSNGセッション492/519件で308がちょうど1回）ため、再入室の検出に使える追加シグナルになる。ただし**MTTのテーブル移動201と1:1で再発行される**（同キャプチャのMTTセッション79/79件で `n(308) == n(テーブル移動201)`）ため、「308が来たら常に新セッション」という単純な規則は全MTTセッションをテーブル移動ごとに分断してしまい誤り。308をセッション境界に使う実装は、直前の `EVT_ENTRY_QUEUED.BattleType` を見てMTT文脈を除外し、かつ同一区間内で2回目以降の308のみを新セッション開始とみなす必要がある（1回目はそのインスタンス自身の確認シグナルとして吸収）。詳細・両エンジン検証値は poker-warehouse `docs/audits/2026-07-sng-session-continuity.md` Step 1 を参照。

## 典型的なハンドのイベントシーケンス

```
1. EVT_DEAL (303)
   - 提供: ヒーロー識別、SeatUserIds
   - 抽出: Hero UserId = SeatUserIds[Player.SeatIndex]

2. EVT_ACTION (304) [複数回]
   - プリフロップアクション: ポスト、レイズ、コール、フォールド
   - 追跡: ポット参加者(VPIP)、レイザー(PFR)

3. EVT_DEAL_ROUND (305) - フロップ
   - コミュニティカード公開
   - ストリート固有カウンターのリセット

4. EVT_ACTION (304) [複数回]
   - フロップアクション: チェック、ベット、レイズ
   - 追跡: コンティニュエーションベット、アグレッション

5. EVT_DEAL_ROUND (305) - ターン
6. EVT_ACTION (304) [複数回]
7. EVT_DEAL_ROUND (305) - リバー
8. EVT_ACTION (304) [複数回]

9. EVT_HAND_RESULTS (306)
   - 提供: HandId、勝者、最終ポット
   - トリガー: 統計計算、ハンドログ生成
```

## フィールド間の関連性

イベント間でフィールドを紐付けるためのクロスリファレンスガイド。

### プレイヤー識別

```
EVT_PLAYER_SEAT_ASSIGNED.TableUsers[].UserId  ──► プレイヤー名・ランク（初期着席）
EVT_PLAYER_JOIN.JoinUser.UserId               ──► プレイヤー名・ランク（途中参加）
                    │
                    ▼
EVT_DEAL.SeatUserIds[N] = UserId              ──► 席インデックスからプレイヤーへのマッピング
EVT_DEAL.Player.SeatIndex                     ──► ヒーローの席インデックス
    → SeatUserIds[Player.SeatIndex] = ヒーローの UserId
                    │
                    ▼
EVT_ACTION.SeatIndex                          ──► アクション実行者 = SeatUserIds[SeatIndex]
EVT_HAND_RESULTS.Results[].UserId             ──► UserId 直接参照（SeatUserIds の値と一致）
```

### セッション間のリンク

| ソースイベント | フィールド | 用途 |
|---|---|---|
| `EVT_ENTRY_QUEUED` | `Id`, `BattleType` | セッション識別子とゲームタイプ |
| `EVT_SESSION_DETAILS` | `Name`, `BlindStructures` | セッション名、ブラインドレベル |
| `EVT_PLAYER_SEAT_ASSIGNED` | `SeatUserIds`, `TableUsers` | 席→プレイヤーマッピング |
| `EVT_DEAL` | `SeatUserIds`, `Game` | ハンドごとの席マッピングとブラインド情報 |
| `EVT_HAND_RESULTS` | `HandId` | ユニークなハンド識別子（ここでのみ取得可能） |
| `EVT_SESSION_RESULTS` | `Ranking`, `RankReward` | 最終順位とランク変動。`RankReward` はランク戦 SNG（BattleType=0）のみで、MTT 含む他の BattleType には出現しない（BQ実測: BattleType=0 は 643/661 セッションに存在、他タイプ 260 セッションで 0 件）。フィールドファミリーごとの出現条件は下記「RankReward フィールドの意味論」参照 |

### 主要な制約

- **HandId**: `EVT_HAND_RESULTS` でのみ取得可能。ハンド中のイベントは `EVT_DEAL` → `EVT_HAND_RESULTS` 境界内のタイムスタンプ順序で相関させる必要がある。
- **SeatUserIds**: 配列インデックス = 論理席番号。値 = UserId（`-1` = 空席）。配列長 = テーブルサイズ（4 または 6）。
- **プレイヤー名**: `EVT_PLAYER_SEAT_ASSIGNED` または `EVT_PLAYER_JOIN` から解決する必要がある。ハンドイベントからは取得できない。
- **SeatUserIds の一貫性**: `EVT_DEAL` と `EVT_PLAYER_SEAT_ASSIGNED` に同じ `SeatUserIds` が存在する。途中参加（`EVT_PLAYER_JOIN`）でプレイヤーが追加されるが、更新された `SeatUserIds` は次の `EVT_DEAL` で初めて反映される。

## データの依存関係とタイミング

### 重要な依存関係
- **ヒーロー識別**: `EVT_DEAL` の `Player` フィールドが必要（観戦モードでは欠落）
- **プレイヤー名**: `EVT_PLAYER_SEAT_ASSIGNED`（初期）または `EVT_PLAYER_JOIN`（途中参加）で取得
- **セッション情報**: `EVT_ENTRY_QUEUED`（ID、バトルタイプ）と `EVT_SESSION_DETAILS`（名前）から取得
- **HandId**: ハンド完了時（`EVT_HAND_RESULTS`）にのみ取得可能
- **UserId**: `EVT_DEAL` の `SeatUserIds[Player.SeatIndex]` から取得

### 集約の課題
- ハンドレベルの集約には `HandId` が必要だが、ハンド終了時にのみ到着
- 必要な全イベントの受信を検証してから処理する必要がある
- プレイヤー情報は複数イベントにまたがって段階的に到着
- リアルタイムでのハンド集約は不可能。境界検出までバッファリングが必要

## ハンドログ生成: 実行時の挙動に関する注意事項

> ハンドログ（PokerStars形式）生成に影響する実行時の挙動。

### EVT_DEAL: Chip / BetChip の意味

EVT_DEAL 時点の `Chip` / `BetChip` は **アンテおよびブラインド支払い後** の値。

| フィールド | 内容 |
|-----------|------|
| `Player.Chip` | アンテ+ブラインド支払い後の残チップ |
| `Player.BetChip` | ブラインドとして投入した額（アンテは含まない） |

元チップの逆算: `Chip + BetChip + Ante`（通常ケース）。ショートオールイン時はアンテ全額を支払えないため、`Progress.Pot / アンテ拠出者数`（`BetStatus` が `BET_ABLE`/`ALL_IN` のプレイヤー数。着席していても `NOT_IN_PLAY` はアンテを支払わない）で実額を推定する。

### EVT_DEAL: Progress.Pot の意味論（配札時点）

`EVT_DEAL.Progress.Pot` は**アンテだけでなく投稿済みブラインド（SB+BB）も既に含む**。poker-warehouse 側の SNG テーブルチップ保存則監査（I1、`audit_sng_table_conservation.sql`）で全数検証済み: `Σ(seated players の Chip+BetChip) + Progress.Pot + Σ(Progress.SidePot) == table_size × DefaultChip` が BigQuery 本番 29,715/29,715 ハンド + ローカル2キャプチャ全件で成立する。`BetChip`（投稿済みブラインド額）は既に `Progress.Pot` の内側に入っているため、この保存則を検算するときに `BetChip` を別途加算すると二重計上になる。

**アンテオールインによるキャップ発生時の例外**: 上記は「配札時点でオールインによるポットキャップが発生していない」ケースに限る。アンテだけで複数プレイヤーがオールインした場合、配札時点の `Pot`/`SidePot` チェーンは既にサイドポット分割済みであり、ブラインドは**最上位（未キャップ）のサイドポットにのみ**含まれる — `Pot` 自体はブラインド抜きでアンテ拠出者数に割り切れる額になる（2026-07-04キャプチャの全51アンテオールインハンドを手動トレースで確認: `Pot = アンテ単位額 × アンテ拠出者数` が50/50ハンドで厳密に成立、例: ハンド260147134の`SidePot[1]=5000`はアンテ超過分1,200+BB分3,800の合算）。ショートスタック推定（`Progress.Pot / アンテ拠出者数`、上記）はこの分割後の値を前提にしている — ブラインド抜きだと誤って仮定して `BetChip` を差し引くと逆に壊れるため注意。

### EVT_DEAL: Player フィールドの欠落

- **観戦モード**: Player フィールド自体が undefined
- **テーブル移動直後**: Player は存在するが `HoleCards: []`

### テーブル移動キメラハンド

MTTでハンド途中（EVT_DEAL〜EVT_HAND_RESULTSの間）に `EVT_ENTRY_QUEUED` が割り込む（テーブル移動）と、クライアントは移動先テーブルで進行中だったハンドの残り（末尾のEVT_ACTION、およびそのEVT_HAND_RESULTS）を受信する。この移動先由来のEVT_ACTIONは、偶然にも移動前テーブルの有効な席インデックス範囲・NextActionSeatの遷移パターンと一致することがあり、その場合SeatIndex未解決ガード（下記）をすり抜けてハンドバッファが継続してしまう。結果として、移動元テーブルのEVT_DEAL（座席構成・ブラインド・ヒーローのホールカード）と移動先テーブルのEVT_HAND_RESULTS（HandId、勝者、獲得チップ）が1つのハンドとして混ざり合う「キメラハンド」が生成される。

実データ検証（393,830イベント、31,392完走ハンド）: 71ハンド（0.23%）がこのパターンに該当し、いずれもEVT_ENTRY_QUEUED直後の最初の完走ハンドだった。

防御は2層:
| ガード | 対象 | 内容 |
|---|---|---|
| SeatIndex未解決スキップ | `EVT_ACTION` | `event.SeatIndex`が配札時のseatUserIdsで解決できない（undefinedまたは-1）場合、そのアクションのみスキップ（EC/WES双方に実装）。 |
| `hasResultsOutsideDealtLineup` | `EVT_HAND_RESULTS` | Results[]のUserIdが1件でも配札時のseatUserIdsに含まれない場合、ハンド全体を棄却（`src/types/game.ts`、EC/WES双方に実装）。上記スキップをすり抜けた偶然の席番号一致もここで最終的に検出される。 |

### EVT_ACTION: 送信されないケース

- **アンテオールインプレイヤー**: アンテで全チップを消費した場合、EVT_ACTION は送信されない
- **タイムアウト / 切断**: 明示的な FOLD の EVT_ACTION が送信されないことがある。この場合、プレイヤーは EVT_HAND_RESULTS の Results にも含まれない
- **BB 未投稿時の CALL**: PokerChase は BB がアンテオールインでも SB に `CALL bet=BB額` を送信する（内部的に BB ベットが存在する扱い）
- **BB アクションスキップ**: 他の全プレイヤーがオールインまたはフォールド済みの場合、BB の EVT_ACTION（check）が送信されない。`NextActionSeat=-2` で即座にハンド終了。PS 形式エクスポートでは `getMissingBBCheck` で `checks` を補完する
- **クロージングコールの欠落（観測1件・稀）**: ストリートを閉じるコールの EVT_ACTION が送信/捕捉されず、そのチップが**次街の EVT_DEAL_ROUND の Progress.Pot にのみ現れる**事例を本番データで1件観測（hand 499644872: プリフロップで SB のクロージングコール +600 が無言でフロップの Pot に加算。プレイヤーはフォールドでもオールインでもなくその後も正常にプレイ継続）。全コーパス45.2万イベント中1件（ハンドの0.003%）のため機序（サーバー省略かキャプチャ欠落か）は未特定。**Pot+ΣSidePot はアクション以外で増加し得ない**ことを利用し、poker-warehouse 側は街境界のポット増加を capture anomaly として検出・隔離している（`has_street_boundary_pot_jump`）。会計処理を実装する場合はこのパターンに備えること

> **NextActionSeat不一致はハンド破棄の根拠にならない（アジャッジ結果）**: 上記の「送信されないケース」があるため、直前の `Progress.NextActionSeat` と次に届く `EVT_ACTION.SeatIndex` が食い違うことは正常系として高頻度に発生する。実データ（393,830イベント）でセッション境界（テーブル移動）外に発生したこの不一致80件を全数アジャッジしたところ、71件がタイムアウト/切断シグネチャ（期待された次アクターがEVT_HAND_RESULTS.Resultsにも不在）、9件がオールイン絡みの順序変化、原因不明は0件だった。かつて `AggregateEventsStream`（ライブ集計）はこの不一致を検出するとハンドバッファを丸ごと破棄していたが、上記アジャッジ結果によりこれは異常検知ではなく通常のサーバー省略仕様への誤反応であると判明したため、当該チェックは削除された（バッファはクリアせず`console.debug`ログのみ残す）。セッション境界由来のバッファ汚染（テーブル移動キメラハンド、下記参照）への防御は、EVT_ENTRY_QUEUEDでの`this.progress`リセット、EC/WES双方のSeatIndex未解決アクションスキップ、`hasResultsOutsideDealtLineup`によるキメラハンド棄却の3層に委譲されている。

### EVT_DEAL_ROUND: CommunityCards

`CommunityCards` はそのストリートで **新たに配られたカードのみ**（FLOP: 3枚, TURN: 1枚, RIVER: 1枚）。オールイン発生後、残りのストリートでは EVT_DEAL_ROUND が送信されない場合があり、残りのカードは EVT_HAND_RESULTS の CommunityCards に含まれる。

### EVT_HAND_RESULTS: CommunityCards の注意点

| ケース | CommunityCards の内容 |
|-------|---------------------|
| 全ストリート配信済み | 空配列 `[]` |
| オールイン後に未配信カードあり | 未配信分のみ（例: TURN+RIVER の2枚） |
| プリフロップで決着 | 空配列 `[]` |

ハンドログ生成時は、EVT_DEAL_ROUND で蓄積したカードと EVT_HAND_RESULTS のカードをマージする必要がある。

### デュアルボード観測（解明済み: テーブル移動キメラの亜種）

同一ハンドバッファ内でFLOPの `EVT_DEAL_ROUND` が異なるコミュニティカード・異なる残存プレイヤー構成で2回配信される事例。当初は原因未解明（run-it-twice相当の機能？）とされていたが、実データ全数調査で**該当12ハンド全てにハンド内の `EVT_ENTRY_QUEUED` / `EVT_PLAYER_SEAT_ASSIGNED` 割込みがある**ことが確認され、正体は「テーブル移動キメラハンド」の亜種と判明した:

- 移動元テーブルのハンド（DEAL + 1枚目のFLOP）と、移動/再編成先テーブルで進行中だった**別ハンド**（プリフロップの断片 + 2枚目のFLOP + RESULTS）が1つのバッファに融合したもの
- 12件中9件は RESULTS の顔ぶれ不一致により `hasResultsOutsideDealtLineup` ガードで棄却されるが、**3件は両ハンドのプレイヤー構成が偶然一致するため通過**していた（統計・ハンドログを静かに汚染）
- 対策: **同一フェーズの `EVT_DEAL_ROUND` 重複を融合バッファのシグネチャとして検出し、ハンド全体を棄却**する（`write-entity-stream.ts` / `entity-converter.ts` / `verify-stats` オラクルの3箇所で同期実装）。正常なハンドでフェーズが重複する事例は0件（12/12が境界イベント割込みと相関）

### ブラインド回転の連続性（ハンド間）

ポジション導出（`getPositionMap`、#95/#101）はハンドごとに `Game.ButtonSeat` / `SmallBlindSeat` / `BigBlindSeat` から独立に決まるが、これらのフィールドが**ハンドをまたいで**ポーカーの回転規則（BB は毎ハンド時計回りに次の着席者へ前進）と整合しているかを実データで全数検証した（連続同卓ペア 30,470 件、セッション境界・卓再編・途中参加を挟むペアは除外）:

| 分類 | 件数 | 説明 |
|---|---|---|
| 1段前進（規則どおり） | 29,369（96.39%） | 正常 |
| ちょうど2段前進 | 1,033 | **間の1ハンドがキャプチャに存在しない**（短時間の切断等）。ブラインド自体は整合 |
| ちょうど3段前進 | 28 | 同上（2ハンド欠落） |
| **ブラインド三点セットの「再配置」（原因未特定）** | **20（0.07%）** | 下記参照 |

**未特定の再配置パターン**: BTN/SB/BB の3席が、1〜3段の前進では説明できない配置へ一斉に移動する（例: `BTN5/SB2/BB3` → `BTN0/SB1/BB2` — 歯抜けの席配置が連続席へスナップするように見える）。19/20 件が MTT、14/20 件は着席構成が完全に同一のまま発生、ブラインドレベル変化を伴うのは3件のみ（レベルアップ起因ではない）、ハンド間隔は16〜50秒。ミスディール後の再配布やサーバー側の席正規化が疑われるが未確認。

**実害なし**: ポジション導出は各ハンドの明示フィールドの純関数であり（フィールドは常に着席済みの席を指す — 31,916件で検証済み）、ハンド間の推論を行わないため、この不連続が統計を汚染することはない。**ハンドをまたいだポジションの推論（前ハンドからの回転計算等）を実装してはならない**根拠でもある。なお、修正後のポジションラベル遷移の妥当性は96.44%で、サーバーフィールド自体の前進整合率（96.39%）と一致する — 残差はすべて上記のデータ側不連続で説明され、ラベリング起因の不整合は0件だった（旧回転式実装は75.99%で、約20ptぶんの実ラベル誤りを上乗せしていた）。

### ブラインド / アンテ構造

PokerChase はアンテ優先モデルを採用。ショートスタックの場合、アンテに先に全額が充当され、残りがあればブラインドに充当される。

> **注**: TDA2024（2024年11月発効）ではショートオールイン時に BB の支払いがアンテより優先されるよう変更された。PokerChase がこの変更に追随しているかは不明。

PokerChase のアンテ/BB 比率は 25% 前後（例: Ante=1400, BB=5700）で、PokerStars より大きい。これにより BB がアンテでオールインするケースが発生しやすい。

## サイドポットの仕様

オールインが発生するとメインポットとサイドポットに分割される。25,322ハンド中 1,899ハンド（7.5%）で発生。

### 構造

- **`Pot`（メインポット）**: 全プレイヤーが参加可能な額。最もチップが少ないオールインプレイヤーを基準に計算。
- **`SidePot[0]`**: 最初のオールインプレイヤー脱落後の残りプレイヤーのポット。
- **`SidePot[1]`**: 2番目のオールインプレイヤー脱落後のポット。
- **不変条件**: `Pot + sum(SidePot) == sum(Results[].RewardChip)` が **100% 成立**（1,899ハンドで検証済み）。

### SidePot 長の分布

| SidePot 長 | ハンド数 | 割合 |
|---|---|---|
| 0（サイドポットなし） | 23,423 | 92.5% |
| 1 | 1,808 | 7.1% |
| 2 | 89 | 0.4% |
| 3 | 2 | <0.01% |

### Progress.SidePot の変遷（ハンド中）

`Progress.SidePot` はオールインが発生するたびに更新される:

```
EVT_ACTION: Seat4 ALL_IN  → Pot=8350, SidePot=[]        # 1人目オールイン
EVT_ACTION: Seat2 ALL_IN  → Pot=9170, SidePot=[2330]     # 2人目 → サイドポット1つ
EVT_ACTION: Seat3 ALL_IN  → Pot=8930, SidePot=[2260,2330] # 3人目 → サイドポット2つ
EVT_HAND_RESULTS:            Pot=8484, SidePot=[2148,2330] # 最終値（再計算される）
```

**注意**: ハンド中の `Progress.SidePot` と `EVT_HAND_RESULTS.SidePot` の値は一致しない場合がある（最終時点で再計算されるため）。

### Results[] の並び順とサイドポットの関係

サイドポットがない場合、`Results[]` は `HandRanking` 昇順（1=最強が先頭）。

サイドポットがある場合、**ポット単位でグルーピング**される:

```
[0] HandRanking=1, Reward=10632  ← メインポット勝者
[1] HandRanking=-1, Reward=0     ← メインポットの敗者
[2] HandRanking=2, Reward=2330   ← サイドポット勝者
[3] HandRanking=-1, Reward=0     ← サイドポットの敗者（FOLD_OPEN）
```

25,322ハンド中、`HandRanking` 昇順にならないのはサイドポット発生時の12ハンドのみ（0.05%）。

### EVT_HAND_RESULTS: Results[].Ranking の意味論（トーナメント最終着順）

`Results[].Ranking` の正の値は、ハンド単位の一時的な順位ではなく**そのプレイヤーの脱落ハンドで確定するトーナメント最終着順**である。poker-warehouse の SNG セッション継続性監査（`docs/audits/2026-07-sng-session-continuity.md` I3, 該当リポジトリ）で全数検証済み:

- 優勝者はトーナメント最終ハンドで `Ranking=1` を受け取る（監査対象の全終端セッションで278/278）。
- 正の `Ranking` が付いたプレイヤーは、そのセッション内で以降二度と配札に現れない（I3: BigQuery本番839-857セッション+ローカル2キャプチャ全てゼロ違反 — 着順が確定した脱落は取り消されない）。
- 同一ハンドで複数プレイヤーが同時にバストした場合でも、サーバーは個別の `Ranking` を割り振ることがある。この序列は開始時スタックなど公開フィールドから再現できないタイブレークに基づく（サーバー内部ロジック、詳細不明）。
- `-2` = In-Play（継続中）、`-1` = Multiway敗退（複数人脱落し個別着順が付かないケース）。

**セッション途中離脱との違い**: リタイア（「プレイヤー離脱状態」の Status=6/7 参照）で席を離れたプレイヤーは脱落そのものではないため、`Results[].Ranking` に値が付くことはない — 離脱者の最終着順はサーバーの `Ranking` からは取得できず、生存順（残チップの多寡）から推定する以外にない（poker-warehouse 側の代替ロジック、下記「プレイヤー離脱状態」参照）。

## カード番号マッピング

カードインデックス 0–51 でランクとスートをエンコード。実装は `src/utils/card-utils.ts` を参照。

**計算式:**
- ランクインデックス = `floor(card / 4)` → 0=2, 1=3, 2=4, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
- スートインデックス = `card % 4` → 0=♠(s), 1=♥(h), 2=♦(d), 3=♣(c)

**全マッピングテーブル:**

| Index | Card | Index | Card | Index | Card | Index | Card |
|-------|------|-------|------|-------|------|-------|------|
| 0     | 2♠   | 1     | 2♥   | 2     | 2♦   | 3     | 2♣   |
| 4     | 3♠   | 5     | 3♥   | 6     | 3♦   | 7     | 3♣   |
| 8     | 4♠   | 9     | 4♥   | 10    | 4♦   | 11    | 4♣   |
| 12    | 5♠   | 13    | 5♥   | 14    | 5♦   | 15    | 5♣   |
| 16    | 6♠   | 17    | 6♥   | 18    | 6♦   | 19    | 6♣   |
| 20    | 7♠   | 21    | 7♥   | 22    | 7♦   | 23    | 7♣   |
| 24    | 8♠   | 25    | 8♥   | 26    | 8♦   | 27    | 8♣   |
| 28    | 9♠   | 29    | 9♥   | 30    | 9♦   | 31    | 9♣   |
| 32    | T♠   | 33    | T♥   | 34    | T♦   | 35    | T♣   |
| 36    | J♠   | 37    | J♥   | 38    | J♦   | 39    | J♣   |
| 40    | Q♠   | 41    | Q♥   | 42    | Q♦   | 43    | Q♣   |
| 44    | K♠   | 45    | K♥   | 46    | K♦   | 47    | K♣   |
| 48    | A♠   | 49    | A♥   | 50    | A♦   | 51    | A♣   |

## データの制約とエッジケース

既知の全エッジケースを集約したリファレンス。セクション参照が付いている項目は[ハンドログ生成: 実行時の挙動に関する注意事項](#ハンドログ生成-実行時の挙動に関する注意事項)に詳細がある。

### イベントレベルのエッジケース

| ケース | 対象イベント | 説明 |
|---|---|---|
| 観戦モード | `EVT_DEAL` | `Player` フィールドが `undefined`。ヒーロー識別不可。 |
| テーブル移動 | `EVT_DEAL` | `Player` は存在するが `HoleCards: []`（空配列）。 |
| テーブル移動キメラハンド | `EVT_ENTRY_QUEUED` → `EVT_HAND_RESULTS` | ハンド途中のテーブル移動で、移動先テーブルの残りアクション・RESULTSが移動元テーブルのDEALと混ざり合う。実データで71/31,392ハンド（0.23%）。`hasResultsOutsideDealtLineup`とSeatIndex未解決スキップで棄却（[詳細](#テーブル移動キメラハンド)）。 |
| アンテオールイン | `EVT_ACTION` | アンテで全チップ消費 — そのプレイヤーの `EVT_ACTION` は発行されない。 |
| BB アクションスキップ | `EVT_ACTION` | 他の全プレイヤーがオールインまたはフォールド済みの場合、BB の check が発行されない（`NextActionSeat=-2`）。 |
| タイムアウト / 切断 | `EVT_ACTION` | 明示的な FOLD アクションが送信されない場合がある。`EVT_HAND_RESULTS.Results[]` にも不在。 |
| NextActionSeat不一致 | `EVT_ACTION` | 上記の送信されないケースにより、直前のNextActionSeatと実際のSeatIndexが食い違うことがある。異常ではなく正常系（[アジャッジ結果](#evt_action-送信されないケース)：非境界80件中71件がタイムアウト/切断、9件がオールイン順序、原因不明0件）。ハンド破棄の根拠にしてはならない。 |
| BB 暗黙ベット | `EVT_ACTION` | BB がアンテオールインでも、SB は `CALL bet=BB額` を受信（内部的に BB ベットが存在する扱い）。 |
| コミュニティカード（ストリート） | `EVT_DEAL_ROUND` | `CommunityCards` は新規配布カードのみ（FLOP: 3枚, TURN: 1枚, RIVER: 1枚）。累積ではない。 |
| コミュニティカード（オールイン） | `EVT_DEAL_ROUND` | オールイン後、残りストリートで `EVT_DEAL_ROUND` が発行されない場合がある。残りのカードは `EVT_HAND_RESULTS.CommunityCards` に含まれる。 |
| コミュニティカード（マージ） | `EVT_HAND_RESULTS` | `CommunityCards` は `EVT_DEAL_ROUND` で未配信のカードのみ。全ストリート配信済みなら空配列 `[]`。蓄積した `EVT_DEAL_ROUND` のカードとマージしてフルボードを取得する。 |
| ブラインド再配置（未特定） | `EVT_DEAL.Game` | 連続ハンド間でBTN/SB/BBが回転規則外の配置へ一斉移動する事例（20/30,470ペア=0.07%、MTT中心）。ポジション導出はハンド内で完結するため実害なし（[詳細](#ブラインド回転の連続性ハンド間)）。 |
| デュアルボード（解明済み） | `EVT_DEAL_ROUND` | 同一バッファ内でFLOPが異なるカードで2回配信される事例（実データ12ハンド）。テーブル移動キメラの亜種であり、フェーズ重複をシグネチャとしてハンドごと棄却する（[詳細](#デュアルボード観測解明済み-テーブル移動キメラの亜種)）。 |
| ディール時のチップ値 | `EVT_DEAL` | `Player.Chip` と `Player.BetChip` は**アンテ/ブラインド支払い後**の値。元チップ = `Chip + BetChip + Ante`（ただしショートスタック推定を参照）。 |
| ショートスタック推定 | `EVT_DEAL` | アンテだけでオールインするショートスタックの場合、`Chip + BetChip + Ante` は過大評価。`Progress.Pot / アンテ拠出者数`（`BetStatus` が `BET_ABLE`/`ALL_IN` のプレイヤー数。`NOT_IN_PLAY` は拠出しない）でプレイヤーあたりのアンテ推定を使用。 |

### スキーマレベルの注意事項

| トピック | 詳細 |
|---|---|
| パススルーモード | Zod スキーマは `.passthrough()` を使用 — 未知の API プロパティは保持され、拒否されない。API フィールド追加でパースが壊れない。ただし `.passthrough()` は「未知プロパティの容認」のみを意味し、**既存プロパティに対する `.max()`/`.length()`/`z.literal()` 等の値域制約は依然として拒否要因になる**（下記インシデント参照）。 |
| タイムスタンプの出所 | `timestamp` フィールドは `web_accessible_resource.ts` がクライアント側で付与（`Date.now()`）。サーバーからではない。WebSocket メッセージ受信時刻を反映。 |
| スキーマ差分ツール | `npm run schema-diff -- <file.ndjson>` で未知プロパティ（追加）や欠落プロパティ（破壊的変更）を検出。 |
| メタルール: 運用コンテンツ配列に厳格な値域制約を課さない | Rewards/Items/Charas/Stamps/Decos 等、PokerChase のシーズン更新・新モード投入で中身が変わるフィールドには `.max()`/`.length()`/`z.literal()` を課さない（`src/types/api.ts` の `EVT_SESSION_RESULTS` 定義直前のコメント参照）。座席インデックス・`BetStatus`・`Phase`・`ActionType` 等、stats集計パイプラインが依存する「ゲーム状態セマンティクス」には引き続き厳格な制約を課す。 |

> **インシデント記録（2026-01/03頃〜2026-07-19修正）**: season3 導入で `EVT_SESSION_RESULTS`（309）の
> ペイロードが進化し（`RankReward.IsSeasonal` の省略、`RankReward.SeasonalRanking` の固定値0→実際の
> 順位整数化、`Items` の3→5件への増加）、当時の厳格な Zod スキーマ（`IsSeasonal` 必須・
> `SeasonalRanking===0` 固定・`Items.max(4)`）がこれを拒否していた。`parseApiEvent` はスキーマ検証に
> 失敗したイベントをストレージに書き込む前に破棄していたため（`src/background/event-ingestion.ts`）、
> 期間中の全ランク戦SNG（Legend Match含む）のセッション結果・RankReward・RPが**復旧不能な形で欠落**
> している（破棄はストレージ書き込み前段階のため、後からのリプレイでは救えない）。
> 2026-07-19 の修正でスキーマを緩和し、季節更新後のイベントは今後正しくパースされるようになったが、
> 過去の欠落分そのものは戻らない。イベント破棄そのものを起こさない仕組み（スキーマ検証に関わらず
> 生イベントを `apiEvents` に無条件保存する Raw Event Lake）は別ブランチ（`feat/restore-raw-event-lake`）
> で並行開発中——本ドキュメントの更新はスキーマ側の修正のみを反映しており、Raw Event Lake の実装詳細は
> そちら、および `docs/architecture.md`「Raw Event Lake」を参照。

### RankReward フィールドの意味論（`EVT_SESSION_RESULTS.RankReward`）

season3/Legend Match（2026-07観測）で `RankReward` に複数のランクトラックが並存するようになった。
それぞれ独立した値であり、混同しないこと。

| フィールド | トラック | 意味 |
|---|---|---|
| `RankPoint` / `RankPointDiff` | 生涯ラダーRP | 昔からある通常のランクポイント。Legend Match でも引き続き送信される（例: `RankPoint: 2524`）。 |
| `SeasonalRankPoint` / `SeasonalRankPointDiff` | season3 シーズナルトラック | season3 で新設されたシーズン限定のランクポイント（例: `SeasonalRankPoint: 215`）。旧仕様では存在せず、`Items[]` にも同値が `legend_season3_point` として重複して現れる。 |
| `SeasonalRanking` | season3 シーズナルトラック | シーズン内の順位。旧仕様では常に `0`（固定値・未使用）だったが、season3 では実際の順位整数が入る（例: `2813`）。 |
| `LegendRankWeeklyRewardId` / `LegendMatchWeeklyPoint` / `LegendMatchWeeklyPointDiff` / `LegendMatchWeeklyBattleCount` | Legend Match 週間トラック | Legend Match（`IsLegendMatch: true`）限定の週間報酬・週間ポイント・週間対戦数トラック。週次でリセットされると推測されるが未確認。 |
| `IsSeasonal` | （旧仕様） | シーズナルランクかどうかを示す旧フラグ。season3/Legend Match のペイロードではフィールド自体が省略される（`undefined`）。存在すれば旧仕様、省略されていれば season3 以降とみなせる。 |
| `IsLegendMatch` | （新規） | Legend Match モードでの結果かどうか。season3 で新規追加。 |

### RankPoint の変動式（外部検証済み）

`RankReward.RankPointDiff` の変動は非公式Wiki（[gamerch: PokerChase ランクポイント](https://gamerch.com/pokerchase/285690)）で以下のように解説されている:

> ランクポイントの増減＝STAGEごとの基準値＋ポイント差による補正値

STAGEごとの基準値（着順1〜6位）:

| STAGE | 1位 | 2位 | 3位 | 4位 | 5位 | 6位 |
|---|---|---|---|---|---|---|
| Ⅰ | +15〜+20 | +5 | +2〜+5 | ±0 | — | — |
| Ⅱ | +20〜+25 | +12〜+15 | +6〜+7 | ±0 | -6〜-8 | — |
| Ⅲ | +25 | +15 | +5 | -2 | -8 | -15 |
| Ⅳ | +30 | +18 | +6 | -4 | -13 | -20 |
| Ⅴ | +35 | +21 | +7 | -6 | -19 | -28 |
| Ⅵ | +35 | +21 | +7 | -7 | -21 | -35 |

補正値は「自分のランクポイントが同卓5人の平均よりどれだけ高い/低いか」で決まり、下振れ側（平均より600以上低い）で+14、上振れ側（平均より600以上高い）で-14、差が±40近辺で±0になる（Wiki記載例: STAGE Ⅲ 5位、平均より92低い場合 `-13 = -15(STAGE Ⅲの5位) + 2(補正値)`）。

**実データでの検証**（本リポジトリ側）: **(a)** 単一キャプチャ（2026-07-04、`npm run validate-schema` のゲート対象ファイル）では `RankReward` を持つ309イベント496件中、`EVT_SESSION_DETAILS.Name2` からSTAGEを特定できた237件全てが基準値±14のバンド内（0件が範囲外）。**(b)** BigQuery全履歴・全観測者では `RankReward` が存在する643セッション全件を `EVT_SESSION_DETAILS.Name`（stage000〜stage006 / ステージⅤ・Ⅵ表記）でSTAGEにマッピングでき、**643/643件が理論バンド内**だった（例: STAGE Ⅵ・1位の実測レンジは+27〜+40で、基準値+35±14=[+21,+49]の内側）。両母集団で違反ゼロ。

**制約（対戦相手のRPは復元不能）**: 補正値の算出には同卓5人の平均ランクポイントが必要だが、`EVT_PLAYER_SEAT_ASSIGNED.TableUsers[]` は対戦相手のランク**バッジ**（`Rank.RankId` 等）のみを送信し、数値のランクポイントはワイヤー上に一切出現しない。したがって特定セッションの補正値そのものを手元データだけから再構築することはできず、上記の検証もあくまで「観測された合計変動が理論バンド内に収まるか」の検証にとどまる。

### EVT_SESSION_RESULTS の条件付きフィールドファミリー

`EVT_SESSION_RESULTS`（309）は BattleType や導入時期によって出現するフィールドが変わる。2つの母集団で再測定した: **(a)** `pokerchase_raw_data_2026-07-04T18-31-12-252Z.ndjson`（単一観測者、309イベント734件 — `npm run validate-schema` のゲート対象そのもの）、**(b)** BigQuery全履歴・全観測者（309イベント922件、内訳: SNG/BattleType=0 が643件、Ring/4 が137件、MTT/1 が87件、bt2が44件、bt6が11件）:

| フィールド群 | スコープ | (a) 07-04単一キャプチャ | (b) BQ全履歴・全観測者 | 備考 |
|---|---|---|---|---|
| `RingReward`（`Ranking`=リーダーボード順位, `Score`, `ResultNum` 等） | **Ring専用** | 122/734 | 137/137（Ring全件）/ 他BattleType 0/785 | `RankReward`（SNG専用）と排他的な関係。両母集団でRing以外は0件 |
| `TournamentReward`（`JoinNum`） | **MTT専用** | 77/734 | 87/87（MTT全件）/ 他BattleType 0/835 | 同上、MTT側のカウンターパート |
| `TargetBlindLv` / `ResultChip` / `PopupMessageTextKey` / `PopupTitleTextKey` | **全BattleType横断**（Ring限定ではない） | 423/734 — SNG 237, Ring 100, MTT 49, bt2 36, bt6 1 | 611/922（66%）— SNG 384/643, Ring 115/137, MTT 59/87, bt2 44/44, bt6 9/11 | 常に4フィールドが揃って出現/欠落する1つのファミリー。両母集団とも全BattleTypeに分布しており「Ring限定」ではない |
| `BattleFinishTime` / `IsSeasonOver` / `IsCountOverRingMedal` | **全BattleType横断** | 562/734 — SNG 350, Ring 111, MTT 62, bt2 36, bt6 3 | 750/922（81%）— SNG 497/643, Ring 126/137, MTT 72/87, bt2 44/44, bt6 11/11 | 2024-11-25以降のセッションで初観測（最古の309自体は2024-09-21）。導入後は型を問わず安定して付与される — 「新しく稀」なフィールドではない |
| `TableId` / `IsOverDailyLimit` / `IsChangeDay` / `IsTimerWinFinish` | 大半がRing、MTTでも稀に出現 | 10/734 — Ring 6, MTT 4 | 9/922 | 2026-03-24以降に追加。既存の`src/types/api.ts`側describe（726/734母数、より古い測定時点）とはスナップショット時点が異なる |
| `WeeklyRewards` | Ring専用、常に空配列 | 7/734 | 6/922 | |

### EVT_SESSION_RESULTS: Ranking の負値

トップレベルの `EVT_SESSION_RESULTS.Ranking`（`EVT_HAND_RESULTS.Results[].Ranking` とは別フィールド）にも負のセンチネルが観測される:

| 値 | (a) 07-04単一キャプチャ (734件中) | (b) BQ全履歴・全観測者 (922件中) | スコープ | 備考 |
|---|---|---|---|---|
| `-1` | 150 | 169 | Ring全件（100%）+ MTTの一部（BQでは32/87） | 観測範囲では `IsLeave` が常に `false` — 「途中退出だから-1」という単純な説明は成立しない。要因未特定なので推測で埋めない |
| `-3` | 13 | 14 | MTTのみ（BQでは14/87） | 意味論未特定。正直に unknown として記録する |

### プレイヤー離脱状態（OtherPlayers[].Status）

25,322ハンドの前後ハンドトレースに基づく状態遷移:

| Status | 名前 | 出現率 | ストーリー |
|---|---|---|---|
| 0 | 通常 | 97.3% | 通常のプレイ中 |
| 1 | 離脱予告/切断 | 0.33% | DEAL時Status=0 → RESULTS時Status=1に遷移。チップ変動なし（ハンド不参加）。数ハンド継続後、Status=6(自発退出) or 7(強制退出)で最終離脱 |
| 4 | 離席中 | 0.5% | Chip>0を保持したまま次ハンドで不在。MTTテーブル移動(RT=2, 53%)が主因。通常ハンド後(41%)やトーナメント敗退(5%)でも発生 |
| 5 | バスト | 1.84% | 常にChip=0。SNG: トーナメント脱落で次ハンドGONE。Ring: リバイイン猶予期間（次ハンドでChip>0に復帰 or 席離脱） |
| 6 | 自発退出 | 0.02% | Chip>0を残したまま次ハンドでGONE。Status=1から遷移するパターンあり |
| 7 | 強制退出 | 0.01% | Chip>0を残したまま次ハンドでGONE。タイムアウト/接続断による強制退場。Status=1から遷移するパターンあり |
| 2, 3 | 未観測 | 0% | 310kイベントで未出現 |

> **注**: EVT_DEAL と EVT_DEAL_ROUND の OtherPlayers[].Status は 0 と 1 のみ観測。Status=5（バスト後リバイイン待ち）は EVT_DEAL でのみ発生し、Ringゲーム限定。

> **訂正（2026-07, poker-warehouse SNG継続性監査で判明）**: Status=6/7（自発退出/強制退出）は Ring限定の挙動ではない。**ランク戦SNG（BattleType=0）でも途中離脱（いわゆる「リタイア」）が発生しうる** — poker-warehouseのI1テーブルチップ保存則監査で、SNGセッション内でプレイヤーが `Chip>0` を残したまま `SeatUserIds` から恒久的に消え、以降そのチップがどこにも再配分されない事例を確認（2026-07-04キャプチャ session_seq=321: プレイヤー507846464がChip≈62,000のまま消失、以降の全ハンドで62,000ちょうどの差分が生じ続けた）。この離脱はトーナメント脱落（`Results[].Ranking` が付く「バスト」）とは別の状態遷移であり、**離脱者は最終ハンドのResults[]にRankingが決して付かない**（脱落ではないため）。またテーブルの総チップ供給量が恒久的に減少する＝SNGはこの意味で離脱を跨ぐと閉じた系ではない。ranking/RP等セッション結果を扱う場合はこの離脱ケースを考慮すること（詳細・検証数値は poker-warehouse `docs/audits/2026-07-sng-session-continuity.md` I1/I5 を参照 — 本リポジトリでの重複記載はしない）。

### ResultType（ハンド終了後の状態遷移）

| ResultType | 名前 | 出現率 | 説明 |
|---|---|---|---|
| 0 | 通常続行 | 98.5% | 次のハンドへ |
| 1 | トーナメント敗退 | 0.8% | ヒーローが脱落。EVT_SESSION_RESULTS が続く |
| 2 | テーブル移動 | 0.4% | MTT。EVT_PLAYER_SEAT_ASSIGNED（ProcessType=2）が続く |
| 3 | 休憩開始 | 0.1% | MTT。休憩終了後にゲーム再開 |
| 4 | テーブル離脱 | 0.2% | Ring退出時、対戦相手不在時 |

### ProcessType（EVT_PLAYER_SEAT_ASSIGNED）

| ProcessType | 名前 | 出現率 | 特徴 |
|---|---|---|---|
| 0 | 初期着席 | 59% | SNG/MTT/Ringの初回着席。Game/Player/Progress なし |
| 1 | テーブル移動先着席 | 7% | MTT/Ring。BB/SBSeat=-1（ハンド間でブラインド未確定） |
| 2 | ゲーム中途中参加 | 29% | Ring/MTT。Game/Player/Progress 全て存在 |
| 3 | MTT再着席 | <1% | 稀（2件のみ観測） |
| 4 | テーブル離脱/復帰 | 5% | IsLeave=trueでRing離脱を示す場合あり |

### その他の解決済みフィールド

| フィールド | 値 | 説明 |
|---|---|---|
| `BlindStructures[].ActiveMinutes` | 正の整数, -1 | -1 = 最終ブラインドレベル（以降上昇なし） |
| `BigBlindSeat` / `SmallBlindSeat` | -1 | ProcessType=1（テーブル移動先着席）でのみ発生。ハンド間でブラインド位置が未確定 |
| `HandLog` | 常に空文字列 | 25,322ハンドで確認。PokerChase内部の予約フィールド（未使用） |

### 処理上の制約

| 制約 | 詳細 |
|---|---|
| EntityConverter シングルパス | `convertEventsToEntities()` は内部状態でハンド境界を追跡。**全イベントを単一呼び出しで渡す必要がある** — チャンク分割すると境界をまたぐハンドが失われる。 |
| 重複検出 | イベントは `[timestamp+ApiTypeId]` 複合キーで識別。同じ timestamp + 同じ ApiTypeId = 重複。 |
| イベント順序 | WebSocket 接続ごとに論理的順序が保証されるが、接続障害によりギャップが発生する可能性がある。 |
| バッチ vs ライブモード | `service.setBatchMode(true)` はバルクインポート中のリアルタイム HUD 更新を無効化。処理後にリセットが必要。 |

### エクスポートとストレージの制限

| 制限 | 値 | コンテキスト |
|---|---|---|
| Service Worker → content_script メッセージ | 64 MiB | Chrome のメッセージパッシング制限。大規模エクスポートはチャンク転送を使用。 |
| Data URL ダウンロード | 約 2 MB | ゲームタブがない場合のフォールバック。Blob ベースのダウンロードを推奨。 |
| IndexedDB オリジンあたり | ブラウザ依存 | 通常は利用可能ディスクの 50% 以上。拡張機能によるハードキャップなし。 |

## Enum リファレンス

`src/types/game.ts` の完全な enum 定義。生の NDJSON イベントデータに出現する値。

### ActionType

| 値 | 名前 | 説明 |
|---|---|---|
| 0 | CHECK | チェック（ベットなし） |
| 1 | BET | オープンベット |
| 2 | FOLD | フォールド |
| 3 | CALL | 既存ベットへのコール |
| 4 | RAISE | 既存ベットへのレイズ |
| 5 | ALL_IN | オールイン（正規化: エンティティアクションでは BET/CALL/RAISE として保存） |

### BattleType

| 値 | 名前 | 説明 |
|---|---|---|
| 0 | SIT_AND_GO | ランク戦 SNG トーナメント |
| 1 | TOURNAMENT | MTT（マルチテーブルトーナメント） |
| 2 | FRIEND_SIT_AND_GO | フレンドマッチ SNG |
| 4 | RING_GAME | リングゲーム（キャッシュゲーム） |
| 5 | FRIEND_RING_GAME | プライベートテーブル リングゲーム |
| 6 | CLUB_MATCH | クラブマッチ SNG |

> 注: 値 3 は未使用（欠番）。

**フィルターグルーピング**（`BATTLE_TYPE_FILTERS` より）:
- SNG: 0, 2, 6
- MTT: 1
- Ring: 4, 5

**Legend Match モード（2026-07観測）**:
`BattleType` 自体は通常の SNG（0）のまま変わらないが、`EVT_SESSION_DETAILS.Name` が
`text_rank_stage_name_legendmatch001`、`Name2` が `text_rank_room_name_legend_stage007_XXX`
になる特別なランク戦。`EVT_ENTRY_QUEUED.Id` も `legend_stage007_XXX` 形式。season3 導入と
同時期に観測され、`EVT_SESSION_RESULTS.RankReward` のシェイプが変わる（詳細は次項
「RankReward フィールドの意味論」参照）。

### BetStatusType

| 値 | 名前 | 説明 |
|---|---|---|
| -1 | HAND_ENDED | ハンド完了 |
| 0 | NOT_IN_PLAY | プレイ中でない |
| 1 | BET_ABLE | アクション可能 |
| 2 | FOLDED | フォールド済み |
| 3 | ALL_IN | オールイン中 |
| 4 | ELIMINATED | トーナメントから脱落 |

### PhaseType

| 値 | 名前 | 説明 |
|---|---|---|
| 0 | PREFLOP | プリフロップ |
| 1 | FLOP | フロップ |
| 2 | TURN | ターン |
| 3 | RIVER | リバー |
| 4 | SHOWDOWN | HUD 内部用の拡張（API からは来ない） |

### RankType

| 値 | 名前 | 説明 |
|---|---|---|
| 0 | ROYAL_FLUSH | ロイヤルフラッシュ |
| 1 | STRAIGHT_FLUSH | ストレートフラッシュ |
| 2 | FOUR_OF_A_KIND | フォーカード |
| 3 | FULL_HOUSE | フルハウス |
| 4 | FLUSH | フラッシュ |
| 5 | STRAIGHT | ストレート |
| 6 | THREE_OF_A_KIND | スリーカード |
| 7 | TWO_PAIR | ツーペア |
| 8 | ONE_PAIR | ワンペア |
| 9 | HIGH_CARD | ハイカード |
| 10 | NO_CALL | コールなし勝利（無競争） |
| 11 | SHOWDOWN_MUCK | ショーダウン後マック（敗北） |
| 12 | FOLD_OPEN | フォールド後に自発的にカード公開 |

### Position

| 値 | 名前 | 説明 |
|---|---|---|
| -2 | BB | ビッグブラインド |
| -1 | SB | スモールブラインド |
| 0 | BTN | ボタン（ディーラー） |
| 1 | CO | カットオフ |
| 2 | HJ | ハイジャック |
| 3 | UTG | アンダーザガン |

### ActionDetail

エンティティの `Action` レコードに付与される統計計算用マーカー。`src/types/game.ts` 参照。

| 値 | 説明 |
|---|---|
| `ALL_IN` | オールインアクションマーカー |
| `VPIP` | 自発的ポット参加 |
| `CBET` | コンティニュエーションベット実行 |
| `CBET_CHANCE` | コンティニュエーションベット機会 |
| `CBET_FOLD` | コンティニュエーションベットにフォールド |
| `CBET_FOLD_CHANCE` | コンティニュエーションベットに直面（フォールド機会） |
| `3BET` | 3ベット実行 |
| `3BET_CHANCE` | 3ベット機会 |
| `3BET_FOLD` | 3ベットにフォールド |
| `3BET_FOLD_CHANCE` | 3ベットに直面（フォールド機会） |
| `DONK_BET` | ドンクベット実行 |
| `DONK_BET_CHANCE` | ドンクベット機会 |
| `RIVER_CALL` | リバーでコール |
| `RIVER_CALL_WON` | リバーでコールして勝利 |

## コードリファレンス

実装の詳細:
- 型定義: `src/types/api.ts`
- エンティティ型: `src/types/entities.ts`
- ゲーム enum: `src/types/game.ts`
- カードユーティリティ: `src/utils/card-utils.ts`
- イベント処理: `src/streams/aggregate-events-stream.ts`
- エンティティ変換: `src/entity-converter.ts`
- バリデーション例: `src/app.test.ts`
- スキーマバリデーションツール: `npm run validate-schema`
- スキーマ差分ツール: `npm run schema-diff`
