# Contributing to PokerChase HUD

Thank you for your interest in contributing to PokerChase HUD! This guide will help you add new statistics to the HUD.

## 📊 Adding New Statistics

### Quick Start

1. Create a new file in `src/stats/core/` with kebab-case naming
2. Implement the `StatDefinition` interface
3. Export from `src/stats/core/index.ts`
4. Your statistic will be automatically registered!

### Example: Creating a Simple Statistic

```typescript
// src/stats/core/my-stat.ts
import type { StatDefinition } from '../../types/stats'
import { ActionDetail } from '../../types/game'
import { formatPercentage } from '../utils'

export const myNewStat: StatDefinition = {
  id: 'myNew',
  name: 'MN',
  description: 'My new statistic',
  
  // Detect when to flag actions
  detectActionDetails: (context) => {
    const details: ActionDetail[] = []
    
    // Your detection logic here
    if (/* condition for opportunity */) {
      details.push(ActionDetail.MY_OPPORTUNITY)  // Add to enum first
    }
    
    if (/* condition for occurrence */) {
      details.push(ActionDetail.MY_OCCURRENCE)  // Add to enum first
    }
    
    return details
  },
  
  // Calculate the statistic value
  calculate: ({ actions }) => {
    const opportunities = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.MY_OPPORTUNITY)
    ).length
    
    const occurrences = actions.filter(a => 
      a.actionDetails.includes(ActionDetail.MY_OCCURRENCE)
    ).length
    
    return [occurrences, opportunities]
  },
  
  // Format as percentage (optional)
  format: formatPercentage
}
```

### Understanding the Context

The `ActionDetailContext` provides information about each action:

```typescript
interface ActionDetailContext {
  playerId: number                    // Player taking action
  actionType: ActionType              // FOLD, CALL, RAISE, etc.
  phase: PhaseType                    // PREFLOP, FLOP, TURN, RIVER
  phasePlayerActionIndex: number      // Action order in phase (0-based)
  phasePrevBetCount: number          // Previous bet/raise count
  handState?: {
    cBetter?: number                // Who made continuation bet
    lastAggressor?: number          // Last player to bet/raise
    currentStreetAggressor?: number // Aggressor on current street
  }
}
```

### Key Concepts

#### phasePrevBetCount
- Tracks the number of bets/raises in the current phase
- PREFLOP starts at 1 (Big Blind counts as first bet)
- Examples:
  - `1` = Only BB posted, no raises yet
  - `2` = After first raise (2-bet)
  - `3` = After 3-bet
  - `4` = After 4-bet

#### phasePlayerActionIndex
- Player's action order in the current phase (0-based)
- Resets at the start of each street
- Example: BB acting first preflop has index 0

### Common Patterns

#### Percentage Statistics
Most statistics follow the pattern: `occurrences / opportunities * 100%`

```typescript
// VPIP - Voluntarily Put money In Pot
detectActionDetails: (context) => {
  // Count first CALL/RAISE in preflop as VPIP
  // Note: We can't distinguish BB/SB in current context
  if (context.phase === PhaseType.PREFLOP && 
      context.phasePlayerActionIndex === 0 &&
      [ActionType.CALL, ActionType.RAISE].includes(context.actionType)) {
    return [ActionDetail.VPIP]
  }
  return []
}
```

#### Aggression Statistics
```typescript
// 3-Bet Detection
detectActionDetails: (context) => {
  // phasePrevBetCount === 2 means facing a 2-bet
  if (context.phase === PhaseType.PREFLOP && 
      context.phasePrevBetCount === 2) {
    
    const details: ActionDetail[] = [ActionDetail.$3BET_CHANCE]
    
    if (context.actionType === ActionType.RAISE) {
      details.push(ActionDetail.$3BET)
    }
    
    return details
  }
  return []
}
```

### Testing Your Statistic

#### Unit Tests (Required)

All new statistics MUST include unit tests. Create a test file in the same directory as your statistic:

For examples, see existing test files:
- `src/stats/core/3bet.test.ts` - Testing statistics with detectActionDetails
- `src/stats/core/vpip.test.ts` - Testing VPIP detection logic
- `src/stats/core/pfr.test.ts` - Testing simple calculation statistics
- `src/stats/helpers.test.ts` - Testing helper functions

```typescript
// src/stats/core/my-stat.test.ts
import { myNewStat } from './my-stat'
import { ActionType, PhaseType, ActionDetail } from '../../types/game'
import type { ActionDetailContext } from '../../types/stats'

describe('myNewStat', () => {
  // Helper to create test context
  const createContext = (overrides: Partial<ActionDetailContext>): ActionDetailContext => ({
    playerId: 1,
    actionType: ActionType.CALL,
    phase: PhaseType.PREFLOP,
    phasePlayerActionIndex: 0,
    phasePrevBetCount: 1,
    ...overrides
  })

  describe('detectActionDetails', () => {
    it('should detect opportunity correctly', () => {
      const context = createContext({
        phasePrevBetCount: 2,
        actionType: ActionType.CALL
      })
      
      const details = myNewStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.MY_OPPORTUNITY)
    })

    it('should detect occurrence correctly', () => {
      const context = createContext({
        phasePrevBetCount: 2,
        actionType: ActionType.RAISE
      })
      
      const details = myNewStat.detectActionDetails!(context)
      expect(details).toContain(ActionDetail.MY_OPPORTUNITY)
      expect(details).toContain(ActionDetail.MY_OCCURRENCE)
    })
  })

  describe('calculate', () => {
    it('should calculate percentage correctly', () => {
      const mockActions = [
        { actionDetails: [ActionDetail.MY_OPPORTUNITY, ActionDetail.MY_OCCURRENCE] },
        { actionDetails: [ActionDetail.MY_OPPORTUNITY] },
        { actionDetails: [ActionDetail.MY_OPPORTUNITY, ActionDetail.MY_OCCURRENCE] },
      ]
      
      const result = myNewStat.calculate({ 
        actions: mockActions as any,
        hands: [],
        phases: []
      })
      
      expect(result).toEqual([2, 3])  // 2 occurrences out of 3 opportunities
    })
  })
})
```

Run tests with:
```bash
npm test -- my-stat.test.ts
```

#### Manual Testing

After unit tests pass:

1. Build the extension: `npm run build`
2. Load in Chrome: chrome://extensions/ → "Load unpacked"
3. Play some hands on PokerChase
4. Check the database in Chrome DevTools:

```javascript
// Open background page console
// View your statistic's action details
await db.actions.where('actionDetails').anyOf(['MY_OPPORTUNITY', 'MY_OCCURRENCE']).toArray()
```

### Debugging Tips

1. **Add logging to your detection logic:**
   ```typescript
   detectActionDetails: (context) => {
     console.log('[MyStat]', context)
     // ... your logic
   }
   ```

2. **Check if your statistic is registered:**
   ```javascript
   // In background console
   service.statsRegistry.getAll().map(s => s.id)
   ```

3. **Verify action details are saved:**
   ```javascript
   // Check recent actions
   await db.actions.reverse().limit(10).toArray()
   ```

### ActionDetail Flags

#### Existing Flags
These are the flags defined in the ActionDetail enum (`src/types/game.ts`):

- `ALL_IN` - All-in action
- `VPIP` - Voluntary pot investment
- `CBET` / `CBET_CHANCE` - Continuation betting
- `CBET_FOLD` / `CBET_FOLD_CHANCE` - Folding to continuation bet
- `$3BET` / `$3BET_CHANCE` - 3-betting (note the $ prefix)
- `$3BET_FOLD` / `$3BET_FOLD_CHANCE` - Folding to 3-bet
- `DONK_BET` / `DONK_BET_CHANCE` - Donk betting

#### Adding New Flags
To add new ActionDetail flags for your statistic:

1. Add your flags to the `ActionDetail` enum in `src/types/game.ts`:
```typescript
export enum ActionDetail {
  // ... existing flags
  MY_OPPORTUNITY = 'MY_OPPORTUNITY',
  MY_OCCURRENCE = 'MY_OCCURRENCE',
}
```

2. Use the enum values in your statistic:
```typescript
detectActionDetails: (context) => {
  if (/* your condition */) {
    return [ActionDetail.MY_OPPORTUNITY]
  }
  return []
}
```

Note: The system uses TypeScript enums for type safety, so new flags must be added to the enum before use.

### Need Help?

- Check existing statistics in `src/stats/core/` for examples
- Review the TypeScript types in `src/types/`
- Open an issue on GitHub for questions

## 📝 Code Style

- Use TypeScript strict mode
- Add Japanese comments for team members: `// 日本語でのコメント`
- Follow existing naming conventions
- Keep statistics focused on a single concept

## 🧪 Submitting Your Contribution

1. Fork the repository
2. Create a feature branch: `feature/stat-[name]`
3. Add your statistic following the guide above
4. **Write unit tests** in `src/stats/core/[stat-name].test.ts`
5. Ensure all tests pass: `npm test`
6. Test manually with real gameplay
7. Submit a pull request with:
   - Description of the statistic
   - Example scenarios where it applies
   - Test coverage for all edge cases
   - Any special considerations

### PR Checklist
- [ ] Statistic implementation in `src/stats/core/[stat-name].ts`
- [ ] Export added to `src/stats/core/index.ts`
- [ ] Unit tests in `src/stats/core/[stat-name].test.ts`
- [ ] All tests passing (`npm test`)
- [ ] Manual testing completed
- [ ] Documentation/comments in Japanese where appropriate

Happy coding! 🎉