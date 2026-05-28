-- ============================================================
-- v1.1 Weekly Roster 마이그레이션
-- ============================================================
--
-- 변경 요지:
--   v1.0: 캠프 = 영구 고정/백업/계약라우트 (한번 등록하면 영구)
--   v1.1: 캠프 × 주차 = 별도 roster (매주 새로 짜거나 이전 주 복사)
--
-- 점진적 마이그레이션 전략:
--   1) weekly_rosters 신규 테이블 + 기존 테이블에 weekly_roster_id 컬럼 추가
--   2) 현재 v1.0 데이터를 2026-05-24 주차(현재 주 일요일)로 스냅샷
--   3) 백필 완료 후 NOT NULL / PK 제약 강화
--   4) RLS 갱신
--
-- 적용 방법:
--   Supabase Dashboard → SQL Editor → 이 파일 통째로 붙여넣고 Run.
--   각 STEP 사이에 BEGIN/COMMIT 으로 묶어두어 한 STEP 실패 시 다음으로 안 넘어감.
--
-- 롤백:
--   STEP 1~2까지는 부수적 컬럼 추가 + UPDATE 뿐이라 앱은 그대로 돌아감.
--   STEP 3에서 PK 제약을 바꾸므로 그 전엔 안전하게 멈출 수 있음.
--   STEP 3 이후 롤백 필요 시 v1.1-rollback.sql 별도 작성 필요.
-- ============================================================


-- ============================================================
-- STEP 1: 신규 테이블 + 컬럼 (additive — 안전)
-- ============================================================

BEGIN;

-- ─── (1.1) weekly_rosters: 캠프×주차 컨테이너 ────────────
CREATE TABLE IF NOT EXISTS weekly_rosters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id     TEXT NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- source: 어떻게 생성되었는지 추적
  --   'migrated_from_v1'           - v1.1 마이그레이션으로 생성
  --   'fresh'                       - 빈 상태로 직접 생성
  --   'excel'                       - 엑셀 업로드로 생성
  --   'copied_from:<source_id>'     - 다른 roster 복사로 생성
  source      TEXT NOT NULL DEFAULT 'fresh',
  UNIQUE (camp_id, week_start),
  -- week_start는 반드시 일요일 (date-fns startOfWeek({weekStartsOn:0})과 정합)
  -- Postgres EXTRACT(DOW): 0=일요일, 1=월요일, ..., 6=토요일
  CHECK (EXTRACT(DOW FROM week_start) = 0)
);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_camp_week
  ON weekly_rosters (camp_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_week
  ON weekly_rosters (week_start DESC);

-- ─── (1.2) workers: weekly_roster_id 컬럼 ────────────────
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS weekly_roster_id UUID
    REFERENCES weekly_rosters(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_workers_roster
  ON workers (weekly_roster_id);

-- ─── (1.3) routes: weekly_roster_id + surrogate id ──────
-- 기존 PK가 (camp_id, route_id) 복합키 → 주차 도입 후 같은 route_id가
-- 여러 주에 존재 가능하므로 PK를 surrogate UUID로 교체해야 함.
-- 이 STEP에서는 id 컬럼만 추가하고, PK 교체는 STEP 3에서.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS weekly_roster_id UUID
    REFERENCES weekly_rosters(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_routes_roster
  ON routes (weekly_roster_id);

-- ─── (1.4) camp_locks: week_start 컬럼 ──────────────────
-- 잠금 단위가 캠프 → (캠프, 주차) 로 변경.
-- 다른 주차를 동시 편집해도 서로 막지 않게 됨.
ALTER TABLE camp_locks
  ADD COLUMN IF NOT EXISTS week_start DATE;

-- ─── (1.5) worker_orders: week_start 컬럼 ───────────────
-- 사용자 정의 인원 순서도 주차별로 별도 관리.
ALTER TABLE worker_orders
  ADD COLUMN IF NOT EXISTS week_start DATE;

COMMIT;


-- ============================================================
-- STEP 2: 백필 — 현재 영구 데이터를 2026-05-24 주차로 snapshot
-- ============================================================
-- 이 STEP은 데이터를 변경하지만 기존 컬럼은 그대로 두므로 앱은 계속 동작.

BEGIN;

DO $$
DECLARE
  v_week_start DATE := DATE '2026-05-24';  -- 현재 주(2026-05-28 Thu) 일요일
  rec RECORD;
  v_roster_id UUID;
BEGIN
  FOR rec IN SELECT id FROM camps LOOP
    -- 멱등성: 이미 해당 주차 roster 있으면 재사용
    SELECT id INTO v_roster_id
      FROM weekly_rosters
      WHERE camp_id = rec.id AND week_start = v_week_start;

    IF v_roster_id IS NULL THEN
      INSERT INTO weekly_rosters (camp_id, week_start, source)
        VALUES (rec.id, v_week_start, 'migrated_from_v1')
        RETURNING id INTO v_roster_id;
    END IF;

    -- workers 백필 (NULL인 것만 — 재실행해도 안전)
    UPDATE workers
      SET weekly_roster_id = v_roster_id
      WHERE camp_id = rec.id AND weekly_roster_id IS NULL;

    -- routes 백필
    UPDATE routes
      SET weekly_roster_id = v_roster_id
      WHERE camp_id = rec.id AND weekly_roster_id IS NULL;

    -- camp_locks: 현재 활성 잠금은 모두 이번 주차로
    UPDATE camp_locks
      SET week_start = v_week_start
      WHERE camp_id = rec.id AND week_start IS NULL;

    -- worker_orders 백필
    UPDATE worker_orders
      SET week_start = v_week_start
      WHERE camp_id = rec.id AND week_start IS NULL;
  END LOOP;
END $$;

-- 검증: 백필 누락 없는지 확인
DO $$
DECLARE
  v_workers_null INT;
  v_routes_null INT;
BEGIN
  SELECT count(*) INTO v_workers_null FROM workers WHERE weekly_roster_id IS NULL;
  SELECT count(*) INTO v_routes_null  FROM routes  WHERE weekly_roster_id IS NULL;
  IF v_workers_null > 0 OR v_routes_null > 0 THEN
    RAISE EXCEPTION '백필 미완료: workers NULL=%, routes NULL=%',
      v_workers_null, v_routes_null;
  END IF;
END $$;

COMMIT;


-- ============================================================
-- STEP 3: 제약 강화 (PK 교체 — 신중하게)
-- ============================================================
-- 백필이 완료된 후에만 실행. 한 번 적용하면 v1.0 코드와 호환 깨짐.
-- (현재 코드는 routes의 PK를 (camp_id, route_id)로 가정하고 upsert 함 →
--  STEP 3 이후엔 코드도 v1.1 로직으로 함께 배포해야 함.)

BEGIN;

-- ─── (3.1) workers.weekly_roster_id NOT NULL ────────────
ALTER TABLE workers
  ALTER COLUMN weekly_roster_id SET NOT NULL;

-- ─── (3.2) routes: PK 교체 ───────────────────────────────
-- 기존 PK 제거
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_pkey;
-- id 컬럼 NOT NULL + 새 PK
ALTER TABLE routes
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN weekly_roster_id SET NOT NULL,
  ADD PRIMARY KEY (id);
-- (weekly_roster_id, route_id) UNIQUE — upsert onConflict 용도
CREATE UNIQUE INDEX IF NOT EXISTS routes_roster_route_uq
  ON routes (weekly_roster_id, route_id);

-- ─── (3.3) camp_locks: PK 교체 ──────────────────────────
-- 기존 PK (camp_id) → (camp_id, week_start)
-- 마이그레이션 시점의 stale 잠금은 정리.
DELETE FROM camp_locks WHERE heartbeat < (now() - interval '1 minute');
ALTER TABLE camp_locks DROP CONSTRAINT IF EXISTS camp_locks_pkey;
ALTER TABLE camp_locks
  ALTER COLUMN week_start SET NOT NULL,
  ADD PRIMARY KEY (camp_id, week_start);

-- ─── (3.4) worker_orders: PK 교체 ───────────────────────
ALTER TABLE worker_orders DROP CONSTRAINT IF EXISTS worker_orders_pkey;
ALTER TABLE worker_orders
  ALTER COLUMN week_start SET NOT NULL,
  ADD PRIMARY KEY (camp_id, week_start, section, role_type);

COMMIT;


-- ============================================================
-- STEP 4: RLS — weekly_rosters
-- ============================================================
-- 기존 workers/routes/schedule_cells RLS는 camp_id 기반이라 그대로 유효.
-- weekly_rosters 만 새로 정책 부여.

BEGIN;

ALTER TABLE weekly_rosters ENABLE ROW LEVEL SECURITY;

-- authenticated: 전체 CRUD 허용 (캠프 권한 체크는 앱 레이어에서 withCampPermission)
DROP POLICY IF EXISTS "auth_all_rosters" ON weekly_rosters;
CREATE POLICY "auth_all_rosters"
  ON weekly_rosters
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- anon: published 캠프에 속한 roster만 SELECT
DROP POLICY IF EXISTS "anon_select_published_rosters" ON weekly_rosters;
CREATE POLICY "anon_select_published_rosters"
  ON weekly_rosters
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM camps
      WHERE camps.id = weekly_rosters.camp_id AND camps.published = true
    )
  );

COMMIT;


-- ============================================================
-- 적용 후 점검 쿼리 (수동 실행, 정보 확인용)
-- ============================================================
--
-- SELECT camp_id, count(*) AS roster_cnt
--   FROM weekly_rosters GROUP BY camp_id ORDER BY camp_id;
--   → 각 캠프당 1개 roster (2026-05-24 주) 가 있어야 함
--
-- SELECT count(*) FROM workers WHERE weekly_roster_id IS NULL;
-- SELECT count(*) FROM routes  WHERE weekly_roster_id IS NULL;
--   → 둘 다 0이어야 함
--
-- SELECT wr.week_start, c.name AS camp_name,
--        (SELECT count(*) FROM workers w WHERE w.weekly_roster_id = wr.id) AS workers,
--        (SELECT count(*) FROM routes  r WHERE r.weekly_roster_id = wr.id) AS routes
--   FROM weekly_rosters wr JOIN camps c ON c.id = wr.camp_id
--   ORDER BY c.name;
--   → 각 캠프 인원/라우트 수가 v1.0과 동일한지 확인
