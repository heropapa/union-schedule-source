import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: sessionStorage,   // 탭별 독립 세션 (다른 탭 로그아웃해도 영향 없음)
    autoRefreshToken: true,
    persistSession: true,
  },
});

/** 아이디 → 내부 이메일 변환 (사용자는 아이디만 입력) */
const EMAIL_DOMAIN = '@schedule.local';
export function toEmail(userId: string): string {
  return userId.includes('@') ? userId : userId + EMAIL_DOMAIN;
}

/** 내부 이메일 → 아이디 표시용 */
export function toDisplayName(email: string): string {
  return email.replace(EMAIL_DOMAIN, '');
}
