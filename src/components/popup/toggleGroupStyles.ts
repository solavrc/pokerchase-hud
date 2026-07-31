/**
 * ポップアップ上部の2つの二択トグル（簡易/詳細、非表示/表示）で共有する幅。
 * 同じ行に並ぶので、幅が違うと別種の設定に見える（sola指定）。文言の実寸では
 * なく固定幅で揃え、ボタン側を flex: 1 で等分する。
 * 値は「トグル + ショートカット入力 + トグル」がポップアップ幅380pxの1行に
 * 収まる上限から決めている。増やすと折り返す。
 */
export const POPUP_TOGGLE_GROUP_WIDTH = 104

/** 2つのトグルで共有する寸法・書体。色は用途ごとに各呼び出し側で足す。 */
export const popupToggleGroupSx = {
  width: POPUP_TOGGLE_GROUP_WIDTH,
  '& .MuiToggleButton-root': {
    flex: 1,
    padding: '4px 0',
    fontSize: '12px',
    fontWeight: 'bold',
    textTransform: 'none',
    whiteSpace: 'nowrap',
  },
}
