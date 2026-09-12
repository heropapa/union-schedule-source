-- v1.9: 계약라우트별 캠프명 (부산2 화면에서 부산3 라우트도 함께 관리)
-- 라우트에 camp_label을 달면 어드민 양식 다운로드 시 그 캠프명으로 출력됨.
-- Supabase SQL Editor에서 1회 실행.

ALTER TABLE routes ADD COLUMN IF NOT EXISTS camp_label text;
