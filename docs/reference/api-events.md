# API Events Reference

> Complete reference for PokerChase WebSocket API events.

## Overview

API events are the primary data source for the HUD. Events arrive via WebSocket in guaranteed logical order, though connectivity issues may cause data loss.

**Important Notes:**
- Event schema is controlled by PokerChase API and may change without notice
- All events have corresponding Zod schemas in `src/types/api.ts`
- Runtime validation ensures type safety
- Use type guard functions for safe event handling

## Event Categories

### Session Events

Session events manage game lifecycle from entry to completion.

| Event                 | ID  | Purpose                                    | Key Fields                |
| --------------------- | --- | ------------------------------------------ | ------------------------- |
| `EVT_ENTRY_QUEUED`    | 201 | Session start, extracts ID and battle type | `Id`, `BattleType` |
| `EVT_SESSION_DETAILS` | 308 | Game configuration and name                | `Name`, `BlindStructures` |
| `EVT_SESSION_RESULTS` | 309 | Session end, triggers cleanup              | `Results`, `Rankings`     |

### Player Events

Player events track seating, identification, and mid-game joins.

| Event                      | ID  | Purpose                          | Key Fields                                     |
| -------------------------- | --- | -------------------------------- | ---------------------------------------------- |
| `EVT_PLAYER_SEAT_ASSIGNED` | 313 | Initial seating with names/ranks | `SeatUserIds[]`, `TableUsers[]`                |
| `EVT_PLAYER_JOIN`          | 301 | Mid-game joins                   | `JoinPlayer`, `JoinUser`                       |
| `EVT_DEAL`                 | 303 | Hand start, hero identification  | `Player.SeatIndex`, `SeatUserIds[]`, `Player.HoleCards[]` |

### Game Events

Game events represent poker actions and hand progression.

| Event              | ID  | Purpose                         | Key Fields                           |
| ------------------ | --- | ------------------------------- | ------------------------------------ |
| `EVT_ACTION`       | 304 | Player actions (bet/fold/raise) | `SeatIndex`, `ActionType`, `BetChip` |
| `EVT_DEAL_ROUND`   | 305 | New street (flop/turn/river)    | `CommunityCards[]`, `Progress`       |
| `EVT_HAND_RESULTS` | 306 | Hand completion, winners        | `HandId`, `Results[]`, `Pot`         |

## Typical Hand Event Sequence

```
1. EVT_DEAL (303)
   - Provides: Hero identification, initial SeatUserIds
   - Extract: Hero UserId = SeatUserIds[Player.SeatIndex]

2. EVT_ACTION (304) [multiple]
   - Preflop actions: posts, raises, calls, folds
   - Track: Who entered pot (VPIP), who raised (PFR)

3. EVT_DEAL_ROUND (305) - Flop
   - Community cards revealed
   - Reset street-specific counters

4. EVT_ACTION (304) [multiple]
   - Flop actions: checks, bets, raises
   - Track: Continuation bets, aggression

5. EVT_DEAL_ROUND (305) - Turn
6. EVT_ACTION (304) [multiple]
7. EVT_DEAL_ROUND (305) - River
8. EVT_ACTION (304) [multiple]

9. EVT_HAND_RESULTS (306)
   - Provides: HandId, winners, final pot
   - Triggers: Statistics calculation, hand log generation
```

## Event Data Relationships

### SeatUserIds Array
- Length determines table size (4 or 6)
- Index = logical seat position
- Value = UserId (or -1 for empty)
- Order randomly assigned at seating

### Player Identification Flow
```
EVT_PLAYER_SEAT_ASSIGNED → Initial player names/ranks
         ↓
EVT_DEAL.Player.SeatIndex → Hero seat identification
         ↓
SeatUserIds[Player.SeatIndex] → Hero UserId
         ↓
EVT_ACTION.UserId → Track hero's actions
```

## Data Dependencies & Timing

### Critical Dependencies
- **Hero Identification**: Requires `EVT_DEAL` with `Player` field (missing in spectator mode)
- **Player Names**: Available via `EVT_PLAYER_SEAT_ASSIGNED` (initial) or `EVT_PLAYER_JOIN` (mid-game)
- **Session Info**: From `EVT_ENTRY_QUEUED` (ID, battle type) and `EVT_SESSION_DETAILS` (name)
- **HandId**: Only available at hand completion (`EVT_HAND_RESULTS`)
- **UserId**: Obtained via `SeatUserIds[Player.SeatIndex]` from `EVT_DEAL`

### Aggregation Challenges
- Hand-level aggregation requires `HandId` which only arrives at hand end
- Must verify all required events are received before processing
- Player information arrives incrementally across multiple events
- Cannot aggregate hands in real-time; must buffer until boundary detected

## Hand Log Generation: Behavioral Notes

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

## Code References

For implementation details:
- Type definitions: `src/types/api.ts`
- Event processing: `src/streams/aggregate-events-stream.ts`
- Validation examples: `src/app.test.ts`
- Schema validation tool: `npm run validate-schema`