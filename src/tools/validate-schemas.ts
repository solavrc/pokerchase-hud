import { readFileSync, existsSync } from 'fs'
import { resolve, basename } from 'path'
import { ApiEventSchema, ApiType } from '../types/api'
interface ApiEvent {
  ApiTypeId: number
  [key: string]: unknown
}

async function main() {
  // コマンドライン引数からファイルパスを取得
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('使用方法: npm run validate-schema -- <NDJSONファイルパス>')
    console.log('例: npm run validate-schema -- ./data.ndjson')
    console.log('\nデフォルトファイルを検索中...')

    // デフォルトファイルを使用
    const defaultFile = 'pokerchase_raw_data_2025-07-12T19-59-04-204Z.ndjson'
    const defaultPath = resolve(process.cwd(), defaultFile)

    if (existsSync(defaultPath)) {
      console.log(`デフォルトファイルを使用: ${defaultFile}`)
      args.push(defaultPath)
    } else {
      console.error('エラー: ファイルパスを指定してください')
      process.exit(1)
    }
  }

  const inputPath = args[0]!  // この時点でargs[0]は必ず存在する
  const filePath = resolve(process.cwd(), inputPath)

  // ファイルの存在確認
  if (!existsSync(filePath)) {
    console.error(`エラー: ファイルが見つかりません: ${filePath}`)
    process.exit(1)
  }

  console.log(`検証データ: ${filePath}`)
  console.log(`ファイル名: ${basename(filePath)}`)

  const content = readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n')
  console.log(`総行数: ${lines.length}`)

  const results = new Map<number, { success: number; errors: Map<string, number>; total: number }>()
  let successCount = 0
  let errorCount = 0
  let parseErrorCount = 0

  console.log('\n検証を開始します...\n')

  lines.forEach((line, index) => {
    if ((index + 1) % 10000 === 0) {
      console.log(`処理中: ${index + 1}行目 (${Math.round((index + 1) / lines.length * 100)}%)`)
    }

    try {
      const event = JSON.parse(line) as ApiEvent
      const apiTypeId = event.ApiTypeId

      if (!results.has(apiTypeId)) {
        results.set(apiTypeId, { success: 0, errors: new Map(), total: 0 })
      }

      const result = results.get(apiTypeId)!
      result.total++

      try {
        // ApiEventSchemaを使用して検証
        ApiEventSchema.parse(event)
        result.success++
        successCount++
      } catch (error: any) {
        // エラーメッセージの生成
        let errorMsg = ''
        let errorDetails: any[] = []

        // Zodエラーの場合、issuesフィールドにエラー情報がある
        if (error.issues) {
          errorDetails = error.issues.map((issue: any) => {
            const path = issue.path.join('.')
            // 実際の値を取得
            let actualValue = event as any
            for (const key of issue.path) {
              actualValue = actualValue?.[key]
            }

            return {
              path,
              message: issue.message,
              actualValue,
              code: issue.code,
              expected: issue.expected,
              received: issue.received
            }
          })

          errorMsg = errorDetails.map(d => `${d.path}: ${d.message} (実際の値: ${JSON.stringify(d.actualValue)})`).join(', ')
        } else {
          errorMsg = error.message || JSON.stringify(error)
        }

        // エラーをカウント
        const currentCount = result.errors.get(errorMsg) || 0
        result.errors.set(errorMsg, currentCount + 1)
        errorCount++

        // 各エラータイプの最初の3件のみ詳細を出力
        if (currentCount < 3) {
          console.log(`\n===== エラー詳細 (${getEventTypeName(apiTypeId)}) =====`)
          console.log(`Line: ${index + 1}`)
          console.log('エラー内容:')
          errorDetails.forEach(d => {
            console.log(`  パス: ${d.path}`)
            console.log(`  メッセージ: ${d.message}`)
            console.log(`  実際の値: ${JSON.stringify(d.actualValue)}`)
            console.log(`  期待値: ${d.expected || 'N/A'}`)
            console.log(`  受信値: ${d.received || 'N/A'}`)
          })
          console.log('\nJSON全体:')
          console.log(JSON.stringify(event, null, 2))
          console.log('=====================================\n')
        }
      }
    } catch (e) {
      parseErrorCount++
    }
  })

  console.log('\n=== 検証結果サマリー ===')
  console.log(`総検証数: ${lines.length}`)
  console.log(`成功: ${successCount} (${(successCount / lines.length * 100).toFixed(2)}%)`)
  console.log(`失敗: ${errorCount} (${(errorCount / lines.length * 100).toFixed(2)}%)`)
  console.log(`JSONパースエラー: ${parseErrorCount}`)

  console.log('\n=== イベントタイプ別の詳細 ===\n')

  const sortedResults = Array.from(results.entries()).sort((a, b) => a[0] - b[0])

  sortedResults.forEach(([apiTypeId, result]) => {
    const successRate = (result.success / result.total * 100).toFixed(2)
    console.log(`${getEventTypeName(apiTypeId)} (${apiTypeId}):`)
    console.log(`  総数: ${result.total}`)
    console.log(`  成功: ${result.success} (${successRate}%)`)

    if (result.errors.size > 0) {
      console.log(`  エラー: ${result.total - result.success}`)
      const sortedErrors = Array.from(result.errors.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)

      sortedErrors.forEach(([error, count]) => {
        console.log(`    - ${error} (${count}回)`)
      })

      if (result.errors.size > 5) {
        console.log(`    ... 他${result.errors.size - 5}種類のエラー`)
      }
    }

    console.log('')
  })
}

function getEventTypeName(apiTypeId: number): string {
  // ApiType enumの逆引きマップを作成
  const typeMap = Object.entries(ApiType).reduce((acc, [key, value]) => {
    if (typeof value === 'number') {
      acc[value] = key
    }
    return acc
  }, {} as Record<number, string>)

  // 定義されていないIDの場合は、番号ベースの名前を生成
  if (!typeMap[apiTypeId]) {
    // 1000番台のチャット関連イベント
    if (apiTypeId >= 1201 && apiTypeId <= 1304) {
      return `UNKNOWN_${apiTypeId}`
    }
    // その他の未知のイベント
    return `UNKNOWN_${apiTypeId}`
  }

  return typeMap[apiTypeId]
}

main().catch(console.error)
