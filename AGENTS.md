# AGENTS.md — PokerChase HUD

PokerChase の Chrome MV3 拡張。すべての開発・レビューエージェントに適用する入口。
機能概要と起動方法は [README.md](README.md)、開発・検証手順は
[CONTRIBUTING.md](CONTRIBUTING.md) を正本とする。

## 作業に必要な範囲を読む

変更・レビュー対象の祖先ディレクトリにある `AGENTS.md` を適用する。
自動読込のないハーネスでも同じ範囲を読む。別ディレクトリの呼び出し元・利用側へ
影響する変更では、その契約も確認する。以下の参照は対象部分だけを読み、全資料の通読は不要。

| 対象 | 規約・正本 |
|---|---|
| `src/` 全般、派生データ・イベント・保存境界 | [src/AGENTS.md](src/AGENTS.md) |
| 取り込み・更新・長時間処理 | [src/background/AGENTS.md](src/background/AGENTS.md) |
| 同期・認証・履歴の読取り | [src/services/AGENTS.md](src/services/AGENTS.md) |
| HUD・ハンドログ・popup | [src/components/AGENTS.md](src/components/AGENTS.md) |
| 統計定義・分母・勝者・ストリート | [docs/statistics.md](docs/statistics.md)（旧 Confirmed Statistical Definitions） |
| ワイヤ形式・正常な欠落・カード/チップ意味論 | [docs/api-events.md](docs/api-events.md) |
| Lake・ACTIVE port・統計台帳・replay の設計根拠 | [docs/architecture.md](docs/architecture.md) |
| replay の取得・可視性 | [docs/replay-api.md](docs/replay-api.md) |
| 帳票出力 | [docs/pokerstars-export.md](docs/pokerstars-export.md) |
| 実ブラウザ検証 | [e2e/README.md](e2e/README.md) |
| Firebase の設定・同期診断 | [docs/firebase-setup.md](docs/firebase-setup.md) |
| telemetry | [docs/observability.md](docs/observability.md) |
| リリース・署名・ストア開示 | [docs/chrome-web-store-release.md](docs/chrome-web-store-release.md) |
| cloud writer の公開・本番反映 | [内容IDの公開条件](src/services/AGENTS.md#cloud-rollout) |
| ファイル探索 | [docs/file-organization.md](docs/file-organization.md) |

## 作業規約

<a id="language"></a>

- 対話・レビュー・UI文言・新規ドキュメントは日本語で書く。既存文書の本文を部分編集
  するときは、その文書の言語を維持する。この AGENTS 群は意図的に日本語へ統一している。
- 新規・編集するコードコメントは日本語で書く。既存のコメントを遡及的に一括翻訳する
  必要はない。既存文書の言語維持規則を、英語のコードコメントを追加する根拠にしない。
- commit と PR title は Conventional Commits、本文・説明は日本語。
  type/scope と `BREAKING CHANGE:` は ASCII のままにする。
  Release Please が解析する括弧は改行をまたがせない。
- 実装・テスト・意味論の参照先を同じ変更で整合させる。機能一覧、コマンド、障害履歴を
  この入口へ追記せず、既存の正本か対象ディレクトリの短い規約を更新する。
- 検証手順は CONTRIBUTING の「Submitting Your Contribution」と「Verifying Against
  Real Data」。通常は `npm run typecheck`、`npm test`、`npm run build`、ブラウザ表示の
  変更は該当 E2E を実行する。文書・コメントのみの変更はリンク・適用範囲・内容整合を
  検証し、実行していないコード検証を実施済みと報告しない。
- `PokerChaseService` を生成するテストは `trackServiceForTeardown()` で登録する（MUST）。
  詳細と同一テスト内の破棄は CONTRIBUTING の「Test conventions」。

<a id="requirement-keywords"></a>

### 要件語（Requirement Keywords）

規約はこの AGENTS 群と CONTRIBUTING に置き、仕様の説明・証拠は `docs/` に置く。
MUST / MUST NOT は必須・禁止、SHOULD / SHOULD NOT は理由を示して逸脱できる既定、
MAY は任意（RFC 2119 / RFC 8174、大文字のみ）。通常の命令文も指示として扱う。
新しい禁止・不変条件には対応する大文字の要件語を添える。日本語コメントも同様。

## データ・公開の境界

- 識別子を含み得る生 payload、クエリ結果、受信時刻を issue・PR・チャット・共有ログへ
  貼らない（MUST NOT）。必要な抜粋だけを
  [掲載・匿名化方針](docs/api-event-examples.md#掲載匿名化方針) に従って匿名化する。
- Sentry へ raw API event、プレイヤー名、account ID、チャット、Firebase document path、
  auth object、token を添付しない（MUST NOT）。schema 診断は `buildSchemaDiagnostic()`
  で生成する（MUST）。`SENTRY_AUTH_TOKEN` は build secret として扱い、commit しない。
- Sentry ingest origin は `optional_host_permissions` に維持する（MUST）。telemetry を
  有効にする公開版、および replay import を popup へ露出する公開版は、それぞれストア
  runbook の開示手順を submission 前に完了する（MUST）。replay の storage flag のみの
  実験実装と、ユーザーに見える操作の公開は区別する。
- CRX 署名鍵を repository や Google account に保管しない（MUST NOT）。署名・backup は
  ストア runbook に従う。生成物は commit しない（対象は CONTRIBUTING）。
- 本番 Firebase rules の deploy と `/config/client` の作成・変更は
  [owner のみが行う外部 gate](src/services/AGENTS.md#production-firebase-authority) であり、
  agent session から実行しない（MUST NOT）。
- 公開 GitHub Release は日本語の概要・主な更新から始め、生成された PR/commit 履歴は
  後段の「技術的な変更一覧」に残す（MUST）。作業手順はストア runbook の release-notes。

## レビューと障害診断

- 非自明な Codex 起点 PR は merge 前に明示 `@codex review` を受ける（MUST）。自動
  per-push review は無効。同一 head への再 mention は禁止（MUST NOT）。指摘は1ラウンド
  分をまとめて修正・pushし、必要なら新 head をレビューする。共有利用枠を消費するため、
  応答待ちは単一の bounded shell wait を使い、モデルターンで busy-poll しない。
  harness ごとのレビュー運用はユーザー側の規約・skill を優先する。
- CI 成功、レビュー承認、merge、release、ストア配布・本番反映は別々に確認する。
- データ欠落の診断では観測地点と区別不能な仮説を明示する（MUST）。local Lake は
  validation 前、Firestore/BQ は validation 後。cloud の穴だけでは未受信と検証落ちを
  区別できず、Lake の不在も server 非送信・hook 非稼働・保存失敗を区別しない。
  直接観測を優先し、機序は反証可能な予測として異なる観測経路でも確かめる。
- イベントの欠落・連続性を指摘する前に API 正本の正常仕様と照合する（MUST）。
  BB action skip、timeout FOLD 不送信、all-in runout の DEAL_ROUND 省略、spectator DEAL、
  SESSION_DETAILS 不在を壊す厳格な連続性検査を追加しない。保存順の並べ替えと実到着順を
  混同せず、未観測の同時多卓・到着逆転を前提に複雑化しない。
