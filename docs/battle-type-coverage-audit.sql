-- BattleType cross-mode audit (read-only, redacted output)
-- Project: pokerchase-hud / Location: asia-northeast1
-- Snapshot contract: the published counts in battle-type-coverage-audit.md
-- are frozen at the 2026-07-22 cutoff. Re-runs must record a new cutoff
-- instead of silently replacing the historical snapshot.
--
-- Privacy contract:
--   * Do not emit observer_ref, user/player IDs, names, entry IDs, room IDs,
--     club IDs, or raw event_json. Private keys may be used only inside an
--     aggregate or one-way audit_ref expression.
--   * audit_ref is a truncated SHA-256 label for correlation inside this audit.
--   * HandId is intentionally retained as the non-personal hand correlation key.

-- Q0. Raw/staging freshness. Raw `timestamp` is the Firestore changelog time;
-- the event time is read from the JSON payload.
SELECT
  'raw_latest' AS source,
  COUNT(*) AS row_count,
  MIN(TIMESTAMP_MILLIS(SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64)))
    AS first_event,
  MAX(TIMESTAMP_MILLIS(SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64)))
    AS last_event,
  MAX(timestamp) AS last_ingested
FROM `pokerchase-hud.firestore_export.apiEvents_raw_latest`
UNION ALL
SELECT
  'staged_events',
  COUNT(*),
  MIN(event_ts),
  MAX(event_ts),
  MAX(ingested_at)
FROM `pokerchase-hud.stg_pokerchase.events`;

-- Q1. Raw 201 BattleType observation and enum-drift detection. This must run
-- before staging validation because an invalid enum value is absent from the
-- accepted-event staging table by definition.
WITH entry AS (
  SELECT
    TIMESTAMP_MILLIS(SAFE_CAST(JSON_VALUE(data, '$.timestamp') AS INT64))
      AS event_ts,
    SAFE_CAST(JSON_VALUE(data, '$.BattleType') AS INT64) AS battle_type
  FROM `pokerchase-hud.firestore_export.apiEvents_raw_latest`
  WHERE SAFE_CAST(JSON_VALUE(data, '$.ApiTypeId') AS INT64) = 201
)
SELECT
  battle_type,
  COUNT(*) AS entry_events,
  MIN(event_ts) AS first_seen,
  MAX(event_ts) AS last_seen,
  COUNTIF(battle_type IS NULL) AS missing_values,
  COUNTIF(battle_type NOT IN (0, 1, 2, 4, 5, 6)) AS out_of_enum_values
FROM entry
GROUP BY battle_type
ORDER BY battle_type;

-- Q2. Session/hand census. These are staged, inferred sessions, not unique
-- PokerChase matches; multiple observers may capture the same match.
WITH entry AS (
  SELECT
    SAFE_CAST(JSON_VALUE(event_json, '$.BattleType') AS INT64) AS battle_type,
    COUNT(*) AS entry_events,
    COUNT(DISTINCT observer_ref) AS observers,
    MIN(event_ts) AS first_seen,
    MAX(event_ts) AS last_seen
  FROM `pokerchase-hud.stg_pokerchase.events`
  WHERE api_type_id = 201
  GROUP BY battle_type
), session_census AS (
  SELECT
    battle_type,
    COUNT(*) AS sessions,
    COUNTIF(has_session_results) AS sessions_with_309,
    COUNTIF(is_rebuy) AS sessions_with_is_rebuy
  FROM `pokerchase-hud.stg_pokerchase.sessions`
  GROUP BY battle_type
), hand_census AS (
  SELECT
    battle_type,
    COUNT(*) AS hands,
    COUNTIF(is_showdown) AS showdown_hands,
    COUNTIF(ARRAY_LENGTH(side_pots) > 0) AS sidepot_hands,
    COUNTIF((SELECT COUNTIF(uid > 0) FROM UNNEST(seat_user_ids) AS uid) = 2)
      AS heads_up_hands
  FROM `pokerchase-hud.stg_pokerchase.hands`
  GROUP BY battle_type
)
SELECT *
FROM entry
LEFT JOIN session_census USING (battle_type)
LEFT JOIN hand_census USING (battle_type)
ORDER BY battle_type;

-- Shared event annotation for Q3-Q5. Repeat this CTE in an interactive query;
-- BigQuery CTE scope ends at each semicolon.

-- Q3. MTT table-move profile. entry_id is used for grouping but never emitted.
WITH annotated AS (
  SELECT
    observer_ref,
    event_ts,
    event_ts_ms,
    api_type_id,
    event_json,
    COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      AS event_sequence,
    LAST_VALUE(IF(
      api_type_id = 201,
      SAFE_CAST(JSON_VALUE(event_json, '$.BattleType') AS INT64),
      NULL
    ) IGNORE NULLS) OVER (
      PARTITION BY observer_ref
      ORDER BY event_ts_ms, api_type_id,
        COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS battle_type,
    LAST_VALUE(IF(
      api_type_id = 201,
      JSON_VALUE(event_json, '$.Id'),
      NULL
    ) IGNORE NULLS) OVER (
      PARTITION BY observer_ref
      ORDER BY event_ts_ms, api_type_id,
        COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS entry_id
  FROM `pokerchase-hud.stg_pokerchase.events`
), mtt AS (
  SELECT * FROM annotated WHERE battle_type = 1
), tournaments AS (
  SELECT
    observer_ref,
    entry_id,
    MIN(event_ts) AS started_at,
    MAX(event_ts) AS ended_at,
    COUNTIF(api_type_id = 201) AS event_201,
    COUNTIF(api_type_id = 308) AS event_308,
    COUNTIF(api_type_id = 313) AS event_313,
    COUNTIF(api_type_id = 306) AS completed_hands,
    ARRAY_AGG(
      IF(api_type_id = 306,
        SAFE_CAST(JSON_VALUE(event_json, '$.HandId') AS INT64), NULL)
      IGNORE NULLS ORDER BY event_ts_ms, api_type_id, event_sequence LIMIT 3
    ) AS sample_hand_ids
  FROM mtt
  GROUP BY observer_ref, entry_id
)
SELECT
  SUBSTR(TO_HEX(SHA256(CONCAT(
    observer_ref, '#', entry_id, '#',
    CAST(UNIX_MILLIS(started_at) AS STRING)
  ))), 1, 12) AS audit_ref,
  started_at,
  ended_at,
  event_201,
  event_308,
  event_313,
  completed_hands,
  sample_hand_ids
FROM tournaments
WHERE event_201 > 1 OR event_308 > 1 OR event_313 > 1
ORDER BY event_201 DESC, event_313 DESC;

-- Q4. Ring bust -> spectator -> rebuy inside one 201 segment.
WITH base AS (
  SELECT
    observer_ref,
    event_ts,
    event_ts_ms,
    api_type_id,
    event_json,
    COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      AS event_sequence,
    COUNTIF(api_type_id = 201) OVER (
      PARTITION BY observer_ref
      ORDER BY event_ts_ms, api_type_id,
        COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS entry_seq,
    LAST_VALUE(IF(
      api_type_id = 201,
      SAFE_CAST(JSON_VALUE(event_json, '$.BattleType') AS INT64),
      NULL
    ) IGNORE NULLS) OVER (
      PARTITION BY observer_ref
      ORDER BY event_ts_ms, api_type_id,
        COALESCE(SAFE_CAST(JSON_VALUE(event_json, '$.sequence') AS INT64), 0)
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS battle_type
  FROM `pokerchase-hud.stg_pokerchase.events`
), ordered AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY observer_ref, entry_seq
      ORDER BY event_ts_ms, api_type_id, event_sequence
    ) AS event_ordinal
  FROM base
), ring AS (
  SELECT
    *,
    SAFE_CAST(JSON_VALUE(event_json, '$.Player.Chip') AS INT64) AS player_chip,
    SAFE_CAST(JSON_VALUE(event_json, '$.Player.SeatIndex') AS INT64) AS player_seat,
    SAFE_CAST(JSON_VALUE(event_json, '$.HandId') AS INT64) AS hand_id
  FROM ordered
  WHERE battle_type IN (4, 5)
), busts AS (
  SELECT
    observer_ref,
    entry_seq,
    battle_type,
    event_ordinal AS bust_ordinal,
    event_ts AS bust_at,
    hand_id AS bust_hand_id
  FROM ring
  WHERE api_type_id = 306 AND player_chip = 0
), spectator AS (
  SELECT
    busts.*,
    ring.event_ordinal AS spectator_ordinal,
    ring.event_ts AS spectator_at
  FROM busts
  JOIN ring USING (observer_ref, entry_seq, battle_type)
  WHERE ring.event_ordinal > bust_ordinal
    AND ring.api_type_id = 303
    AND ring.player_seat IS NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY observer_ref, entry_seq, bust_ordinal
    ORDER BY ring.event_ordinal
  ) = 1
), rebuy AS (
  SELECT
    spectator.*,
    ring.event_ts AS rebuy_at,
    (
      SELECT COUNTIF(boundary.api_type_id = 309)
      FROM ring AS boundary
      WHERE boundary.observer_ref = spectator.observer_ref
        AND boundary.entry_seq = spectator.entry_seq
        AND boundary.event_ordinal > spectator.bust_ordinal
        AND boundary.event_ordinal < ring.event_ordinal
    ) AS session_results_between
  FROM spectator
  JOIN ring USING (observer_ref, entry_seq, battle_type)
  WHERE ring.event_ordinal > spectator_ordinal
    AND ring.api_type_id = 303
    AND ring.player_seat IS NOT NULL
    AND ring.player_chip > 0
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY observer_ref, entry_seq, bust_ordinal
    ORDER BY ring.event_ordinal
  ) = 1
)
SELECT
  SUBSTR(TO_HEX(SHA256(CONCAT(
    observer_ref, '#', CAST(entry_seq AS STRING), '#ring-lifecycle-v1'
  ))), 1, 12) AS audit_ref,
  battle_type,
  bust_hand_id,
  bust_at,
  spectator_at,
  rebuy_at,
  session_results_between,
  TIMESTAMP_DIFF(spectator_at, bust_at, SECOND) AS seconds_to_spectator,
  TIMESTAMP_DIFF(rebuy_at, spectator_at, SECOND) AS seconds_to_rebuy
FROM rebuy
WHERE session_results_between = 0
ORDER BY bust_at;

-- Q5. Accepted-hand identity and lineup invariants by BattleType.
WITH per_hand AS (
  SELECT
    battle_type,
    observer_ref,
    hand_id,
    seat_user_ids,
    actions,
    results,
    (SELECT COUNTIF(uid > 0) FROM UNNEST(seat_user_ids) AS uid)
      AS occupied_seats,
    (SELECT COUNT(DISTINCT uid) FROM UNNEST(seat_user_ids) AS uid WHERE uid > 0)
      AS distinct_occupied_users
  FROM `pokerchase-hud.stg_pokerchase.hands`
), duplicate_hand_keys AS (
  SELECT observer_ref, hand_id
  FROM per_hand
  GROUP BY observer_ref, hand_id
  HAVING COUNT(*) > 1
)
SELECT
  battle_type,
  COUNT(*) AS hands,
  COUNTIF(occupied_seats != distinct_occupied_users) AS duplicate_positive_seat_users,
  COUNTIF(EXISTS(
    SELECT 1 FROM UNNEST(results) AS result
    WHERE result.user_id NOT IN UNNEST(seat_user_ids)
  )) AS results_outside_dealt_lineup,
  COUNTIF(EXISTS(
    SELECT 1 FROM UNNEST(actions) AS action
    WHERE action.user_id NOT IN UNNEST(seat_user_ids)
  )) AS actions_outside_dealt_lineup,
  (SELECT COUNT(*) FROM duplicate_hand_keys) AS duplicate_hand_keys_global
FROM per_hand
GROUP BY battle_type
ORDER BY battle_type;
