# PokerChase ログ仕様

> PokerChase WebSocket API のハンドログ関連イベントの挙動仕様。
> `api-events.md` がスキーマ定義を扱うのに対し、本文書はハンドログ生成に影響する実行時の挙動を記述する。

## EVT_DEAL (303)

### Chip / BetChip の意味

EVT_DEAL 時点の `Player.Chip` と `Player.BetChip` は **アンテおよびブラインド支払い後** の値。

```
元チップ = Chip + BetChip + Ante（通常ケース）
```

ただし、ショートオールイン時はアンテの全額を支払えないため、この逆算が成立しない。

| フィールド | 内容 |
|-----------|------|
| `Player.Chip` | アンテ+ブラインド支払い後の残チップ |
| `Player.BetChip` | ブラインドとして投入した額（アンテは含まない） |
| `OtherPlayers[].Chip` | 同上 |
| `OtherPlayers[].BetChip` | 同上 |

### Player フィールドの欠落

以下のケースで `Player` フィールドが存在しない、または `HoleCards` が空配列になる:

- **観戦モード**: Player フィールド自体が undefined
- **テーブル移動直後**: Player は存在するが `HoleCards: []`。PokerChase がカードを配布していない状態

### Progress.Pot / SidePot

EVT_DEAL 時点の Pot/SidePot はアンテ・ブラインド投入後の値。

- `Pot`: メインポット（ショートスタックが参加可能な金額）
- `SidePot`: サイドポット配列（ショートスタック超過分）

ショートオールイン発生時、`Pot / アクティブプレイヤー数` でショートスタックの実際の投入額を推定可能。

## EVT_ACTION (304)

### アンテオールインプレイヤー

アンテで全チップを消費したプレイヤーには EVT_ACTION が送信されない。

### タイムアウト / 切断

タイムアウトや切断によるフォールドの場合、明示的な FOLD の EVT_ACTION が送信されないことがある。この場合、プレイヤーは EVT_HAND_RESULTS の Results にも含まれない。

### CALL の BetChip

`BetChip` はストリート内の累積ベット額。PokerChase は内部的に BB が投稿されていなくても BB 額へのCALL を送信する（内部的には BB ベットが存在する扱い）。

## EVT_DEAL_ROUND (305)

### CommunityCards

`CommunityCards` はそのストリートで**新たに配られたカード**のみ:

- FLOP: 3枚
- TURN: 1枚
- RIVER: 1枚

オールイン発生後、残りのストリートでは EVT_DEAL_ROUND が送信されない場合がある。この場合、残りのカードは EVT_HAND_RESULTS の CommunityCards に含まれる。

## EVT_HAND_RESULTS (306)

### CommunityCards の注意点

EVT_HAND_RESULTS の `CommunityCards` は **フルボード（5枚）とは限らない**:

| ケース | CommunityCards の内容 |
|-------|---------------------|
| 全ストリート配信済み | 空配列 `[]` |
| オールイン後に配信されなかったカードがある | 未配信分のみ（例: TURN+RIVER の2枚） |
| プリフロップで決着 | 空配列 `[]` |

ハンドログ生成時は、EVT_DEAL_ROUND で蓄積したカードと EVT_HAND_RESULTS のカードをマージする必要がある。

### Results の注意点

- タイムアウト/切断でフォールド扱いになったプレイヤーは Results に含まれない
- `RewardChip` は Uncalled bet 返却前の総額

### Pot / SidePot

- `Pot`: メインポット額
- `SidePot`: サイドポット配列（複数のサイドポットが存在可能）
- PokerChase のポット計算自体は正確（検証済み）

## ブラインド / アンテ構造

### アンテ優先モデル

PokerChase はアンテ優先モデルを採用:

1. 全プレイヤーがアンテを投入
2. SB がスモールブラインドを投入
3. BB がビッグブラインドを投入

ショートスタックの場合、アンテに先に全額が充当され、残りがあればブラインドに充当される。

> **注**: 2024年11月発効の TDA2024 では、ショートオールイン時に BB の支払いがアンテより優先されるよう変更された。PokerChase がこの変更に追随しているかは不明。

### アンテ / BB 比率

PokerChase のブラインドストラクチャでは、アンテが BB に対して比較的大きい場合がある:

```
例: Level 10 — Ante=1400, SB=2850, BB=5700 (Ante/BB = 24.6%)
例: Level 3  — Ante=70, SB=140, BB=280 (Ante/BB = 25%)
```

この比率により、BB ポジションのプレイヤーがアンテで全チップを消費し BB を投稿できないケースが PokerStars より発生しやすい。
