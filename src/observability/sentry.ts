import * as Sentry from '@sentry/browser'
import type { ErrorEvent } from '@sentry/browser'
import manifest from '../../manifest.json'

export type SentryRuntime = 'background' | 'content_script' | 'popup'

export interface SchemaValidationIssue {
  path: string
  code: string
}

export interface CaptureErrorOptions {
  operation: string
  errorType?: string
}

const SENTRY_DSN =
  'https://7a6e9be8cb1bdaab2ec2b9ba0565ad93@o4507260715794432.ingest.us.sentry.io/4511816450637824'
const SENTRY_RELEASE = `pokerchase-hud@${manifest.version}`
const SAFE_TAGS = new Set([
  'api_type_id',
  'error_type',
  'event_kind',
  'extension_version',
  'operation',
  'runtime'
])
const MAX_TEXT_LENGTH = 500
const MAX_EVENTS_PER_RUNTIME = 20
const reportedSchemaApiTypes = new Set<number>()
const reportedErrors = new WeakSet<Error>()

let initialized = false
let sentEventCount = 0

const telemetryEnabled = (): boolean =>
  process.env.SENTRY_ENABLED === 'true'

const stripUrlDetails = (value: string): string =>
  value.replace(
    /(https?:\/\/[^\s?#"'<>]+)(?:[?#][^\s"'<>]*)?/gi,
    '$1?[redacted]'
  )

export const sanitizeTelemetryText = (value: string): string => {
  const sanitized = stripUrlDetails(value)
    .replace(/\b[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\b/gi, '[redacted-id]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\bBearer\s+[A-Z0-9._~+/=-]+\b/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+\b/gi, '[redacted-token]')
    .replace(/\b\d{8,18}\b/g, '[redacted-id]')

  return sanitized.length > MAX_TEXT_LENGTH
    ? `${sanitized.slice(0, MAX_TEXT_LENGTH)}…`
    : sanitized
}

const sanitizeFrameUrl = (value: string | undefined): string | undefined => {
  if (!value) return value
  return stripUrlDetails(value)
}

/**
 * Final privacy boundary for every Sentry event.
 *
 * PokerChase payloads can contain player names, user IDs, auth state, and
 * complete hand histories. Those values are useful in the local Raw Event
 * Lake, but must never leave the extension as telemetry. Keep only the stack,
 * a small allow-list of developer-controlled tags, and schema paths/codes.
 */
export const sanitizeSentryEvent = (event: ErrorEvent): ErrorEvent => {
  const sanitized: ErrorEvent = {
    ...event,
    // Supplying an explicit non-routable address prevents Sentry ingest from
    // deriving city/region metadata from the transport IP. The project-level
    // IP scrubber removes this placeholder before storage.
    user: { ip_address: '0.0.0.0' },
    request: undefined,
    breadcrumbs: undefined,
    extra: undefined,
    transaction: undefined,
    server_name: undefined
  }

  if (sanitized.message) {
    sanitized.message = sanitizeTelemetryText(sanitized.message)
  }

  if (sanitized.logentry) {
    sanitized.logentry = {
      ...sanitized.logentry,
      message: sanitized.logentry.message
        ? sanitizeTelemetryText(sanitized.logentry.message)
        : undefined,
      params: undefined
    }
  }

  if (sanitized.exception?.values) {
    sanitized.message = undefined
    sanitized.logentry = undefined
    sanitized.exception = {
      ...sanitized.exception,
      values: sanitized.exception.values.map(exception => ({
        type: exception.type
          ? sanitizeTelemetryText(exception.type)
          : 'Error',
        // Exception messages are intentionally discarded, not merely
        // regex-scrubbed: an arbitrary thrown string can contain a player
        // name or hand payload that cannot be recognized reliably.
        value: 'Captured exception',
        mechanism: exception.mechanism
          ? {
              type: exception.mechanism.type,
              handled: exception.mechanism.handled,
              synthetic: exception.mechanism.synthetic
            }
          : undefined,
        stacktrace: exception.stacktrace
          ? {
              ...exception.stacktrace,
              frames: exception.stacktrace.frames?.map(frame => ({
                ...frame,
                filename: sanitizeFrameUrl(frame.filename),
                abs_path: sanitizeFrameUrl(frame.abs_path),
                context_line: undefined,
                pre_context: undefined,
                post_context: undefined,
                vars: undefined
              }))
            }
          : undefined
      }))
    }
  }

  sanitized.tags = Object.fromEntries(
    Object.entries(sanitized.tags ?? {})
      .filter(([key]) => SAFE_TAGS.has(key))
      .map(([key, value]) => [key, sanitizeTelemetryText(String(value))])
  )

  const schemaValidation = sanitized.contexts?.schema_validation
  sanitized.contexts = schemaValidation
    ? { schema_validation: schemaValidation }
    : undefined

  return sanitized
}

export const initSentry = (runtime: SentryRuntime): void => {
  if (!telemetryEnabled() || initialized) return

  Sentry.init({
    dsn: SENTRY_DSN,
    release: SENTRY_RELEASE,
    environment: 'production',
    skipBrowserExtensionCheck: true,
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration({
        onerror: true,
        onunhandledrejection: true
      }),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration()
    ],
    attachStacktrace: true,
    maxBreadcrumbs: 0,
    sampleRate: 1,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: false,
        response: false
      },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: {
        document: false,
        variables: false
      },
      genAI: {
        inputs: false,
        outputs: false
      },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0
    },
    transportOptions: {
      fetchOptions: {
        keepalive: true
      }
    },
    initialScope: {
      tags: {
        runtime,
        extension_version: manifest.version
      }
    },
    beforeSend: event => {
      if (sentEventCount >= MAX_EVENTS_PER_RUNTIME) return null
      sentEventCount += 1
      return sanitizeSentryEvent(event)
    }
  })

  initialized = true
}

export const captureHandledException = (
  error: unknown,
  options: CaptureErrorOptions
): void => {
  if (!initialized) return

  const normalizedError = error instanceof Error
    ? error
    : new Error('Non-Error exception')

  if (reportedErrors.has(normalizedError)) return
  reportedErrors.add(normalizedError)

  Sentry.withScope(scope => {
    scope.setTag('operation', sanitizeTelemetryText(options.operation))
    if (options.errorType) {
      scope.setTag('error_type', sanitizeTelemetryText(options.errorType))
    }
    Sentry.captureException(normalizedError)
  })
}

/**
 * Report a destructive API schema mismatch once per ApiTypeId for the current
 * extension runtime. Raw event JSON and validation values are intentionally
 * excluded; only Zod issue paths and codes are sent.
 */
export const captureSchemaValidationFailure = (
  apiTypeId: number,
  issues: readonly SchemaValidationIssue[]
): void => {
  if (!initialized || reportedSchemaApiTypes.has(apiTypeId)) return
  reportedSchemaApiTypes.add(apiTypeId)

  const safeIssues = issues.slice(0, 10).map(issue => ({
    path: sanitizeTelemetryText(issue.path),
    code: sanitizeTelemetryText(issue.code)
  }))

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setFingerprint(['schema-validation', String(apiTypeId)])
    scope.setTags({
      event_kind: 'schema_validation_failure',
      api_type_id: String(apiTypeId)
    })
    scope.setContext('schema_validation', {
      issue_count: issues.length,
      paths: safeIssues.map(issue => issue.path).join(','),
      codes: [...new Set(safeIssues.map(issue => issue.code))].join(',')
    })
    Sentry.captureMessage('PokerChase API schema validation failed')
  })
}
