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

### スキップ対象

| ケース | 判定条件 | 理由 |
|-------|---------|------|
| Hero 未参加 | `HoleCards` が空/未定義 | テーブル移動直後、分析価値なし |
| BB アンテオールイン | `chipsAfterAnte(bbSeat) === 0` | PS 形式に前例なし、GTO Wizard 非対応 |

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

セッション内の**最小ハンド ID** を Tournament# として使用。バッチエクスポート時は handIds が降順で処理されるため、プリパスで最小値を確定。

## GTO Wizard 固有の制約

- **BB 行が必須**: BB 行がないハンドはパースエラー
- **Hand ID 重複排除**: 同一 Hand ID の再インポートがエラーになる場合がある
- **ポット整合チェック**: `from main pot` / `from side pot` 表記を使う場合、投入額合計 = ポット合計が検証される
- **ステータス区分**: Error（パース/バリデーション失敗）、Unsolved（GTO 解なし）、Zero Percent（0%頻度アクション）は別ステータス

## 未対応事項

- **サイドポット表記**: `from main pot` / `from side pot` の区別、Summary の `Main pot X. Side pot Y.` 内訳は未実装。実装時はポット整合に注意（GTO Wizard がバリデーションする）
