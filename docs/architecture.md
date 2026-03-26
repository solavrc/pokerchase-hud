# アーキテクチャ設計判断

> データストレージ、データモデル、クラウド同期、インデックス最適化に関する設計判断とその根拠。

## 1. データストレージ: Dexie.js (IndexedDB)

### 採用理由
- 複合インデックス（`[timestamp+ApiTypeId]`）とマルチエントリインデックス（`*seatUserIds`）のネイティブサポート
- 効率的なバルク操作（`bulkPut`、`bulkAdd`）
- TypeScript型安全性
- 88KB、v4.0.4 安定版

### 却下した選択肢
| 選択肢 | 却下理由 |
|---|---|
| 生 IndexedDB | 冗長な API、複合インデックスの手動実装、トランザクション管理が困難 |
| idb (12KB) | 複合インデックス非対応、マルチエントリクエリの手動実装が必要 |
| PouchDB | ドキュメント指向でリレーショナルデータに不適合 |
| LocalForage | KV のみ、複雑なクエリ不可 |
| RxDB | 200KB+ で過剰 |

## 2. データモデル: 正規化エンティティ

### 構造
- `hands`: ハンドレベルデータ
- `phases`: ストリートごとの情報
- `actions`: 個々のプレイヤーアクション（統計マーカー付き）

### 採用理由
- マルチエントリインデックスによるプレイヤーベースクエリの効率化
- データ重複なし、新統計の追加に柔軟

### 却下: 非正規化単一テーブル
大規模なデータ重複、個別アクションのクエリ困難、スケールでの性能低下。

## 3. クラウド同期: Firestore + 生イベントのみ

### データ構造
```
/users/{userId}/apiEvents/{timestamp_ApiTypeId}
```

### 採用理由
- シンプルな単一コレクション、タイムスタンプによる増分同期
- BigQuery 直接エクスポート対応
- 処理ロジックをローカルで自由に更新可能

### 却下した選択肢
| 選択肢 | 却下理由 |
|---|---|
| Firestore に正規化エンティティ | ストレージ +40%、書き込み 4 倍、処理の柔軟性喪失 |
| Cloud Storage (ファイル) | クエリ不可、同時実行問題、BigQuery 自動エクスポート不可 |

## 4. 同期戦略: イベント駆動

- ゲーム終了時に 100+ 新規イベントで自動アップロード
- 手動同期 UI（上り/下り選択可）
- 定期同期なし（コスト最適化: Firestore 無料枠 50k reads/day）

### 却下: リアルタイム同期 (onSnapshot)
10k イベント = 10k 読み取り、Service Worker 30 秒タイムアウト問題、単一デバイス利用では不要。

## 5. インデックス最適化 (v3 マイグレーション)

### 追加インデックス

| テーブル | インデックス | 用途 |
|---|---|---|
| `apiEvents` | `[ApiTypeId+timestamp]` | 特定イベントタイプの時系列クエリ |
| `hands` | `approxTimestamp` | 最近のハンドの効率的取得 |
| `actions` | `[playerId+phase]` | プレイヤーの特定ストリートアクション |
| `actions` | `[playerId+actionType]` | アクションタイプ別集計 |
| `meta` | `updatedAt` | キャッシュ有効期限管理 |

### パフォーマンス改善例

```javascript
// Before: 全 EVT_DEAL 取得 → フィルタ + ソート (O(n))
// After: 複合インデックスで直接取得 (O(log n))
await db.apiEvents.where('[ApiTypeId+timestamp]')
  .between([ApiType.EVT_DEAL, 0], [ApiType.EVT_DEAL, Infinity])
  .reverse().first()

// Before: 全アクション取得 → メモリ内フィルタ
// After: 複合インデックスで直接フィルタ
await db.actions.where('[playerId+phase]')
  .equals([playerId, PhaseType.FLOP]).toArray()
```

### メタテーブル汎用化
`ImportMeta` → `MetaRecord` に拡張。インポート追跡、統計キャッシュ、同期状態、アプリケーション設定に対応。

### ストレージ影響
インデックス追加で約 10-15% 増加。クエリ性能向上がコストを上回る。

## 将来の検討事項
1. 30-90 日後の古いデータを Cloud Storage にアーカイブ
2. 頻繁にアクセスされる統計のサマリーテーブル
3. 長期保存のためのイベント圧縮

## 参考文献
- [Dexie.js Documentation](https://dexie.org/)
- [Dexie.js Indexing Best Practices](https://dexie.org/docs/Indexing)
- [Firebase Firestore Pricing](https://firebase.google.com/pricing)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
