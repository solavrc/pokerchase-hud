# Changelog

## [4.2.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v4.1.0...pokerchase-hud-v4.2.0) (2026-03-26)


### Features

* サイドポット表記をPokerStars形式に準拠 + エッジケース修正 ([#78](https://github.com/solavrc/pokerchase-hud/issues/78)) ([5a8639e](https://github.com/solavrc/pokerchase-hud/commit/5a8639ec931779b4395e12c5e6d410b9c4438825))


### Bug Fixes

* @types/chrome更新に伴う型エラーを修正 ([a8c4187](https://github.com/solavrc/pokerchase-hud/commit/a8c4187d6c1a393ceef863048a9f0f572011feea))
* @types/chrome更新に伴う型エラーを修正 ([7dc4ea1](https://github.com/solavrc/pokerchase-hud/commit/7dc4ea1dd2a581ba5ef0a8e31230fedf83774e4c))
* BBアンテオールイン（BB未投稿）ハンドをスキップ ([fddb9b6](https://github.com/solavrc/pokerchase-hud/commit/fddb9b60e805097518075c0ad0ac746e3e1c6eef))
* BBアンテオールインのスキップを解除 ([e93e403](https://github.com/solavrc/pokerchase-hud/commit/e93e4033487b3a9c8634bc0889b6a04f8c2cbcee))
* BBアンテオールインはシンプルにスキップ ([45c87ca](https://github.com/solavrc/pokerchase-hud/commit/45c87ca61eea156702440c82ad3b17115b884505))
* BBアンテオールイン時にBB優先配分で出力 ([6ff1ea2](https://github.com/solavrc/pokerchase-hud/commit/6ff1ea2d231336812ba14ade0d3073e1c3e8b417))
* BBアンテオールイン時のSB callをcheckに変換 ([d547c39](https://github.com/solavrc/pokerchase-hud/commit/d547c3977d9f17bed25b2aa4135ee095271ee57e))
* BB全チップ &lt; SB額のハンドをスキップ ([46af8c2](https://github.com/solavrc/pokerchase-hud/commit/46af8c24e84ce2f3f4d7d2e24c117fdc63d5a6fb))
* chrome.offscreen APIでWorkerを維持 ([720d307](https://github.com/solavrc/pokerchase-hud/commit/720d307988d7295c10cad986a598c76baa61c7e4))
* **deps:** update dependency react-window to v2 ([#62](https://github.com/solavrc/pokerchase-hud/issues/62)) ([03f63e9](https://github.com/solavrc/pokerchase-hud/commit/03f63e98f4ae165c5dd7b3b7ac67b7c404c05088))
* **deps:** update material-ui ecosystem to v7 ([#71](https://github.com/solavrc/pokerchase-hud/issues/71)) ([009a543](https://github.com/solavrc/pokerchase-hud/commit/009a543ca1d34de1b71c1c8402cae12c7be6815e))
* **deps:** update react ecosystem to v19 (major) ([#72](https://github.com/solavrc/pokerchase-hud/issues/72)) ([c6a452b](https://github.com/solavrc/pokerchase-hud/commit/c6a452b1bc776d39c7987798b8f1499ae2ebbb48))
* getPlayerChipsのPotベース推定を復活 ([88b41e8](https://github.com/solavrc/pokerchase-hud/commit/88b41e881a324036da91ceb8286ff78c0bb58092))
* getPlayerChipsをシンプルなロジックに戻す ([9babad3](https://github.com/solavrc/pokerchase-hud/commit/9babad3a8da46817de68c0dc1d9afc1142489abc))
* HUでBBアンテオールインのハンドをスキップ ([445c7ba](https://github.com/solavrc/pokerchase-hud/commit/445c7ba7dc81898704b84cefd95c378aefb58c96))
* keepAliveをchrome.runtime.getPlatformInfoに変更 ([32fff2c](https://github.com/solavrc/pokerchase-hud/commit/32fff2cbe1546ca05c56b4fcd0892469950bd772))
* npm audit脆弱性を修正 (picomatch, yaml) ([#76](https://github.com/solavrc/pokerchase-hud/issues/76)) ([8bde5ce](https://github.com/solavrc/pokerchase-hud/commit/8bde5cec2ba7bd6866cae2d4296cd392bf64eb15))
* PokerStars形式エクスポートのエッジケース修正 ([2320ff1](https://github.com/solavrc/pokerchase-hud/commit/2320ff112928d3776126d0435a1cb866eb3f5caa))
* PokerStars形式エクスポートのエッジケース修正 ([f03b19c](https://github.com/solavrc/pokerchase-hud/commit/f03b19c81d67a20dfaf281f6905876f0204fa5d7))
* アンテショートオールインの実額計算 ([6368ecb](https://github.com/solavrc/pokerchase-hud/commit/6368ecbaabe8096adbc2fead43859f74b207dae5))
* エクスポートループでイベントループに制御を返す ([8275bcf](https://github.com/solavrc/pokerchase-hud/commit/8275bcf8dd1014a178fdd9ba3688bbc4bdf83a73))
* エクスポート中のService Workerアイドル停止を防止 ([f159bd2](https://github.com/solavrc/pokerchase-hud/commit/f159bd2a6902dbfe3923921b4098950e12de5fa8))
* エクスポート中のService Workerアイドル停止を防止 ([#48](https://github.com/solavrc/pokerchase-hud/issues/48)) ([f9f17d7](https://github.com/solavrc/pokerchase-hud/commit/f9f17d7d5f868b8b2a6ede1878859facb1e33b83))
* サイドポット時の collected/Summary をPS形式に準拠 ([8b445be](https://github.com/solavrc/pokerchase-hud/commit/8b445be639033302d3dc5d7541bd9ec23670b892))
* トーナメントIDにセッション内最小のハンドIDを使用 ([a9dc536](https://github.com/solavrc/pokerchase-hud/commit/a9dc536cee66d43d6e1b2d1970295064f65199f2))
* トーナメントIDのプリパス計算 ([97f122d](https://github.com/solavrc/pokerchase-hud/commit/97f122ddafc1c0633ee4f121c422c05e5304d9e3))
* トーナメントIDをセッション内の最初のハンドIDで統一 ([ca07aa3](https://github.com/solavrc/pokerchase-hud/commit/ca07aa3f7c896ba874ebe1dd190fd73f9bdf724b))


### Reverts

* サイドポット表記を元の形式に戻す ([4fcc9d3](https://github.com/solavrc/pokerchase-hud/commit/4fcc9d3435bffe820b347e23806dcd912931f451))

## [4.1.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v4.0.0...pokerchase-hud-v4.1.0) (2026-03-24)


### Features

* **stats:** add river call accuracy (RCA) statistic ([272f9bd](https://github.com/solavrc/pokerchase-hud/commit/272f9bdeb989376f8d51897a48bab3ccd0fc395d))
* **ui:** add progress indicators and double-click prevention for export/rebuild ([4816f4a](https://github.com/solavrc/pokerchase-hud/commit/4816f4a892a4e5ae231de2d2284a90a7e2f2c3ae))
* スキーマ差分検知ツール追加 (npm run schema-diff) ([7524890](https://github.com/solavrc/pokerchase-hud/commit/752489068f4c3df1b1d5562714e5290d154d4aee))


### Bug Fixes

* baseSchema を strict() → passthrough() に変更 ([a8cf72e](https://github.com/solavrc/pokerchase-hud/commit/a8cf72e9fdc8c9c3ce9fff15ee42fc0a8d2bf33d))
* CBetFold判定修正 + expected値を仕様ベースで再構築 ([636fde8](https://github.com/solavrc/pokerchase-hud/commit/636fde8595e9d0252412e63e4a3af080fce48050))
* EVT_PLAYER_SEAT_ASSIGNED スキーマに WaitTableType を追加 ([d2b934e](https://github.com/solavrc/pokerchase-hud/commit/d2b934e837f25e959641340fcd40e20c69b3d42f))
* EVT_SESSION_RESULTS スキーマに新規プロパティ追加 ([24a9c1b](https://github.com/solavrc/pokerchase-hud/commit/24a9c1b16c4823a26922d3636ac5f78f5948c1a4))
* EVT_SESSION_RESULTS.TableId の型を string | number に修正 ([cda9e2c](https://github.com/solavrc/pokerchase-hud/commit/cda9e2c5e4fc44c774fcc492219c1388723b0fb7))
* **log:** downgrade hand export errors to warnings ([2c75670](https://github.com/solavrc/pokerchase-hud/commit/2c756707d04d8c2bd39d51bf2a87309bac87f921))
* PokerStars形式ハンドログのフォーマット修正 ([e2fd460](https://github.com/solavrc/pokerchase-hud/commit/e2fd460df8974fd69705dc6832fdbb1e77ab8b0f))
* **ui:** block concurrent operations in background + add debug log ([2bffc00](https://github.com/solavrc/pokerchase-hud/commit/2bffc008e2fc036c92e96352fe7443e9eed73e9a))
* **ui:** cache Firebase auth state for instant popup rendering ([32676f4](https://github.com/solavrc/pokerchase-hud/commit/32676f47aa95c5251a2ea762ab016ad618dbf921))
* **ui:** ensure exportState/rebuildState is set on processing messages ([35f77f5](https://github.com/solavrc/pokerchase-hud/commit/35f77f5be65c008fd475707f26a378de3826b6c9))
* **ui:** optimistically disable buttons on export/rebuild click ([2773a0b](https://github.com/solavrc/pokerchase-hud/commit/2773a0bf6618fe7bd2dfc78a36a3ad8ab861a9d2))
* エクスポートが10,000件で打ち切られる問題を修正 ([1dcf68a](https://github.com/solavrc/pokerchase-hud/commit/1dcf68a0ac00cc2e618a7ed613c8641504d06369))
* エクスポートのdata URLサイズ制限を解消 ([6d5a7c6](https://github.com/solavrc/pokerchase-hud/commit/6d5a7c657ee9bafac84bd8765f16a49e9b34b820))
* ハンドログの金額計算修正 + PS形式エクスポート全セッション対応 ([3725832](https://github.com/solavrc/pokerchase-hud/commit/3725832625343da8ab936cb72df4f2e2ea73ba7a))
* 大容量エクスポートの64MiBメッセージ制限を回避 ([1eefd97](https://github.com/solavrc/pokerchase-hud/commit/1eefd975267ef747caee4e88d3fff60bb287051e))
* 未知ApiTypeIdイベントの内容をログ出力 ([7c1fb05](https://github.com/solavrc/pokerchase-hud/commit/7c1fb0567acc27c16e65fa56d53f9a06f593fd8a))


### Performance Improvements

* **export:** eliminate N+1 query pattern in exportMultipleHands ([2d66f09](https://github.com/solavrc/pokerchase-hud/commit/2d66f0986c407221c0ae8c63babc252b68626713))

## [4.0.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v3.0.0...pokerchase-hud-v4.0.0) (2025-07-24)


### ⚠ BREAKING CHANGES

* **popup:** Removed unsyncedCount from FirebaseAuthSection props
* **types:** Removed ApiEventType, ApiEventUnion exports. Use ApiEvent instead.
* **types:** Non-application API events (numeric ApiTypeIds) are now filtered out in background.ts
* **db:** Database migration v3 required. Existing databases will be automatically migrated on first run.

### Features

* **db:** optimize database indexes and introduce generic MetaRecord type ([b57c312](https://github.com/solavrc/pokerchase-hud/commit/b57c31220c559328d1664c24b71df568fe800d5d))
* **popup:** improve cloud sync UX and fix tab navigation ([6b02c14](https://github.com/solavrc/pokerchase-hud/commit/6b02c14e69dcacdf92c4cca6ccf8afa3113b0eea))
* **ui:** improve export/import button UX ([63f0dbe](https://github.com/solavrc/pokerchase-hud/commit/63f0dbe45cc4bfa6c17da9c411f19b336217f28b))


### Bug Fixes

* **components:** convert import paths to lowercase for case-sensitive filesystems ([6ff07b7](https://github.com/solavrc/pokerchase-hud/commit/6ff07b7994dc7242afa7c5ff8f9467bbf735f4ba))
* **types:** replace deprecated z.nativeEnum with z.enum ([22ed364](https://github.com/solavrc/pokerchase-hud/commit/22ed364069cd02ff0c0e047cfc427555bc8f82ec))


### Performance Improvements

* optimize toArray() usage with chunk processing and add common utilities ([f4f33b4](https://github.com/solavrc/pokerchase-hud/commit/f4f33b4ee4c202e319f5d09678d9b46e6be85678))


### Code Refactoring

* **types:** consolidate API types and embrace Zod Schema Way pattern ([b90f125](https://github.com/solavrc/pokerchase-hud/commit/b90f125c634572fa3ffc85ec10fc1c8ba230f54d))
* **types:** reduce type assertions using type guards ([141ec96](https://github.com/solavrc/pokerchase-hud/commit/141ec9642e5912c41efa5c85142d0c04d6cb3410))

## [3.0.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.5.0...pokerchase-hud-v3.0.0) (2025-07-24)


### ⚠ BREAKING CHANGES

* **hud:** Requires Firebase project setup and OAuth configuration

### Features

* **hud:** implement Firebase cloud sync with automatic backup ([c9062db](https://github.com/solavrc/pokerchase-hud/commit/c9062db99c5be388d46653b04ca2ab798f1404d2))
* **manifest:** add extension key for consistent ID across environments ([1a25ad9](https://github.com/solavrc/pokerchase-hud/commit/1a25ad9724d913a9f2045a7c60ef0ed9003f9d79))
* **popup:** switch to existing game tab when extension icon clicked outside game ([03a58e5](https://github.com/solavrc/pokerchase-hud/commit/03a58e5d6ec703b4c657914fa458d7e19ecdafbd))
* **ui:** improve popup layout and add manual sync controls ([d855e63](https://github.com/solavrc/pokerchase-hud/commit/d855e634708fe394b4a303ea142ee6efed9b4d36))


### Bug Fixes

* **background:** remove automatic data rebuild on extension update ([4b04831](https://github.com/solavrc/pokerchase-hud/commit/4b04831da9ab23f30cd4bb4ca383ce9dc3d25c70))
* **content:** suppress "Extension context invalidated" errors ([027ca3d](https://github.com/solavrc/pokerchase-hud/commit/027ca3d8d9f53117244f7a78c1ca063abab3326d))

## [2.5.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.4.0...pokerchase-hud-v2.5.0) (2025-07-23)


### Features

* **hud:** implement Chrome Storage persistence and Service Worker keepalive ([07f9cdb](https://github.com/solavrc/pokerchase-hud/commit/07f9cdb8880941adcb5ff700922360108e5e988e))


### Bug Fixes

* **hud:** PRレビュー指摘事項の修正 ([0605424](https://github.com/solavrc/pokerchase-hud/commit/0605424630da9a8438b1597612ab43f9341ca2ad))

## [2.4.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.3.0...pokerchase-hud-v2.4.0) (2025-07-16)


### Features

* **api:** implement Zod schema validation for API events ([ae91013](https://github.com/solavrc/pokerchase-hud/commit/ae9101376cd415882a824a6f204c054d4540c30b))

## [2.3.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.2.0...pokerchase-hud-v2.3.0) (2025-07-15)


### Features

* **hud:** display SPR and pot odds for all players ([37d5636](https://github.com/solavrc/pokerchase-hud/commit/37d563659dbedf27d9f5cd924efefc49638ca739))
* **realtime-stats:** add SPR (Stack to Pot Ratio) display ([2a7dc9e](https://github.com/solavrc/pokerchase-hud/commit/2a7dc9eb60c7ccfbd39b60b0741f2ac0a3c17cd1))
* **ui:** improve player name visibility and hand ranking display ([3d12f9a](https://github.com/solavrc/pokerchase-hud/commit/3d12f9a492a2120a4a4370a276d56f6fa95d82a1))


### Bug Fixes

* **hud:** fix player position misalignment and pot odds display format ([0959a8a](https://github.com/solavrc/pokerchase-hud/commit/0959a8a7e0b4dd11c77313352c3de7646a56542c))

## [2.2.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.1.0...pokerchase-hud-v2.2.0) (2025-07-15)


### Features

* **ci:** auto-trigger release workflow after Release PR merge ([#13](https://github.com/solavrc/pokerchase-hud/issues/13)) ([0cbe6af](https://github.com/solavrc/pokerchase-hud/commit/0cbe6af36937c2314cd5c292258a48d40efb12ec))


### Bug Fixes

* API types update, hand log improvements, and statistics fixes ([#15](https://github.com/solavrc/pokerchase-hud/issues/15)) ([d73d8fc](https://github.com/solavrc/pokerchase-hud/commit/d73d8fc30da4efec8aa39e03cfe2bd11199bb0d6))

## [2.1.0](https://github.com/solavrc/pokerchase-hud/compare/pokerchase-hud-v2.0.0...pokerchase-hud-v2.1.0) (2025-07-13)


### Features

* Add minimal GitHub Actions CI/CD pipeline ([5a2be4a](https://github.com/solavrc/pokerchase-hud/commit/5a2be4a1f1cfeb233b20024066d3ddcd1be5293d))
* add real-time statistics HUD for hero player ([118e27e](https://github.com/solavrc/pokerchase-hud/commit/118e27ebc0f66942e007546e232072e833bc0c72))
* **ci:** implement Release-Please with manual trigger and security controls ([#9](https://github.com/solavrc/pokerchase-hud/issues/9)) ([cd1cfec](https://github.com/solavrc/pokerchase-hud/commit/cd1cfecfce48f08c117c80c18dff635e227ad081))
* Complete architectural refactor to v2 modular system ([ef18094](https://github.com/solavrc/pokerchase-hud/commit/ef180943e31f5ad1775f6bc23cd0e6ed69d03a65))
* Dynamic URL management from manifest.json ([6670633](https://github.com/solavrc/pokerchase-hud/commit/6670633d882a8304a97ae220a3c3fe5b179d15d5))
* enhance contributor environment for statistics development ([5348ece](https://github.com/solavrc/pokerchase-hud/commit/5348ece81e9413df4d96c6b3d16cdeb601863bfd))
* Improve log window UI and positioning ([4f19936](https://github.com/solavrc/pokerchase-hud/commit/4f19936b16cb6b789dc0dfa17e549de7e35e96bc))
* Optimize import performance by 83% with direct entity generation ([b1cf85f](https://github.com/solavrc/pokerchase-hud/commit/b1cf85fbda2e4e44a0572c3029056de33b665751))
* Refactor HUD component and add click-to-scroll for log window ([c338c87](https://github.com/solavrc/pokerchase-hud/commit/c338c8716e0d962a72aa77ee41b28d9139b16473))


### Bug Fixes

* Add package-lock.json for CI/CD compatibility ([cc05612](https://github.com/solavrc/pokerchase-hud/commit/cc05612e62f1f840dd116d95d496afa845963e09))
* **ci:** add issues permission for Release-Please label creation ([#11](https://github.com/solavrc/pokerchase-hud/issues/11)) ([e97e7bf](https://github.com/solavrc/pokerchase-hud/commit/e97e7bf154abfb0c50a3aa1459bde21d295c1d72))
* Create dist directory before copying files in build process ([2558855](https://github.com/solavrc/pokerchase-hud/commit/25588554382b78b55e0b6371161a65414eae0f20))
* improve real-time HUD color coding for waiting states ([baf2bb8](https://github.com/solavrc/pokerchase-hud/commit/baf2bb8a280210b371ada86e58a41c48101e6054))
* prevent all probabilities showing green when check is available ([a6fbd72](https://github.com/solavrc/pokerchase-hud/commit/a6fbd72e6d3523c200f22c08972813b736777c95))
* Resolve transaction mode conflict in refreshDatabase ([5e5c916](https://github.com/solavrc/pokerchase-hud/commit/5e5c916aaed747bfaae4873f5d6721c2449b9842))


### Performance Improvements

* Optimize bundle size by 75%+ through build improvements ([dd14e43](https://github.com/solavrc/pokerchase-hud/commit/dd14e4346aa3a1f32c2a6f6abf174368febee71d))

## Changelog
