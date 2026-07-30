# Chrome Web Store release

Chrome Web Store の「検証済み CRX アップロード」を有効にした後は、すべての
パッケージ更新を登録済みの RSA 秘密鍵で署名した CRX として提出する。

リリース状態は次の3段階を分けて確認する。前段階が完了しても、後段階が自動的に
完了したことにはならない。

1. Release Please の release PR が main にマージされる
2. GitHub Actions が GitHub Release と `extension.zip` / `extension.crx` を作成する
3. Chrome Web Store Developer Dashboard で `extension.crx` を手動提出し、審査・公開する

## Sentry disclosure

Sentry error monitoring is an external data transfer. General errors send
sanitized crash metadata. API schema failures additionally send a bounded
poker-semantic event snapshot after the extension pseudonymizes direct player
identifiers and removes names, free text, credentials, and authentication or
session tokens.
Before submitting a telemetry-enabled release:

1. Chrome Web Store の説明と Privacy practices で、匿名化したクラッシュ情報
   （拡張バージョン、実行コンテキスト、スタック、スキーマ失敗箇所、
   個人識別子を仮名化した対局イベント値）を、信頼性改善とAPI変更への追従目的で
   Sentry へ送信することを明示する。
2. 既存ユーザーにも更新情報でデータ取扱いの変更を明示する。実際の送信は
   Popup の **診断情報を送信** をユーザーが有効にし、Chrome の
   optional host permissionを許可した後だけ開始する。
3. 公開中の [privacy policy](../PRIVACY.md) に収集項目、用途、Sentry への送信、
   保持・削除方針を反映し、Developer Dashboard の専用 URL 欄と Popup の
   診断情報セクションから到達できることを確認する。公開 URL は
   `https://github.com/solavrc/pokerchase-hud/blob/main/PRIVACY.md` とする。
4. repository secret `SENTRY_AUTH_TOKEN` が、個人 OAuth token ではなく
   最小権限の Sentry organization token（CI/source-map upload 用）であることを
   確認する。

詳細なクライアント側の除外項目と検証手順は
[`docs/observability.md`](observability.md) を参照する。

Sentry ingest originは`optional_host_permissions`で宣言する。requiredの
`host_permissions`へ移すと、権限警告を伴う更新で既存インストールが無効化され、
ユーザーの再承認までHUD全体が停止し得るため禁止する。

## Signing key

- 秘密鍵はリポジトリや Google アカウントに保存しない。
- GitHub Actions では repository secret `CWS_CRX_PRIVATE_KEY` から読み込む。
- Developer Dashboard の **Package > Verified CRX Uploads** には、対応する公開鍵だけを登録する。
- 秘密鍵を紛失すると Chrome Web Store support に鍵の交換を依頼する必要があるため、
  GitHub Actions とは別の安全な keystore にもバックアップする。

2048-bit RSA 鍵と公開鍵は次のように生成できる。

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out privatekey.pem
openssl rsa -in privatekey.pem -pubout -out publickey.pem
```

秘密鍵を repository secret に登録する。

```sh
gh secret set CWS_CRX_PRIVATE_KEY < privatekey.pem
```

## Release artifact

Release Please がリリースを作成すると、workflow は通常の `extension.zip` に加えて
署名済みの `extension.crx` を GitHub Release に添付する。Chrome Web Store の更新には
`extension.crx` をアップロードする。この workflow は Chrome Web Store への提出・公開を
行わない。Developer-mode でのインストールには GitHub Release の `extension.zip` を使い、
`extension.crx` は検証済み CRX アップロード用の成果物として扱う。

提出前に、ソース・GitHub Release・Developer Dashboard のバージョンをそれぞれ確認する。

```sh
jq -r .version manifest.json
gh release view pokerchase-hud-vX.Y.Z --json tagName,publishedAt,assets
```

Developer Dashboard ではアップロード後のバージョン、審査状態、公開状態を確認する。
GitHub Release が存在することだけをもって、Web Store 公開済みとは記載しない。

ローカルで同じ CRX を作成する場合は、先に通常の build を行い、秘密鍵のパスを渡す。

```sh
npm run build
npm run pack:crx -- /path/to/privatekey.pem
```
