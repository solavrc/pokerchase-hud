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
| `EVT_SESSION_RESULTS` | `Ranking`, `RankReward` | 最終順位とランク変動 |

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

元チップの逆算: `Chip + BetChip + Ante`（通常ケース）。ショートオールイン時はアンテ全額を支払えないため、`Progress.Pot / アクティブプレイヤー数` で実額を推定する。

### EVT_DEAL: Player フィールドの欠落

- **観戦モード**: Player フィールド自体が undefined
- **テーブル移動直後**: Player は存在するが `HoleCards: []`

### EVT_ACTION: 送信されないケース

- **アンテオールインプレイヤー**: アンテで全チップを消費した場合、EVT_ACTION は送信されない
- **タイムアウト / 切断**: 明示的な FOLD の EVT_ACTION が送信されないことがある。この場合、プレイヤーは EVT_HAND_RESULTS の Results にも含まれない
- **BB 未投稿時の CALL**: PokerChase は BB がアンテオールインでも SB に `CALL bet=BB額` を送信する（内部的に BB ベットが存在する扱い）

### EVT_DEAL_ROUND: CommunityCards

`CommunityCards` はそのストリートで **新たに配られたカードのみ**（FLOP: 3枚, TURN: 1枚, RIVER: 1枚）。オールイン発生後、残りのストリートでは EVT_DEAL_ROUND が送信されない場合があり、残りのカードは EVT_HAND_RESULTS の CommunityCards に含まれる。

### EVT_HAND_RESULTS: CommunityCards の注意点

| ケース | CommunityCards の内容 |
|-------|---------------------|
| 全ストリート配信済み | 空配列 `[]` |
| オールイン後に未配信カードあり | 未配信分のみ（例: TURN+RIVER の2枚） |
| プリフロップで決着 | 空配列 `[]` |

ハンドログ生成時は、EVT_DEAL_ROUND で蓄積したカードと EVT_HAND_RESULTS のカードをマージする必要がある。

### ブラインド / アンテ構造

PokerChase はアンテ優先モデルを採用。ショートスタックの場合、アンテに先に全額が充当され、残りがあればブラインドに充当される。

> **注**: TDA2024（2024年11月発効）ではショートオールイン時に BB の支払いがアンテより優先されるよう変更された。PokerChase がこの変更に追随しているかは不明。

PokerChase のアンテ/BB 比率は 25% 前後（例: Ante=1400, BB=5700）で、PokerStars より大きい。これにより BB がアンテでオールインするケースが発生しやすい。

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
| アンテオールイン | `EVT_ACTION` | アンテで全チップ消費 — そのプレイヤーの `EVT_ACTION` は発行されない。 |
| タイムアウト / 切断 | `EVT_ACTION` | 明示的な FOLD アクションが送信されない場合がある。`EVT_HAND_RESULTS.Results[]` にも不在。 |
| BB 暗黙ベット | `EVT_ACTION` | BB がアンテオールインでも、SB は `CALL bet=BB額` を受信（内部的に BB ベットが存在する扱い）。 |
| コミュニティカード（ストリート） | `EVT_DEAL_ROUND` | `CommunityCards` は新規配布カードのみ（FLOP: 3枚, TURN: 1枚, RIVER: 1枚）。累積ではない。 |
| コミュニティカード（オールイン） | `EVT_DEAL_ROUND` | オールイン後、残りストリートで `EVT_DEAL_ROUND` が発行されない場合がある。残りのカードは `EVT_HAND_RESULTS.CommunityCards` に含まれる。 |
| コミュニティカード（マージ） | `EVT_HAND_RESULTS` | `CommunityCards` は `EVT_DEAL_ROUND` で未配信のカードのみ。全ストリート配信済みなら空配列 `[]`。蓄積した `EVT_DEAL_ROUND` のカードとマージしてフルボードを取得する。 |
| ディール時のチップ値 | `EVT_DEAL` | `Player.Chip` と `Player.BetChip` は**アンテ/ブラインド支払い後**の値。元チップ = `Chip + BetChip + Ante`（ただしショートスタック推定を参照）。 |
| ショートスタック推定 | `EVT_DEAL` | アンテだけでオールインするショートスタックの場合、`Chip + BetChip + Ante` は過大評価。`Progress.Pot / activePlayerCount` でプレイヤーあたりのアンテ推定を使用。 |

### スキーマレベルの注意事項

| トピック | 詳細 |
|---|---|
| パススルーモード | Zod スキーマは `.passthrough()` を使用 — 未知の API プロパティは保持され、拒否されない。API フィールド追加でパースが壊れない。 |
| タイムスタンプの出所 | `timestamp` フィールドは `web_accessible_resource.ts` がクライアント側で付与（`Date.now()`）。サーバーからではない。WebSocket メッセージ受信時刻を反映。 |
| スキーマ差分ツール | `npm run schema-diff -- <file.ndjson>` で未知プロパティ（追加）や欠落プロパティ（破壊的変更）を検出。 |

### 未解決フィールド（`要調査`）

本番データで観測されているが完全には文書化されていないフィールド:

| イベント | フィールド | 観測値 | 備考 |
|---|---|---|---|
| `EVT_DEAL` | `OtherPlayers[].Status` | 0, 1, 5 | 値 1 と 5 は全イベントの 1% 未満 |
| `EVT_HAND_RESULTS` | `OtherPlayers[].Status` | 0–7 | 5=ELIMINATED は既知。6, 7 は未文書化 |
| `EVT_PLAYER_SEAT_ASSIGNED` | `ProcessType` | 0–4 | 0（初期着席）のみ文書化済み |
| `EVT_SESSION_DETAILS` | `BlindStructures[].ActiveMinutes` | 正の整数, -1 | -1 = 最終ブラインドレベル（以降上昇なし） |
| `EVT_HAND_RESULTS` | `ResultType` | 0–4 | 0=通常, 2=テーブル移動, 3=休憩開始, 4=テーブル離脱 / 対戦相手不在 |

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
