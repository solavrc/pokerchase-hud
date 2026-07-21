# Chrome Web Store release

Chrome Web Store の「検証済み CRX アップロード」を有効にした後は、すべての
パッケージ更新を登録済みの RSA 秘密鍵で署名した CRX として提出する。

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
`extension.crx` をアップロードする。

ローカルで同じ CRX を作成する場合は、先に通常の build を行い、秘密鍵のパスを渡す。

```sh
npm run build
npm run pack:crx -- /path/to/privatekey.pem
```
