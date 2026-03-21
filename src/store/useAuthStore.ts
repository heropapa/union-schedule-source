import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

export type UserRole = 'admin' | 'viewer';

/** 고유 세션 ID 생성 */
const SESSION_ID = crypto.randomUUID();
let _sessionCheckInterval: ReturnType<typeof setInterval> | null = null;

interface AuthState {
  session: Session | null;
  user: User | null;
  role: UserRole | null;
  loading: boolean;
  error: string | null;
  kickedOut: boolean;  // 다른 기기에서 로그인하여 강제 로그아웃됨

  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName: string) => Promise<boolean>;
  logout: () => Promise<void>;
  isAdmin: () => boolean;
}

/** Supabase Storage에 세션 등록 */
async function registerSession(uid: string): Promise<void> {
  const blob = new Blob(
    [JSON.stringify({ sessionId: SESSION_ID, ts: Date.now() })],
    { type: 'application/json' },
  );
  await supabase.storage
    .from('snapshots')
    .upload(`${uid}/session.json`, blob, { upsert: true, contentType: 'application/json' });
}

/** 현재 세션이 유효한지 확인 */
async function checkSession(uid: string): Promise<boolean> {
  const { data } = await supabase.storage
    .from('snapshots')
    .download(`${uid}/session.json`);
  if (!data) return true; // 파일 없으면 통과
  const info = JSON.parse(await data.text());
  return info.sessionId === SESSION_ID;
}

/** 세션 체크 인터벌 시작 (15초마다) */
function startSessionCheck(uid: string) {
  stopSessionCheck();
  _sessionCheckInterval = setInterval(async () => {
    const valid = await checkSession(uid);
    if (!valid) {
      stopSessionCheck();
      useAuthStore.setState({ kickedOut: true });
      await supabase.auth.signOut();
      useAuthStore.setState({ session: null, user: null, role: null });
    }
  }, 15000);
}

function stopSessionCheck() {
  if (_sessionCheckInterval) {
    clearInterval(_sessionCheckInterval);
    _sessionCheckInterval = null;
  }
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  session: null,
  user: null,
  role: null,
  loading: true,
  error: null,
  kickedOut: false,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const role = await fetchRole(session.user.id);
        // 기존 세션 복원 시 세션 등록 + 체크 시작
        await registerSession(session.user.id);
        startSessionCheck(session.user.id);
        set({ session, user: session.user, role, loading: false, error: null, kickedOut: false });
      } else {
        set({ session: null, user: null, role: null, loading: false });
      }

      // 세션 변경 감지 (토큰 갱신, 로그아웃 등)
      supabase.auth.onAuthStateChange(async (_event, session) => {
        if (session?.user) {
          const role = await fetchRole(session.user.id);
          set({ session, user: session.user, role });
        } else {
          stopSessionCheck();
          set({ session: null, user: null, role: null });
        }
      });
    } catch {
      set({ loading: false, error: '인증 초기화 실패' });
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null, kickedOut: false });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    if (data.user) {
      const role = await fetchRole(data.user.id);
      // 세션 등록 (이전 세션은 자동 무효화)
      await registerSession(data.user.id);
      startSessionCheck(data.user.id);
      set({ session: data.session, user: data.user, role, loading: false, kickedOut: false });
    }
  },

  signup: async (email, password, displayName) => {
    set({ loading: true, error: null });
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      const msg = error.message === 'User already registered'
        ? '이미 등록된 아이디입니다'
        : error.message;
      set({ loading: false, error: msg });
      return false;
    }
    // display_name 업데이트
    if (data.user) {
      await supabase
        .from('profiles')
        .update({ display_name: displayName })
        .eq('id', data.user.id);
    }
    set({ loading: false, error: null });
    return true;
  },

  logout: async () => {
    stopSessionCheck();
    await supabase.auth.signOut();
    set({ session: null, user: null, role: null, error: null, kickedOut: false });
  },

  isAdmin: () => get().role === 'admin',
}));

/** profiles 테이블에서 role 조회 */
async function fetchRole(userId: string): Promise<UserRole> {
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  return (data?.role as UserRole) ?? 'viewer';
}
