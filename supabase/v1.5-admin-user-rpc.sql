-- v1.5: 앱 내 admin 계정관리용 RPC 함수들
-- admin(role='admin') 만 호출 가능. 브라우저에 service-role 키를 두지 않고
-- SECURITY DEFINER 함수로 auth.users 를 안전하게 조작.
-- Supabase SQL Editor에서 1회 실행.

create extension if not exists pgcrypto with schema extensions;

-- 호출자가 admin 인지 확인
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

-- 계정 생성 (이름 = 로그인 성함, 비번 임의 길이 허용)
create or replace function public.admin_create_user(p_name text, p_password text, p_role text default 'viewer')
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare uid uuid; em text;
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception '성함을 입력하세요'; end if;
  if coalesce(p_password,'') = '' then raise exception '비밀번호를 입력하세요'; end if;
  em := p_name || '@schedule.local';
  if exists (select 1 from auth.users where email = em) then
    raise exception '이미 존재하는 성함입니다: %', p_name;
  end if;
  uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    em, crypt(p_password, gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', p_name),
    '', '', '', '', '', '', '', ''
  );
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', em), 'email', em, now(), now(), now());
  insert into public.profiles (id, email, role, display_name)
  values (uid, em, coalesce(p_role,'viewer'), p_name)
  on conflict (id) do update set display_name = excluded.display_name, role = excluded.role;
end $$;

-- 비밀번호 변경
create or replace function public.admin_set_password(p_name text, p_password text)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  if coalesce(p_password,'') = '' then raise exception '비밀번호를 입력하세요'; end if;
  update auth.users
    set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
    where email = p_name || '@schedule.local';
  if not found then raise exception '없는 계정입니다: %', p_name; end if;
end $$;

-- 권한(role) 변경: 'admin' | 'viewer'
create or replace function public.admin_set_role(p_name text, p_role text)
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  update public.profiles set role = p_role
    where email = p_name || '@schedule.local';
  if not found then raise exception '없는 계정입니다: %', p_name; end if;
end $$;

-- 계정 삭제 (identities/profiles 함께 정리)
create or replace function public.admin_delete_user(p_name text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare em text;
begin
  if not public.is_admin() then raise exception '관리자만 가능합니다'; end if;
  em := p_name || '@schedule.local';
  if em = 'admin@schedule.local' then raise exception 'admin 계정은 삭제할 수 없습니다'; end if;
  delete from public.profiles where email = em;
  delete from auth.users where email = em;  -- identities는 FK cascade
end $$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_create_user(text, text, text) to authenticated;
grant execute on function public.admin_set_password(text, text) to authenticated;
grant execute on function public.admin_set_role(text, text) to authenticated;
grant execute on function public.admin_delete_user(text) to authenticated;
