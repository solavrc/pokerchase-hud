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

## Code References

For implementation details:
- Type definitions: `src/types/api.ts`
- Event processing: `src/streams/aggregate-events-stream.ts`
- Validation examples: `src/app.test.ts`
- Schema validation tool: `npm run validate-schema`