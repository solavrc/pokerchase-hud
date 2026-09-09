# services/ の開発・レビュー規約

[src 共通規約](../AGENTS.md) に加えてこのディレクトリへ適用する。
Lake の三要素 cursor・fresh Dexie query・replay 順序は src 共通規約を参照。
認証・deploy・同期診断の手順は [firebase-setup.md](../../docs/firebase-setup.md)。

## 同期・認証

<a id="cloud-identity"></a>

- 旧 `timestamp_ApiTypeId` / `timestamp_ApiTypeId_sequence` document は読取り互換を維持し、
  新規保存は sequence を除く canonical content の SHA-256による
  `timestamp_ApiTypeId_h_sha256` 内容IDを使う（MUST）。
  upload は同内容を確認するか、`currentDocument.exists=false` で create する。ローカル
  再採番を根拠に既存の別 payload を上書きしない（MUST NOT）。旧IDと内容IDの同内容行が
  移行時に残ることはあるが、以後の復元・upload で同内容の複製を増殖させない。
- 内容IDが保証するのは内容保持と同内容の重複計上防止。失われた元の因果順や端末間の
  統計一致まで保証したと説明しない（MUST NOT）。同じ cloud 集合でも既存 local slot の
  違いで相対順と順序依存の統計が変わり得る。詳しくは architecture の順序の観測限界。
- cloud upload は現在 parse できる application event だけ。noise / unknown は local に
  残して raw chunk cursor を進めるが、application type の parse 失敗は recoverable
  として `syncUnparseableFloor` に保持し、後の schema 修正でも再提示する（MUST）。
  cursor / sync 完了時刻で未解決行を永久に追い越さない。
- upload は増分、download は全履歴。自動 upload は session-end 309 と開始201/308の
  独立 trigger を同じ backlog threshold / in-flight guard に通す。同期のための periodic
  timer は追加しない（MUST NOT）。現在の値・保存形式は実装と Firebase 正本を参照。
- auth flow は `firebaseAuthService.ready()` 後、最初の token 取得より前に
  `authGeneration` を snapshot し、refresh、401 retry、sync bookkeeping の各 commit
  点で一致を再確認する（MUST）。uid 比較だけでは A→B→A を検出できない。不一致では
  commit せず中止する。cross-account upload の既知残存リスクを、watermark の汚染まで
  許す根拠にしない。
- token 取得・refresh を含む auth await は transport timeout で bound する（MUST）。
  retry class ごとの owner は1層に揃え、429 等の retry を複数層へ重ねない。
- auth の cached-first 表示は background で再確認する。cache を認証の正典にしない。
- min-version gate は cloud sync の共通入口でだけ enforce し、HUD を止めない（MUST）。
  network / HTTP / missing document / malformed data は supported に倒す。公開 read は
  `config/client` のみに限定し、client write を許さない。

<a id="production-firebase-authority"></a>

### 本番 Firebase の権限境界

- production project `pokerchase-hud` への `firebase/firestore.rules` deploy と
  `/config/client` の作成・変更は owner follow-up であり、agent session から実行しない
  （MUST NOT）。rules の merge / emulator 成功を production deploy 済みと扱わない。
  document が未作成なら min-version gate は fail-open するため、agent が障害として seed
  しない。fork / self-host と local emulator の手順・target 確認は Firebase 正本に従う。

<a id="cloud-rollout"></a>

### 内容IDの公開条件

- 新 writer の公開前に API event の immutable-payload rules を owner が本番へ適用する
  （MUST）。owner の read/create/delete、同内容またはトップレベル sequence だけの
  update は維持し、旧 client の別 payload upsert も拒否する。rules の merge / emulator
  成功を production deploy 済みと扱わない。
- poker-warehouse の同内容 dedup / 異内容 sequence collision 対応を merge し、`run.yml`
  で本番反映してから、または同時に content-ID の本番書込みを始める（MUST）。HUD-local
  の dedup だけでは warehouse の正確さを証明しない。deploy と公開の承認・反映確認は
  それぞれ既存手順に従う。詳細は [architecture.md](../../docs/architecture.md)。

<a id="recent-hands"></a>

## 直近ハンドの読取り

- 対象は `hand.seatUserIds` に player がいる dealt-in hands のみ（MUST）。`-1` は
  empty sentinel。表示件数は aggregate の `handLimitFilter` と独立させる。cache は
  unfiltered の assembly window を持ち、参加 filter → display limit の順に適用する。
  limit ごとの重複 cache は作らない。
- Results の相手カードは showdown participant（rank 0–9 / SHOWDOWN_MUCK）かつ有効
  カードだけ。hero の配札は Lake の必要 field だけを検証して読む（MUST）。その読取りを
  イベント全体の Zod 成否で遮断しない。`approxTimestamp` と同一 lineup で照合し、
  `SeatUserIds[Player.SeatIndex]` が対象 hero であることも再検証する。
- hero 判定は最初の await 前に1回 snapshot し、cache key と Lake 読取りへ同じ値を渡す。
  replay projection は Results が空欄の行だけを補い、showdown gate をかけず exactly two
  valid cards を確認する（MUST）。非開示を推定で埋めない。詳細は
  [replay-api.md](../../docs/replay-api.md)。
- preflop label と prior bet count は `resolveEffectiveActionType()` を使う（MUST）。
  `ALL_IN` 付き行の cumulative bet が相手の既存最大以下なら call、超えれば aggressive。
  preflop 比較は BB を初期値に含める。`ALL_IN` がない明示 type は再解釈しない。
- label は最後の action、額はその label を作った action のもの。taxonomy と数値表示を
  分離し、`-F` を street separator の `/F` に変えない。cold-call family は対峙した bet
  数で区別する。これらは read-time 導出で、DB / export / cloud に保存しない。
- bet sizing は同一 player/street の cumulative bet の増分を分子とし、
  `potBefore = pot + sum(sidePot) - increment` とする（MUST）。変更は成立した hand の
  settlement 恒等式で母集団を絞って実データと照合する。field 名だけから推測しない。
- 「参加のみ」は first Fold / Walk でも `sawFlop` / showdown があれば残す（MUST）。
  BB Check と不明 label も残す。BB action skip や forced all-in を label だけで消さない。
- netChips は保存済み chip accounting を使い、不明値は null。board は phase の累積
  communityCards の最長配列。読取りの batched query を per-hand N+1 に戻さない。
