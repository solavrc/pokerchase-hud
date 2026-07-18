import {
  classifyTableSizeLayer,
  matchesTableSizeFilter,
  selectedTableSizeLayers,
  DEFAULT_TABLE_SIZE_FILTER,
  ALL_TABLE_SIZE_LAYERS,
  type TableSizeFilter
} from './table-size'

describe('classifyTableSizeLayer', () => {
  // 6-max table (seatUserIds.length === 6)
  it('classifies a 6-max hand with all 6 seats dealt as full', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4, 5, 6] })).toBe('full')
  })

  it('classifies a 6-max hand with 5 dealt (1 empty seat) as full', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4, 5, -1] })).toBe('full')
  })

  it('classifies a 6-max hand with 4 dealt as the 4p layer (excluded from full)', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4, -1, -1] })).toBe('4p')
  })

  it('classifies a 6-max hand with 3 dealt as the 3p layer', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, -1, -1, -1] })).toBe('3p')
  })

  it('classifies a 6-max hand with 2 dealt as the hu layer', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, -1, -1, -1, -1] })).toBe('hu')
  })

  it('returns null for a 6-max hand with only 1 dealt seat (degenerate)', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, -1, -1, -1, -1, -1] })).toBeNull()
  })

  // 4-max table (seatUserIds.length === 4) -- '4p' does not exist at this table size,
  // a 4-max hand with all 4 dealt IS the full layer.
  it('classifies a 4-max hand with all 4 seats dealt as full', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4] })).toBe('full')
  })

  it('classifies a 4-max hand with 3 dealt as the 3p layer (excluded from full)', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, -1] })).toBe('3p')
  })

  it('classifies a 4-max hand with 2 dealt as the hu layer', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, -1, -1] })).toBe('hu')
  })

  it('returns null for an unexpected table size (not 4 or 6)', () => {
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3] })).toBeNull()
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4, 5] })).toBeNull()
    expect(classifyTableSizeLayer({ seatUserIds: [1, 2, 3, 4, 5, 6, 7] })).toBeNull()
  })
})

describe('selectedTableSizeLayers', () => {
  it('returns undefined (no filtering) when every layer is selected -- the default', () => {
    expect(selectedTableSizeLayers(DEFAULT_TABLE_SIZE_FILTER)).toBeUndefined()
  })

  it('returns undefined (no filtering) when nothing is selected, mirroring gameTypes convention', () => {
    const none: TableSizeFilter = { full: false, '4p': false, '3p': false, hu: false }
    expect(selectedTableSizeLayers(none)).toBeUndefined()
  })

  it('returns the exact selected subset when 1-3 layers are checked', () => {
    const huOnly: TableSizeFilter = { full: false, '4p': false, '3p': false, hu: true }
    expect(selectedTableSizeLayers(huOnly)).toEqual(['hu'])

    const fullAnd4p: TableSizeFilter = { full: true, '4p': true, '3p': false, hu: false }
    expect(selectedTableSizeLayers(fullAnd4p)).toEqual(['full', '4p'])
  })

  it('returns the subset in ALL_TABLE_SIZE_LAYERS order, not object key insertion order', () => {
    const filter: TableSizeFilter = { hu: true, full: false, '4p': false, '3p': true }
    expect(selectedTableSizeLayers(filter)).toEqual(['3p', 'hu'])
  })
})

describe('matchesTableSizeFilter', () => {
  it('matches every hand (including unclassifiable ones) when layers is undefined', () => {
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4, 5, 6] }, undefined)).toBe(true)
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3] }, undefined)).toBe(true) // unclassifiable table size
  })

  it('matches only hands whose layer is in the selected list', () => {
    const layers = ['hu' as const]
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, -1, -1, -1, -1] }, layers)).toBe(true) // hu
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4, 5, 6] }, layers)).toBe(false) // full
  })

  it('excludes unclassifiable hands when a filter is active', () => {
    const layers = ALL_TABLE_SIZE_LAYERS.slice() as any
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3] }, layers)).toBe(false)
  })

  it('6-max vs 4-max relative rule: same dealt count (4), different table size, different layer match', () => {
    const fourPOnly = ['4p' as const]
    // 6-max, 4 dealt -> '4p' layer -> matches
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4, -1, -1] }, fourPOnly)).toBe(true)
    // 4-max, 4 dealt -> 'full' layer (4p doesn't exist at 4-max) -> does not match '4p' filter
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4] }, fourPOnly)).toBe(false)

    const fullOnly = ['full' as const]
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4] }, fullOnly)).toBe(true) // 4-max full
    expect(matchesTableSizeFilter({ seatUserIds: [1, 2, 3, 4, -1, -1] }, fullOnly)).toBe(false) // 6-max 4p, not full
  })
})
