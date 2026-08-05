-- v1.8: 공개 게시판(로그인 없이 anon)용 RLS 정책.
-- "게시판에 공개(published=true)"된 캠프의 camps/weekly_rosters/workers/routes/schedule_cells 를
-- anon 역할이 SELECT 할 수 있게 허용. (쓰기는 불가, 읽기만)
-- Supabase SQL Editor에서 1회 실행.

-- camps: 공개된 캠프만
alter table camps enable row level security;
drop policy if exists board_anon_camps on camps;
create policy board_anon_camps on camps for select to anon
  using (published = true);

-- weekly_rosters: 공개 캠프의 roster
alter table weekly_rosters enable row level security;
drop policy if exists board_anon_rosters on weekly_rosters;
create policy board_anon_rosters on weekly_rosters for select to anon
  using (exists (select 1 from camps c where c.id = weekly_rosters.camp_id and c.published));

-- workers: 공개 캠프의 인원
alter table workers enable row level security;
drop policy if exists board_anon_workers on workers;
create policy board_anon_workers on workers for select to anon
  using (exists (select 1 from camps c where c.id = workers.camp_id and c.published));

-- routes: 공개 캠프의 라우트
alter table routes enable row level security;
drop policy if exists board_anon_routes on routes;
create policy board_anon_routes on routes for select to anon
  using (exists (select 1 from camps c where c.id = routes.camp_id and c.published));

-- schedule_cells: 공개 캠프의 셀
alter table schedule_cells enable row level security;
drop policy if exists board_anon_cells on schedule_cells;
create policy board_anon_cells on schedule_cells for select to anon
  using (exists (select 1 from camps c where c.id = schedule_cells.camp_id and c.published));
