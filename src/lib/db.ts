/**
 * DB 접근 레이어 — 모든 Store는 이 모듈을 통해 Supabase DB에 접근
 *
 * v1.1 변화: workers/routes/orders/locks 는 모두 "주간 roster" 단위로 분리됨.
 *   - 각 (camp_id, week_start) 조합에 대해 weekly_rosters 행 하나가 존재
 *   - workers/routes/worker_orders 는 weekly_roster_id 또는 (camp_id, week_start) 키로 스코프
 *   - camp_locks 는 (camp_id, week_start) 복합키 — 다른 주차 동시 편집 가능
 */
import { supabase } from './supabase';
import type { Camp, Worker, Route, ScheduleCell, CampPermission, CampLock, WeeklyRoster } from '../types';

// ─── Camp ───────────────────────────────────────────────

export async function fetchCamps(): Promise<Camp[]> {
  const { data, error } = await supabase
    .from('camps')
    .select('*')
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name,
    wave: r.wave,
    color: r.color,
    companyId: r.company_id,
  }));
}

export async function upsertCamp(camp: Camp, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('camps').upsert({
    id: camp.id,
    name: camp.name,
    wave: camp.wave,
    color: camp.color,
    company_id: camp.companyId,
    sort_order: sortOrder,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deleteCamp(campId: string): Promise<void> {
  const { error } = await supabase.from('camps').delete().eq('id', campId);
  if (error) throw error;
}

export async function setCampPublished(campId: string, published: boolean): Promise<void> {
  const { error } = await supabase.from('camps').update({ published, updated_at: new Date().toISOString() }).eq('id', campId);
  if (error) throw error;
}

export async function fetchPublishedCamps(): Promise<Camp[]> {
  const { data, error } = await supabase
    .from('camps')
    .select('*')
    .eq('published', true)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name,
    wave: r.wave,
    color: r.color,
    companyId: r.company_id,
  }));
}

// ─── Weekly Roster (v1.1 핵심) ──────────────────────────

type RosterRow = {
  id: string;
  camp_id: string;
  week_start: string;
  created_by: string | null;
  created_at: string;
  source: string;
};

const rosterFromRow = (r: RosterRow): WeeklyRoster => ({
  id: r.id,
  campId: r.camp_id,
  weekStart: r.week_start,
  createdBy: r.created_by ?? undefined,
  createdAt: r.created_at,
  source: r.source,
});

/** (캠프 × 주차)의 roster를 찾음. 없으면 null. */
export async function fetchRoster(campId: string, weekStart: string): Promise<WeeklyRoster | null> {
  const { data, error } = await supabase
    .from('weekly_rosters')
    .select('*')
    .eq('camp_id', campId)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (error) throw error;
  return data ? rosterFromRow(data as RosterRow) : null;
}

/** 캠프의 모든 roster 목록 (불러오기 UX용 — 최신순). */
export async function listRostersByCamp(campId: string): Promise<WeeklyRoster[]> {
  const { data, error } = await supabase
    .from('weekly_rosters')
    .select('*')
    .eq('camp_id', campId)
    .order('week_start', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(r => rosterFromRow(r as RosterRow));
}

/** 빈 roster 생성. source 기본값 'fresh'. */
export async function createRoster(input: {
  campId: string;
  weekStart: string;
  source?: string;
}): Promise<WeeklyRoster> {
  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const { data, error } = await supabase
    .from('weekly_rosters')
    .insert({
      camp_id: input.campId,
      week_start: input.weekStart,
      created_by: userId,
      source: input.source ?? 'fresh',
    })
    .select('*')
    .single();
  if (error) throw error;
  return rosterFromRow(data as RosterRow);
}

/** roster 삭제 (CASCADE로 workers/routes도 함께 삭제됨). */
export async function deleteRoster(rosterId: string): Promise<void> {
  const { error } = await supabase.from('weekly_rosters').delete().eq('id', rosterId);
  if (error) throw error;
}

// ─── Workers ────────────────────────────────────────────

type WorkerRow = {
  id: string;
  weekly_roster_id: string;
  camp_id: string;
  name: string;
  login_id: string;
  role: string;
  assigned_routes: string[] | null;
  rotations: string[] | null;
  phone: string | null;
  vehicle: string | null;
  note: string | null;
  sort_order: number | null;
};

const workerFromRow = (r: WorkerRow): Worker => ({
  id: r.id,
  weeklyRosterId: r.weekly_roster_id,
  campId: r.camp_id,
  name: r.name,
  loginId: r.login_id,
  role: r.role as 'regular' | 'backup',
  assignedRoutes: r.assigned_routes ?? [],
  rotations: r.rotations ?? [],
  phone: r.phone ?? undefined,
  vehicle: r.vehicle ?? undefined,
  note: r.note ?? undefined,
});

/** 특정 roster의 인원 목록. */
export async function fetchWorkersByRoster(rosterId: string): Promise<Worker[]> {
  const { data, error } = await supabase
    .from('workers')
    .select('*')
    .eq('weekly_roster_id', rosterId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => workerFromRow(r as WorkerRow));
}

export async function upsertWorker(worker: Worker, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('workers').upsert({
    id: worker.id,
    weekly_roster_id: worker.weeklyRosterId,
    camp_id: worker.campId,
    name: worker.name,
    login_id: worker.loginId,
    role: worker.role,
    assigned_routes: worker.assignedRoutes,
    rotations: worker.rotations,
    phone: worker.phone ?? null,
    vehicle: worker.vehicle ?? null,
    note: worker.note ?? null,
    sort_order: sortOrder,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deleteWorker(workerId: string): Promise<void> {
  const { error } = await supabase.from('workers').delete().eq('id', workerId);
  if (error) throw error;
}

/** 특정 roster의 모든 인원 삭제 (백업 복구/주차 불러오기 시 덮어쓰기용). */
export async function deleteWorkersByRoster(rosterId: string): Promise<void> {
  const { error } = await supabase.from('workers').delete().eq('weekly_roster_id', rosterId);
  if (error) throw error;
}

// ─── Worker Orders ──────────────────────────────────────

export async function updateWorkerOrders(
  campId: string,
  weekStart: string,
  section: string,
  roleType: string,
  ids: string[],
): Promise<void> {
  const { error } = await supabase.from('worker_orders').upsert({
    camp_id: campId,
    week_start: weekStart,
    section,
    role_type: roleType,
    ordered_ids: ids,
  });
  if (error) throw error;
}

export async function fetchWorkerOrders(
  campId: string,
  weekStart: string,
): Promise<Record<string, Record<string, string[]>>> {
  const { data, error } = await supabase
    .from('worker_orders')
    .select('*')
    .eq('camp_id', campId)
    .eq('week_start', weekStart);
  if (error) throw error;
  const result: Record<string, Record<string, string[]>> = {};
  for (const r of data ?? []) {
    if (!result[r.section]) result[r.section] = {};
    result[r.section][r.role_type] = r.ordered_ids ?? [];
  }
  return result;
}

// ─── Routes ─────────────────────────────────────────────

type RouteRow = {
  id: string;
  weekly_roster_id: string;
  camp_id: string;
  route_id: string;
  sub_routes: string[] | null;
  sort_order: number | null;
};

const routeFromRow = (r: RouteRow): Route => ({
  id: r.route_id,            // 앱 모델에서 Route.id 는 사용자 facing 번호 (예: '707')
  subRoutes: r.sub_routes ?? [],
});

/** 특정 roster의 라우트 목록. */
export async function fetchRoutesByRoster(rosterId: string): Promise<Route[]> {
  const { data, error } = await supabase
    .from('routes')
    .select('*')
    .eq('weekly_roster_id', rosterId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => routeFromRow(r as RouteRow));
}

/** 라우트 upsert — onConflict 키는 (weekly_roster_id, route_id) UNIQUE 인덱스. */
export async function upsertRoute(
  rosterId: string,
  campId: string,
  route: Route,
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase.from('routes').upsert(
    {
      weekly_roster_id: rosterId,
      camp_id: campId,
      route_id: route.id,
      sub_routes: route.subRoutes,
      sort_order: sortOrder,
    },
    { onConflict: 'weekly_roster_id,route_id' },
  );
  if (error) throw error;
}

export async function deleteRoute(rosterId: string, routeId: string): Promise<void> {
  const { error } = await supabase
    .from('routes')
    .delete()
    .eq('weekly_roster_id', rosterId)
    .eq('route_id', routeId);
  if (error) throw error;
}

/** 특정 roster의 모든 라우트 삭제 (백업 복구/주차 불러오기 시 덮어쓰기용). */
export async function deleteRoutesByRoster(rosterId: string): Promise<void> {
  const { error } = await supabase.from('routes').delete().eq('weekly_roster_id', rosterId);
  if (error) throw error;
}

// ─── Schedule Cells ─────────────────────────────────────
// 변경 없음 — worker_id 가 이미 roster에 매여있으므로 자연스럽게 주차 스코프됨.

export async function fetchCellsByCamp(campId: string, dateRange?: { start: string; end: string }): Promise<Record<string, ScheduleCell>> {
  let query = supabase.from('schedule_cells').select('*').eq('camp_id', campId);
  if (dateRange) {
    query = query.gte('date', dateRange.start).lte('date', dateRange.end);
  }
  const { data, error } = await query;
  if (error) throw error;
  const cells: Record<string, ScheduleCell> = {};
  for (const r of data ?? []) {
    const key = `${r.worker_id}::${r.date}`;
    cells[key] = {
      workerId: r.worker_id,
      date: r.date,
      status: r.status,
      routes: r.routes ?? [],
    };
  }
  return cells;
}

export async function upsertCell(cell: ScheduleCell, campId: string): Promise<void> {
  const { error } = await supabase.from('schedule_cells').upsert({
    worker_id: cell.workerId,
    date: cell.date,
    status: cell.status,
    routes: cell.routes,
    camp_id: campId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function upsertCellsBatch(cells: ScheduleCell[], campId: string): Promise<void> {
  if (!cells.length) return;
  const rows = cells.map(c => ({
    worker_id: c.workerId,
    date: c.date,
    status: c.status,
    routes: c.routes,
    camp_id: campId,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('schedule_cells').upsert(rows);
  if (error) throw error;
}

export async function deleteCell(workerId: string, date: string): Promise<void> {
  const { error } = await supabase.from('schedule_cells').delete().eq('worker_id', workerId).eq('date', date);
  if (error) throw error;
}

// ─── Camp Locks (v1.1: 주차별) ──────────────────────────

/** 현재 로그인 사용자의 표시 이름 (본인 profiles 행 — RLS 허용). 없으면 이메일 앞부분. */
async function currentDisplayName(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', userId)
    .maybeSingle();
  if (!data) return null;
  return data.display_name || (data.email ? String(data.email).split('@')[0] : null);
}

export async function acquireLock(
  campId: string,
  weekStart: string,
  sessionId: string,
): Promise<{ success: boolean; lock?: CampLock }> {
  // 기존 잠금 조회 (profiles 조인 없이 — 이름은 잠금 행에 직접 저장된 값을 사용)
  const { data: existing } = await supabase
    .from('camp_locks')
    .select('*')
    .eq('camp_id', campId)
    .eq('week_start', weekStart)
    .maybeSingle();

  const userId = (await supabase.auth.getUser()).data.user?.id;

  if (existing) {
    const heartbeatAge = Date.now() - new Date(existing.heartbeat).getTime();
    if (heartbeatAge < 45000) {
      if (existing.locked_by === userId) {
        // 내 잠금 — heartbeat 갱신 (이름도 최신화)
        await supabase
          .from('camp_locks')
          .update({
            heartbeat: new Date().toISOString(),
            session_id: sessionId,
            locked_by_name: await currentDisplayName(userId),
          })
          .eq('camp_id', campId)
          .eq('week_start', weekStart);
        return { success: true };
      }
      return {
        success: false,
        lock: {
          campId: existing.camp_id,
          weekStart: existing.week_start,
          lockedBy: existing.locked_by,
          lockedAt: existing.locked_at,
          heartbeat: existing.heartbeat,
          sessionId: existing.session_id,
          displayName: existing.locked_by_name ?? undefined,
        },
      };
    }
    // stale 잠금 — 정리
    await supabase
      .from('camp_locks')
      .delete()
      .eq('camp_id', campId)
      .eq('week_start', weekStart);
  }

  // 새 잠금 (편집자 이름을 행에 함께 저장)
  const { error } = await supabase.from('camp_locks').insert({
    camp_id: campId,
    week_start: weekStart,
    locked_by: userId,
    session_id: sessionId,
    heartbeat: new Date().toISOString(),
    locked_by_name: await currentDisplayName(userId),
  });
  if (error) {
    // race — 다른 사용자가 잡음
    return { success: false };
  }
  return { success: true };
}

export async function releaseLock(campId: string, weekStart: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  await supabase
    .from('camp_locks')
    .delete()
    .eq('camp_id', campId)
    .eq('week_start', weekStart)
    .eq('locked_by', userId);
}

export async function heartbeatLock(campId: string, weekStart: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  await supabase
    .from('camp_locks')
    .update({ heartbeat: new Date().toISOString() })
    .eq('camp_id', campId)
    .eq('week_start', weekStart)
    .eq('locked_by', userId);
}

export async function getAllLocks(): Promise<CampLock[]> {
  const { data, error } = await supabase
    .from('camp_locks')
    .select('*');
  if (error) throw error;
  return (data ?? []).map(r => ({
    campId: r.camp_id,
    weekStart: r.week_start,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at,
    heartbeat: r.heartbeat,
    sessionId: r.session_id,
  }));
}

// ─── Permissions ────────────────────────────────────────

export async function fetchPermissions(): Promise<CampPermission[]> {
  const { data, error } = await supabase
    .from('camp_permissions')
    .select('*');
  if (error) throw error;
  return (data ?? []).map(r => ({
    userId: r.user_id,
    campId: r.camp_id,
    canEdit: r.can_edit,
  }));
}

export async function setPermission(userId: string, campId: string, canEdit: boolean): Promise<void> {
  if (canEdit) {
    const { error } = await supabase.from('camp_permissions').upsert({
      user_id: userId,
      camp_id: campId,
      can_edit: true,
    });
    if (error) throw error;
  } else {
    await supabase.from('camp_permissions').delete().eq('user_id', userId).eq('camp_id', campId);
  }
}

// ─── Users (admin only) ─────────────────────────────────

export interface UserProfile {
  id: string;
  email: string;
  role: string;
  displayName: string;
}

export async function fetchAllUsers(): Promise<UserProfile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id,
    email: r.email,
    role: r.role,
    displayName: r.display_name,
  }));
}
