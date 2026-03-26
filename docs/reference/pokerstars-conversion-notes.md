# PokerChase → PokerStars 変換ノート

> PokerChase ログから PokerStars 形式への変換で得られた知見と設計判断。

## 変換不可能なケース（スキップ対象）

### Hero 未参加ハンド

テーブル移動直後の最初のハンドで `HoleCards: []` となるケース。PokerChase がカードを配布していない。分析価値がないためスキップ。

**判定条件**: `event.Player?.HoleCards` が空配列または未定義

### BB アンテオールイン

BB ポジションのプレイヤーがアンテで全チップを消費し、BB を投稿できないケース。

- PokerStars 実ログに前例がない
- GTO Wizard は BB 行が必須（手動テストで確認）
- BB 優先配分（アンテ行をスキップし全額を BB 行に配分）も GTO Wizard で非対応
- アンテ行なし + BB 行なしの組み合わせも非対応

**判定条件**: `getPlayerChipsAfterAnte(bbSeat) === 0`

**背景**: PokerChase のアンテ/BB 比率が PokerStars より大きい（25% 前後）ため、BB がアンテでオールインするケースが発生しやすい。

## 変換上の注意点

### ショートスタックのチップ額推定

EVT_DEAL の `Chip + BetChip + Ante` ではショートオールイン時に正しいチップ額を算出できない（ゲーム設定のアンテ額が加算されるため）。

**解決策**: `Progress.Pot / アクティブプレイヤー数` でメインポットの per-player 額を推定し、ショートスタックの実際のチップ額として使用。

```typescript
// chipsAfterAnte === 0 のプレイヤー
const perPlayerMainPot = Math.floor(event.Progress.Pot / activePlayers)
if (perPlayerMainPot <= ante) {
  return perPlayerMainPot  // ショートスタックの実額
}
```

### コミュニティカードのマージ

EVT_HAND_RESULTS の `CommunityCards` がフルボードでない場合、EVT_DEAL_ROUND で蓄積したカードとマージが必要。

```
蓄積: [Kc, 2s, Jh]  (FLOP から)
Results: [8c, 8h]     (TURN + RIVER のみ)
→ フルボード: [Kc, 2s, Jh, 8c, 8h]
```

**マージロジック**:
- `CommunityCards` が空 → 蓄積カードをそのまま使用
- `CommunityCards` が蓄積分以上 → フルボードとして使用
- `CommunityCards` が蓄積分より少ない → 蓄積 + CommunityCards でマージ

### Uncalled Bet のタイミング

PokerStars 形式では Uncalled bet は**ショウダウン前**に出力される。サイドポット + ショウダウンの組み合わせでも発生する:

```
Uncalled bet (3612) returned to Player147802279
*** SHOW DOWN ***
```

**判定**: ショウダウン時でも、最後のベット/レイズ以降にコールがなければ Uncalled bet を出力。

### BB 未投稿時の SB アクション

PokerChase は BB がアンテオールインでも SB に `CALL bet=BB額` を送信する（内部的に BB ベットが存在する扱い）。変換時に BB 行が存在しない場合、この CALL の解釈が問題になる。

**現在の対応**: BB アンテオールインのハンド自体をスキップ。

### トーナメント ID

PokerStars 形式では同一トーナメント内の全ハンドが共通の Tournament# を持つ。
PokerChase には明示的なトーナメント ID がないため、セッション内の最小ハンド ID を使用。

**注意**: バッチエクスポート時に handIds が降順で処理されるため、プリパスで最小値を確定する必要がある。

## GTO Wizard 固有の制約

- **BB 行が必須**: BB 行がないハンドはパースエラー
- **Hand ID による重複排除**: 同一 Hand ID のハンドを再インポートするとエラーになる場合がある（キャッシュ or 重複排除）
- **サイドポット表記**: `from main pot` / `from side pot` の区別と Summary の `Main pot X. Side pot Y.` 内訳は、ポット整合が正しくないとバリデーションエラーになる（要慎重な実装）
- **Error vs Unsolved vs Zero Percent**: UI 上で異なるステータスとして表示される。Error はパース/バリデーション失敗、Unsolved は GTO 解なし、Zero Percent は 0% 頻度のアクション

## 未対応事項

### サイドポット表記の完全対応

現在 `collected X from pot` / `Total pot X` のシンプルな形式で出力。PS 準拠の `from main pot` / `from side pot` 表記と Summary 内訳は未実装。

実装時の注意:
- `RewardChip` から Uncalled bet を差し引いた額を使用
- HandRanking=1 のプレイヤーがメインポット勝者
- ポット整合（投入額合計 = ポット合計）が GTO Wizard のバリデーションで検証される
