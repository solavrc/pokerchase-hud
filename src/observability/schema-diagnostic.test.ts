import { buildSchemaDiagnostic } from './schema-diagnostic'

describe('schema repair diagnostics', () => {
  it('preserves poker semantics while pseudonymizing direct identifiers', () => {
    const payload = {
      ApiTypeId: 303,
      FriendId: 129532369,
      PlayerName: 'sensitive-player-name',
      SeatUserIds: [129532369, 99887766, -1],
      Enabled: true,
      BattleType: 4,
      HandId: 531064322,
      Game: {
        Ante: 100,
        SmallBlind: 200,
        BigBlind: 400
      },
      Progress: {
        Pot: 1800,
        NextActionTypes: [2, 3, 4, 5]
      },
      Results: [{
        UserId: 129532369,
        HoleCards: [8, 24],
        Ranking: 2,
        RewardChip: 0
      }],
      Nested: {
        Items: [
          { Amount: 100, Label: 'private-value' },
          { Amount: 2.5, Extra: null }
        ]
      },
      Message: {
        Ms: 'private chat text',
        Us: {
          Id: 99887766,
          Na: 'another sensitive player'
        }
      },
      AccessToken: 'secret-token',
      Class: {
        'user@example.com': 'dynamic-private-value'
      }
    }

    const diagnostic = buildSchemaDiagnostic(payload, [{
      path: ['ApiTypeId'],
      code: 'invalid_union'
    }])

    expect(diagnostic.payloadShape).toEqual(expect.arrayContaining([
      '$: object',
      'ApiTypeId: integer',
      'FriendId: integer',
      'PlayerName: string',
      'SeatUserIds: array',
      'Enabled: boolean',
      'Nested.Items: array',
      'Nested.Items[]: object',
      'Nested.Items[].Amount: integer',
      'Nested.Items[].Amount: number',
      'Nested.Items[].Extra: null',
      'Class.[dynamic-key]: string'
    ]))
    expect(diagnostic.issues).toEqual([{
      path: 'ApiTypeId',
      code: 'invalid_union',
      expected: undefined,
      actualType: 'integer'
    }])

    expect(diagnostic.sanitizedPayload).toMatchObject({
      ApiTypeId: 303,
      FriendId: 'user#1',
      PlayerName: 'player-name#1',
      SeatUserIds: ['user#1', 'user#2', -1],
      BattleType: 4,
      HandId: 531064322,
      Game: {
        Ante: 100,
        SmallBlind: 200,
        BigBlind: 400
      },
      Progress: {
        Pot: 1800,
        NextActionTypes: [2, 3, 4, 5]
      },
      Results: [{
        UserId: 'user#1',
        HoleCards: [8, 24],
        Ranking: 2,
        RewardChip: 0
      }],
      Nested: {
        Items: [
          {
            Amount: 100,
            Label: '[redacted-string:length=13]'
          },
          {
            Amount: 2.5,
            Extra: null
          }
        ]
      },
      Message: '[redacted-text]',
      AccessToken: '[redacted]'
    })
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain('129532369')
    expect(serialized).not.toContain('99887766')
    expect(serialized).not.toContain('sensitive-player-name')
    expect(serialized).not.toContain('private-value')
    expect(serialized).not.toContain('private chat text')
    expect(serialized).not.toContain('another sensitive player')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('user@example.com')
    expect(serialized).not.toContain('dynamic-private-value')
  })

  it('reports expected and actual types at a broken existing path', () => {
    const diagnostic = buildSchemaDiagnostic(
      {
        ApiTypeId: 1305,
        FriendId: 'redacted-at-source'
      },
      [{
        path: ['FriendId'],
        code: 'invalid_type',
        expected: 'number'
      }]
    )

    expect(diagnostic.issues).toEqual([{
      path: 'FriendId',
      code: 'invalid_type',
      expected: 'number',
      actualType: 'string'
    }])
    expect(diagnostic.sanitizedPayload).toEqual({
      ApiTypeId: 1305,
      FriendId: 'user#1'
    })
    expect(JSON.stringify(diagnostic)).not.toContain('redacted-at-source')
  })

  it('redacts dynamic map keys in validation issue paths', () => {
    const diagnostic = buildSchemaDiagnostic(
      {
        RingReward: {
          Class: {
            Alice: 'unexpected'
          }
        }
      },
      [{
        path: ['RingReward', 'Class', 'Alice'],
        code: 'invalid_type',
        expected: 'number'
      }]
    )

    expect(diagnostic.issues).toEqual([{
      path: 'RingReward.Class.[dynamic-key]',
      code: 'invalid_type',
      expected: 'number',
      actualType: 'string'
    }])
    expect(JSON.stringify(diagnostic)).not.toContain('Alice')
  })

  it('redacts unknown strings by default while retaining allow-listed protocol IDs', () => {
    const diagnostic = buildSchemaDiagnostic({
      ApiTypeId: 9999,
      Name: 'new player name',
      Biography: 'new free-form field',
      NewEnum: 'unexpected-private-value',
      ItemId: 'item0028',
      SettingDecoIds: ['deco0001', 'deco0002']
    }, [])

    expect(diagnostic.sanitizedPayload).toEqual({
      ApiTypeId: 9999,
      Name: 'player-name#1',
      Biography: '[redacted-text]',
      NewEnum: '[redacted-string:length=24]',
      ItemId: 'item0028',
      SettingDecoIds: ['deco0001', 'deco0002']
    })
    expect(JSON.stringify(diagnostic)).not.toContain('unexpected-private-value')
  })

  it('redacts identifier-sized unknown numbers while keeping poker state and event continuity', () => {
    const diagnostic = buildSchemaDiagnostic({
      ApiTypeId: 303,
      ProfileNo: 129532369,
      HandId: 531064322,
      RoomId: 123456789,
      timestamp: 1784560697458,
      NextBlindUnixSeconds: 1784560697,
      Chip: 25_000_000,
      SidePot: [12_000_000],
      SmallCounter: 1234567
    }, [])

    expect(diagnostic.sanitizedPayload).toEqual({
      ApiTypeId: 303,
      ProfileNo: '[redacted-number:digits=9]',
      HandId: 531064322,
      RoomId: 123456789,
      timestamp: 1784560697458,
      NextBlindUnixSeconds: 1784560697,
      Chip: 25_000_000,
      SidePot: [12_000_000],
      SmallCounter: 1234567
    })
    expect(JSON.stringify(diagnostic)).not.toContain('129532369')
  })
})
