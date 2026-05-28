-- ============================================================
-- v1.1 Weekly Roster — Clean Start 마이그레이션
-- ============================================================
--
-- 결정: v1.0 영구 인원/라우트/스케쥴은 모두 의미 없음 → 비우고 새로 시작.
--   - 보존: camps (9개 캠프 정의), profiles (계정), camp_permissions (권한)
--   - 삭제: workers, routes, schedule_cells, worker_orders, camp_locks
--
-- 적용 방법:
--   Supabase Dashboard → SQL Editor → 통째 붙여넣고 Run.
--   전체가 BEGIN/COMMIT 한 트랜잭션 — 한 줄이라도 에러 나면 전부 롤백.
--
-- ⚠️ 옛 인원/라우트/스케쥴 데이터가 비워집니다. 백업 필요하면 먼저 export.
-- ============================================================

BEGIN;

-- ─── (1) 옛 데이터 비우기 ──────────────────────────────────
-- CASCADE: 자식 테이블도 함께 비움
TRUNCATE TABLE workers, routes, schedule_cells, worker_orders, camp_locks
  RESTART IDENTITY CASCADE;

-- ─── (2) weekly_rosters: 캠프 × 주차 컨테이너 ────────────
CREATE TABLE IF NOT EXISTS weekly_rosters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id     TEXT NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,                       -- 주의 일요일
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- source: 어떻게 생성되었는지 — 'fresh' | 'excel' | 'copied_from:<id>'
  source      TEXT NOT NULL DEFAULT 'fresh',
  UNIQUE (camp_id, week_start),
  -- 일요일만 허용 (date-fns startOfWeek({weekStartsOn:0}) 정합)
  -- Postgres EXTRACT(DOW): 0=일요일
  CHECK (EXTRACT(DOW FROM week_start) = 0)
);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_camp_week
  ON weekly_rosters (camp_id, week_start DESC);

-- ─── (3) workers: weekly_roster_id (NOT NULL) ───────────
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS weekly_roster_id UUID NOT NULL
    REFERENCES weekly_rosters(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_workers_roster
  ON workers (weekly_roster_id);

-- ─── (4) routes: PK 교체 (composite → surrogate UUID) ──
-- 같은 route_id가 여러 주차에 존재 가능해야 하므로 PK를 surrogate UUID로.
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_pkey;
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS weekly_roster_id UUID NOT NULL
    REFERENCES weekly_rosters(id) ON DELETE CASCADE,
  ADD PRIMARY KEY (id);
-- upsert onConflict 용도
CREATE UNIQUE INDEX IF NOT EXISTS routes_roster_route_uq
  ON routes (weekly_roster_id, route_id);

-- ─── (5) camp_locks: PK (camp_id) → (camp_id, week_start) ─
ALTER TABLE camp_locks DROP CONSTRAINT IF EXISTS camp_locks_pkey;
ALTER TABLE camp_locks
  ADD COLUMN IF NOT EXISTS week_start DATE NOT NULL,
  ADD PRIMARY KEY (camp_id, week_start);

-- ─── (6) worker_orders: PK 확장 ──────────────────────────
ALTER TABLE worker_orders DROP CONSTRAINT IF EXISTS worker_orders_pkey;
ALTER TABLE worker_orders
  ADD COLUMN IF NOT EXISTS week_start DATE NOT NULL,
  ADD PRIMARY KEY (camp_id, week_start, section, role_type);

-- ─── (7) RLS: weekly_rosters ─────────────────────────────
ALTER TABLE weekly_rosters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_rosters" ON weekly_rosters;
CREATE POLICY "auth_all_rosters"
  ON weekly_rosters FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_select_published_rosters" ON weekly_rosters;
CREATE POLICY "anon_select_published_rosters"
  ON weekly_rosters FOR SELECT TO anon
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
-- SELECT count(*) FROM workers;          -- 0이어야 함
-- SELECT count(*) FROM routes;           -- 0이어야 함
-- SELECT count(*) FROM schedule_cells;   -- 0이어야 함
-- SELECT count(*) FROM camps;            -- 9 (보존)
-- SELECT count(*) FROM weekly_rosters;   -- 0 (앱에서 첫 주차 만들 때 생성)
