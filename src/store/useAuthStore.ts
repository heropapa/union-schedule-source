import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { fetchPermissions } from '../lib/db';
import type { Session, User } from '@supabase/supabase-js';
import type { CampPermission } from '../types';

export type UserRole = 'admin' | 'viewer';

interface AuthState {
  session: Session | null;
  user: User | null;
  role: UserRole | null;
  loading: boolean;
  error: string | null;
  permissions: CampPermission[];

  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: () => boolean;
  canEditCamp: (campId: string) => boolean;
  loadPermissions: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  session: null,
  user: null,
  role: null,
  loading: true,
  error: null,
  permissions: [],

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const role = await fetchRole(session.user.id);
        set({ session, user: session.user, role, loading: false, error: null });
        // 권한 로드
        if (role !== 'admin') {
          const perms = await fetchPermissions();
          set({ permissions: perms });
        }
      } else {
        set({ session: null, user: null, role: null, loading: false });
      }

      supabase.auth.onAuthStateChange(async (_event, session) => {
        if (session?.user) {
          const role = await fetchRole(session.user.id);
          set({ session, user: session.user, role });
        } else {
          set({ session: null, user: null, role: null, permissions: [] });
        }
      });
    } catch {
      set({ loading: false, error: '인증 초기화 실패' });
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    if (!data.user) {
      set({ loading: false, error: '로그인 실패' });
      return;
    }

    const role = await fetchRole(data.user.id);

    // 권한 로드
    let perms: CampPermission[] = [];
    if (role !== 'admin') {
      perms = await fetchPermissions();
    }

    set({
      session: data.session,
      user: data.user,
      role,
      permissions: perms,
      loading: false,
    });
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ session: null, user: null, role: null, error: null, permissions: [] });
  },

  isAdmin: () => get().role === 'admin',

  canEditCamp: (campId: string) => {
    const { role, user, permissions } = get();
    if (role === 'admin') return true;
    if (!user) return false;
    return permissions.some(p => p.userId === user.id && p.campId === campId && p.canEdit);
  },

  loadPermissions: async () => {
    const perms = await fetchPermissions();
    set({ permissions: perms });
  },
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
