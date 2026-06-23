-- v1.4: 관리자 계정 일괄 생성 (로그인=한글 성함, 비밀번호=5020)
-- Supabase SQL Editor에서 1회 실행. 이미 있으면 건너뜀(중복 안전).
--
-- ⚠️ 참고
--  - 비밀번호 5020(4자)은 Supabase 가입 API 최소길이(6자) 제한이 있는데,
--    아래는 auth.users 에 직접 시드하므로 그 제한을 우회함 (로그인은 정상).
--  - 로그인 시 입력하는 "성함"은 내부적으로 "성함@schedule.local" 이메일로 변환됨.
--    (앱 toEmail 규칙과 동일)

create extension if not exists pgcrypto;

do $$
declare
  names text[] := array['최아라','임지현','백승엽','조용환','김봉상','양순옥','정인호'];
  nm text;
  em text;
  uid uuid;
begin
  foreach nm in array names loop
    em := nm || '@schedule.local';

    -- 이미 있으면 비밀번호만 5020으로 갱신하고 다음으로
    select id into uid from auth.users where email = em;
    if uid is not null then
      update auth.users
        set encrypted_password = crypt('5020', gen_salt('bf')),
            updated_at = now()
        where id = uid;
      continue;
    end if;

    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      -- GoTrue가 NULL이면 "Database error querying schema"로 터지므로 빈 문자열로 채움
      confirmation_token, recovery_token, email_change,
      email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      em, crypt('5020', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('display_name', nm),
      '', '', '', '', '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', em),
      'email', em, now(), now(), now()
    );

    -- 앱 프로필 (role: admin | viewer)
    insert into public.profiles (id, email, role, display_name)
    values (uid, em, 'viewer', nm)
    on conflict (id) do update set display_name = excluded.display_name, email = excluded.email;
  end loop;
end $$;
