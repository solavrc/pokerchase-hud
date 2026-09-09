/** @jest-environment node */
/** 固定rawの人物・文脈・結果証拠を、製品の全18統計と独立した固定分数の両方で検査する。 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { apiEventSchemas, ApiType } from '../types/api'
import type { ApiEvent } from '../types'
import { orderAndFilterApplicationEventsForReplay } from '../utils/database-utils'
import { runOracle, type OraclePlayerResult } from './verify-stats/oracle'
import { runProductPipelines } from './verify-stats/pipeline'
import { COMPARED_STATS, compareProductPaths, compareResults } from './verify-stats/compare'
import targets from './verify-stats/fixtures/oracle-evidence.expected.json'

const fixtures = {
  finite18: { path: 'e2e/fixtures/identity-stat-evidence.ndjson', sha256: '7e2ece3e68b5e8edf0d4dd2a81d030ad51679b4e4bd78f6af1ac18646ab2b6f0', events: 156, hands: 18, players: 72 },
  terminal5: { path: 'e2e/fixtures/terminal-phase-evidence.ndjson', sha256: '58f39d5eabc7667f604c1106c36b2f67415791d76aa9b9074945a6916931ecea', events: 56, hands: 5, players: 20 },
  shared25: { path: 'e2e/fixtures/identity-action-eligibility.ndjson', sha256: '61bece1e1b59cc346be458a95cfc8922c297682a51424eb985d740c0b62bf511', events: 259, hands: 25, players: 4 },
} as const

type FixtureEvent = ApiEvent & { timestamp: number }

function loadFixture(name: keyof typeof fixtures): FixtureEvent[] {
  const fixture = fixtures[name]
  const bytes = readFileSync(resolve(fixture.path))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256)
  const events = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(events).toHaveLength(fixture.events)
  for (const event of events) {
    const schema = apiEventSchemas[event.ApiTypeId as ApiType]
    expect(schema?.safeParse(event).success).toBe(true)
    expect(Number.isFinite(event.timestamp)).toBe(true)
  }
  return events
}

function splitHands(events: FixtureEvent[]): Map<number, FixtureEvent[]> {
  const hands = new Map<number, FixtureEvent[]>()
  let current: FixtureEvent[] = []
  let session: FixtureEvent | undefined
  let handSession: FixtureEvent | undefined
  const finish = () => {
    const end = current.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)
    if (end?.ApiTypeId === ApiType.EVT_HAND_RESULTS) hands.set(end.HandId, handSession ? [handSession, ...current] : current)
  }
  for (const event of events) {
    if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) session = event
    if (event.ApiTypeId === ApiType.EVT_DEAL) {
      finish()
      current = [event]
      handSession = session
    } else if (current.length > 0) current.push(event)
  }
  finish()
  return hands
}

describe('独立raw oracleの有限証拠契約', () => {
  test.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s: 全player全18統計とraw固定分数', async name => {
    const raw = loadFixture(name)
    const events = await orderAndFilterApplicationEventsForReplay(raw)
    expect(events).toHaveLength(fixtures[name].events)
    const oracle = runOracle(events)
    const { legacy, ledger } = await runProductPipelines(events)
    expect(oracle.size).toBe(fixtures[name].players)
    for (const report of [compareResults(legacy, oracle, 0), compareResults(ledger, oracle, 0), compareProductPaths(legacy, ledger)]) {
      expect(report.stats.map(stat => stat.stat)).toEqual(COMPARED_STATS)
      expect(report.eligiblePlayers).toBe(fixtures[name].players)
      for (const stat of report.stats) expect(stat.mismatches).toEqual([])
    }
    const hands = splitHands(raw)
    expect(hands.size).toBe(fixtures[name].hands)
    const perHand = new Map<number, {
      oracle: ReturnType<typeof runOracle>,
      product: Awaited<ReturnType<typeof runProductPipelines>>,
    }>()
    for (const target of targets.rows.filter(row => row.fixture === name)) {
      const hand = hands.get(target.handId)
      expect(hand).toBeDefined()
      if (!perHand.has(target.handId)) {
        const ordered = await orderAndFilterApplicationEventsForReplay(hand!)
        perHand.set(target.handId, { oracle: runOracle(ordered), product: await runProductPipelines(ordered) })
      }
      const values = perHand.get(target.handId)!
      for (const [path, players] of Object.entries({ oracle: values.oracle, legacy: values.product.legacy, ledger: values.product.ledger })) {
        const actual = players.get(target.playerId)
        expect(actual?.hands).toBe(target.hands)
        for (const [stat, fraction] of Object.entries(target.stats)) {
          expect({ path, handId: target.handId, playerId: target.playerId, stat, value: actual?.stats[stat as keyof OraclePlayerResult['stats']] })
            .toEqual({ path, handId: target.handId, playerId: target.playerId, stat, value: fraction })
        }
      }
    }
  }, 30_000)

  test.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s: actual CLIが厳密比較で成功する', name => {
    const child = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/tools/verify-stats.ts'), resolve(fixtures[name].path), '--min-hands=0', '--threshold=100'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    })
    expect({ error: child.error?.message, status: child.status, stderr: child.stderr }).toEqual({ error: undefined, status: 0, stderr: '' })
    expect(child.stdout).toContain('PASS: legacy and ledger stats all >= 100%')
  }, 40_000)

  test('schema-validな統計差を注入してもactual CLIが成功にしない', async () => {
    const root = resolve('e2e/out')
    mkdirSync(root, { recursive: true })
    const directory = mkdtempSync(join(root, 'oracle-cli-negative-'))
    const oracleFile = resolve('src/tools/verify-stats/oracle.ts')
    let injected = 0
    try {
      const output = join(directory, 'verify-stats.cjs')
      await build({
        entryPoints: [resolve('src/tools/verify-stats.ts')], outfile: output,
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
        plugins: [{ name: 'test-only-statistical-disagreement', setup(builder) {
          builder.onLoad({ filter: /[/\\]verify-stats[/\\]oracle\.ts$/ }, args => {
            expect(args.path).toBe(oracleFile)
            const source = readFileSync(args.path, 'utf8')
            const marker = '  return result\n}'
            expect(source.split(marker)).toHaveLength(2)
            injected++
            // raw/schema/製品を変えず、有効な整数分数に実差を作る。ファイルは上書きしない。
            return { contents: source.replace(marker, `  const target = result.values().next().value
  if (target) target.stats.vpip = [target.stats.vpip[0] + 1, target.stats.vpip[1] + 1]
${marker}`), loader: 'ts' }
          })
        } }],
      })
      expect(injected).toBe(1)
      const control = join(directory, 'verify-stats-control.cjs')
      await build({ entryPoints: [resolve('src/tools/verify-stats.ts')], outfile: control,
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
      const normal = spawnSync(process.execPath, [control, resolve(fixtures.finite18.path), '--min-hands=0', '--threshold=100'], { encoding: 'utf8', timeout: 30_000 })
      expect({ error: normal.error?.message, status: normal.status, signal: normal.signal }).toEqual({ error: undefined, status: 0, signal: null })
      expect(normal.stdout).toContain('Loaded 156 events')
      expect(normal.stdout).not.toContain('Filtered out')
      const child = spawnSync(process.execPath, [output, resolve(fixtures.finite18.path), '--min-hands=0', '--threshold=100'], { encoding: 'utf8', timeout: 30_000 })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(1)
      expect(child.signal).toBeNull()
      expect(child.stdout).toContain('Loaded 156 events')
      expect(child.stdout).not.toContain('Filtered out')
      expect(child.stdout).toContain('Mismatches for vpip')
      expect(child.stderr).toContain('legacy:vpip')
      expect(child.stderr).toContain('ledger:vpip')
      expect(child.stderr).not.toContain('legacy-vs-ledger:')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 40_000)
})
