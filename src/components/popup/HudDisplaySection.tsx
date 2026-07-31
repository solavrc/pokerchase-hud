import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import type { UIConfig } from '../../types/hand-log'
import { saveSyncedUIConfig } from '../../utils/ui-config-storage'
import { broadcastUIConfig } from './broadcast-ui-config'
import { popupToggleGroupSx } from './toggleGroupStyles'

interface HudDisplaySectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
}

/**
 * HUD表示モード（コンパクト/フル）。UIScaleSection と同じ保存パス
 * （setUIConfig → chrome.storage.sync → 開いている全ゲームタブへ
 * updateUIConfig メッセージ送信）に従う。ただし端末固有のscaleは
 * 同期payloadから除外する。
 *
 * 「表示モード:」のラベルと3行目の独立ブロックは廃止し、
 * 非表示/表示 と同じ ToggleButtonGroup として UIScaleSection の
 * 右カラムへ積む（sola指定）。どちらも「HUDをどう出すか」の二択であり、
 * 見た目が違うと別種の設定に見える。幅も
 * `popupToggleGroupSx` で揃える。文言を コンパクト/フル から 簡易/詳細 へ
 * 短くしたのは、非表示/表示 と同じ2文字ずつにして固定幅へ無理なく収めるため
 * （`hudDisplayMode` の値 'compact' | 'full' は変えていない）。
 *
 * 統計カラー表示のON/OFFもここにあったが廃止し、常時有効にした。
 * しきい値カラーはHUDの読み取りやすさそのものであって好みの設定ではない。
 */
export const HudDisplaySection = ({
  uiConfig,
  setUIConfig,
}: HudDisplaySectionProps) => {
  const updateUIConfig = (newConfig: UIConfig) => {
    setUIConfig(newConfig)
    saveSyncedUIConfig(newConfig)
    broadcastUIConfig(newConfig)
  }

  // DEFAULT_UI_CONFIGとのマージ済みuiConfigが渡ってくる前提だが、念のため
  // フォールバックしておく（#143のデフォルト = compact）。
  const hudDisplayMode = uiConfig.hudDisplayMode ?? 'compact'

  return (
    <ToggleButtonGroup
      value={hudDisplayMode}
      exclusive
      aria-label="HUD表示モード"
      onChange={(_event, newValue: string | null) => {
        // exclusive な ToggleButtonGroup は選択中を再クリックすると null を返す。
        // 表示モードに「未選択」は無いので現状維持にする。
        if (newValue === null) return
        updateUIConfig({ ...uiConfig, hudDisplayMode: newValue as 'full' | 'compact' })
      }}
      size="small"
      sx={[
        popupToggleGroupSx,
        {
          '& .MuiToggleButton-root.Mui-selected': {
            backgroundColor: 'primary.main',
            color: (theme) => theme.palette.getContrastText(theme.palette.primary.main),
            '&:hover': {
              backgroundColor: 'primary.dark',
            },
          },
        },
      ]}
    >
      <ToggleButton value="compact">
        簡易
      </ToggleButton>
      <ToggleButton value="full">
        詳細
      </ToggleButton>
    </ToggleButtonGroup>
  )
}
