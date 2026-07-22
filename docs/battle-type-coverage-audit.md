# BattleType 横断カバレッジ監査

最終更新: 2026-07-22

## 結論

- HUD が宣言する `BattleType` は `0, 1, 2, 4, 5, 6` の6種類で、BigQuery Rawの
  `EVT_ENTRY_QUEUED`（201）にも6種類すべてが実在した。schema検証前のRawで
  `null`、値3、その他のenum外値は0件だった。
- ランク戦SNG（0）以外もパース・保存・フィルター対象に含まれる。監査後の追補で
  1のMTTテーブル移動、private MTTのrebuy/移動、2のinterleave、4の買い直しには
  lifecycle fixtureが追加された。一方、5はisolated stats testだけ、6は
  lifecycle testなしである。特に5は1セッション78ハンドしかなく、正常性を一般化できない。
- MTT（1）はテーブル移動ごとに同じトーナメントIDの201/308が再発行され、313の
  座席スナップショットと次の306へ続く。テーブル間の並行進行により、受信順の
  `HandId` は単調増加を保証しない。セッション境界に `HandId` の大小比較を使っては
  ならない。
- Ring（4）では、ヒーローのチップ0 → 観戦ハンド → 同一201区間内で買い直して復帰、
  という遷移を4セッションで確認した。201/309は買い直し境界として発行されず、309の
  `IsRebuy` も立たない。
- 現行enumの2は `FRIEND_SIT_AND_GO` であり、private MTT専用の値はない。追加調査では
  private MTT 2例の201がすべて `BattleType=1` で、6ではなかった。これは観測済みの
  private MTTが通常MTTと同じ値を共有することを示すが、全主催者・将来versionへ一般化する
  仕様保証ではない。
- クラウドのRaw Event Lakeはアプリケーションイベント9種だけを同期する。Zod schemaが
  知っている非アプリイベント（例: 319「参加申込結果」）や未知イベントはローカルには保存されても、
  このクラウド監査の母集団には含まれない。

ランタイム不具合として確定した項目はない。MTT移動（private MTTのrebuyを含む）、Ring買い直し、Friend SNGの主要な
lifecycle fixtureは追補済みだが、Friend Ring、Club SNGのfixture不足は
将来変更に対する回帰リスクである。

## 対象・粒度・鮮度

以下の件数・最終時刻は**2026-07-22の監査cutoffで固定した履歴スナップショット**であり、
常に最新であることを表す運用メトリクスではない。2026-07-22の再実行ではQ0〜Q2が同じ値を
再現した。将来再監査する場合も、結論を比較可能にするためcutoffとquery versionを併記する。

データソースは `pokerchase-hud` BigQuery project の次のテーブルである。

| レイヤー | 粒度 | 主キー相当 | 監査時点の行数 | 最終イベント時刻 |
|---|---|---|---:|---|
| `firestore_export.apiEvents_raw_latest` | Firestore documentの最新像 | document name | 532,236 | 2026-07-22 01:34:00 UTC（10:34:00 JST） |
| `stg_pokerchase.events` | warehouseが採用する9種のアプリイベント | Firestore `document_name` | 528,995 | 2026-07-21 20:08:48 UTC（05:08:48 JST） |
| `stg_pokerchase.sessions` | 観測者ごとの推定セッション | observer + session_seq | 1,276 | 上記staging由来 |
| `stg_pokerchase.hands` | 完走し採用されたハンド | observer + hand_seq | 43,762 | 上記staging由来 |

`event_ts` はPokerChaseサーバー時刻ではなく、クライアントがWebSocketを受信した時刻である。
複数観測者が同じゲームを記録しうるため、行数はユニークな対戦数ではない。またRawから
stagingに約5時間25分の遅延があったため、本監査の集計はstagingの最終イベント時刻を
cutoffとする。

`[event_ts_ms, api_type_id, sequence]` は保存主キー順であり、受信順そのものではない。
異なるイベント種別が同一millisecondに届くと、保存・raw exportでは`api_type_id`順になる。
BigQuery監査母集団とは別に検証したextension raw export（393,830イベント）では異種同一msが
210組あり、その結果を踏まえてQ3/Q4をsession/hand境界の因果順で再評価しても本書の公表値は
変わらなかった。再実行SQLは、必要な境界だけを
`canonical_boundary_order`で正規化する。これは任意イベントのwire順を復元するものではない。

本監査では、ポーカーを強整合性のある状態機械として扱う。イベント順は任意ではなく、
stack、pot、phase、seat、およびhand/session境界の各invariantを同時に満たす必要がある。
同一timestampで保存主キー順しか残っていない場合も`api_type_id`順を受信順とはみなさず、
これらのinvariantから一意に決まる境界だけをcanonicalizeする。一意に決まらない因果関係は
推測せず、その関係に依存する判定をfail-closedにする。

## 4方向カバレッジマトリクス

| 値 | enum名 | 宣言 | staging観測 | 既存docs | unit test | lifecycle fixture / E2E | 判定 |
|---:|---|:---:|:---:|:---:|:---:|:---:|---|
| 0 | `SIT_AND_GO` | yes | yes | yes | yes | yes | 基準モード。量は十分 |
| 1 | `TOURNAMENT` | yes | yes | yes | yes | yes | テーブル移動とprivate MTT rebuy lifecycle fixtureあり |
| 2 | `FRIEND_SIT_AND_GO` | yes | yes | yes | yes | yes | interleave lifecycle fixtureあり |
| 4 | `RING_GAME` | yes | yes | yes | yes | yes | 買い直し遷移fixtureあり |
| 5 | `FRIEND_RING_GAME` | yes | yes | yes | isolated statsのみ | no | 1セッションのみ。未検証領域が大きい |
| 6 | `CLUB_MATCH` | yes | yes | yes | no | no | 実ログはあるが回帰テストなし |
| 3 / その他 | なし | no | no | 3は欠番と記載 | no | no | 出現時はschema driftとして扱う |
| `null` / 欠落 | なし | no | Rawでもno | 不正 | no | no | 201では0件。出現時は破壊的変更候補 |

`src/types/api.ts` 冒頭の201例示だけは2を列挙していないが、同ファイルの201 schema説明と
`docs/api-events.md` の一覧には6種すべてが記載されている。

## 観測量

| BattleType | 201 | 観測者 | 推定session | 309あり | hand | showdown | side pot hand | 初観測（UTC） | 最終観測（UTC） |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 0 | 1,015 | 8 | 971 | 684 | 34,553 | 11,843 | 2,513 | 2024-09-21 | 2026-07-21 |
| 1 | 94 | 4 | 92 | 90 | 4,733 | 1,809 | 516 | 2024-09-24 | 2026-07-20 |
| 2 | 11 | 3 | 10 | 9 | 424 | 108 | 23 | 2025-07-16 | 2026-01-15 |
| 4 | 183 | 4 | 183 | 138 | 3,203 | 1,234 | 170 | 2024-09-21 | 2026-07-20 |
| 5 | 1 | 1 | 1 | 0 | 78 | 20 | 2 | 2025-08-06 | 2025-08-06 |
| 6 | 19 | 2 | 19 | 11 | 771 | 222 | 44 | 2025-01-07 | 2026-01-06 |

`sessions.is_rebuy = true` はMTT（1）の23セッションだけで、Ring（4/5）は0だった。
これはRingの買い直しが存在しないという意味ではない。後述の実ログではRing買い直しが
201/309を伴わず、ハンド内の `Player` の消失・復帰として現れる。

## 匿名化ハンドログ

`audit_ref` は観測者とセッション順序から生成した短いSHA-256参照である。プレイヤー名、
User/Player/observer ID、private room IDは出力していない。`HandId` は障害調査用の公開可能な
相関キーとしてそのまま記載する。

### 0: ランク戦SNG

```text
[BT=0 audit_ref=4184bbfeda09]
201 x1 -> 308 x1 -> 303/306 x106 -> 309 x1; 313 x1
hands=106; sample HandId=260213363,260213520,260213582
hero-visible=79; spectator=27; blinds=100/200..4300/8600; ante=50..2200
```

SNG終盤の空席は `SeatUserIds` の-1 sentinelで表現される。配列長ではなく正のUserId数を
数えると、2人対戦は3,233ハンド確認できる。

### 1: MTT

```text
[BT=1 audit_ref=952005e4927c]
201 x4; 308 x4; 313 x5; completed hands=105
12:16:42  201 -> 308 -> 313(ProcessType=1, heroSeat=5)
12:27:18  201 -> 308 -> 313(ProcessType=2, heroSeat=5)
12:53:15  201 -> 308 -> 313(ProcessType=2, heroSeat=2)
12:55:44  201 -> 308 -> 313(ProcessType=4, heroSeat=2)
sample HandId=288320969,288321359,288321636
```

同じトーナメントIDを保ったまま201/308がテーブル移動ごとに再発行された。移動付近では
受信順が `...288331102, 288331101, 288331638...` となる実例があり、別テーブルの並行進行を
示す。採用済みハンドの `(observer, HandId)` 重複は全BattleTypeで0件だった。

MTTの棄却ハンドは `incomplete=83`、`chimera_results=16`。後者は旧テーブルの303と移動先
テーブルの306が融合した形を検知したもので、採用済みハンドでは `Results.UserId` が303の
lineup外になるケースは0件だった。現行のchimera guardは少なくともこの監査母集団では
機能している。

#### private MTTの観測実例

2026-07-04 18:31 UTCに生成されたローカルRaw export（最終イベント17:42:53 UTC）を
全JSON field横断で再検索し、BigQuery Raw/Stagingとの時刻・件数一致を確認した。名前、
Code、entry/room/club/ticket識別子、player/User/observer IDは監査出力から除外した。

```text
[BT=1 audit_ref=f9456658b07b]
201 x2; 308 x2; 313 x1; 303 x6; 306 x6; 309 x1
HandId=489343800,489343979,489344092,489344320,489344491,489344771
same redacted entry identity; 313 ProcessType=0; final 309 IsRebuy=false

[BT=1 audit_ref=b1feff03635a]
201 x3; 308 x3; 313 x5; 303 x220; 306 x224; 309 x3
309: IsRebuy=true -> IsRebuy=true -> final Ranking=3, IsRebuy=false
move 1: HandId 284723970 -> 313 ProcessType=1, heroSeat 0->5 -> 284724598
move 2: HandId 284728288 -> 313 ProcessType=1, heroSeat 1->2 -> 284728560
late final result sample HandId=284772026
```

2例とも、同じredacted entry identityで再発行された201は一貫して `BattleType=1` だった。
短い例は6 handで完了し、長い例は220件の303に対して224件の306があり、2回のrebuy後に
最終3位となった。長い例では最終309の後にも306が1件到着しており、303と306の件数が
一致しないこと自体を欠損とは扱わない。

したがって、少なくとも観測したprivate MTTを2=`FRIEND_SIT_AND_GO`や6=`CLUB_MATCH`へ
分類してはならず、201の実値どおり1=`TOURNAMENT`として扱う。これは2例の観測結論であり、
未知の主催形態、新しいクライアント/HUD version、将来追加されるmodeまで1を保証しない。
調査候補として指定された他の3ラベルはlocal exportとBigQueryの双方で完全一致せず、
部分語の十分な共起もなかったため、このmappingの根拠には含めていない。

### 2: Friend SNG

```text
[BT=2 audit_ref=6a9017d85260]
201 x1; 308 x0; 303 x80; 306 x81; 309 x1; 313 x0
hands around session=80; sample HandId=428812561,428812789,428812876
ranking=1
```

2では308を一度も観測していない。313は11 entry中1件だけにあったが、その区間には完走handが
なく、hand-bearing区間では0件だった。さらに、別の長時間区間では201が1回だけなのに
306が167回、309が10回あり、各309の後も新しい201なしで次のハンドが続いた。同一観測者の
複数タブや複数試合が共有IndexedDBへinterleaveした可能性があり、201だけをFriend SNGの
絶対的な試合境界として使うのは危険である。private IDは監査出力から除外した。

### 4: Ring

```text
[BT=4 audit_ref=8f34d5fc1c03]
22:38:41 303 heroSeat=5 chip=109848
22:39:15 306 HandId=287193536 heroChip=0
22:39:30 303 hero absent (spectator)
22:39:38 306 HandId=287193581 Player chip=50000; dealt heroSeat=null; holeCards=0
22:39:41 303 heroSeat=5 chip=49875 (rebuy complete)
22:40:11 306 HandId=287193614 heroChip=49375
```

同じ形を4セッション、2観測者で確認した。バストから観戦303までは12–17秒、観戦から
復帰303までは8–112秒。途中に201/309はない。したがって次を守る必要がある。

- `Player` がない303は観戦ハンドとして保存し、以前のhero seat/hole cardsを継承しない。
- 観戦ハンドの306に `Player` が再出現しても、そのハンドをhero dealt handへ昇格しない。
- 次の `Player` あり303を新しいhero-visible handの開始とする。
- Ringの買い直しを309の `IsRebuy` やsession resetに依存して判定しない。
- recent hand/HUDの集計境界は「同じテーブル滞在の継続」と「heroがそのhandを配られたか」を
  分離する。

### 5: Friend Ring

```text
[BT=5 audit_ref=206089923a1f]
201 x1; 308 x0; 303/306 x78; 301 x1; 313 x1; 309 x0
sample HandId=394859462,394859666,394860260
hero-visible=77; spectator=0; blinds=10/20; ante=0
private room identifier=[redacted]
```

1観測者・1区間しかないため、leave/rejoin、バスト、買い直し、完了309、複数タブ、部屋の
再作成は未検証である。この1区間から「5には308/309が来ない」と一般化してはならない。

### 6: Club SNG

```text
[BT=6 audit_ref=aef1296d4087]
201 x1; 308 x1; 303/306 x76; 309 x1; 313 x1
sample HandId=424725400,424725697,424725847
default chip=15000; blind levels=16
club identifier=[redacted]
```

19セッション中11件に309、18件に308、7件に313があった。1件だけ308が欠落し、8件は309が
ないため、いずれも必須境界として扱えない。

## 優先シナリオの判定

### MTTテーブル移動

| 観点 | 実測 | 判定 |
|---|---|---|
| tournament identity | 同じ201.Idのまま201/308が複数回 | Idはトーナメント識別、テーブル識別ではない |
| table identity | 313のlineupとhero seatが変化 | 313/次303のlineupを境界確認に使う |
| HandId continuity | 重複0、ただし局所逆転あり | 一意性には使えるが単調性には使えない |
| stale old-table tail | chimera reject 16 | rejectを維持しfixture化する |
| stats/HUD cleanup | 実データはあるがE2Eなし | old lineupを新テーブルへ持ち越さないtestが必要 |
| interleaving | テーブル間でHandId順が交差 | 保存主キー順を受信順とみなさず、session/hand境界の因果順で評価する |

### Ringバスト → 観戦 → 買い直し

| 観点 | 実測 | 判定 |
|---|---|---|
| stack 0 | 306で確認 | eliminationと同一視しない |
| spectator | 次303でPlayerなし | hero identityを前handから補完しない |
| rebuy | 同区間内にPlayer/positive chipが復帰 | 201/309/IsRebuy非依存 |
| mid-hand復帰 | 観戦303に対応する306でPlayerが先に復帰 | deal時のhero不在を優先する |
| leave/rejoin | この4例では新201なし | 別区間パターンは追加captureが必要 |
| aggregation | sessionは継続、hero participationは不連続 | 二つの境界を別々に持つ |

### Private MTT

観測した2例では201の `BattleType=1` と、短い完走・rebuy・テーブル移動・最終順位までを
確認できた。残るcapture gapは次のとおりである。

1. 異なる主催者・ラベルでも1を共有するか、追加の匿名captureで標本を増やす。
2. leave/rejoin、途中参加、脱落後の観戦継続を同一entry identityで追跡する。
3. 現行のPokerChase client/HUD versionで開始前から終了まで再captureし、2026-07-04 export
   以後にevent shapeやenumが変化していないことを確認する。
4. クラウド対象外の319やunknown eventもローカルで保全し、201/308/313/303/306/309と
   相対順序だけを匿名化して比較する。
5. 追加済みのsanitized private MTT fixture
   (`src/streams/private-mtt-lifecycle.test.ts`)を維持し、`BattleType=1`、中間309の
   `IsRebuy=true`、table move後のseat再anchor、最終`Ranking=3`を回帰検証する。

## ハンド整合性チェック

- 採用済み43,762ハンドで `(observer, HandId)` 重複は0。
- 正の `SeatUserIds` の重複は全BattleTypeで0。空席-1 sentinelは重複するため除外した。
- 採用済みハンドでaction/resultのUserIdが303の正のlineup外になるケースは0。
- 2を除く5種で2人着席ハンドを確認した（0: 3,233、1: 49、2: 0、4: 32、5: 1、6: 58）。
  2は0件だが母集団が424ハンドと小さく、仕様差とは断定しない。
- `table_size` はseat slot配列長であり、着席人数ではない。heads-up判定は正の
  `SeatUserIds` 数を使う。
- hero seatがあるのにhole cardsが0枚のhandは1/4/5で観測された。観戦からの途中復帰や
  reveal条件を含むため、即座に破損扱いせず、deal時点のPlayer有無と合わせて評価する。

## リスクと推奨fixture

| 優先度 | リスク | 根拠 | 確信度 | 最小fixture / 対応 |
|---|---|---|---|---|
| P1 | MTT移動で旧303と新306が融合 | `chimera_results` 16件 | high | 追加済みtable-move fixture/chimera rejectを維持 |
| P1 | Ring買い直し途中の観戦handをhero hand化 | 実例4件 | high | 追加済みrebuy/spectator fixtureを維持 |
| P1 | private MTTを2または6として誤分類 | 観測2例の201はすべて1 | high（観測例） | 追加済みprivate MTT fixtureを維持し、追加主催者で継続監査 |
| P2 | Friend SNGの201単独境界が複数試合を融合 | 201×1に309×10の区間 | medium（複数タブ仮説） | 追加済みinterleave fixtureを維持 |
| P2 | Friend Ringの仕様を1区間から一般化 | 1 session/78 hands | high（標本不足） | leave/rejoin/rebuy/endの実機capture |
| P2 | Club SNGの308/309欠落 | 308なし1、309なし8 | high | 各イベント欠落fixture |
| P3 | unknown BattleTypeをsilent drop | 現在は0件 | high（現在値のみ） | enum外/null 201のschema-drift test |

## 再実行

匿名化済み集計SQLは [`battle-type-coverage-audit.sql`](./battle-type-coverage-audit.sql) に置く。
クエリはplayer名、User/Player/observer ID、private room IDを結果へ出力しない。出力される
`audit_ref` は短縮hash、対戦相関には `HandId` を使う。

構文・参照schemaだけを確認する場合は `bq query --location=asia-northeast1
--use_legacy_sql=false --dry_run < docs/battle-type-coverage-audit.sql` を使う。実行時も本番datasetへは
`SELECT`のみとし、Q0〜Q5は独立した結果セットとして読む。Q3/Q4の
`canonical_boundary_order`はこの監査に必要な境界だけの規則であり、汎用の受信順resolverとして
別用途へ流用しない。
