-- v1.2: 캠프 잠금 배너에 편집자 이름 표시
-- camp_locks 에 편집자 표시 이름을 직접 저장 (profiles 조인/ RLS 의존 제거).
-- Supabase SQL Editor에서 1회 실행.

ALTER TABLE camp_locks
  ADD COLUMN IF NOT EXISTS locked_by_name TEXT;
