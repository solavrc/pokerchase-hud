# background/ の開発・レビュー規約

[src 共通規約](../AGENTS.md) に加えてこのディレクトリへ適用する。
ACTIVE port・replay・Lake の横断契約は src 共通規約を正本とし、ここでは SW の commit
境界と操作の所有者を定める。

## 取り込みの直列化

- ACTIVE / INACTIVE の変更は `event-ingestion.ts` の到着順 queue 内、raw write の
  durability barrier と content dedup の後に行う（MUST）。同じ timestamp/type の別内容
  は新規イベント。同一 content の再送は activity を動かさない。
- raw write 失敗は非対称に扱う（MUST）。START は ACTIVE に倒して reload を止めるが、
  END の失敗で INACTIVE にはしない。読取り側の stale state は drain barrier で解決し、
  write 側の optimistic activity 更新へ戻さない。

## Forced update の commit 点

- 自動・手動を含む forced-update reload は `commitReloadIfStillSafe()` へ集約する
  （MUST）。明示した全データ削除後の `deleteAllData()` reload だけが既存の例外。
- SAFE は session 非 active、sync 中でない、operation idle の全条件。SW 起動時の
  activity は unknown / unsafe とし、実際の終了観測まで安全としない（MUST）。
- pending update を await より先に永続化し、ingestion と `pending-storage-writes.ts`
  の両 tail を drain する（MUST）。drain cap 到達は reload 拒否。最後に tail と安全条件を
  同期的に再確認し、二重 commit guard を保持する。最終確認と reload の間に await を
  入れない（MUST NOT）。reload 前に完了すべき新しい storage write は pending tail へ登録。
- update の再確認は既存の session-end / 成功203、operation 完了、SW startup の入口を
  使う。定期 update check は SW を起こす `chrome.alarms` で行う。
- badge は `resolveActiveBadge()` の rebuild > update > whats-new を維持する（MUST）。
  下位機能が上位 badge を消さない。未読更新は update install 時だけ記録し、popup の
  version と Releases link 表示後の acknowledge で解消する。startup で再主張する。

## Import・export・rebuild

- 長時間処理は `currentOperationState` に一元化し、background が競合操作を拒否する
  （MUST）。popup の optimistic UI だけを排他制御にしない。mount から状態を復元でき、
  `started` を取り逃しても `processing` で active operation を復元できるようにする。
- ファイル選択と5 MiB転送は専用 import tab が所有する（MUST）。action popup が file を
  読み込まない。tab は重複させず既存を focus し、terminal 結果は `lastImportResult` に
  保存する。転送失敗の `importDataCancel` は冪等に operation を解放するが、process が
  session を detach した後の保存・再構築を取り消さない。
- 大容量 export は chunk message と content script の Blob download を使う。
  単一 message の64 MiB制限・Data URLの約2 MB制限に依存する全量転送へ戻さない。
- `getLatestSessionStats()` の preGame 呼出しだけが hero-only の career stats を返す。
  通常の import 完了後は既存の再計算・配信が所有し、古い hero-only 応答で上書きしない。
  hero 不明時の復旧は `findLatestPlayerDealEvent()` と通常の setter を使う。

## Device layout と評価依頼

- layout reset は列挙済みの全 `HUD_POSITION_STORAGE_KEYS` と `handLogLayout` を削除し、
  `uiScale` を既定値へ set する（MUST）。scale の削除だけでは legacy sync 値が復活する。
  remove 成功 / set 失敗の部分成功も、永続化できた状態を必ず開いた tab へ broadcast し、
  応答では失敗を報告する。storage 全体の prefix 探索で無関係な key を消さない。
- 評価依頼は popup mount 時に復元済み hero の dealt-in hands で eligibility を判定する。
  不明・不正 hero、clock skew 等の不確実性は非表示へ倒す（MUST）。per-hand counter や
  ingestion hook は増やさず、閾値と snooze は `constants/review-prompt.ts` を使う。
- `reviewPrompt` は background 単一 writer。rated / dismissed は terminal、後の later
  で復活させない（MUST）。eligibleSince は一度 latch したら全データ削除でも戻さない。
  popup の banner は durable acknowledge 後にだけ閉じ、評価 tab もその後に開く。
- 評価依頼には badge・notification・HUD surface を設けない（MUST NOT）。rebuild、
  pending update、min-version block があれば抑止し、popup mount 後の変化にも追従する。
