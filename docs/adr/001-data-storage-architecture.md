# ADR-001: データストレージアーキテクチャ

## ステータス
承認済み

## コンテキスト
PokerChase HUDは、リアルタイムでポーカーゲームイベントを処理し、統計を計算し、クラウドストレージとのデータ同期を提供するChrome拡張機能です。システムは以下を処理する必要があります：

- **データ量**: セッションあたり数万イベント（〜10,000イベント = 〜2MB）
- **リアルタイム要件**: ゲームプレイ中のHUD更新は1秒以内
- **オフライン機能**: インターネット接続なしでの完全な機能
- **Chrome拡張機能の制約**: Manifest V3 Service Worker環境（30秒タイムアウト）
- **クラウド同期**: オプションのバックアップとデバイス間同期
- **分析**: BigQueryへのデータエクスポート

## 決定要因
1. **パフォーマンス**: 大規模データセットでの複雑なクエリを効率的に処理
2. **オフラインファースト**: インターネットなしでコア機能が動作
3. **コスト最適化**: クラウドストレージと操作コストの最小化
4. **複雑性**: 明確な関心の分離を持つ保守可能なアーキテクチャ
5. **ブラウザ制約**: IndexedDBとService Workerの制限内での動作

## 検討したオプション

### 1. ローカルストレージオプション

#### オプション1.1: Dexie.js（IndexedDBラッパー）- **採用**
- **利点**:
  - 複雑なIndexedDB APIの優れた抽象化
  - 複合インデックスのネイティブサポート（`[timestamp+ApiTypeId]`）
  - 配列クエリ用のマルチエントリインデックス（`*seatUserIds`）
  - 効率的なバルク操作（`bulkPut`、`bulkAdd`）
  - 型安全性を持つTypeScriptサポート
  - 88KBのサイズは機能セットに対して妥当
  - v4.0.4安定版リリースで実戦検証済み
- **欠点**:
  - 追加の依存関係
  - Dexie固有機能の学習曲線

#### オプション1.2: 生のIndexedDB
- **利点**:
  - 依存関係なし
  - 実装の完全な制御
- **欠点**:
  - 冗長で複雑なAPI
  - 複合/マルチエントリインデックスの手動実装
  - エラーが発生しやすいトランザクション管理
  - 大幅な開発オーバーヘッド

#### オプション1.3: idb（軽量ラッパー）
- **利点**:
  - 最小サイズ（12KB）
  - シンプルなPromiseベースAPI
- **欠点**:
  - 複合インデックスの組み込みサポートなし
  - マルチエントリクエリの手動実装
  - 要件と比較して限定的な機能セット

#### オプション1.4: その他の代替案（PouchDB、LocalForage、RxDB）
- **欠点**:
  - PouchDB: ドキュメント指向（リレーショナルデータに不適合）
  - LocalForage: キーバリューのみ（複雑なクエリ不可）
  - RxDB: 過剰なサイズ（200KB+）と複雑性

### 2. データモデルオプション

#### オプション2.1: 正規化されたエンティティ - **採用**
3つのテーブルを持つ現在の構造：
- `hands`: ハンドレベルのデータ
- `phases`: ストリートごとの情報（プリフロップ/フロップ/ターン/リバー）
- `actions`: 個々のプレイヤーアクション

- **利点**:
  - マルチエントリインデックスによる効率的なプレイヤーベースのクエリ
  - データの重複なし
  - 関心の明確な分離
  - 新しい統計の追加に柔軟
- **欠点**:
  - 完全なハンドデータに複数のクエリが必要
  - 書き込みの複雑性（ハンドあたり3テーブル）

#### オプション2.2: 非正規化単一テーブル
- **利点**:
  - すべてのハンドデータを単一クエリで取得
- **欠点**:
  - 大規模なデータ重複
  - 複雑なフィルタリングロジック
  - 個々のアクションのクエリが困難
  - スケールでのパフォーマンス低下

### 3. クラウドストレージオプション

#### オプション3.1: Firestoreで生イベントのみ - **採用**
- **利点**:
  - シンプルなデータモデル（単一コレクション）
  - タイムスタンプクエリによる増分同期
  - 低ストレージコスト（重複なし）
  - 処理ロジックを更新する柔軟性
  - 直接的なBigQueryエクスポートサポート
- **欠点**:
  - BigQueryは生イベントからエンティティを再構築する必要

#### オプション3.2: Firestoreに正規化エンティティ
- **利点**:
  - BigQueryでの直接SQLクエリ
  - エンティティ再構築不要
- **欠点**:
  - 40%多いストレージ（ハンドあたり2,800バイト vs 2,000バイト）
  - 4倍の書き込み操作（4コレクション）
  - データ重複と同期の複雑性
  - 処理の柔軟性の喪失

#### オプション3.3: Cloud Storage（ファイル）
- **利点**:
  - 90%安いストレージ（$0.02/GB vs $0.18/GB）
- **欠点**:
  - クエリ機能なし（ファイル全体をダウンロード必要）
  - 複数セッションでの同時実行問題
  - BigQuery自動エクスポートの喪失
  - 増分同期の複雑な実装

### 4. 同期戦略オプション

#### オプション4.1: イベント駆動同期 - **採用**
- ゲーム終了時に100+新規イベントで自動同期
- UIコントロールによる手動同期
- 定期的なバックグラウンド同期なし

- **利点**:
  - Firestore無料枠に最適化（50k読み取り/日）
  - 予測可能なコスト
  - シンプルな実装
  - ポーカーセッションパターンに適合
- **欠点**:
  - デバイス間でリアルタイムではない

#### オプション4.2: リアルタイム同期（onSnapshot）
- **利点**:
  - デバイス間での即座の更新
- **欠点**:
  - 高いFirestore読み取りコスト（10kイベント = 10k読み取り）
  - Service Worker 30秒タイムアウト問題
  - 複雑な競合解決
  - 単一デバイスのポーカーセッションには不要

## 決定

1. **ローカルストレージ**: IndexedDB管理にDexie.js
2. **データモデル**: 正規化されたエンティティ（hands、phases、actions）
3. **クラウドストレージ**: 生のapiEventsのみをFirestoreに保存
4. **同期戦略**: 手動コントロール付きのイベント駆動同期

## 結果

### ポジティブ
- **パフォーマンス**: 適切なインデックスで最適化されたクエリ
- **コスト効率**: 最小限のFirestore操作
- **保守性**: ローカル処理とクラウドバックアップの明確な分離
- **柔軟性**: クラウド移行なしで統計ロジックを更新可能
- **信頼性**: 良好なドキュメントを持つ実証済み技術

### ネガティブ
- **BigQueryの複雑性**: エンティティ再構築ロジックを実装する必要
- **同期遅延**: リアルタイムのデバイス間更新なし
- **依存関係**: Dexie.js APIに依存

### 軽減戦略
1. **BigQuery UDF**: エンティティ変換ロジックを再利用可能な関数として実装
2. **マテリアライズドビュー**: BigQueryで一般的な集計を事前計算
3. **ドキュメント**: データモデルの明確なドキュメントを維持
4. **抽象化レイヤー**: 必要に応じて移行を容易にするためDexie固有のコードをラップ

## 実装メモ

### 現在のインデックス使用
```javascript
// マルチエントリインデックスを使用した効率的なプレイヤークエリ
await db.hands.where('seatUserIds').equals(playerId).toArray()
await db.actions.where('playerId').equals(playerId).toArray()
```

### 同期最適化
```javascript
// クラウドから最新のタイムスタンプのみをクエリ
const latest = await firestore
  .collection('apiEvents')
  .orderBy('timestamp', 'desc')
  .limit(1)
  .get();

// より新しいイベントのみをアップロード
const newEvents = await db.apiEvents
  .where('timestamp').above(latest.timestamp)
  .toArray();
```

### 将来の検討事項
1. **ハイブリッドストレージ**: 30-90日後に古いデータをCloud Storageにアーカイブ
2. **事前集計**: 頻繁にアクセスされる統計のサマリーテーブルを追加
3. **圧縮**: 長期保存のためのイベント圧縮を実装

## 参考文献
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Dexie.js Documentation](https://dexie.org/)
- [Firebase Firestore Pricing](https://firebase.google.com/pricing)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)