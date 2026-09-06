# components/ の開発・レビュー規約

[src 共通規約](../AGENTS.md) に加えて UI に適用する。
データの意味・カード可視性は [統計正本](../../docs/statistics.md) と
[履歴サービス規約](../services/AGENTS.md#recent-hands) に従う。
実ブラウザ検証は [e2e/README.md](../../e2e/README.md)、手動表示確認は `npm run mockup`。

## HUD と席の保持

- ゲームは Unity canvas。DOM nameplate を探して位置を決めず、保存用 original seat と
  hero=0 の表示座標を分離する。HUD panel は固定 anchor box 内の absolute 配置で下へ
  展開し、header の画面位置を変えない（MUST）。`HUD_ANCHOR_HEIGHT` 変更は実ブラウザで
  再計測し、既存の `hudPosition_*` の意味を維持する。content 高依存の中央寄せへ戻さない。
- dim cache は表示 seat 単位。trusted lineup の新 player は直ちに上書きし、離席なら
  最後の snapshot と drill-down を保持する（MUST）。session end は realtime だけを消し、
  aggregate / open panel は残す。filter 変更で再計算不能な離席 snapshot を削除しない。
- 次の成功201、または201を逃した後の最初の trusted hero-seated DEAL で旧 lineup を
  破棄する（MUST）。spectator DEAL で hero 回転を更新しない。明示境界を逃した trusted
  table change は既存の複数席衝突判定を使う。batch `latestStats` は dim cache を経由しない。
- last-table 復元は display-only（MUST）。pipeline / ACTIVE / replay 判定へ入れず、
  hero seat 0 は保存・復元しない。空席だけへ復元し、最初の適用 live lineup と次 session
  境界で破棄する。live per-hand 更新だけが debounce 保存を所有し、hero-only batch や
  non-hero 不在 snapshot は保存しない。version / schema / duplicate seat の不正は全体を
  復元しない。読書きは background message 経由で write 時も再検証する。
- pre-game hero は同じ seat 0 で career stats を表示し、live DEAL が自然に引き継ぐ。
  別 panel を追加せず、古い mount 応答が live lineup を上書きしないようにする。

## 統計表示・直近ハンド

- compact は既定、full は詳細 grid。各 HUD の展開状態は独立させ、body click はコピー・
  drill-down click へ伝播させない。既存の保存設定に欠けた key は default と merge する。
- 色と分類の閾値は `hud/statColorRules.ts` / `playerTypeRules.ts` のデータ定義を使う。
  色は各 stat の分母、分類は vpip / af / vpipF の個別 n-gate を維持する（MUST）。whale は
  raw VPIP ではなく full-table vpipF で判定し、AF 不足でも独立判定できる。必要統計の
  forcing は計算対象だけを増やし、ユーザーが隠した grid row を表示しない。
- stat tooltip は dynamic tooltip（なければ値と分子/分母）＋日本語 helpText。
  developer badge は固定 player ID 集合で判定し、各ユーザーの hero に付けない。
- 直近ハンドは複数 player の panel を同時に開ける。positional panel と recent-hands
  の種類間は排他とし、他 player の recent-hands を閉じる単一ID状態へ戻さない。
- 直近ハンドは header row・時刻列・showdown marker を追加せず、240px HUD 内の値を
  優先する。結果は各 hand の BB で割り、不正 BB は chips に fallback。正確な chips、
  単位、F/T/R 凡例は空の action や fallback 行も含め tooltip に残す（MUST）。
- rank-only カードには full rank/suit tooltip を残す（MUST）。色だけに依存させない。
  fixed table layout、F/T/R の改行、bold 損益、classic scrollbar 15px を含む狭い幅を
  実ブラウザで測定する。文字数の見積もりを表示検証の代わりにしない。
- 直近ハンド件数・参加 filter は device-local 設定と background broadcast を使う。
  content script から直接 `storage.local` を読書き・監視しない（MUST NOT）。

## HandLog の geometry と仮想行

- layout は `transitionHandLogLayout()` の component-local state machine が所有する
  （MUST）。move / resize / scale / viewport / async load / reset を通し、別 effect/ref
  から座標を変更・保存しない。interaction 中の環境変更は pending、古い request/scale の
  load 結果は拒否、共通 exit から persistence effect を高々1回出す。
- reset は新しい `readHandLogEnvironment()` を入力し、固定 top-left default から
  normalize する（MUST）。古い viewport を使って救済操作を繰り返さない。
- viewport の size clamp は表示だけ。保存 size は resize で実際に変わった軸だけ更新
  する（MUST）。移動や縮小画面への追従で元 size を失わない。position は常に clamp、
  viewport=0 の軸は上限だけ保留し下限0を維持する。外枠は border-box、move は右上 grip、
  右下は resize 専用とする。
- 仮想行高は実 font/size の grapheme ごとの pixel 測定と CSS wrapping から求める
  （MUST）。固定文字数・code point 単位に戻さない。CJK / emoji / 結合文字 / NBSP /
  禁則の変更は Chrome の実測で検証し、fallback も cluster 単位の保守的幅を使う。
- 折返し幅は表示 size − scrollbar − row padding。stable scrollbar gutter と DPR 変化時の
  再測定を維持し、wrap の全入力を `getItemSize` callback deps に含める（MUST）。

## Popup

- theme は独立した `popupTheme` sync key、auto は OS 設定に追従、初描画前に読込む。
  UIConfig へ混ぜて theme 変更を game tab の HUD 更新として broadcast しない。
- export/import/rebuild は optimistic 表示と background guard を組み合わせる。forced
  update と評価依頼は成功応答を待つ。失敗・timeout は retry 可能に残し、評価 state の
  durable acknowledge 前に store tab を開かない（MUST NOT）。
- 更新情報は固定 `GITHUB_RELEASES_URL` にリンクし、release body を埋め込まない。
  未公開 version の tag URL や日付を固定しない。評価先は `chrome.runtime.id` から生成する。
