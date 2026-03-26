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

## Card Number Mapping

Card indices 0–51 encode rank and suit. See `src/utils/card-utils.ts` for implementation.

**Formula:**
- Rank index = `floor(card / 4)` → 0=2, 1=3, 2=4, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
- Suit index = `card % 4` → 0=♠(s), 1=♥(h), 2=♦(d), 3=♣(c)

**Full mapping table:**

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

## Field Relationships

Cross-reference guide for linking fields across event types.

### Player Identification

```
EVT_PLAYER_SEAT_ASSIGNED.TableUsers[].UserId  ──► Player name/rank (initial seating)
EVT_PLAYER_JOIN.JoinUser.UserId               ──► Player name/rank (mid-game join)
                    │
                    ▼
EVT_DEAL.SeatUserIds[N] = UserId              ──► Maps seat index to player
EVT_DEAL.Player.SeatIndex                     ──► Hero's seat index
    → SeatUserIds[Player.SeatIndex] = Hero's UserId
                    │
                    ▼
EVT_ACTION.SeatIndex                          ──► Acting player = SeatUserIds[SeatIndex]
EVT_HAND_RESULTS.Results[].UserId             ──► Direct UserId (matches SeatUserIds values)
```

### Session Linkage

| Source Event | Field | Links To |
|---|---|---|
| `EVT_ENTRY_QUEUED` | `Id`, `BattleType` | Session identifier and game type |
| `EVT_SESSION_DETAILS` | `Name`, `BlindStructures` | Session name, blind levels |
| `EVT_PLAYER_SEAT_ASSIGNED` | `SeatUserIds`, `TableUsers` | Seat-to-player mapping |
| `EVT_DEAL` | `SeatUserIds`, `Game` | Per-hand seat mapping and blind info |
| `EVT_HAND_RESULTS` | `HandId` | Unique hand identifier (only available here) |
| `EVT_SESSION_RESULTS` | `Ranking`, `RankReward` | Final placement and rank changes |

### Key Constraints

- **HandId**: Only available at `EVT_HAND_RESULTS`. During a hand, events must be correlated by timestamp ordering within an `EVT_DEAL`→`EVT_HAND_RESULTS` boundary.
- **SeatUserIds**: Array index = logical seat. Value = UserId (`-1` = empty seat). Array length = table size (4 or 6).
- **Player names**: Must be resolved from `EVT_PLAYER_SEAT_ASSIGNED` or `EVT_PLAYER_JOIN` events, not from hand events.
- **SeatUserIds consistency**: The same `SeatUserIds` array is present in `EVT_DEAL` and `EVT_PLAYER_SEAT_ASSIGNED`. Mid-game joins (`EVT_PLAYER_JOIN`) add players to seats, but the updated `SeatUserIds` only appears in the next `EVT_DEAL`.

## Data Constraints & Edge Cases

Consolidated reference for all known edge cases. Items marked with a section reference are documented in detail in the [Hand Log Generation: Behavioral Notes](#hand-log-generation-behavioral-notes) section above.

### Event-Level Edge Cases

| Case | Affected Event | Description |
|---|---|---|
| Spectator mode | `EVT_DEAL` | `Player` field is `undefined`. No hero identification possible. |
| Table transfer | `EVT_DEAL` | `Player` exists but `HoleCards: []` (empty array). |
| Ante all-in | `EVT_ACTION` | Player consumed all chips on ante — no `EVT_ACTION` is emitted for this player. |
| Timeout / disconnect | `EVT_ACTION` | Explicit FOLD action may not be sent. Player is also absent from `EVT_HAND_RESULTS.Results[]`. |
| BB implicit bet | `EVT_ACTION` | When BB is ante-all-in, SB still receives `CALL bet=BB amount` (PokerChase treats BB bet as existing internally). |
| Community cards (street) | `EVT_DEAL_ROUND` | `CommunityCards` contains only newly dealt cards (FLOP: 3, TURN: 1, RIVER: 1), not cumulative. |
| Community cards (all-in) | `EVT_DEAL_ROUND` | After all-in, remaining streets may not emit `EVT_DEAL_ROUND`. Remaining cards appear in `EVT_HAND_RESULTS.CommunityCards`. |
| Community cards (merge) | `EVT_HAND_RESULTS` | `CommunityCards` contains only cards NOT previously dealt via `EVT_DEAL_ROUND`. Empty `[]` if all streets were dealt normally. Must merge with accumulated `EVT_DEAL_ROUND` cards to get the full board. |
| Chip values at deal | `EVT_DEAL` | `Player.Chip` and `Player.BetChip` are **post-ante/blind** values. Original chips = `Chip + BetChip + Ante` (but see short stack estimation below). |
| Short stack estimation | `EVT_DEAL` | For short-stacked players where ante alone causes all-in, `Chip + BetChip + Ante` overestimates. Use `Progress.Pot / activePlayerCount` for per-player ante estimation. |

### Schema-Level Notes

| Topic | Details |
|---|---|
| Passthrough mode | Zod schemas use `.passthrough()` — unknown API properties are preserved, not rejected. API field additions won't break parsing. |
| Timestamp source | `timestamp` field is added client-side by `web_accessible_resource.ts` (`Date.now()`), not from the server. Reflects WebSocket message receipt time. |
| Schema diff tool | `npm run schema-diff -- <file.ndjson>` runs strict validation to detect unknown properties (additions) or missing properties (breaking changes). |

### Unresolved Fields (`要調査`)

Fields observed in production data but not fully documented:

| Event | Field | Known Values | Notes |
|---|---|---|---|
| `EVT_DEAL` | `OtherPlayers[].Status` | 0, 1, 5 | Values 1 and 5 appear in <1% of events |
| `EVT_HAND_RESULTS` | `OtherPlayers[].Status` | 0–7 | 5=ELIMINATED known; 6, 7 undocumented |
| `EVT_PLAYER_SEAT_ASSIGNED` | `ProcessType` | 0–4 | Only 0 (initial seating) is documented |
| `EVT_SESSION_DETAILS` | `BlindStructures[].ActiveMinutes` | positive int, -1 | -1 = final blind level (no further increases) |
| `EVT_HAND_RESULTS` | `ResultType` | 0–4 | 0=normal, 2=table transfer, 3=break start, 4=table leave / no opponents |

### Processing Constraints

| Constraint | Details |
|---|---|
| EntityConverter single-pass | `convertEventsToEntities()` tracks hand boundaries via internal state. Must receive **all events in a single call** — splitting across chunks loses hands that span boundaries. |
| Duplicate detection | Events are keyed by `[timestamp+ApiTypeId]` compound key. Same timestamp + same ApiTypeId = duplicate. |
| Event ordering | Events arrive in guaranteed logical sequence per WebSocket connection, but connectivity losses can cause gaps. |
| Batch vs live mode | `service.setBatchMode(true)` disables real-time HUD updates during bulk imports. Must be reset after processing. |

### Export & Storage Limits

| Limit | Value | Context |
|---|---|---|
| Service Worker → content_script message | 64 MiB | Chrome's message passing limit. Large exports use chunked transfer. |
| Data URL download | ~2 MB | Fallback when no game tab is available. Blob-based download preferred. |
| IndexedDB per-origin | Browser-dependent | Typically 50%+ of available disk. No hard cap enforced by the extension. |

## Enum Reference

Complete enum definitions from `src/types/game.ts`. These values appear in raw NDJSON event data.

### ActionType

| Value | Name | Description |
|---|---|---|
| 0 | CHECK | Check (no bet) |
| 1 | BET | Open bet |
| 2 | FOLD | Fold hand |
| 3 | CALL | Call existing bet |
| 4 | RAISE | Raise existing bet |
| 5 | ALL_IN | All-in (normalized: stored as BET/CALL/RAISE in entity actions) |

### BattleType

| Value | Name | Description |
|---|---|---|
| 0 | SIT_AND_GO | Ranked SNG tournament |
| 1 | TOURNAMENT | MTT (multi-table tournament) |
| 2 | FRIEND_SIT_AND_GO | Friend match SNG |
| 4 | RING_GAME | Ring game (cash game) |
| 5 | FRIEND_RING_GAME | Private table ring game |
| 6 | CLUB_MATCH | Club match SNG |

> Note: Values 3 is unused (gap in numbering).

**Filter groupings** (from `BATTLE_TYPE_FILTERS`):
- SNG: 0, 2, 6
- MTT: 1
- Ring: 4, 5

### BetStatusType

| Value | Name | Description |
|---|---|---|
| -1 | HAND_ENDED | Hand complete |
| 0 | NOT_IN_PLAY | Not currently in play |
| 1 | BET_ABLE | Can act |
| 2 | FOLDED | Has folded |
| 3 | ALL_IN | Is all-in |
| 4 | ELIMINATED | Eliminated from tournament |

### PhaseType

| Value | Name | Description |
|---|---|---|
| 0 | PREFLOP | Pre-flop |
| 1 | FLOP | Flop |
| 2 | TURN | Turn |
| 3 | RIVER | River |
| 4 | SHOWDOWN | Extension (not from API — added by HUD for internal use) |

### RankType

| Value | Name | Description |
|---|---|---|
| 0 | ROYAL_FLUSH | Royal flush |
| 1 | STRAIGHT_FLUSH | Straight flush |
| 2 | FOUR_OF_A_KIND | Four of a kind |
| 3 | FULL_HOUSE | Full house |
| 4 | FLUSH | Flush |
| 5 | STRAIGHT | Straight |
| 6 | THREE_OF_A_KIND | Three of a kind |
| 7 | TWO_PAIR | Two pair |
| 8 | ONE_PAIR | One pair |
| 9 | HIGH_CARD | High card |
| 10 | NO_CALL | Won without call (unchallenged) |
| 11 | SHOWDOWN_MUCK | Showed down but mucked (lost) |
| 12 | FOLD_OPEN | Voluntarily showed cards after folding |

### Position

| Value | Name | Description |
|---|---|---|
| -2 | BB | Big blind |
| -1 | SB | Small blind |
| 0 | BTN | Button (dealer) |
| 1 | CO | Cutoff |
| 2 | HJ | Hijack |
| 3 | UTG | Under the gun |

### ActionDetail

Markers attached to entity `Action` records for statistics calculation. See `src/types/game.ts`.

| Value | Description |
|---|---|
| `ALL_IN` | All-in action marker |
| `VPIP` | Voluntary pot entry |
| `CBET` | Continuation bet executed |
| `CBET_CHANCE` | Continuation bet opportunity |
| `CBET_FOLD` | Folded to continuation bet |
| `CBET_FOLD_CHANCE` | Faced a continuation bet (fold opportunity) |
| `3BET` | 3-bet executed |
| `3BET_CHANCE` | 3-bet opportunity |
| `3BET_FOLD` | Folded to 3-bet |
| `3BET_FOLD_CHANCE` | Faced a 3-bet (fold opportunity) |
| `DONK_BET` | Donk bet executed |
| `DONK_BET_CHANCE` | Donk bet opportunity |
| `RIVER_CALL` | Called on the river |
| `RIVER_CALL_WON` | Called on the river and won |

## Code References

For implementation details:
- Type definitions: `src/types/api.ts`
- Entity types: `src/types/entities.ts`
- Game enums: `src/types/game.ts`
- Card utilities: `src/utils/card-utils.ts`
- Event processing: `src/streams/aggregate-events-stream.ts`
- Entity conversion: `src/entity-converter.ts`
- Validation examples: `src/app.test.ts`
- Schema validation tool: `npm run validate-schema`
- Schema diff tool: `npm run schema-diff`