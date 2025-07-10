/**
 * HANDS - Total number of hands played
 */

import type { StatDefinition } from '../../types/stats'

export const handsStat: StatDefinition = {
  id: 'hands',
  name: 'HAND',
  description: 'プレイしたハンド数',
  calculate: ({ hands }) => {
    return hands.length
  },
  format: (value) => {
    return value.toString()
  }
}