/**
 * Player Name - Display player name with ID
 */

import type { StatDefinition } from '../../types/stats'

export const playerNameStat: StatDefinition = {
  id: 'playerName',
  name: 'Name',
  description: 'プレイヤー名',
  calculate: (context) => {
    const playerInfo = context.session.players.get(context.playerId)
    if (playerInfo) {
      return playerInfo.name
    } else {
      return `Player ${context.playerId}`
    }
  },
  format: (value) => {
    return value as string
  }
}
