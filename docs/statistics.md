# 統計定義と派生データの契約

HUD と downstream 分析が共有する意味論の正本。旧 AGENTS.md の
「Confirmed Statistical Definitions」を整理し、現行実装と照合したもの。実装の挙動は変更していない。
変更時の検証・再構築要件は [src/AGENTS.md](../src/AGENTS.md)、統計の追加手順は
[CONTRIBUTING.md](../CONTRIBUTING.md)、ワイヤ仕様は [api-events.md](api-events.md)。

## 母集団と既定値

主要統計は PT4/HM3 と比較できる定義を採用する。判断機会へ絞った WTSDa / WWSFa、
full-table VPIP·F は別指標として既定非表示。RCA と VPIP·F は HUD 独自指標で、
tracker 互換と説明しない。

`gameTypes` と `tableSize` で絞ってから `handLimit` を適用する。table-size layer は
[classifyTableSizeLayer](../src/utils/table-size.ts) に統一されている。full は6席卓の
5–6 dealt-in、または4席卓の4 dealt-in。4席卓で3人なら3p層である。
人数 filter の UI は full → 4p → 3p → HU の連続範囲で、legacy の飛び飛び選択は
[table-size-range.ts](../src/utils/table-size-range.ts) が最小の包含範囲へ正規化する。

| ID / 表示名 | 分子・分母または値 |
|---|---|
| `hands` / HAND | 対象 player の dealt-in hand 数 |
| `playerName` / Name | session の player 名。未取得なら `Player {playerId}` |
| `vpip` / VPIP | 自発的 preflop 投入 hand / 機会 hand。BB で preflop action が0件の hand（walk / BB action skip）は分母から除く。non-BB の fold は機会に含む |
| `pfr` / PFR | preflop raise hand / VPIP と同じ walk 除外分母 |
| `vpipF` / VPIP·F | full-table layer 内の VPIP。walk 除外も同じ。既定非表示、tooltip は各 layer の内訳 |
| `3bet` / 3B | preflop 2-bet に対して raise / 2-bet に直面し、レイズ不能と判明していない機会（`phasePrevBetCount === 2`）。実際の RAISE は分子・分母に含む |
| `3betfold` / 3BF | 3-bet に直面して fold / その機会（bet count 3）。original raiser に限定せず cold-facing を含む |
| `cbet` / CB | PFR が flop の最初の bet を実行 / その機会。集計は `phase === FLOP` に限定 |
| `cbetFold` / CBF | 実行済み CBet に同じ street で fold / それに直面した機会。PFR が check した後の他者の bet は対象外 |
| `af` / AF | postflop `(BET + RAISE) / CALL`。preflop・CHECK・FOLD は除外 |
| `afq` / AFq | postflop `(BET + RAISE) / (BET + RAISE + CALL + FOLD)`。CHECK は除外 |
| `wtsd` / WTSD | showdown 到達 hand / flop を見た hand。preflop all-in を含む |
| `wwsf` / WWSF | 勝った hand / flop を見た hand。WTSD と同じ母集団 |
| `wtsdNoAi` / WTSDa | showdown 到達 hand / 当該 player に FLOP action が1件以上ある hand。既定非表示 |
| `wwsfNoAi` / WWSFa | 勝った hand / 当該 player に FLOP action が1件以上ある hand。既定非表示 |
| `wsd` / W$SD | 勝った showdown hand / 全 showdown hand。preflop all-in と SHOWDOWN_MUCK を含み、NO_CALL は含めない |
| `steal` / STL | folded-to の CO/BTN/SB から first-in raise / その機会。HU の button=SB も含む |
| `foldToSteal` / FTS | 特定済み steal raise に SB/BB が fold / その機会（bet count 2）。HU の BB も含む |
| `riverCallAccuracy` / RCA | `RIVER_CALL_WON` / `RIVER_CALL`（river CALL action 単位） |

実装 ID・登録・表示既定は [stats/core](../src/stats/core/index.ts) と
[types/stats.ts](../src/types/stats.ts) を参照。`phasePrevBetCount` は preflop では BB を
1とし、open 後2、3-bet 後3。`phasePlayerActionIndex` は各 street で0から始まる。
stat 固有の一時状態は `handState.statStates[id]`、共有 `actions` は構造情報である。

## 派生契約

次の意味論は `EntityConverter` と `WriteEntityStream` の両方に共通する。

- **ALL_IN 正規化**: 同一 street で CHECK 権があれば CALL にしない。preflop は BB
  option の RAISE、postflop は先制 BET（最小額未満も含む）。`FOLD, ALL_IN` だけなら
  short/equal call を維持する。通常の BET 選択肢ありは BET、CALL ありは RAISE、空の
  メニューは従来の CALL fallback。action 自身の Phase で新 street が確定した場合は、
  前 street のメニューを使わず既存の street-opening BET を優先する。
- **3bet 機会**: `canRaise` は現在の席・street に一致する非空の直前メニューだけから
  判定する。preflop の RAISE、または ALL_IN と CALL/CHECK の併存はレイズ可能。
  `FOLD, CALL` / `FOLD, ALL_IN` だけなら機会から除外する。空・別席・別street は不明
  として従来の機会判定を維持し、記録された RAISE はメニューより優先して分子・分母へ
  入れる。3betfold の機会にこのレイズ可否除外を適用しない。bet 段階の数え方も維持する。
  この write-time 修正は Raw Lake 再構築で既存 action / ledger へ反映する。counter の
  構造・ordinal は変えず、再構築で新しい generation の寄与値へ置き換える。
- **ストリート**: action 自身の `EVT_ACTION.Progress.Phase` を
  [resolveActionPhase](../src/utils/action-phase.ts) で解決する。`DEAL_ROUND` の回数を
  正典にしない。`NextActionSeat === -2` の hand-ending row は wire の Phase が3へ
  固定されるため override 対象から除外し、進行中 street を維持する。
- **FLOP membership**: FLOP `DEAL_ROUND` の BET_ABLE / ALL_IN を含み、fold 済みを
  除外する。全員 preflop all-in などで `DEAL_ROUND` が省略され、RESULTS で累積 board が
  3枚以上になった場合、未作成の FLOP phase を補う。dealt-in かつ preflop FOLD して
  いない席を入れ、board は先頭3枚にする。
- **SHOWDOWN**: `isShowdownParticipant()`（rank 0–9 または SHOWDOWN_MUCK=11）が
  2人以上必要。Results の行数だけで決めず、NO_CALL=10 / FOLD_OPEN=12 は除外する。
- **勝者**: `deriveHandSettlement()` の `contestedAward > 0` を `winningPlayerIds` に
  する。`RewardChip` には uncalled return が含まれるため raw payout > 0 や
  `HandRanking === 1` では代替できない。side-pot winner と自分の overbet 返却を区別する。
- **position**: `getPositionMap()` は明示 `ButtonSeat` / `SmallBlindSeat` / `BigBlindSeat`
  から導出する。空席を含む `seatUserIds` の単純回転で代替しない。DB/export は original
  seat、HUD 表示は hero 起点の回転位置。
- **netChips**: `grossPayout - totalContribution`。
  `totalContribution = startingStack + grossPayout - finalStack`、grossPayout は
  uncalled return 込みの RewardChip。lineup・snapshot・支払保存則・table 保存則が
  不成立、short-ante tier が曖昧、legacy 未再構築なら推定せず null にする。
- **table 保存則**: tournament (BattleType 0/1/2/6) は開始/終了 stack 総和が等しい。
  Ring (4/5) は rake 流出を許すが chip creation は許さない。Ring の mid-hand rebuy /
  add-on だけは `deriveMidHandChipInflow()` で snapshot から独立に流入を求め、終了
  stack から差し引いて判定する。street 内の `Chip + BetChip`、street 間の直前 BetChip
  差分を使い、減少異常は unknown、RESULTS の最終検査は超過だけを数える。tournament
  へ inflow 許容を広げない。
- **ante / side pot**: `buildAnteAllInChipsMap()` は Pot / SidePot の tier 差分を使い、
  `fixAnteAllInChips()` は RewardChip で席を照合する。seat 順を stack 順とみなさない。
  settlement の恒等式は `Pot + sum(SidePot) == sum(RewardChip)`。

チップ会計の実装は [hand-chip-accounting.ts](../src/utils/hand-chip-accounting.ts)、
表記の正本は [pokerstars-export.md](pokerstars-export.md)。PokerStars の calls は追加額、
Dealt to は hero のみ、main / side pot の eligibility は別々に扱う。
省略された BB check は `getMissingBBCheck` で補うが NO_CALL 勝利には補わない。
read-time の ALL_IN 実質分類・bet sizing・カードの可視性は
[履歴サービス規約](../src/services/AGENTS.md#recent-hands) を参照する。

## 検証資料の読み方

[22ハンド監査](hand-analysis.md) は2026-03の履歴資料。AF/AFq・WTSD/WWSF・VPIP の
値は2026-07の tracker 定義再整合より前なので、現在の期待値には使わない。
`verify-stats` は raw からの独立 oracle と import/rebuild path を照合する。
live path は [cross-path-parity.test.ts](../src/cross-path-parity.test.ts) と
[entity-converter.test.ts](../src/entity-converter.test.ts) を合わせて検証する。
