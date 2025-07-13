/**
 * Real-time Statistics Service Tests
 */

import { RealTimeStatsService } from './realtime-stats-service'

describe('RealTimeStatsService', () => {
  describe('calculateStats', () => {
    test('コミュニティカードが含まれる', () => {
      /**
       * シナリオ: RealTimeStatsServiceが統計を計算する場合
       * 検証内容:
       * - ホールカードとコミュニティカードの両方が結果に含まれる
       * - UI表示用にカード情報が統計データに組み込まれる
       * - 動作確認のために追加された機能が正しく動作する
       */
      const stats = RealTimeStatsService.calculateStats(
        101, // playerId
        [], // actions
        [], // phases
        [], // hands
        new Set(), // winningHandIds
        [48, 49], // holeCards
        5, // activeOpponents
        [1, 2, 3] // communityCards
      )

      expect(stats.holeCards).toEqual([48, 49])
      expect(stats.communityCards).toEqual([1, 2, 3])
    })
  })
})