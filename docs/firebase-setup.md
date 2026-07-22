# Firebase Setup & Cloud Sync Guide

Firebase認証、Firestoreバックアップ、BigQueryミラーの現行構成と、forkで別projectを使う場合の設定手順をまとめる。

> [!CAUTION]
> このrepositoryはproduction project `pokerchase-hud` のFirebase config、OAuth client、
> manifest key、`.firebaserc`を既定値として持つ。`npm run firebase:deploy*`も既定では同projectを
> 対象にする。fork / self-host環境では、後述の3箇所を差し替え、CLIのtargetを確認するまで
> deployしないこと。本書の監査ではlive auth設定・rules deploy状態・Extension稼働状態を変更も
> 再デプロイもしていない。

## 現行アーキテクチャ

MV3 bundleにはFirebase JavaScript SDKを含めていない。Chrome Web Storeのremote-code scannerに
誤検出され得るloaderを避けるため、次のREST経路を使う。

- Google OAuth: `chrome.identity.getAuthToken()`
- Firebase sign-in / token refresh: Identity Toolkit REST / Secure Token REST
- Firestore read / write: Firestore v1 REST（`:runQuery`, `:runAggregationQuery`, `:commit`）
- 認証状態: Firebase ID token / refresh tokenを`chrome.storage.local`へ保存
- local正本: IndexedDB `PokerChaseDB.apiEvents`（Raw Event Lake）

実装は `src/services/firebase-auth-service.ts`、`firebase-config.ts`、
`firestore-backup-service.ts`、`auto-sync-service.ts` を参照する。

### Firestore data model

```text
/users/{firebaseUid}
  lastSyncTimestamp: number | null
  lastSyncTime: string | null
  /apiEvents/{eventId}
    timestamp: number
    ApiTypeId: number
    sequence: number
    ...wire payload fields

/config/client
  minSupportedVersion: string  # read by min-version-gate.ts
```

`eventId`は`sequence=0`ならlegacy互換の`timestamp_ApiTypeId`、1以上なら
`timestamp_ApiTypeId_sequence`。`/users/{uid}`とsubcollectionは本人だけがread/writeできる。
`/config/client`は未認証clientにもread-onlyで、client writeは拒否する。正確なruleは
[`firestore.rules`](../firestore.rules)を正本とする。

## Fork / self-host projectの設定

既存production構成を使う通常buildではこの節の変更は不要である。別Firebase projectを使う場合は
必ず次を一組として変更する。

1. Firebase projectを作成し、Google providerのAuthenticationとFirestore `(default)` databaseを有効化する。
2. Web app configを`src/services/firebase-config.ts`へ設定する。
3. Chrome Extension用OAuth clientを作成し、`manifest.json`の`oauth2.client_id`を差し替える。
4. `.firebaserc`の`projects.default`をfork側projectへ変更する。
5. `npm run build`後、unpacked extensionのIDとOAuth clientの対象IDが一致することを確認する。
6. rules / indexesをdeployする場合は、Firebase CLIが別途install・login済みであることと、
   `firebase use` / `.firebaserc`のtargetがfork側であることを確認する。

```bash
# rulesだけ
npm run firebase:deploy:rules

# rulesとindexes
npm run firebase:deploy

# local Firestore emulator
npm run firebase:emulators
```

`firebase-tools`はこのrepositoryのdependencyではない。上記scriptは環境にあるFirebase CLIを呼ぶ。

### Extension IDとOAuth client

現行`manifest.json`は公開鍵`key`を含むため、同じmanifestをunpackedで読み込む場合もextension IDを
安定させる構成である。productionはchecked-in OAuth clientを1つ使い、環境別manifestや
dev/staging/prod自動切替は実装していない。forkでkeyまたはChrome Web Store listingが変わり
extension IDが別になる場合、そのID用のOAuth clientを用意する。

必要なmanifest設定:

```json
{
  "permissions": ["identity"],
  "host_permissions": ["https://*.googleapis.com/*"],
  "oauth2": {
    "client_id": "your-client-id.apps.googleusercontent.com",
    "scopes": [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile"
    ]
  }
}
```

## Cloud sync contract

### Upload

1. Firestoreの最大`timestamp`をqueryし、基本watermarkにする。
2. local Raw Event Lakeを`[timestamp+ApiTypeId+sequence]`のcompound cursorで5,000行ずつscanする。
3. 9種のschema-valid application eventだけをupload候補にする。非application / unknown eventは
   localには残るがcloudへ送らない。application typeなのに現schemaでparseできない行は
   `unparseable floor`を永続化して保留し、後のschema修正後に再提示できるようscanを巻き戻す。
4. 300 writes/batchをtimestamp coverage順に直列でFirestore `:commit`へupsertする。後続batchは
   直前batchのacknowledge後だけ開始し、古いbatch失敗時に新しいtimestampだけが先にwatermarkを
   進めない。同一millisecondがbatch境界を跨ぐ場合は、次回その最大timestamp群をまとめて再提示する。
   document IDが決定的なので、acknowledge済み行の再送は同じdocumentを更新する。
5. Firestoreが全writeをacknowledgeした後だけfloorと同期完了時刻を進める。

ログの母集団を混同しないこと。`raw events` / `scan snapshot`はlocal Lakeで走査する全行、
`valid application`はvalidation通過行、`acknowledged Firestore writes`は実際にcommitされた行である。
例えば「1,023 raw rowsをscanし695 writesをacknowledge」は、それだけで308件の欠損を意味しない。
残りには同期対象外noise、unknown、schema修正待ちの保留行、watermark巻き戻しで再確認した既存行が
含まれ得る。pass終端の分類別summaryを確認する。

### Download

1. signed-in userの`apiEvents`全documentを`timestamp, __name__`順に1,000件ずつ取得する。
2. payload全体（top-level `sequence`を除く）のcanonical contentでlocal Lakeへmergeする。
   旧documentのmissing sequenceは0として扱い、新形式のsequenceは空きslotなら保持する。
3. local-only行は削除しない。cloudはdownload対象だがlocal Lakeを置換する「唯一の正本」ではない。
4. merge後、同じ`EntityConverter` instanceの`convertEventChunk()`でderived tablesを再構築し、
   session/player stateと統計を復元する。途中pageでdownloadが失敗しても、既に保存したraw rowsに
   対してrebuildを試みたうえでsync全体はerrorにする。

### Trigger

- accountごとの初回sign-in: uid-scopedの完了時刻がない場合にbidirectional sync
- `EVT_SESSION_RESULTS`（309）: primary upload trigger
- `EVT_ENTRY_QUEUED`（201）/ `EVT_SESSION_DETAILS`（308）: 309欠落時の次session fallback trigger
- popup: upload / downloadを明示実行

自動triggerは「前回の完了時刻より後のraw rowsが100件以上」を同期実行のheuristicに使う。
この件数にはcloudへ送らないnoiseも含まれ、実upload cursorや請求対象件数ではない。定期pollingは行わない。

## BigQuery mirror

productionのFirestore→BigQuery経路は、Firebase Extension
[`firestore-bigquery-export`](https://github.com/firebase/extensions/tree/next/firestore-bigquery-export)による
realtime incremental mirrorである。Firebase Consoleの標準daily exportではない。

- collection path: `users/{userId}/apiEvents`
- dataset: `firestore_export`
- change history table: `apiEvents_raw_changelog`
- latest-state view: `apiEvents_raw_latest`
- dbt staging: `stg_pokerchase.events`ほか（`poker-warehouse`が日次構築）

Extensionの`timestamp`はFirestore変更のingestion時刻であり、PokerChase event受信時刻は
JSON `data.timestamp`である。latest-state viewの行identityは`document_name`。

```sql
SELECT
  SAFE_CAST(JSON_VALUE(data, '$.ApiTypeId') AS INT64) AS api_type_id,
  COUNT(*) AS latest_documents,
  COUNT(DISTINCT REGEXP_EXTRACT(
    document_name, r'(?:^|/)users/([^/]+)/apiEvents(?:/|$)'
  )) AS observer_count,
  MIN(TIMESTAMP_MILLIS(SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64))) AS first_event,
  MAX(TIMESTAMP_MILLIS(SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64))) AS last_event
FROM `pokerchase-hud.firestore_export.apiEvents_raw_latest`
WHERE SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64) IS NOT NULL
GROUP BY api_type_id
ORDER BY api_type_id;
```

### Firebase Extensions廃止への対応

現行production経路はまだ上記Extensionで、自己管理Functionsへの移行は完了していない。
追跡は[Issue #206](https://github.com/solavrc/pokerchase-hud/issues/206)を正本とする。issueには
2026年9月に移行資料・tool公開予定、2027-03-31以降はinstall/redeploy/config変更/patchが不可に
なる旨が記録されている。`firebase.json`と`npm run firebase:deploy*`はrules / indexesだけを扱い、
Extensionをdeployしない。

Issue本文にある`GEN_2, ACTIVE`は2026-07-21時点の観測記録であり、この文書監査ではlive cloudを
再照合していない。現在のversionや稼働状態をrepository configから推定しないこと。

## Cost and quota

固定の「典型ユーザーはfree tier内」やpayload bytesだけの容量見積もりは使わない。Firestoreは
document field名、metadata、single/composite indexもstorageへ計上し、syncの巻き戻しはidempotentでも
write課金になり得る。ConsoleのUsage / Billingで実測する。

- [Cloud Firestore pricing](https://firebase.google.com/docs/firestore/pricing) — document reads/writes/deletes、index reads、storage、network。free quotaはproject内の1 databaseだけ
- [BigQuery pricing](https://cloud.google.com/bigquery/pricing) — query bytes、storage、streaming等。dry-runでquery bytesを事前確認する
- [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) — Authを含むplan条件

## Troubleshooting

### Authentication

- OAuth clientが現在のextension IDを許可しているか確認する。
- `identity` permission、Google profile/email scopes、`*.googleapis.com` host permissionを確認する。
- Service Worker consoleの`[FirebaseAuth]`ログとHTTP statusを確認する。
- token refresh後も401が続く場合はsign out/inし、project / OAuth clientの組合せを再確認する。

### Firestore REST timeout / 429 / 5xx

全REST requestは30秒timeout、network/timeout/429/5xxに最大2回（500ms、1,000ms）のbackoff retry、
401にtoken force-refresh 1回を持つ。既定retry後も`Firestore REST request failed`が続く場合に限り、
quota、rules、network、batch size / retry設定を調査する。permission denied等の非retryable 4xxは即時errorになる。

### Popupと同期状態が一致しない

1. popupとService Worker consoleで同じpassの`[AutoSync]`、`[Firestore]`ログを追う。
2. `scanned raw`、`valid application`、`acknowledged Firestore writes`、
   `filtered non-application/unknown`、`deferred unparseable application`を分類ごとに確認する。
3. popupのpending数はraw-row heuristicであり、実upload件数と一致する契約ではない。
4. partial download / rebuild errorではRaw Event Lakeは残るため、原因解消後にmanual downloadまたは
   「データ再構築」を実行する。

### Repository-side checks

module内部の`firebaseAuthService`や`firestore`はconsole globalではない。存在しないSDK APIを
DevToolsから直接呼ぶ代わりに、実装とtestを使う。

```bash
npm test -- src/services/firebase-auth-service.test.ts
npm test -- src/services/firestore-backup-service.test.ts
npm test -- src/services/auto-sync-service.test.ts
npm run typecheck
npm run build
```

rulesを変更した場合はemulator testを追加し、deploy前に差分とtarget projectを再確認する。
