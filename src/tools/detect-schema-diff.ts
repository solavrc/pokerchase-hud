// @ts-nocheck
/**
 * Schema Diff Detection Tool
 * 
 * NDJSONファイルのイベントを現在のスキーマと比較し、
 * 増分差分（未知プロパティ）と減少差分（必須プロパティ欠損）を検出する。
 * 
 * Usage:
 *   npx tsx src/tools/detect-schema-diff.ts <NDJSONファイルパス>
 *   npm run schema-diff -- <NDJSONファイルパス>
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, basename } from 'path'
import { apiEventSchemas, ApiType } from '../types/api'

interface PropertyDiff {
  count: number
  sampleValues: unknown[]
}

interface DiffReport {
  apiTypeId: number
  typeName: string
  total: number
  unknownProperties: Map<string, PropertyDiff>
  parseErrors: Map<string, number>
}

function getEventTypeName(apiTypeId: number): string {
  const typeMap = Object.entries(ApiType).reduce((acc, [key, value]) => {
    if (typeof value === 'number') acc[value] = key
    return acc
  }, {} as Record<number, string>)
  return typeMap[apiTypeId] ?? `UNKNOWN_${apiTypeId}`
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('使用方法: npx tsx src/tools/detect-schema-diff.ts <NDJSONファイルパス>')
    console.log('例: npx tsx src/tools/detect-schema-diff.ts ./export.ndjson')
    process.exit(1)
  }

  const filePath = resolve(process.cwd(), args[0]!)
  if (!existsSync(filePath)) {
    console.error(`エラー: ファイルが見つかりません: ${filePath}`)
    process.exit(1)
  }

  console.log(`ファイル: ${basename(filePath)}`)

  const content = readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n')
  console.log(`総行数: ${lines.length}\n`)

  // 各イベントタイプの strict() 版スキーマをキャッシュ
  const strictSchemas = new Map<number, ReturnType<typeof Object.values<typeof apiEventSchemas>[number]['strict']>>()
  for (const [key, schema] of Object.entries(apiEventSchemas)) {
    try {
      strictSchemas.set(Number(key), (schema as any).strict())
    } catch { /* some schemas may not support strict */ }
  }

  const reports = new Map<number, DiffReport>()
  let jsonParseErrors = 0
  let unknownSchemaCount = 0

  for (let i = 0; i < lines.length; i++) {
    if ((i + 1) % 10000 === 0) {
      console.log(`処理中: ${i + 1}/${lines.length} (${Math.round((i + 1) / lines.length * 100)}%)`)
    }

    let event: Record<string, unknown>
    try {
      event = JSON.parse(lines[i]!)
    } catch {
      jsonParseErrors++
      continue
    }

    const apiTypeId = event.ApiTypeId as number

    if (!reports.has(apiTypeId)) {
      reports.set(apiTypeId, {
        apiTypeId,
        typeName: getEventTypeName(apiTypeId),
        total: 0,
        unknownProperties: new Map(),
        parseErrors: new Map()
      })
    }
    const report = reports.get(apiTypeId)!
    report.total++

    const strictSchema = strictSchemas.get(apiTypeId)
    if (!strictSchema) {
      unknownSchemaCount++
      continue
    }

    const result = strictSchema.safeParse(event)
    if (result.success) continue

    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        // 増分差分: 未知プロパティ
        for (const key of (issue as any).keys ?? []) {
          const prop = report.unknownProperties.get(key) ?? { count: 0, sampleValues: [] }
          prop.count++
          if (prop.sampleValues.length < 3) {
            prop.sampleValues.push(event[key])
          }
          report.unknownProperties.set(key, prop)
        }
      } else {
        // 減少差分: 必須プロパティ欠損、型不一致など
        const errorPath = issue.path.join('.') || 'root'
        const key = `${errorPath}: ${issue.message}`
        report.parseErrors.set(key, (report.parseErrors.get(key) ?? 0) + 1)
      }
    }
  }

  // === レポート出力 ===
  console.log('=== スキーマ差分レポート ===\n')

  const sortedReports = Array.from(reports.values()).sort((a, b) => a.apiTypeId - b.apiTypeId)
  let hasFindings = false
  let totalUnknownProps = 0
  let totalParseErrors = 0

  for (const report of sortedReports) {
    const hasUnknown = report.unknownProperties.size > 0
    const hasMissing = report.parseErrors.size > 0

    if (!hasUnknown && !hasMissing) continue
    hasFindings = true

    console.log(`📋 ${report.typeName} (${report.apiTypeId}) — ${report.total}件`)

    if (hasUnknown) {
      console.log('  🆕 未知プロパティ（増分差分）:')
      for (const [key, { count, sampleValues }] of report.unknownProperties) {
        const sample = sampleValues.map(v => JSON.stringify(v)).join(', ')
        console.log(`    + ${key} (${count}件) 例: ${sample}`)
        totalUnknownProps += count
      }
    }

    if (hasMissing) {
      console.log('  ⚠️  バリデーションエラー（減少差分の可能性）:')
      for (const [error, count] of report.parseErrors) {
        console.log(`    - ${error} (${count}件)`)
        totalParseErrors += count
      }
    }

    console.log()
  }

  if (!hasFindings) {
    console.log('✅ 差分なし — 全イベントが現在のスキーマに完全適合しています。\n')
  }

  // サマリー
  console.log('=== サマリー ===')
  console.log(`検証イベント数: ${lines.length - jsonParseErrors}`)
  console.log(`JSONパースエラー: ${jsonParseErrors}`)
  console.log(`スキーマ未定義: ${unknownSchemaCount}件`)
  console.log(`未知プロパティ: ${totalUnknownProps}件`)
  console.log(`バリデーションエラー: ${totalParseErrors}件`)
  console.log(`イベントタイプ数: ${reports.size}`)
}

main().catch(console.error)
