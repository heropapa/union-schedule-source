-- v1.3: routes 의 옛 (camp_id, route_id) 유니크 제약 제거
-- v1.1에서 라우트는 주차(weekly_roster)별로 분리됨 → 같은 캠프가 여러 주차에
-- 동일 route_id(예: 701)를 가질 수 있어야 함. 옛 제약이 "다른 주 불러오기" 등
-- 라우트 복사를 막으므로 제거. (주차별 유니크는 routes_roster_route_uq 인덱스가 담당)
-- Supabase SQL Editor에서 1회 실행.

ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_camp_id_route_id_key;
