/**
 * test-service-teardown.ts の回帰テスト。
 *
 * ここで固定したいのは2点:
 *  1. 追跡済みインスタンスの 500ms デバウンス persistState() タイマーは、
 *     テスト終了時に取り消され、**後続テスト**の共有 chrome.storage.local
 *     モックを汚染しない（CIで観測されたフレークそのもの）。
 *  2. ヘルパーが登録するルートスコープの afterEach は、describe 内の afterEach
 *     より後に走る。したがってファイル側 teardown が最後に persist を誘発しても
 *     取りこぼさない。
 *
 * 実時間で待つ（フェイクタイマーを使わない）のは意図的: 取り消し漏れが
 * 「後続テストの実行中に実タイマーが発火する」という形でしか現れないため。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from './test-service-teardown'

const STORAGE_KEY = PokerChaseService.STORAGE_KEY
const DEBOUNCE_MS = 500

describe('trackServiceForTeardown', () => {
  let db: PokerChaseDB
  let service: PokerChaseService

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
  })

  afterEach(async () => {
    // describe スコープの teardown が persist を誘発するケース。ヘルパーの
    // ルート afterEach がこの後に走らなければ、このタイマーが残る。
    service.playerId = 999
    db.close()
    await db.delete()
  })

  test('前段: persistState() の保留タイマーを仕込むだけで終わる', async () => {
    service.playerId = 42
    service.session.setId('leaky-session')
    // デバウンス窓が明けないうちにテストを終える（ここでは何も書かれていない）
    expect(chrome.storage.local.get).toBeDefined()
  })

  test('後段: 前段の保留タイマーは発火せず、ストレージは汚染されない', async () => {
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 2))

    const stored = await chrome.storage.local.get(STORAGE_KEY)
    expect(stored[STORAGE_KEY]).toBeUndefined()
    // 自分自身の restoreState() も、前段の状態を引き継いでいないこと
    expect(service.playerId).toBeUndefined()
  })
})

/**
 * 規約の実効性チェック。ヘルパーを用意しても、新しいテストファイルが素の
 * `new PokerChaseService(...)` を書けばフレークは再発する（今回まさに40ファイル
 * ぶん溜まっていた）。人手の監査ではなく、ここで機械的に落とす。
 */
describe('規約: テストの PokerChaseService 生成は必ず trackServiceForTeardown() で包む', () => {
  const SRC_ROOT = join(__dirname, '..')

  const listTestFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return listTestFiles(full)
      return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [full] : []
    })

  test('素の生成式が残っていない', () => {
    const offenders: string[] = []

    for (const file of listTestFiles(SRC_ROOT)) {
      // このファイル自身は除外する: 上の説明コメントに生成式が散文として
      // 現れるため（生成箇所そのものは冒頭の describe で包んである）。
      if (file === __filename) continue
      const source = readFileSync(file, 'utf8')
      const pattern = /new PokerChaseService\(/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source)) !== null) {
        // 直前が `trackServiceForTeardown(`（改行・インデント許容）であること
        const preceding = source.slice(0, match.index)
        if (/trackServiceForTeardown\(\s*$/.test(preceding)) continue
        const line = preceding.split('\n').length
        offenders.push(`${relative(SRC_ROOT, file)}:${line}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('private フィールド `_persistStateTimer` へ直接触るその場しのぎが残っていない', () => {
    const offenders: string[] = []

    for (const file of listTestFiles(SRC_ROOT)) {
      if (file === __filename) continue
      const source = readFileSync(file, 'utf8')
      const pattern = /_persistStateTimer/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source)) !== null) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${relative(SRC_ROOT, file)}:${line}`)
      }
    }

    // 取り消しは公開 API cancelPendingPersist() に一本化する（フィールド名の
    // 変更を型検査で捕まえられるようにするため）。
    expect(offenders).toEqual([])
  })
})
