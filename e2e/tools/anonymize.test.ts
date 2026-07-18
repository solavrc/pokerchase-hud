import { anonymizeEvents, syntheticPlayerName, SYNTHETIC_ID_BASE } from './anonymize'

describe('anonymizeEvents', () => {
  it('remaps UserId/UserName pairs deterministically and consistently across events', () => {
    const events = [
      {
        ApiTypeId: 313,
        TableUsers: [
          { UserId: 561384657, UserName: 'sola', Rank: { RankId: 'diamond' } },
          { UserId: 863459972, UserName: 'CM', Rank: { RankId: 'diamond' } },
        ],
        SeatUserIds: [-1, 561384657, 863459972, -1],
      },
      {
        ApiTypeId: 306,
        HandId: 1,
        Results: [
          { UserId: 561384657, RewardChip: 100 },
          { UserId: 863459972, RewardChip: 0 },
        ],
      },
    ]

    const [seatAssigned, handResults] = anonymizeEvents(events) as any[]

    // Same real UserId -> same synthetic id across both events.
    const solaId = seatAssigned.TableUsers[0].UserId
    const cmId = seatAssigned.TableUsers[1].UserId
    expect(solaId).toBe(SYNTHETIC_ID_BASE)
    expect(cmId).toBe(SYNTHETIC_ID_BASE + 1)
    expect(seatAssigned.TableUsers[0].UserName).toBe(syntheticPlayerName(solaId))
    expect(seatAssigned.TableUsers[1].UserName).toBe(syntheticPlayerName(cmId))

    // SeatUserIds: -1 (empty seat) left untouched, real ids remapped.
    expect(seatAssigned.SeatUserIds).toEqual([-1, solaId, cmId, -1])

    // Bare UserId (no sibling UserName) still remapped, using the same map.
    expect(handResults.Results[0].UserId).toBe(solaId)
    expect(handResults.Results[1].UserId).toBe(cmId)

    // No real ids/names survive.
    const serialized = JSON.stringify([seatAssigned, handResults])
    expect(serialized).not.toContain('561384657')
    expect(serialized).not.toContain('863459972')
    expect(serialized).not.toContain('sola')
    expect(serialized).not.toContain('CM')
  })

  it('does not mutate the input events', () => {
    const events = [{ ApiTypeId: 301, JoinUser: { UserId: 42, UserName: 'real-name' } }]
    const before = JSON.parse(JSON.stringify(events))
    anonymizeEvents(events)
    expect(events).toEqual(before)
  })

  it('reuses a caller-provided idMap across separate calls (stable ids per extraction run)', () => {
    const idMap = new Map<number, number>()
    const first = anonymizeEvents([{ UserId: 100, UserName: 'a' }], { idMap }) as any[]
    const second = anonymizeEvents([{ UserId: 100, UserName: 'a' }, { UserId: 200, UserName: 'b' }], { idMap }) as any[]

    expect(first[0].UserId).toBe(second[0].UserId)
    expect(second[1].UserId).toBe(first[0].UserId + 1)
  })

  it('leaves non-player numeric fields untouched', () => {
    const events = [{ ApiTypeId: 306, HandId: 258411144, Pot: 42700 }]
    const [result] = anonymizeEvents(events) as any[]
    expect(result.HandId).toBe(258411144)
    expect(result.Pot).toBe(42700)
  })
})
