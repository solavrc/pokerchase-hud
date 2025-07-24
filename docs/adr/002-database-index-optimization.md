# ADR-002: データベースインデックス最適化

## ステータス
承認済み

## コンテキスト
PokerChase HUDのパフォーマンス分析により、以下のクエリパターンが頻繁に実行されることが判明しました：

1. **プレイヤー統計計算**: 特定プレイヤーの全アクションを取得
2. **最新イベント取得**: 特定タイプ（EVT_DEAL等）の最新イベント
3. **時間範囲クエリ**: 最近Nハンドのデータ取得
4. **フェーズ別アクション**: プレイヤーの特定ストリートでのアクション
5. **アクションタイプ別集計**: RAISE、FOLD等の特定アクションの集計

現在のインデックス構成では、これらのクエリの一部が非効率的で、メモリ内でのフィルタリングに依存していました。

## 決定

### 1. 新規インデックスの追加（v3マイグレーション）

#### apiEventsテーブル
```javascript
// 追加
'[ApiTypeId+timestamp]' // 特定イベントタイプの時系列クエリ用
```

#### handsテーブル
```javascript
// 追加
'approxTimestamp' // 最近のハンドの効率的な取得用
```

#### actionsテーブル
```javascript
// 追加
'[playerId+phase]'      // プレイヤーの特定ストリートでのアクション
'[playerId+actionType]' // プレイヤーの特定アクションタイプの集計
```

#### metaテーブル
```javascript
// 追加
'updatedAt' // キャッシュ有効期限管理用
```

### 2. メタテーブルの汎用化

`ImportMeta`型を`MetaRecord`型に拡張し、以下の用途に対応：

- **インポート追跡**: 最後に処理したタイムスタンプ
- **統計キャッシュ**: プレイヤー統計の一時保存
- **同期状態**: Firestoreとの同期状態管理
- **アプリケーション設定**: 将来の拡張用

## 影響と期待される改善

### パフォーマンス改善

1. **最新EVT_DEAL取得**
   - Before: 全EVT_DEALを取得してフィルタ＋ソート
   - After: `[ApiTypeId+timestamp]`インデックスで直接取得

2. **プレイヤーのプリフロップアクション**
   - Before: 全アクションを取得してメモリ内フィルタ
   - After: `[playerId+phase]`インデックスで直接フィルタ

3. **最近100ハンド**
   - Before: 全ハンドを取得してソート＋スライス
   - After: `approxTimestamp`インデックスで効率的な範囲クエリ

### ストレージへの影響

- インデックス追加により約10-15%のストレージ増加見込み
- クエリ性能の向上がストレージコストを上回る

## 実装例

### 最適化されたクエリパターン

```javascript
// 1. 特定プレイヤーのフロップアクション
await db.actions.where('[playerId+phase]')
  .equals([playerId, PhaseType.FLOP])
  .toArray()

// 2. 最新のEVT_DEAL取得
await db.apiEvents.where('[ApiTypeId+timestamp]')
  .between([ApiType.EVT_DEAL, 0], [ApiType.EVT_DEAL, Infinity])
  .reverse()
  .first()

// 3. 最近100ハンド
await db.hands.where('approxTimestamp')
  .above(Date.now() - 24*60*60*1000) // 24時間以内
  .reverse()
  .limit(100)
  .toArray()
```

### メタテーブルの活用例

```javascript
// 統計キャッシュ
await db.meta.put({
  id: `statisticsCache:${playerId}`,
  value: { playerId, stats, handCount },
  updatedAt: Date.now(),
  expiresAt: Date.now() + 5 * 60 * 1000 // 5分後に期限切れ
})

// キャッシュ取得時の有効期限チェック
const cache = await db.meta.get(`statisticsCache:${playerId}`)
if (cache && cache.expiresAt > Date.now()) {
  return cache.value.stats
}
```

## リスクと軽減策

### リスク
1. **マイグレーション時間**: 大量データでのインデックス再構築
2. **後方互換性**: v2からv3への移行

### 軽減策
1. **段階的マイグレーション**: Service Workerの初回起動時に実行
2. **エラーハンドリング**: マイグレーション失敗時の自動リトライ

## 測定基準

以下のメトリクスで改善を測定：
- 統計計算の平均実行時間
- データベースクエリの実行回数
- メモリ使用量の削減

## 参考文献
- [Dexie.js Indexing Best Practices](https://dexie.org/docs/Indexing)
- [IndexedDB Performance Patterns](https://web.dev/indexeddb-best-practices/)