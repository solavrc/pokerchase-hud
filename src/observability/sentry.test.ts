import type { ErrorEvent } from '@sentry/browser'
import {
  sanitizeSentryEvent,
  sanitizeTelemetryText
} from './sentry'

describe('Sentry privacy boundary', () => {
  it('redacts identifiers, credentials, emails, and URL details', () => {
    const input =
      'user@example.com Bearer abc.def token eyJabc.def.ghi ' +
      'FriendId 129532369 https://example.com/path?uid=123#secret'

    expect(sanitizeTelemetryText(input)).toBe(
      '[redacted-email] Bearer [redacted] token [redacted-token] ' +
      'FriendId [redacted-id] https://example.com/path?[redacted]'
    )
  })

  it('drops payload-bearing fields and keeps only allow-listed metadata', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: 'Failed for player 129532369',
      user: { id: 'user-1', email: 'user@example.com' },
      request: {
        url: 'https://game.poker-chase.com/?token=secret',
        data: { rawEvent: true }
      },
      breadcrumbs: [{ message: 'raw hand history' }],
      extra: { rawEvent: { PlayerName: 'secret' } },
      transaction: 'https://game.poker-chase.com/table/secret',
      tags: {
        runtime: 'background',
        extension_version: '5.3.1',
        player_name: 'secret'
      },
      contexts: {
        schema_validation: {
          issue_count: 1,
          paths: 'Results.0.Ranking',
          codes: 'invalid_type'
        },
        device: {
          name: 'personal-device'
        }
      },
      exception: {
        values: [{
          type: 'Error',
          value: 'UID 129532369 at https://example.com/path?uid=129532369',
          stacktrace: {
            frames: [{
              filename: 'https://example.com/app.js?uid=129532369',
              abs_path: 'https://example.com/app.js#secret',
              context_line: 'const rawEvent = secret',
              pre_context: ['secret'],
              post_context: ['secret'],
              vars: { player: 'secret' }
            }]
          }
        }]
      }
    }

    const sanitized = sanitizeSentryEvent(event)

    expect(sanitized.user).toEqual({ ip_address: '0.0.0.0' })
    expect(sanitized.request).toBeUndefined()
    expect(sanitized.breadcrumbs).toBeUndefined()
    expect(sanitized.extra).toBeUndefined()
    expect(sanitized.transaction).toBeUndefined()
    expect(sanitized.tags).toEqual({
      runtime: 'background',
      extension_version: '5.3.1'
    })
    expect(sanitized.contexts).toEqual({
      schema_validation: {
        issue_count: 1,
        paths: 'Results.0.Ranking',
        codes: 'invalid_type'
      }
    })
    expect(sanitized.message).toBeUndefined()
    expect(sanitized.exception?.values?.[0]?.value).toBe(
      'Captured exception'
    )
    expect(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: 'https://example.com/app.js?[redacted]',
      abs_path: 'https://example.com/app.js?[redacted]',
      context_line: undefined,
      pre_context: undefined,
      post_context: undefined,
      vars: undefined
    })
  })
})
