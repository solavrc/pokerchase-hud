import * as Sentry from '@sentry/browser'
import type { ErrorEvent } from '@sentry/browser'
import manifest from '../../manifest.json'
import type { SchemaDiagnostic } from './schema-diagnostic'
import {
  SENTRY_TELEMETRY_CONSENT_STORAGE_KEY,
  SENTRY_TELEMETRY_ENABLED_MESSAGE,
  SENTRY_TELEMETRY_REVOKED_MESSAGE,
  SENTRY_TELEMETRY_STATUS_MESSAGE,
  clearSentryTelemetryConsent,
  hasSentryHostPermission,
  initializeSentryTelemetryConsentBridge,
  readSentryTelemetryEnabled,
  readSentryTelemetryConsent,
  readSentryTelemetryConsentState,
  registerSentryPermissionRevocationSync
} from './telemetry-consent'

export type SentryRuntime = 'background' | 'content_script' | 'popup'

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
const MAX_BUFFERED_BOOTSTRAP_ERRORS = 5

let initialized = false
let configuredRuntime: SentryRuntime | undefined
let consentListenerRegistered = false
let contentRevocationListenerRegistered = false
let backgroundConsentListenerRegistered = false
let initializationPromise: Promise<void> | undefined
let shutdownPromise: Promise<void> | undefined
let initializationGeneration = 0
let directRevocationPending = false
let sentEventCount = 0
let bootstrapErrorBuffer: BootstrapErrorBuffer | undefined

interface BootstrapErrorBuffer {
  runtime: SentryRuntime
  errors: unknown[]
  dispose: () => void
}

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
 * complete hand histories. General error telemetry keeps only the stack and a
 * small allow-list of developer-controlled tags. Schema-validation telemetry
 * may additionally contain a client-sanitized semantic event snapshot built by
 * schema-diagnostic.ts; direct identifiers and free text have already been
 * removed before this final boundary runs.
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

const closeSentry = async (): Promise<void> => {
  if (shutdownPromise) {
    await shutdownPromise
    return
  }
  if (!initialized) return
  initialized = false
  sentEventCount = 0
  reportedSchemaApiTypes.clear()
  const shutdown = Sentry.close(0).then(() => undefined)
  shutdownPromise = shutdown
  try {
    await shutdown
  } finally {
    if (shutdownPromise === shutdown) {
      shutdownPromise = undefined
    }
  }
}

const createBootstrapErrorBuffer = (
  runtime: SentryRuntime
): BootstrapErrorBuffer | undefined => {
  if (typeof globalThis.addEventListener !== 'function') {
    return undefined
  }

  const errors: unknown[] = []
  const remember = (error: unknown): void => {
    if (!initialized && errors.length < MAX_BUFFERED_BOOTSTRAP_ERRORS) {
      errors.push(error)
    }
  }
  const onError = (event: Event): void => {
    const errorEvent = event as globalThis.ErrorEvent
    remember(errorEvent.error ?? new Error(`${runtime} bootstrap error`))
  }
  const onUnhandledRejection = (event: Event): void => {
    const rejectionEvent = event as PromiseRejectionEvent
    remember(rejectionEvent.reason)
  }

  globalThis.addEventListener('error', onError)
  globalThis.addEventListener('unhandledrejection', onUnhandledRejection)

  return {
    runtime,
    errors,
    dispose: () => {
      globalThis.removeEventListener('error', onError)
      globalThis.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }
}

const flushBootstrapErrors = (buffer: BootstrapErrorBuffer | undefined): void => {
  buffer?.dispose()
  if (!initialized || !buffer) return

  for (const error of buffer.errors) {
    captureHandledException(error, {
      operation: `${buffer.runtime}.bootstrap`
    })
  }
}

const discardBootstrapErrors = (): void => {
  bootstrapErrorBuffer?.dispose()
  bootstrapErrorBuffer = undefined
}

type SentryStartResult = 'started' | 'disabled' | 'waiting_for_consent_mirror'

const startSentry = async (
  runtime: SentryRuntime,
  generation: number
): Promise<SentryStartResult> => {
  if (shutdownPromise) {
    await shutdownPromise
  }
  if (!telemetryEnabled() || initialized) return 'disabled'
  const consentState = await readSentryTelemetryConsentState(runtime)
  if (consentState !== true) {
    return runtime === 'content_script' && consentState === undefined
      ? 'waiting_for_consent_mirror'
      : 'disabled'
  }
  if (!await hasSentryHostPermission(runtime)) {
    await clearSentryTelemetryConsent()
    return 'disabled'
  }
  // Consent may be revoked while the async permission check is in flight.
  // Re-read immediately before the synchronous SDK initialization so a stale
  // startup cannot resurrect telemetry after storage.onChanged closed it.
  if (!await readSentryTelemetryConsent(runtime)) return 'disabled'
  if (generation !== initializationGeneration) return 'disabled'

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
    // Client-report envelopes bypass beforeSend. Disable them so the privacy
    // sanitizer and hard per-runtime event budget cover every SDK envelope.
    sendClientReports: false,
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
  return 'started'
}

/**
 * Start telemetry only after an explicit, per-profile opt-in has granted the
 * optional Sentry host permission. Adding that host as a required permission
 * would disable existing Web Store installations during the update.
 */
export const initSentry = (runtime: SentryRuntime): Promise<void> => {
  configuredRuntime = runtime
  registerSentryPermissionRevocationSync()
  if (
    runtime === 'background' &&
    !backgroundConsentListenerRegistered
  ) {
    backgroundConsentListenerRegistered = true
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { type?: unknown }).type !==
          SENTRY_TELEMETRY_STATUS_MESSAGE
      ) {
        return false
      }
      void readSentryTelemetryEnabled()
        .then(enabled => {
          sendResponse?.({ sentryTelemetryEnabled: enabled })
        })
        .catch(() => {
          sendResponse?.({ sentryTelemetryEnabled: false })
        })
      return true
    })
  }
  if (
    runtime === 'content_script' &&
    !contentRevocationListenerRegistered
  ) {
    contentRevocationListenerRegistered = true
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        !message ||
        typeof message !== 'object'
      ) {
        return false
      }
      const type = (message as { type?: unknown }).type
      if (type === SENTRY_TELEMETRY_REVOKED_MESSAGE) {
        directRevocationPending = true
        initializationGeneration += 1
        discardBootstrapErrors()
        void closeSentry()
          .then(() => {
            sendResponse?.({ sentryTelemetryStateApplied: type })
          })
          .catch(() => {
            sendResponse?.({ sentryTelemetryStateFailed: type })
          })
        return true
      } else if (type === SENTRY_TELEMETRY_ENABLED_MESSAGE) {
        directRevocationPending = false
        const pendingTransition =
          initializationPromise ?? shutdownPromise ?? Promise.resolve()
        void pendingTransition
          .catch(() => undefined)
          .then(async () => {
            if (
              configuredRuntime &&
              !initialized &&
              !directRevocationPending
            ) {
              await initSentry(configuredRuntime)
            }
            sendResponse?.(initialized
              ? { sentryTelemetryStateApplied: type }
              : { sentryTelemetryStateFailed: type })
          })
          .catch(() => {
            sendResponse?.({ sentryTelemetryStateFailed: type })
          })
        return true
      }
      return false
    })
  }
  if (runtime === 'background') {
    void initializeSentryTelemetryConsentBridge().catch(() => {
      console.warn('[Sentry] Failed to initialize the consent mirror')
    })
  }

  if (!consentListenerRegistered) {
    consentListenerRegistered = true
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const consentArea = runtime === 'content_script' ? 'session' : 'local'
      if (
        areaName !== consentArea ||
        !(SENTRY_TELEMETRY_CONSENT_STORAGE_KEY in changes)
      ) {
        return
      }

      if (changes[SENTRY_TELEMETRY_CONSENT_STORAGE_KEY]?.newValue === true) {
        if (
          runtime === 'content_script' &&
          directRevocationPending
        ) {
          return
        }
        const pendingInitialization = initializationPromise
        void (pendingInitialization ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => {
            // storage.onChanged normally follows the commit. Deferring also
            // makes the ordering explicit for callback-style implementations
            // and prevents a concurrent initial read from consuming the wake.
            if (configuredRuntime && !initialized) {
              void initSentry(configuredRuntime)
            }
          })
      } else {
        initializationGeneration += 1
        discardBootstrapErrors()
        void closeSentry()
      }
    })
  }

  if (initializationPromise) return initializationPromise
  bootstrapErrorBuffer ??= createBootstrapErrorBuffer(runtime)
  const generation = initializationGeneration
  initializationPromise = startSentry(runtime, generation)
    .then(result => {
      if (result === 'waiting_for_consent_mirror') return
      const completedBuffer = bootstrapErrorBuffer
      bootstrapErrorBuffer = undefined
      flushBootstrapErrors(completedBuffer)
    })
    .catch(error => {
      discardBootstrapErrors()
      throw error
    })
    .finally(() => {
      initializationPromise = undefined
    })
  return initializationPromise
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
 * extension runtime. The attached event is not the exact raw event: the
 * extension pseudonymizes account identifiers and removes names, chat text,
 * credentials, and dynamic keys before it reaches the Sentry SDK.
 */
export const captureSchemaValidationFailure = (
  apiTypeId: number,
  buildDiagnostic: () => SchemaDiagnostic
): void => {
  if (
    !initialized ||
    sentEventCount >= MAX_EVENTS_PER_RUNTIME ||
    reportedSchemaApiTypes.has(apiTypeId)
  ) return
  const diagnostic = buildDiagnostic()
  reportedSchemaApiTypes.add(apiTypeId)

  const safeIssues = diagnostic.issues.slice(0, 10).map(issue => ({
    path: sanitizeTelemetryText(issue.path),
    code: sanitizeTelemetryText(issue.code),
    expected: issue.expected
      ? sanitizeTelemetryText(issue.expected)
      : 'unknown',
    actualType: sanitizeTelemetryText(issue.actualType)
  }))
  const safeShape = diagnostic.payloadShape
    .slice(0, 100)
    .map(sanitizeTelemetryText)
  const sanitizedEventJson = JSON.stringify(diagnostic.sanitizedPayload)

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setFingerprint(['schema-validation', String(apiTypeId)])
    scope.setTags({
      event_kind: 'schema_validation_failure',
      api_type_id: String(apiTypeId)
    })
    scope.setContext('schema_validation', {
      issue_count: diagnostic.issues.length,
      paths: safeIssues.map(issue => issue.path).join(','),
      codes: [...new Set(safeIssues.map(issue => issue.code))].join(','),
      issues: safeIssues.map(issue =>
        `${issue.path} | ${issue.code} | expected=${issue.expected} | actual=${issue.actualType}`
      ).join('\n'),
      payload_shape: safeShape.join('\n'),
      shape_truncated:
        diagnostic.shapeTruncated || diagnostic.payloadShape.length > 100,
      sanitized_event_json: sanitizedEventJson,
      payload_truncated: diagnostic.payloadTruncated
    })
    Sentry.captureMessage('PokerChase API schema validation failed')
  })
}
