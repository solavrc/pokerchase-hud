import * as z from 'zod'
import { apiEventSchemas } from '../types/api'

export interface SchemaIssueLike {
  path: readonly PropertyKey[]
  code: string
  expected?: unknown
}

export interface SchemaValidationIssue {
  path: string
  code: string
  expected?: string
  actualType: string
}

export interface SchemaDiagnostic {
  issues: SchemaValidationIssue[]
  payloadShape: string[]
  sanitizedPayload: unknown
  shapeTruncated: boolean
  payloadTruncated: boolean
}

const MAX_DEPTH = 6
const MAX_SHAPE_ENTRIES = 100
const MAX_OBJECT_KEYS = 40
const MAX_ARRAY_SAMPLES = 3
const MAX_PAYLOAD_DEPTH = 10
const MAX_PAYLOAD_NODES = 2000
const MAX_PAYLOAD_OBJECT_KEYS = 80
const MAX_PAYLOAD_ARRAY_ENTRIES = 50
const MAX_PAYLOAD_STRING_LENGTH = 2000
const SAFE_SCHEMA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const MAP_VALUE_CONTAINER = '[map-value]'
// Build the allow-list from the current Zod protocol itself. A known
// container name is not enough: if a future payload changes Player from its
// fixed object shape to { Alice: ... }, Alice must still be treated as a
// user-controlled map key. ZodRecord is deliberately not traversed.
const buildKnownSchemaFields = (): {
  byContainer: Map<string, Set<string>>
  all: Set<string>
} => {
  const byContainer = new Map<string, Set<string>>()
  const all = new Set<string>()

  const visit = (schema: unknown, container?: string): void => {
    if (
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodDefault
    ) {
      visit(schema.unwrap(), container)
      return
    }
    if (schema instanceof z.ZodArray) {
      visit(schema.element, container)
      return
    }
    if (schema instanceof z.ZodUnion) {
      for (const option of schema.options) visit(option, container)
      return
    }
    if (!(schema instanceof z.ZodObject)) return

    const fields = Object.keys(schema.shape)
    if (container) {
      const known = byContainer.get(container) ?? new Set<string>()
      for (const field of fields) known.add(field)
      byContainer.set(container, known)
    }
    for (const [field, child] of Object.entries(schema.shape)) {
      all.add(field)
      visit(child, field)
    }
  }

  for (const schema of Object.values(apiEventSchemas)) {
    visit(schema)
  }
  return { byContainer, all }
}

const KNOWN_SCHEMA_FIELDS = buildKnownSchemaFields()
const USER_IDENTIFIER_KEY =
  /(?:user|friend|player|account|member|owner|device)[A-Za-z0-9_]*Ids?$/i
const USER_NAME_KEY =
  /(?:name|nickname)$/i
const SECRET_KEY =
  /(?:token|secret|password|authorization|cookie|sessionId|email|ipAddress|accessKey|phone|address)/i
const FREE_TEXT_KEY =
  /(?:biography|body|chat|comment|content|description|handLog|message|text)/i
const COMPACT_FREE_TEXT_KEYS = new Set(['Ms'])
const SAFE_SEMANTIC_STRING_KEY =
  /^(?:CharaId|ClassLvId|Co|CostumeId|DecoId|EmblemId|FavoriteCharaId|Fr|ItemId|RankId|RankLvId|SettingDecoIds|StampId)$/i
const SAFE_LARGE_NUMERIC_KEY =
  /^(?:ApiTypeId|HandId|RoomId|TableId|timestamp|.*(?:BetChip|Blind|BlindLv|Chip|Pot|UnixSeconds))$/i
const IDENTIFIER_SIZED_NUMBER_MIN = 10_000_000

const jsonType = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'number(non-finite)'
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  return typeof value
}

const safeSchemaKey = (
  key: PropertyKey,
  parentKey?: string
): string => {
  if (typeof key !== 'string' || !SAFE_SCHEMA_KEY.test(key)) {
    return '[dynamic-key]'
  }
  if (parentKey === MAP_VALUE_CONTAINER) {
    // The map key itself was already replaced with [dynamic-key]. Nested map
    // values may themselves contain user-controlled keys, so retain only
    // field names already present somewhere in the bundled protocol.
    return KNOWN_SCHEMA_FIELDS.all.has(key) ? key : '[dynamic-key]'
  }
  if (
    parentKey &&
    !KNOWN_SCHEMA_FIELDS.byContainer.get(parentKey)?.has(key)
  ) {
    return '[dynamic-key]'
  }
  // `parentKey === undefined` is the API event root: its property names are
  // server protocol fields needed to define a new event schema, not entries
  // in a user-keyed map. Their values still pass through the independent
  // identifier/free-text/secret sanitizer below.
  return key
}

const appendPath = (base: string, key: string): string => {
  if (key === '[]') return `${base}[]`
  return base === '$' ? key : `${base}.${key}`
}

const formatIssuePath = (path: readonly PropertyKey[]): string => {
  if (path.length === 0) return '$'

  let result = ''
  let parentKey: string | undefined
  for (const part of path) {
    if (typeof part === 'number') {
      result = `${result}[]`
      continue
    }
    const key = safeSchemaKey(part, parentKey)
    result = result ? `${result}.${key}` : key
    parentKey = key === '[dynamic-key]'
      ? MAP_VALUE_CONTAINER
      : typeof part === 'string' ? part : undefined
  }
  return result
}

const valueAtPath = (
  payload: unknown,
  path: readonly PropertyKey[]
): unknown => {
  let current = payload
  for (const part of path) {
    if (
      current === null ||
      (typeof current !== 'object' && typeof current !== 'function')
    ) {
      return undefined
    }
    current = (current as Record<PropertyKey, unknown>)[part]
  }
  return current
}

const sanitizeStringValue = (value: string): string => {
  const sanitized = value
    .replace(
      /(https?:\/\/[^\s?#"'<>]+)(?:[?#][^\s"'<>]*)?/gi,
      '$1?[redacted]'
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[redacted-email]'
    )
    .replace(
      /\bBearer\s+[A-Z0-9._~+/=-]+\b/gi,
      'Bearer [redacted]'
    )
    .replace(
      /\beyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+\b/gi,
      '[redacted-token]'
    )

  return sanitized.length > MAX_PAYLOAD_STRING_LENGTH
    ? `${sanitized.slice(0, MAX_PAYLOAD_STRING_LENGTH)}…`
    : sanitized
}

/**
 * Keep poker semantics while removing direct identifiers before Sentry sees
 * the event. Aliases are stable within one event so relationships such as
 * SeatUserIds -> Results[].UserId remain inspectable.
 */
const buildSanitizedPayload = (
  payload: unknown
): { value: unknown, truncated: boolean } => {
  const userAliases = new Map<string, string>()
  const nameAliases = new Map<string, string>()
  let nodeCount = 0
  let truncated = false

  const alias = (
    value: unknown,
    aliases: Map<string, string>,
    prefix: string
  ): unknown => {
    // Negative/zero values are protocol sentinels (for example an empty seat),
    // not PokerChase account identifiers.
    if (typeof value === 'number' && value <= 0) return value
    if (value === null || value === undefined) return value

    const key = `${typeof value}:${String(value)}`
    const existing = aliases.get(key)
    if (existing) return existing
    const next = `${prefix}#${aliases.size + 1}`
    aliases.set(key, next)
    return next
  }

  const visit = (
    value: unknown,
    depth: number,
    rawKey?: string,
    parentKey?: string
  ): unknown => {
    nodeCount += 1
    if (nodeCount > MAX_PAYLOAD_NODES) {
      truncated = true
      return '[truncated]'
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
      truncated = true
      return '[truncated]'
    }

    const isCompactUserId =
      (rawKey === 'Id' && parentKey === 'Us') ||
      rawKey === 'Uid' ||
      rawKey === 'UID'
    const isCompactUserName =
      rawKey === 'Na' && parentKey === 'Us'
    const isUserIdentifier =
      Boolean(rawKey && USER_IDENTIFIER_KEY.test(rawKey)) ||
      isCompactUserId
    const isUserName =
      Boolean(rawKey && USER_NAME_KEY.test(rawKey)) ||
      isCompactUserName

    if (isUserIdentifier) {
      if (Array.isArray(value)) {
        if (value.length > MAX_PAYLOAD_ARRAY_ENTRIES) truncated = true
        return value
          .slice(0, MAX_PAYLOAD_ARRAY_ENTRIES)
          .map(item => alias(item, userAliases, 'user'))
      }
      return alias(value, userAliases, 'user')
    }

    if (isUserName) {
      return alias(value, nameAliases, 'player-name')
    }

    if (rawKey && SECRET_KEY.test(rawKey)) {
      return '[redacted]'
    }

    if (
      rawKey &&
      (FREE_TEXT_KEY.test(rawKey) || COMPACT_FREE_TEXT_KEYS.has(rawKey))
    ) {
      return Array.isArray(value)
        ? value.slice(0, MAX_PAYLOAD_ARRAY_ENTRIES).map(() => '[redacted-text]')
        : '[redacted-text]'
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_PAYLOAD_ARRAY_ENTRIES) truncated = true
      return value
        .slice(0, MAX_PAYLOAD_ARRAY_ENTRIES)
        .map(item => visit(item, depth + 1, rawKey, parentKey))
    }

    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length > MAX_PAYLOAD_OBJECT_KEYS) truncated = true

      return Object.fromEntries(
        entries
          .slice(0, MAX_PAYLOAD_OBJECT_KEYS)
          .map(([childKey, child], index) => {
            const schemaKey = safeSchemaKey(childKey, rawKey)
            const safeKey = schemaKey === '[dynamic-key]'
              ? `[dynamic-key-${index + 1}]`
              : schemaKey
            return [
              safeKey,
              visit(
                child,
                depth + 1,
                schemaKey === '[dynamic-key]'
                  ? MAP_VALUE_CONTAINER
                  : childKey,
                rawKey
              )
            ]
          })
      )
    }

    if (typeof value === 'string') {
      return rawKey && SAFE_SEMANTIC_STRING_KEY.test(rawKey)
        ? sanitizeStringValue(value)
        : `[redacted-string:length=${value.length}]`
    }
    if (
      value === null ||
      typeof value === 'boolean'
    ) {
      return value
    }
    if (typeof value === 'number') {
      const identifierSized =
        Number.isInteger(value) &&
        Math.abs(value) >= IDENTIFIER_SIZED_NUMBER_MIN
      return identifierSized &&
        !(rawKey && SAFE_LARGE_NUMERIC_KEY.test(rawKey))
        ? `[redacted-number:digits=${String(Math.abs(value)).length}]`
        : value
    }

    return `[${jsonType(value)}]`
  }

  return {
    value: visit(payload, 0),
    truncated
  }
}

/**
 * Produce a schema-repair artifact with a privacy-preserving semantic snapshot.
 *
 * The structural view proves the received JSON types. The sanitized payload
 * additionally preserves poker-relevant values while aliasing direct account
 * identifiers and removing names, free text, credentials, and dynamic keys.
 */
export const buildSchemaDiagnostic = (
  payload: unknown,
  rawIssues: readonly SchemaIssueLike[]
): SchemaDiagnostic => {
  const shape = new Set<string>()
  let truncated = false

  const addShape = (entry: string): boolean => {
    if (shape.has(entry)) return true
    if (shape.size >= MAX_SHAPE_ENTRIES) {
      truncated = true
      return false
    }
    shape.add(entry)
    return true
  }

  const visit = (
    value: unknown,
    path: string,
    depth: number,
    parentKey?: string
  ): void => {
    const type = jsonType(value)
    if (!addShape(`${path}: ${type}`)) return
    if (depth >= MAX_DEPTH) {
      if (type === 'array' || type === 'object') truncated = true
      return
    }

    if (Array.isArray(value)) {
      const samples = value.slice(0, MAX_ARRAY_SAMPLES)
      const elementTypes = [...new Set(samples.map(jsonType))].sort()
      addShape(
        `${path}[]: ${elementTypes.length > 0
          ? elementTypes.join('|')
          : 'empty'}`
      )
      for (const sample of samples) {
        if (sample !== null && typeof sample === 'object') {
          visit(
            sample,
            appendPath(path, '[]'),
            depth + 1,
            parentKey
          )
        }
      }
      if (value.length > MAX_ARRAY_SAMPLES) truncated = true
      return
    }

    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
      if (entries.length > MAX_OBJECT_KEYS) truncated = true

      for (const [rawKey, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
        const key = safeSchemaKey(rawKey, parentKey)
        visit(
          child,
          appendPath(path, key),
          depth + 1,
          key === '[dynamic-key]' ? MAP_VALUE_CONTAINER : rawKey
        )
      }
    }
  }

  visit(payload, '$', 0)

  const issues = rawIssues.map(issue => {
    const expected = typeof issue.expected === 'string'
      ? issue.expected.slice(0, 80)
      : undefined
    return {
      path: formatIssuePath(issue.path),
      code: issue.code.slice(0, 80),
      expected,
      actualType: jsonType(valueAtPath(payload, issue.path))
    }
  })
  const sanitizedPayload = buildSanitizedPayload(payload)

  return {
    issues,
    payloadShape: [...shape],
    sanitizedPayload: sanitizedPayload.value,
    shapeTruncated: truncated,
    payloadTruncated: sanitizedPayload.truncated
  }
}
