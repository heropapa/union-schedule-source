import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: sessionStorage,   // 탭별 독립 세션 (다른 탭 로그아웃해도 영향 없음)
    autoRefreshToken: true,
    persistSession: true,
    // 기본값(navigator.locks)은 탭이 백그라운드에 있다 돌아오면 토큰 갱신 잠금이
    // 풀리지 않아 이후 모든 요청이 무한 대기하는 경우가 있다. 세션이 탭별
    // sessionStorage라 탭 간 잠금이 필요 없으므로 잠금 없이 바로 실행.
    lock: async (_name, _acquireTimeout, fn) => fn(),
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
