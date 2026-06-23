-- v1.7: 계정 이름(로그인 성함) 변경 RPC. admin 전용.
-- 이름 변경 = 로그인 이메일(성함@schedule.local) + 표시이름 일괄 변경.
-- Supabase SQL Editor에서 1회 실행.

create or replace function public.admin_rename_user(p_old_name text, p_new_name text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare uid uuid; old_em text; new_em text;
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  if coalesce(trim(p_new_name),'') = '' then raise exception '새 성함을 입력하세요'; end if;
  old_em := p_old_name || '@schedule.local';
  new_em := p_new_name || '@schedule.local';
  if old_em = 'admin@schedule.local' then raise exception 'admin 계정 이름은 바꿀 수 없습니다'; end if;

  select id into uid from auth.users where email = old_em;
  if uid is null then raise exception '없는 계정입니다: %', p_old_name; end if;
  if exists (select 1 from auth.users where email = new_em) then
    raise exception '이미 존재하는 성함입니다: %', p_new_name;
  end if;

  update auth.users
    set email = new_em,
        raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || jsonb_build_object('display_name', p_new_name),
        updated_at = now()
    where id = uid;

  update auth.identities
    set identity_data = jsonb_build_object('sub', uid::text, 'email', new_em),
        provider_id = new_em,
        updated_at = now()
    where user_id = uid and provider = 'email';

  update public.profiles
    set email = new_em, display_name = p_new_name
    where id = uid;
end $$;

grant execute on function public.admin_rename_user(text, text) to authenticated;
