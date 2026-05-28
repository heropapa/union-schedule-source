-- ============================================================
-- 게시판(BoardPage2) 익명 접근용 RLS 정책
-- ============================================================
--
-- 적용 방법:
--   1. Supabase Dashboard → SQL Editor
--   2. 이 파일 내용 붙여넣고 Run
--   3. 적용 후 BoardPage2가 atone 계정 없이 직접 anon key로
--      published 캠프 데이터를 읽을 수 있게 됨
--
-- 배경:
--   기존엔 BoardPage가 'atone@schedule.local' 계정과
--   하드코딩된 비밀번호 '150527'로 로그인해서 데이터를 읽었음.
--   비밀번호가 Vite 번들에 평문 노출되는 문제 + 별도 계정 유지
--   부담 → anon key + RLS로 전환.
--
-- 보안 모델:
--   - anon 사용자: camps.published=true 행만 SELECT 가능
--   - workers/routes/schedule_cells: 위 camps에 속한 것만 SELECT 가능
--   - 모든 INSERT/UPDATE/DELETE는 anon 불가 (authenticated만)
-- ============================================================

-- ─── camps: published 행만 anon SELECT 허용 ─────────────────
DROP POLICY IF EXISTS "anon_select_published_camps" ON camps;
CREATE POLICY "anon_select_published_camps"
  ON camps FOR SELECT
  TO anon
  USING (published = true);

-- ─── workers: published 캠프 소속만 anon SELECT 허용 ────────
DROP POLICY IF EXISTS "anon_select_workers_of_published" ON workers;
CREATE POLICY "anon_select_workers_of_published"
  ON workers FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM camps
      WHERE camps.id = workers.camp_id
        AND camps.published = true
    )
  );

-- ─── routes: published 캠프 소속만 anon SELECT 허용 ─────────
DROP POLICY IF EXISTS "anon_select_routes_of_published" ON routes;
CREATE POLICY "anon_select_routes_of_published"
  ON routes FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM camps
      WHERE camps.id = routes.camp_id
        AND camps.published = true
    )
  );

-- ─── schedule_cells: published 캠프 소속만 anon SELECT 허용 ─
DROP POLICY IF EXISTS "anon_select_cells_of_published" ON schedule_cells;
CREATE POLICY "anon_select_cells_of_published"
  ON schedule_cells FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM camps
      WHERE camps.id = schedule_cells.camp_id
        AND camps.published = true
    )
  );

-- ─── RLS 강제 활성화 확인 (이미 켜져있다면 no-op) ───────────
ALTER TABLE camps           ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_cells  ENABLE ROW LEVEL SECURITY;

-- ─── 적용 후 정리(선택): atone 계정 삭제 ────────────────────
-- 더 이상 사용하지 않으니 Supabase Dashboard → Authentication → Users
-- 에서 'atone@schedule.local' 사용자를 삭제하세요.
-- (SQL로 지우려면 profiles 행도 같이 정리 필요 — 대시보드 권장)
