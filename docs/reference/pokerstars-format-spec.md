# PokerStars ハンドヒストリーフォーマット仕様

> PokerStars 形式のハンドログフォーマット仕様。
> 主に GTO Wizard 等の外部ツールとの互換性に必要な仕様を記述する。

## 参考リソース

- **パーサー実装**: [thlorenz/hhp](https://github.com/thlorenz/hhp) — PokerStars, Ignition, PartyPoker, Pacific 対応
- **テストフィクスチャ**: `thlorenz/hhp/test/fixtures/holdem/pokerstars/` に実ログ例あり
- **アンテオールイン参考**: `posts-allin.txt`

## ヘッダー

```
PokerStars Hand #<HandId>: Tournament #<TournamentId>, <TournamentName> Hold'em No Limit - Level <RomanLevel> (<SB>/<BB>) - <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> <TZ>
Table '<TableName>' <MaxSeats>-max Seat #<ButtonSeat> is the button
```

- `HandId`: ハンド固有の ID
- `TournamentId`: トーナメント（セッション）固有の ID。セッション内の全ハンドで共通
- `RomanLevel`: ブラインドレベルのローマ数字表記 (I, II, III, ...)

## 座席

```
Seat <N>: <PlayerName> (<Chips> in chips)
```

- `Chips`: **アンテ・ブラインド支払い前** のチップ数

## アンテ / ブラインド

```
<PlayerName>: posts the ante <Amount>
<PlayerName>: posts the ante <Amount> and is all-in
<PlayerName>: posts small blind <Amount>
<PlayerName>: posts small blind <Amount> and is all-in
<PlayerName>: posts big blind <Amount>
<PlayerName>: posts big blind <Amount> and is all-in
```

### ショートオールイン

チップがアンテやブラインドの全額に満たない場合、**実際の投入額** を表示:

```
Seat 1: norgas69 (14 in chips)          ← 元チップ 14
norgas69: posts the ante 3              ← アンテ 3 (設定値: 3)
norgas69: posts big blind 11 and is all-in  ← 残り 11 (設定値: 20)
```

### アンテ優先

PokerStars はアンテ優先モデル。アンテを先に支払い、残りをブラインドに充当。

### BB 行の必須性

GTO Wizard は BB 行が存在しないハンドを受け付けない。BB がアンテで全チップを消費し BB を投稿できないケースは PokerStars 実ログに前例がなく、外部ツールでも非対応。

## ホールカード

```
*** HOLE CARDS ***
Dealt to <HeroName> [<Card1> <Card2>]
```

Hero のカードのみ表示。他プレイヤーのカードはショウダウンまで非公開。

## ストリート

```
*** FLOP *** [<Card1> <Card2> <Card3>]
*** TURN *** [<FlopCards>] [<TurnCard>]
*** RIVER *** [<FlopTurnCards>] [<RiverCard>]
```

TURN/RIVER では既出カードを `[]` で、新カードを別の `[]` で表示。

## アクション

```
<PlayerName>: folds
<PlayerName>: checks
<PlayerName>: calls <AdditionalAmount>
<PlayerName>: bets <Amount>
<PlayerName>: raises <AdditionalAmount> to <TotalAmount>
<PlayerName>: bets <Amount> and is all-in
<PlayerName>: raises <AdditionalAmount> to <TotalAmount> and is all-in
<PlayerName>: calls <AdditionalAmount> and is all-in
```

- `calls` の金額は **追加投入額**（= 対戦相手のベット額 - 自分の既投入額）
- `raises` の金額: `raises <追加額> to <ストリート内合計>`

## Uncalled Bet

最後のベット/レイズがコールされなかった場合:

```
Uncalled bet (<Amount>) returned to <PlayerName>
```

ショウダウン時でもサイドポットがあるケースで発生する。

## ショウダウン

```
*** SHOW DOWN ***
<PlayerName>: shows [<Card1> <Card2>] (<HandDescription>)
<PlayerName>: mucks hand
<PlayerName> collected <Amount> from pot
<PlayerName> collected <Amount> from main pot
<PlayerName> collected <Amount> from side pot
<PlayerName> finished the tournament in <Nth> place
```

### サイドポット時の collected

サイドポットがある場合、`from main pot` / `from side pot` を使い分ける:

```
MasterQkiu collected 938 from side pot
MasterQkiu collected 67 from main pot
```

## サマリー

```
*** SUMMARY ***
Total pot <Amount>
Total pot <Amount> Main pot <MainAmount>. Side pot <SideAmount>. | Rake 0
Board [<Card1> <Card2> <Card3> <Card4> <Card5>]
Seat <N>: <PlayerName> (<Position>) showed [<Cards>] and won (<Amount>) with <HandDesc>
Seat <N>: <PlayerName> (<Position>) showed [<Cards>] and lost with <HandDesc>
Seat <N>: <PlayerName> (<Position>) folded before Flop
Seat <N>: <PlayerName> (<Position>) folded before Flop (didn't bet)
Seat <N>: <PlayerName> (<Position>) folded on the Flop
Seat <N>: <PlayerName> (<Position>) folded on the Turn
Seat <N>: <PlayerName> (<Position>) folded on the River
Seat <N>: <PlayerName> (<Position>) mucked
Seat <N>: <PlayerName> (<Position>) collected (<Amount>)
```

- サイドポットがある場合、`Main pot <X>. Side pot <Y>. | Rake 0` の内訳を付加
- `folded before Flop (didn't bet)`: アンテのみ投入でフォールド
- `folded before Flop`: ブラインド投入後にフォールド
