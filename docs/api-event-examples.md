# APIイベント実例集

`docs/api-events.md` のフィールド説明だけでは誤読しやすい箇所を、実際に観測した
ハンドの最小部分抜粋で示す。例はすべて BigQuery
`pokerchase-hud.stg_pokerchase.hand_events` / `events` を2026-07-22 JSTに
読み取り専用で照合した。

## 掲載・匿名化方針

- JSON内の数値・配列・enum値は、出典イベントの値をそのまま使う。
- 表示名、`UserId`、`SeatUserIds`、observer/session/auth ID、受信timestampは掲載しない。
- `HandId` は調査キーとして意図的に残す。303/304/305はwire上に`HandId`を持たないため、
  直後の306までを同一ハンド境界として結び付けた値を見出しに示す。
- 各JSONは構文として有効な**部分抜粋**であり、Zodスキーマを単体で満たす完全payloadではない。
  省略フィールドを推測で補ってはいない。
- 実データの再照合では、raw payloadをissueやPRへ貼らず、必要なフィールドだけを
  同じ匿名化方針で抽出する。

## 調査方法

303〜306は、306の`HandId`から同じ`observer_ref + hand_seq`を逆引きする。
以下は本番BigQueryに対する`SELECT`のみの例である。

> [!CAUTION]
> 以下2つのSQLは、個人情報を含み得るraw `event_json`を返す**ローカル調査専用**のqueryである。
> query結果をissue、PR、chat、共有ログへ貼らない。共有時は本文の匿名化済み部分抜粋だけを使う。

```sql
-- LOCAL ONLY: event_json may contain identifiers; never paste or share query output.
DECLARE target_hand_id INT64 DEFAULT 529819815;

WITH target AS (
  SELECT observer_ref, hand_seq
  FROM `pokerchase-hud.stg_pokerchase.hand_events`
  WHERE api_type_id = 306
    AND SAFE_CAST(JSON_VALUE(event_json, '$.HandId') AS INT64) = target_hand_id
)
SELECT observer_ref, event_idx, event_ts_ms, api_type_id, event_json
FROM `pokerchase-hud.stg_pokerchase.hand_events`
JOIN target USING (observer_ref, hand_seq)
ORDER BY observer_ref, event_idx;
```

309はハンド境界外なので、終端306と同じ`observer_ref`で、その受信時刻以降の最初の309を
`stg_pokerchase.events`から取得する。複数観測者に同じ`HandId`がある場合も、
`observer_ref`を跨いで結合しない。

```sql
-- LOCAL ONLY: event_json may contain identifiers; never paste or share query output.
DECLARE target_hand_id INT64 DEFAULT 530853194;

WITH terminal AS (
  SELECT observer_ref, event_ts_ms AS results_ts, event_json
  FROM `pokerchase-hud.stg_pokerchase.events`
  WHERE api_type_id = 306
    AND SAFE_CAST(JSON_VALUE(event_json, '$.HandId') AS INT64) = target_hand_id
),
next_309 AS (
  SELECT t.observer_ref, e.event_ts_ms, e.event_json
  FROM terminal AS t
  JOIN `pokerchase-hud.stg_pokerchase.events` AS e
    ON e.observer_ref = t.observer_ref
   AND e.api_type_id = 309
   AND e.event_ts_ms >= t.results_ts
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY t.observer_ref, t.results_ts ORDER BY e.event_ts_ms
  ) = 1
)
SELECT observer_ref, results_ts AS event_ts_ms, event_json FROM terminal
UNION ALL
SELECT observer_ref, event_ts_ms, event_json FROM next_309
ORDER BY observer_ref, event_ts_ms;
```

## 303→304→306: 強制投稿オールインとサイドポット

調査キー: `HandId=529819815`

### EVT_DEAL（303）— 配札時点の会計

```json
{
  "ApiTypeId": 303,
  "Game": {
    "Ante": 1400,
    "SmallBlind": 2850,
    "BigBlind": 5700,
    "SmallBlindSeat": 0,
    "BigBlindSeat": 3
  },
  "Player": {
    "SeatIndex": 3,
    "BetStatus": 1,
    "Chip": 111416,
    "BetChip": 5700
  },
  "OtherPlayers": [
    {
      "SeatIndex": 0,
      "Status": 0,
      "BetStatus": 3,
      "Chip": 0,
      "BetChip": 84
    }
  ],
  "Progress": {
    "Phase": 0,
    "NextActionSeat": 3,
    "Pot": 2968,
    "SidePot": [5616]
  }
}
```

直接観測できるのは、SBのseat 0が`BetStatus=3 (ALL_IN)`、`Chip=0`、
`BetChip=84`であることまで。開始スタック1,484は
`Game.Ante + BetChip + Chip = 1,400 + 84 + 0`から一意に復元する。
この式は303の会計内訳を表し、アンテとBBを実時間でどちらから先に投稿したかは示さない。

### EVT_ACTION（304）— BBは追加投入なしでcheck

```json
{
  "ApiTypeId": 304,
  "SeatIndex": 3,
  "ActionType": 0,
  "Chip": 111416,
  "BetChip": 5700,
  "Progress": {
    "Phase": 3,
    "NextActionSeat": -2,
    "Pot": 2968,
    "SidePot": [5616]
  }
}
```

`ActionType=0`（CHECK）、`Chip=111416`、`BetChip=5700`は直接値で、
同じseat 3の303から変化していない。304はSBの強制投稿オールインを自発actionとして
生成せず、BBの追加投入0のcheckだけを送っている。

### EVT_HAND_RESULTS（306）— 最終ポットとの照合

```json
{
  "ApiTypeId": 306,
  "HandId": 529819815,
  "CommunityCards": [35, 14, 33, 27, 7],
  "Pot": 2968,
  "SidePot": [5616],
  "ResultType": 0,
  "Results": [
    {
      "HandRanking": 1,
      "RankType": 4,
      "Ranking": -2,
      "RewardChip": 2968
    },
    {
      "HandRanking": 2,
      "RankType": 7,
      "Ranking": -2,
      "RewardChip": 5616
    }
  ]
}
```

`Pot + ΣSidePot = 2,968 + 5,616 = 8,584`と
`ΣRewardChip = 8,584`は直接値の算術照合である。303から総額は増えておらず、
304に追加投入がないこととも一致する。rawには`uncalled return`やpot別受取人の独立フィールドは
ないため、それらの名称や帰属をJSON単体から断定しない。

この例は、強制投稿オールインを自発的なall-in actionとして統計計上しないこと、
追加投入0でも304が届く場合があること、306で`Pot`と全`SidePot`を合算することのfixtureになる。

## 303→304→305→306: 累計BetChipとCommunityCardsの結合

調査キー: `HandId=530846908`

### EVT_DEAL（303）とEVT_ACTION（304）— BetChipはストリート内累計

```json
{
  "ApiTypeId": 303,
  "Game": {
    "Ante": 200,
    "BigBlind": 780,
    "BigBlindSeat": 3
  },
  "OtherPlayers": [
    {
      "SeatIndex": 3,
      "BetStatus": 1,
      "Chip": 19985,
      "BetChip": 780
    }
  ],
  "Progress": {
    "Phase": 0,
    "Pot": 2370,
    "SidePot": []
  }
}
```

```json
{
  "ApiTypeId": 304,
  "SeatIndex": 3,
  "ActionType": 3,
  "Chip": 18425,
  "BetChip": 2340,
  "Progress": {
    "Phase": 0,
    "NextActionSeat": -1,
    "Pot": 6270,
    "SidePot": []
  }
}
```

`ActionType=3`（CALL）と`BetChip=2340`は直接値だが、追加コール額は
`2,340 - 780 = 1,560`と303の同席直前値との差分で求める。
`BetChip=2340`をそのまま追加額として足すとBBを二重計上する。

### EVT_DEAL_ROUND（305）— 新しく配られたカードだけ

```json
{
  "ApiTypeId": 305,
  "CommunityCards": [18, 25, 16],
  "Progress": {
    "Phase": 1,
    "Pot": 6270,
    "SidePot": []
  }
}
```

```json
{
  "ApiTypeId": 305,
  "CommunityCards": [3],
  "Progress": {
    "Phase": 2,
    "Pot": 10408,
    "SidePot": []
  }
}
```

### EVT_HAND_RESULTS（306）— 305で未配信の残りだけ

```json
{
  "ApiTypeId": 306,
  "HandId": 530846908,
  "CommunityCards": [15],
  "Pot": 16136,
  "SidePot": [],
  "ResultType": 0
}
```

各`CommunityCards`配列は直接観測値である。フルボード
`[18, 25, 16, 3, 15]`はイベント順に連結して復元する。
305を累積boardとして上書きしたり、306だけをフルboardとみなしたりすると欠落する。

この例は、flop/turnを305で受信した後、turnでall-inになってriverの305が省略され、
未配信のriverだけが306に入るケースのfixtureになる。

## 306→309: ResultType=1とセッション終了

調査キー: `HandId=530853194`

### EVT_HAND_RESULTS（306）— 勝者にもResultType=1が出る

```json
{
  "ApiTypeId": 306,
  "HandId": 530853194,
  "Pot": 12316,
  "SidePot": [2392],
  "ResultType": 1,
  "Player": {
    "SeatIndex": 1,
    "BetStatus": -1,
    "Chip": 120000,
    "BetChip": 0
  },
  "OtherPlayers": [
    {
      "SeatIndex": 3,
      "Status": 5,
      "BetStatus": -1,
      "Chip": 0,
      "BetChip": 0
    }
  ],
  "Results": [
    {
      "HandRanking": 1,
      "RankType": 7,
      "Ranking": 1,
      "RewardChip": 14708
    },
    {
      "HandRanking": -1,
      "RankType": 7,
      "Ranking": 2,
      "RewardChip": 0
    }
  ]
}
```

### EVT_SESSION_RESULTS（309）— 直後の最終順位

```json
{
  "ApiTypeId": 309,
  "Ranking": 1,
  "IsLeave": false,
  "IsRebuy": false
}
```

306の`ResultType=1`、勝者の`Results[].Ranking=1`、ヒーローの終了チップ120,000、
309のトップレベル`Ranking=1`は直接観測値である。309が306の209ms後に到着したことは、
匿名化のため掲載していない受信timestamp同士の差分である。

したがって`ResultType=1`は「ヒーロー敗退」ではなく、少なくともこの実例では
「トーナメント終了によりヒーローの最終順位が確定」と読む必要がある。
309の`RankReward`、所持品、報酬、キャラクター情報はこの意味論に不要で、
アカウント情報でもあるため抜粋から除外した。

## 実raw例を掲載しないイベント

| 対象 | 判断 | 理由 |
|---|---|---|
| `EVT_SESSION_DETAILS`（308） | 単一JSONは掲載しない | セッション境界として重要なのは同一observer内の出現回数と201/309との前後関係であり、1件のpayloadでは証明できない。`BlindStructures`のフィールド形は`src/types/api.ts`で十分確認できる。 |
| `EVT_PLAYER_SEAT_ASSIGNED`（313） | 実rawは掲載しない | `TableUsers`と`SeatUserIds`は表示名・UserIdの対応そのもの。必要なら実IDを使わない合成fixtureで構造だけを示す。 |
| 319・既知の非applicationイベント・未知イベント | このhand実例集では扱わない | hand境界に属さず`HandId`を持たない。Raw Event Lakeの取り込み分類を説明する場合は`docs/architecture.md`に合成payloadを置く方が適切。 |
