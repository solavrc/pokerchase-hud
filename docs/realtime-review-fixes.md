# リアルタイム盤面と役成立確率

この変更はリアルタイム表示とpage-world WebSocket hookを対象とする。
Raw Event Lake、保存済みentities、統計台帳、クラウド同期の導出は変更しない。
保存時導出の変更ではないため、REBUILD_ADVISORY_VERSIONは上げない。

## WebSocketの透過性

元のコンストラクターをProxyで包み、constructで生成済みのinstanceに受信listenerを追加する。
静的なCONNECTING/OPEN/CLOSING/CLOSED、prototype、instanceof、サブクラスのnew.targetを保持する。
受信payloadの分類・転送と再接続の所有者は変更しない。

## ストリートと公開カード

- ACTIONのstreetは既存のresolveActionPhaseで解決する。NextActionSeat=-2の終了行にあるPhase=3で、リバー到達を推定しない。
- ROUNDのカードは、そのROUNDのProgress.Phaseに対応する盤面位置へ配置する。ベッティングの進行とカードの受信位置は別に保持する。
- 後続streetのカードが先に来ても、欠けた盤面位置を詰めない。必要な3/4/5枚が揃うまで、そのstreetの役確率を表示しない。カードを推定で補完しない（MUST NOT）。
- 遅着した過去streetのROUNDはカードだけを補う。同streetでもACTION済みの席のBetChip/Chip/BetStatusと最新Progressを開始時snapshotで巻き戻さない。
- 未行動席はROUNDのsnapshotで補い、省略された席はFOLDEDと扱う。正常なtimeout FOLD不送信をエラーとみなさない。
- DEALとstream resetで前ハンドのカード位置・既行動席を破棄する。

テストの同msバーストや順序入替は人工入力による回帰条件であり、NDJSONの保存順が
実際の通信到着順を表すという主張ではない。APIの正常なイベント省略を禁止する
連続性検査は追加せず、表示側で確定できる情報だけを使う。

## 役成立確率とequity

役成立確率は、残りの未知カードからリバーまで配った場合の最終役の排他的分布であり、
相手に勝つ確率ではない。ポットオッズと大小比較して有利・不利の色を付けない。
確定した役だけ緑色、その他の正の確率は中立色とする。RankTypeは小さい値ほど強い。

プリフロップ計算はランク多重集合とスートの組合せ数による分布へ置き換え、
169種類のスターティングハンド分類でキャッシュする。既知カードはホールカード2枚だけ、
残り50枚からボード5枚を等確率で選ぶ前提であり、相手レンジや露出したdead cardは考慮しない。
ポケットペアのクワッズ確率は(C(48,3)+12*46)/C(50,5)で独立に検算できる。

公開UIではプリフロップの役確率表を暫定的に非表示とし、スターティングハンド順位を残す。
計算値の更新と表示の再公開は別の判断として扱う。フロップ以降の表示は継続する。

## 検証範囲

既存CIのtypecheck、Jest、extension build、CRX packaging smoke、browser-e2eで検証する。
新規回帰テストはコンストラクター互換性、カードの遅着・再送、金融snapshotの保持、
終了行のフェーズ、役の強弱、不適切なオッズ色付けの除去を対象とする。
認証refreshの保存順序に関する未確認の懸念は、この修正には含めない。
