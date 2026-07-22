# PokerStars 形式エクスポート仕様

> PokerChase ログから PokerStars 形式ハンドログへの変換仕様。
> フォーマット定義、変換ルール、GTO Wizard 互換性の知見を含む。
>
> **関連**: イベントのエッジケース（CommunityCards マージ、アンテオールイン、Chip 値の意味等）は [api-events.md](api-events.md) の「Data Constraints & Edge Cases」セクションに集約。

## 参考リソース

- **パーサー実装**: [thlorenz/hhp](https://github.com/thlorenz/hhp) — PokerStars 等の HH パーサー
- **アンテオールイン参考**: `thlorenz/hhp/test/fixtures/holdem/pokerstars/posts-allin.txt`

## フォーマット定義

### ヘッダー

```
PokerStars Hand #<HandId>: Tournament #<TournamentId>, <Name> Hold'em No Limit - Level <Roman> (<SB>/<BB>) - <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> JST
Table '<Name>' 6-max Seat #<ButtonSeat> is the button
```

- `TournamentId`: セッション内最小の HandId を使用（プリパスで確定）

### 座席・ブラインド

```
Seat <N>: <Player> (<Chips> in chips)       ← アンテ・ブラインド支払い前のチップ
<Player>: posts the ante <Amount>
<Player>: posts the ante <Amount> and is all-in
<Player>: posts small blind <Amount>
<Player>: posts small blind <Amount> and is all-in
<Player>: posts big blind <Amount>
<Player>: posts big blind <Amount> and is all-in
```

ショートオールイン時は**実際の投入額**を表示（ゲーム設定額ではない）:
```
Seat 1: norgas69 (14 in chips)
norgas69: posts the ante 3
norgas69: posts big blind 11 and is all-in   ← 設定値 20 ではなく実額 11
```

### アクション

```
<Player>: folds / checks / calls <追加額> / bets <額>
<Player>: raises <追加額> to <ストリート内合計>
<Player>: bets|calls|raises ... and is all-in
```

### ストリート・ショウダウン・サマリー

```
*** HOLE CARDS ***
Dealt to <Hero> [<Card1> <Card2>]           ← Hero のみ
*** FLOP *** [<C1> <C2> <C3>]
*** TURN *** [<Flop>] [<Turn>]
*** RIVER *** [<FlopTurn>] [<River>]
Uncalled bet (<Amount>) returned to <Player>
*** SHOW DOWN ***
<Player>: shows [<Cards>] (<HandDesc>)
<Player> collected <Amount> from pot
*** SUMMARY ***
Total pot <Amount>
Board [<Cards>]
Seat <N>: <Player> (<Position>) <結果>
```

## 変換ルール

### 出力対象と制約

| ケース | 判定条件 | 理由 |
|-------|---------|------|
| Hero 未参加 | `HoleCards` が空/未定義 | テーブル移動直後、分析価値なし |
| BB アンテオールイン | `chipsAfterAnte(bbSeat) === 0` | ハンドの連続性を保つため出力する。ただし BB 投稿行は生成できず、GTO Wizard ではパースエラーになる場合がある |

バッチエクスポートでは、個別ハンドのイベント不足や変換エラーは警告としてスキップし、
残りのハンドの処理を継続する。すべての変換処理が例外で失敗した場合はエクスポート全体を
エラーとして終了する。一方、Hero 未参加ハンドの変換は空文字列として扱われるため、選択した
ハンドがすべてこのケースだった場合は、現行実装では空の出力で完了することがある。

### ショートスタックのチップ額推定

`Chip + BetChip + Ante` ではショートオールイン時に正しいチップ額を算出できない（ゲーム設定のアンテ額が加算されるため）。

```typescript
const chipsAfterAnte = getPlayerChipsAfterAnte(event, seatIndex)
if (chipsAfterAnte === 0) {
  // Pot / アクティブプレイヤー数 でメインポットの per-player 額を推定
  return Math.floor(event.Progress.Pot / activePlayers)
}
return chipsAfterAnte + ante
```

### コミュニティカードのマージ

EVT_HAND_RESULTS.CommunityCards がフルボードでない場合:

```
蓄積（FLOP から）: [Kc, 2s, Jh]
Results:           [8c, 8h]      ← TURN + RIVER のみ
→ フルボード:      [Kc, 2s, Jh, 8c, 8h]
```

- CommunityCards が空 → 蓄積カードをそのまま使用
- CommunityCards が蓄積分以上 → フルボードとして使用
- CommunityCards が蓄積分より少ない → 蓄積 + CommunityCards でマージ

### ショウダウン時の Uncalled Bet

ショウダウン時でもサイドポットがある場合、コールされていない最後の bet/raise を `Uncalled bet` として**ショウダウン前に**出力。

### アクション未記録プレイヤー

EVT_ACTION が送信されないプレイヤー（タイムアウト/切断）は SUMMARY で `folded before Flop (didn't bet)` として処理。

### トーナメント ID

セッション内の**数値として最小のハンド ID** を Tournament# として使用する。これは
受信順や時系列上の最初のハンドを意味しない。MTT のテーブル移動後は Hand ID の大小と
時系列が逆転することがあるため、バッチ処理前のプリパスで決定論的な最小値を確定する。

## GTO Wizard 固有の制約

- **BB 行が必須**: BB 行がないハンドはパースエラー
- **Hand ID 重複排除**: 同一 Hand ID の再インポートがエラーになる場合がある
- **ポット整合チェック**: `from main pot` / `from side pot` 表記を使う場合、投入額合計 = ポット合計が検証される
- **ステータス区分**: Error（パース/バリデーション失敗）、Unsolved（GTO 解なし）、Zero Percent（0%頻度アクション）は別ステータス

## サイドポット表記

### collected 行

```
# サイドポットなし:
PlayerA collected 3080 from pot

# サイドポット1つ（side pot → main pot の順で出力、PS準拠）:
PlayerA collected 938 from side pot
PlayerA collected 67 from main pot

# 複数サイドポット:
PlayerA collected 200 from side pot-2
PlayerA collected 450 from side pot-1
PlayerA collected 200 from main pot
```

### ポットごとの勝者の割り当て（分配ロジック）

`EVT_HAND_RESULTS` はポット単位の内訳（どのポットを誰が獲得したか）を直接は提供しない
（`Pot` / `SidePot[]` の金額列と、プレイヤーごとの `HandRanking` / `RewardChip` 合計のみ）。
collected 行の帰属は以下の前提から復元する:

- **参加資格は入れ子構造**: メインポット ⊇ side pot-1 ⊇ side pot-2 …（早くオールインした
  プレイヤーほど浅いポットまでしか資格がない）
- したがって各勝者が獲得するのは**メイン側から連続する区間**であり、最強ハンドが資格の
  ある全ポットを総取りし、その資格が尽きた次のポットからはより弱い勝者に移る
- 「potIdx+1 == HandRanking」のような 1:1 対応は**成立しない**（例: HandRanking=1 が
  メイン+side1 を獲得し、side2 は HandRanking=2 が獲得するケース。実データ
  Hand #296039758 で確認済み）

実装（`buildCollectedEntries`）: 勝者（`RewardChip > 0`、NO_CALL 勝者は先頭扱い）を
`HandRanking` 昇順に並べ、メインポットから順に、残 `RewardChip` を持つ最強グループへ
ポットを割り当てて残額を消費していく貪欲法。同点スプリット時の端数（オッドチップ）は
残額が最小のメンバーに寄せることで、後続ポットの資格判定（残額 > 0）が壊れないように
している。検算の不変条件は `Pot + sum(SidePot) == sum(RewardChip)`（実データで 100% 成立、
docs/api-events.md 参照）。

### Summary 行

```
# サイドポットなし（トーナメント）:
Total pot 3080

# サイドポットなし（キャッシュゲーム）:
Total pot 3080 | Rake 0

# サイドポットあり:
Total pot 16343 Main pot 10475. Side pot 5868. | Rake 0

# 複数サイドポット:
Total pot 850 Main pot 200. Side pot-1 450. Side pot-2 200. | Rake 0
```

### 分配の検算

`HandRanking` とポット番号を 1:1 対応させず、前述の入れ子の参加資格と残
`RewardChip` に基づく貪欲法で割り当てる。検算では
`Pot + sum(SidePot) == sum(Results[].RewardChip)` が成立することを確認する。
