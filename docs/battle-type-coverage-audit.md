# BattleType 横断カバレッジ監査

最終更新: 2026-07-22

## 結論

- HUD が宣言する `BattleType` は `0, 1, 2, 4, 5, 6` の6種類で、BigQuery の
  `EVT_ENTRY_QUEUED`（201）にも6種類すべてが実在した。`null`、値3、その他の
  enum外値は0件だった。
- ランク戦SNG（0）以外もパース・保存・フィルター対象には含まれる。しかし、
  ライフサイクルを通した E2E fixture は0と4だけで、1はunit testのみ、2/6はtestがなく、
  5はisolated stats testだけである。特に5は1セッション78ハンドしかなく、正常性を
  一般化できない。
- MTT（1）はテーブル移動ごとに同じトーナメントIDの201/308が再発行され、313の
  座席スナップショットと次の306へ続く。テーブル間の並行進行により、受信順の
  `HandId` は単調増加を保証しない。セッション境界に `HandId` の大小比較を使っては
  ならない。
- Ring（4）では、ヒーローのチップ0 → 観戦ハンド → 同一201区間内で買い直して復帰、
  という遷移を4セッションで確認した。201/309は買い直し境界として発行されず、309の
  `IsRebuy` も立たない。
- 現行enumの2は `FRIEND_SIT_AND_GO` であり、Friend MTT専用の値はない。Friend MTTが
  1を共有するのか、別の未知値を使うのか、201以外の属性で識別するのかは、この
  Raw Event Lakeからは確認できない。現時点では「未対応」ではなく**未検証**である。
- クラウドのRaw Event Lakeはアプリケーションイベント9種だけを同期する。Zod schemaが
  知っている非アプリイベント（例: 319「参加申込結果」）や未知イベントはローカルには保存されても、
  このクラウド監査の母集団には含まれない。

ランタイム不具合として確定した項目はない。ただし、MTT移動、Ring買い直し、Friend系の
fixture不足は、将来変更に対する回帰リスクである。

## 対象・粒度・鮮度

データソースは `pokerchase-hud` BigQuery project の次のテーブルである。

| レイヤー | 粒度 | 主キー相当 | 監査時点の行数 | 最終イベント時刻 |
|---|---|---|---:|---|
| `firestore_export.apiEvents_raw_latest` | Firestore documentの最新像 | document name | 532,236 | 2026-07-22 01:34:00 UTC（10:34:00 JST） |
| `stg_pokerchase.events` | 有効なアプリイベント | observer + timestamp + ApiTypeId + sequence | 528,995 | 2026-07-21 20:08:48 UTC（05:08:48 JST） |
| `stg_pokerchase.sessions` | 観測者ごとの推定セッション | observer + session_seq | 1,276 | 上記staging由来 |
| `stg_pokerchase.hands` | 完走し採用されたハンド | observer + hand_seq | 43,762 | 上記staging由来 |

`event_ts` はPokerChaseサーバー時刻ではなく、クライアントがWebSocketを受信した時刻である。
複数観測者が同じゲームを記録しうるため、行数はユニークな対戦数ではない。またRawから
stagingに約5時間25分の遅延があったため、本監査の集計はstagingの最終イベント時刻を
cutoffとする。

## 4方向カバレッジマトリクス

| 値 | enum名 | 宣言 | staging観測 | 既存docs | unit test | lifecycle fixture / E2E | 判定 |
|---:|---|:---:|:---:|:---:|:---:|:---:|---|
| 0 | `SIT_AND_GO` | yes | yes | yes | yes | yes | 基準モード。量は十分 |
| 1 | `TOURNAMENT` | yes | yes | yes | yes | no | テーブル移動fixtureが必要 |
| 2 | `FRIEND_SIT_AND_GO` | yes | yes | yes | no | no | 実ログはあるが回帰テストなし |
| 4 | `RING_GAME` | yes | yes | yes | yes | yes | 買い直し遷移のfixtureはない |
| 5 | `FRIEND_RING_GAME` | yes | yes | yes | isolated statsのみ | no | 1セッションのみ。未検証領域が大きい |
| 6 | `CLUB_MATCH` | yes | yes | yes | no | no | 実ログはあるが回帰テストなし |
| 3 / その他 | なし | no | no | 3は欠番と記載 | no | no | 出現時はschema driftとして扱う |
| `null` / 欠落 | なし | no | no | 不正 | no | no | 201では0件。出現時は破壊的変更候補 |

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

### 2: Friend SNG

```text
[BT=2 audit_ref=6a9017d85260]
201 x1; 308 x0; 303 x80; 306 x81; 309 x1; 313 x0
hands around session=80; sample HandId=428812561,428812789,428812876
ranking=1
```

2では308/313を一度も観測していない。さらに、別の長時間区間では201が1回だけなのに
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
| interleaving | テーブル間でHandId順が交差 | timestamp+ApiTypeId+sequenceの受信順を保持する |

### Ringバスト → 観戦 → 買い直し

| 観点 | 実測 | 判定 |
|---|---|---|
| stack 0 | 306で確認 | eliminationと同一視しない |
| spectator | 次303でPlayerなし | hero identityを前handから補完しない |
| rebuy | 同区間内にPlayer/positive chipが復帰 | 201/309/IsRebuy非依存 |
| mid-hand復帰 | 観戦303に対応する306でPlayerが先に復帰 | deal時のhero不在を優先する |
| leave/rejoin | この4例では新201なし | 別区間パターンは追加captureが必要 |
| aggregation | sessionは継続、hero participationは不連続 | 二つの境界を別々に持つ |

### Friend MTT

現行資料で確認できるFriendトーナメントは2=`FRIEND_SIT_AND_GO`だけである。private MTTを
実際に開始し、次を同一captureで取得するまでBattleType mapping、テーブル移動、完了条件を
確定しない。

1. 開始前から終了まで同じChrome profileとHUD versionで記録する。
2. ローカルRaw Event Lakeから201/308/313/303/306/309を抽出する。クラウドにない319や
   unknown eventも同時に保全する。
3. 2テーブル以上で意図的に移動を発生させ、201.Id、BattleType、308.Name、313.ProcessType、
   hero seat、前後のHandIdを照合する。
4. 途中参加、脱落、観戦、完了309、報酬familyを記録する。
5. 共有前にplayer/User/observer ID、表示名、private room/club IDを削除し、HandIdと相対時刻、
   event countだけを残す。

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
| P1 | MTT移動で旧303と新306が融合 | `chimera_results` 16件 | high | 201/308/313を跨ぐ旧deal tail + 新table結果 |
| P1 | Ring買い直し途中の観戦handをhero hand化 | 実例4件 | high | 306 chip0 → Playerなし303 → Playerあり306 → Playerあり303 |
| P1 | Friend MTTを既存2として誤分類 | 専用enum/観測なし | high（観測ギャップ） | 実機capture後にmappingを固定 |
| P2 | Friend SNGの201単独境界が複数試合を融合 | 201×1に309×10の区間 | medium（複数タブ仮説） | 複数タブ/interleave fixture |
| P2 | Friend Ringの仕様を1区間から一般化 | 1 session/78 hands | high（標本不足） | leave/rejoin/rebuy/endの実機capture |
| P2 | Club SNGの308/309欠落 | 308なし1、309なし8 | high | 各イベント欠落fixture |
| P3 | unknown BattleTypeをsilent drop | 現在は0件 | high（現在値のみ） | enum外/null 201のschema-drift test |

## 再実行

匿名化済み集計SQLは [`battle-type-coverage-audit.sql`](./battle-type-coverage-audit.sql) に置く。
クエリはplayer名、User/Player/observer ID、private room IDを結果へ出力しない。出力される
`audit_ref` は短縮hash、対戦相関には `HandId` を使う。
