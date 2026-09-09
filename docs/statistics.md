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
| `pfr` / PFR | preflop raise hand / raise有無を判定できる機会hand。walk除外はVPIPと同じだが、人物不明行のあるhandでは統計ごとに分母を判定する |
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

- **操作一覧の適用範囲**: 非空の直前 Progress が現在の席・解決済み street に一致し、
  最後の201以後に得られた場合だけ、その action の選択肢として使う。正規化と3bet機会は
  同じ根拠を使う。ここで境界にする201は、schema検証を通り、application eventと判定された
  数値 `Code === 0` の参加成功だけである。Raw Lakeに保存されても、Code欠落などschemaで
  rejectされたraw通知や`Code !== 0`の参加失敗は境界にしない。この201は既存 hand の採否を
  変えず Progress を失効させ、live bufferにも境界を保持する。空・欠測・別席・別street・
  201越境は不明とし、
  過去の一覧を探索しない。
- **ALL_IN 正規化**: 適用可能な一覧に CHECK と ALL_IN があれば CALL にしない。preflop は BB
  option の RAISE、postflop は先制 BET（最小額未満も含む）。`FOLD, ALL_IN` だけなら
  short/equal call を維持する。通常の BET 選択肢ありは BET、CALL と ALL_IN ありは RAISE。
  一覧が不明なら従来の CALL fallback。action 自身が新しい postflop street を開く場合は、
  前 street のメニューを使わず既存の street-opening BET を優先する。
- **3bet 機会**: `canRaise` は上記の適用範囲を満たすメニューだけから
  判定する。preflop の RAISE、または ALL_IN と CALL/CHECK の併存はレイズ可能。
  `FOLD, CALL` / `FOLD, ALL_IN` だけなら機会から除外する。空・別席・別street は不明
  として従来の機会判定を維持し、記録された RAISE はメニューより優先して分子・分母へ
  入れる。3betfold の機会にこのレイズ可否除外を適用しない。bet 段階は正規化後のactionで数える。
  この write-time 修正は Raw Lake 再構築で既存 action / ledger へ反映する。counter の
  構造・ordinal は変えず、再構築で新しい generation の寄与値へ置き換える。
- **人物不明ACTION以後の機会**: 有効な席交代境界のため帰属できない最初の304と同ms以後は、
  3bet・3betfold・CB・CBF・STL・FTSの新しい分子・分母をともに計上しない。
  境界より前の確定済みflagは保ち、街が変わってもこの6指標の履歴は回復しない。
  帰属できる明示RAISE/CALL/FOLDとstreet進行は保つ。同ms群の行順は因果順の根拠にしない。
- **人物不明ACTION以後のALL_IN型**: 直前Progressが303/305、または配札人物へ帰属できる304で、
  そのtimestampが直前までの全人物不明304より厳密に後、現在のALL_INより厳密に前にあり、
  非空メニューが当該席・streetに一致するときだけBET/RAISE/CALL型を確定する。
  不成立なら候補actionTypeを互換性のため残し、`Action.normalizationUnproven=true`を保存する。
  この行はAF/AFqやriver CALL判定に使わない。PFRはpreflopで型未知のALL_INがあり既知RAISEが
  無いhandだけ分子・分母から除外し、既知RAISEの1/1やpostflopだけ型未知のhandのPFRは保つ。
  preflopのraw ALL_INは自発的参加なのでVPIPは保つ。型が回復しても上記6指標は回復しない。
- **ストリート**: action 自身の `EVT_ACTION.Progress.Phase` を
  [resolveActionPhase](../src/utils/action-phase.ts) で解決する。`DEAL_ROUND` の回数を
  正典にしない。`NextActionSeat === -2` の hand-ending row は wire の Phase が3へ
  固定されるため override 対象から除外し、進行中 street を維持する。
- **preflopの試行**: 人物境界のため除外したpreflop ACTIONの旧UIDを
  `Hand.preflopIdentityUnprovenPlayerIds`へ保存する。VPIP（VPIP·Fを含む）は保持済みの
  最初のpreflop actionによる分類を保つ。当該人物のpreflop行が全て帰属不明なら0/0とし、
  除外後の空action列から0/1やwalkを作らない。PFRは既知RAISEがあれば1/1を保つ。
  RAISEがなく、除外preflop行があり、strict pre-boundaryの確定preflop FOLDもなければ0/0。
  型未知ALL_INが残る場合も既知RAISEなしでは否定できない。既知CALL後の曖昧さはVPIPの
  1/1を保つが、PFRの否定を証明しない。postflopだけの曖昧さはpreflopの根拠を消さない。
  境界のみで除外304がないケースや、席交代のない通常のtimeout・BB skipの扱いは維持する。
  強制postを自発行動へ変換しない。
  除外した終端304（`NextActionSeat=-2`）はwireのPhaseから街を特定できないため、
  厳密に早いtimestampのpostflop 305または有効な非終端304がない場合もpreflopの未知候補に残す。
  同msの街配信・行動だけでPFRの否定を作らず、既知CALLのVPIPや既知RAISE/FOLDは上記規則で保つ。
- **FLOP membership**: 既存FLOPまたは累積boardが3枚以上の場合に参加者を補完する。
  305も当該boardもないpostflop ACTION単独からのFLOP作成は、この変更には含めない。
  帰属可能なFLOP `DEAL_ROUND` の BET_ABLE / ALL_IN、既知の
  当該人物のpostflop ACTIONを肯定根拠にする。累積boardが3枚以上かつ直接UID付きの
  正当なshowdown参加者が2人以上なら、その人物も肯定できる。配信305の有無でこの
  根拠を変えず、未作成FLOPはboard先頭3枚で補う。既知のpreflop FOLDと、帰属可能な
  配信FLOPの明示不参加snapshotは否定根拠とする。結果の存在やFOLD_OPENだけでは肯定しない。
  境界前の既知FLOP参加は後続の人物境界で消さない。FLOPあり／board3枚以上で、
  人物境界または無305のFOLD_OPENがあり、肯定・否定根拠のない人物は
  `Hand.flopParticipationUnprovenPlayerIds`に残す。通常の未受信検出へ広げない。
  統計は肯定したFLOP参加だけを分母に使う。カード公開・payoutは直接UIDの事実として保つ。
- **SHOWDOWN**: `isShowdownParticipant()`（rank 0–9 または SHOWDOWN_MUCK=11）が
  2人以上必要。Results の行数だけで決めず、NO_CALL=10 / FOLD_OPEN=12 は除外する。
- **勝者**: `deriveHandSettlement()` の `contestedAward > 0` を `winningPlayerIds` に
  する。`RewardChip` には uncalled return が含まれるため raw payout > 0 や
  `HandRanking === 1` では代替できない。side-pot winner と自分の overbet 返却を区別する。
  有効な席交代証拠があり精算から勝者を解決できないhandは
  `Hand.winnerIdentityUnproven=true`を保存し、WWSF/WWSFa/W$SD/RCAの分子・分母から除外する。
  WTSD/WTSDa、確定したCALLや人物単位で閉じたチップ会計は保つ。席交代証拠のないlegacy
  未解決handへこの除外を広げない。
- **position**: `getPositionMap()` は明示 `ButtonSeat` / `SmallBlindSeat` / `BigBlindSeat`
  から導出する。空席を含む `seatUserIds` の単純回転で代替しない。DB/export は original
  seat、HUD 表示は hero 起点の回転位置。
- **netChips**: `grossPayout - totalContribution`。
  `totalContribution = startingStack + grossPayout - finalStack`、grossPayout は
  uncalled return 込みの RewardChip。このendpoint式は開始・終了が同一人物のときに限る。
  301の`JoinUser.UserId`が配札時と異なる席は以降のsnapshotを切り離す。
  Ringで交代前の明示FOLDとチップ観測列が整合し、受取が0なら
  `totalContribution = startingStack + FOLDまでのinflow - FOLD.Chip`でhand投入だけを確定する。
  初期NOT_IN_PLAY/ELIMINATED・BetChip0で境界まで無行動・不参加が続けば投入0を証明する。
  交代しないFOLD済み人物の終了snapshot欠落にもFOLD時点の投入を使う。
  明示FOLDの証明は本人の開始とチップ観測列で判定し、他席の欠落・不整合とは分ける。
  卓全体のinflowは従来どおり全席の整合が必要で、初期不参加0の証明もこの条件を維持する。
  退出後のcash残高は補完しない。同一人物の301は従来の買い足し経路を維持する。
  lineup・snapshot・支払保存則・table 保存則が
  不成立、short-ante tier が曖昧、legacy 未再構築なら推定せず null にする。
  席交代で投入が未解決のhandにはlegacy snapshot欠損用の勝者fallbackも使わない。
- **table 保存則**: tournament (BattleType 0/1/2/6) は開始/終了 stack 総和が等しい。
  Ring (4/5) は rake 流出を許すが chip creation は許さない。Ring の mid-hand rebuy /
  add-on だけは `deriveMidHandChipInflow()` で snapshot から独立に流入を求め、終了
  stack から差し引いて判定する。street 内の `Chip + BetChip`、street 間の直前 BetChip
  差分を使い、減少異常は unknown、RESULTS の最終検査は超過だけを数える。tournament
  へ inflow 許容を広げない。
  人物が交代したRing卓では現金残高の総和を比較せず、全員のhand投入が確定した場合に
  `sum(totalContribution) >= sum(RewardChip)`を確認する。新occupantの資金は含めない。
- **ハンド中の席交代**: DEALのlineupは固定し、301以降の同席actionと305のmembershipを
  旧人物へ付けない。新しい人物は次のDEALから参加者にする。301の名前・rank更新はUserId別に
  保持する。liveのAggregate→WriteEntityとimport/rebuildの両方へ301を渡し、保存済みの
  hand・action・phase・統計台帳はRaw Lakeから再構築する。DBのキーとindexは変わらない。
  同msの301と303〜306、境界後の同席action/参加snapshot、終了より前の313で旧人が続く
  場合は会計unknown。301には卓IDがなく、同一卓の入力列という前提と観測限界は
  [api-events](api-events.md#evt_player_join-ハンド中の人物交代)に記載する。
  人物へのaction・チップ帰属を止めても、304が示す卓のstreet進行は保持する。305が未受信・
  後着でも、別席のハンド終了FOLDを前streetへ戻したり、blind精算を流入異常にしない。
- **hand所有のsession情報**: `id`・`battleType`・`name`はDEAL時に一体で保持する。
  完成後の同ms301は人物会計だけを再評価し、次の201/308を旧handへ遡及適用しない。
  次のDEALは更新済みsessionを使う。liveのworker内context、EC、HandLogで同じ境界を使い、
  このsession境界のためにRaw Lake・永続schemaへmetadataは追加しない。
- **ante / side pot**: `buildAnteAllInChipsMap()` は Pot / SidePot の tier 差分を使い、
  `fixAnteAllInChips()` は RewardChip で席を照合する。seat 順を stack 順とみなさない。
  settlement の恒等式は `Pot + sum(SidePot) == sum(RewardChip)`。

`HAND_STAT_CONTRIBUTION_VERSION=3`は人物・統計ごとの試行根拠を考慮した計算規則を表す。
counterの42要素とordinalは維持する。旧versionの台帳は読み出し時にcanonicalから再計算されるが、
旧canonicalにないeligibilityはこれだけでは復元できない。`REBUILD_ADVISORY_VERSION=10`の
Raw Event Lake再構築でoptionalなHand/Actionの証拠と台帳を同時に更新する。Dexie schemaは8のまま。

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

人物境界とFLOP参加の有限対照は [identity-stat-evidence.ndjson](../e2e/fixtures/identity-stat-evidence.ndjson)
と [期待値](../e2e/fixtures/identity-stat-evidence.expected.json)に固定する。warehouseの同名fixtureと
同一入力で、VPIP/PFRの分子・分母、FLOPの真・偽・不明、直接UIDの公開カード・payoutを検証する。
独立raw oracleは人物境界・街・直前Progressの根拠・統計ごとの試行・勝者の確定可否を
製品helperから独立に計算する。上記18ハンドに加え、
[終端5ハンド](../e2e/fixtures/terminal-phase-evidence.ndjson)と
[人物・行動文脈25ハンド](../e2e/fixtures/identity-action-eligibility.ndjson)を
`--min-hands=0 --threshold=100`の実CLIで検証する。
[固定期待値](../src/tools/verify-stats/fixtures/oracle-evidence.expected.json)はrawの行番号と理由を持ち、
全playerの全18統計の三者一致とは別に、同じhandのoracle・legacy・ledgerへ直接assertする。
固定入力のSHAとschemaも検査し、正当な整数分数に意図的な差を入れたCLIは非0終了することを
[検証テスト](../src/tools/verify-stats-evidence.test.ts)で確認する。
