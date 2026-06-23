-- v1.6: 캠프 권한 2단계(읽기/쓰기). 기존 can_edit(쓰기)만 있던 것을 level로 확장.
-- 권한 없음 = 행 없음, 'read' = 보기, 'write' = 쓰기(보기 포함).
-- Supabase SQL Editor에서 1회 실행.

alter table camp_permissions add column if not exists level text not null default 'write';

-- 기존 행(= can_edit true 로 부여됐던 것)은 모두 쓰기로 간주
update camp_permissions set level = 'write' where level is null or level = '';
