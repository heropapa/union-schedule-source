/**
 * DB 접근 레이어 — 모든 Store는 이 모듈을 통해 Supabase DB에 접근
 */
import { supabase } from './supabase';
import type { Camp, Worker, Route, ScheduleCell, SubRoute, CampPermission, CampLock } from '../types';

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

// ─── Workers ────────────────────────────────────────────

export async function fetchWorkersByCamp(campId: string): Promise<Worker[]> {
  const { data, error } = await supabase
    .from('workers')
    .select('*')
    .eq('camp_id', campId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name,
    loginId: r.login_id,
    campId: r.camp_id,
    role: r.role,
    assignedRoutes: r.assigned_routes ?? [],
    rotations: r.rotations ?? [],
    phone: r.phone ?? undefined,
    vehicle: r.vehicle ?? undefined,
    note: r.note ?? undefined,
  }));
}

export async function upsertWorker(worker: Worker, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('workers').upsert({
    id: worker.id,
    name: worker.name,
    login_id: worker.loginId,
    camp_id: worker.campId,
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

export async function updateWorkerOrders(campId: string, section: string, roleType: string, ids: string[]): Promise<void> {
  const { error } = await supabase.from('worker_orders').upsert({
    camp_id: campId,
    section,
    role_type: roleType,
    ordered_ids: ids,
  });
  if (error) throw error;
}

export async function fetchWorkerOrders(campId: string): Promise<Record<string, Record<string, string[]>>> {
  const { data, error } = await supabase
    .from('worker_orders')
    .select('*')
    .eq('camp_id', campId);
  if (error) throw error;
  const result: Record<string, Record<string, string[]>> = {};
  for (const r of data ?? []) {
    if (!result[r.section]) result[r.section] = {};
    result[r.section][r.role_type] = r.ordered_ids ?? [];
  }
  return result;
}

// ─── Routes ─────────────────────────────────────────────

export async function fetchRoutesByCamp(campId: string): Promise<Route[]> {
  const { data, error } = await supabase
    .from('routes')
    .select('*')
    .eq('camp_id', campId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.route_id,
    subRoutes: r.sub_routes ?? [],
  }));
}

export async function upsertRoute(campId: string, route: Route, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('routes').upsert(
    {
      camp_id: campId,
      route_id: route.id,
      sub_routes: route.subRoutes,
      sort_order: sortOrder,
    },
    { onConflict: 'camp_id,route_id' }
  );
  if (error) throw error;
}

export async function deleteRoute(campId: string, routeId: string): Promise<void> {
  const { error } = await supabase.from('routes').delete().eq('camp_id', campId).eq('route_id', routeId);
  if (error) throw error;
}

// ─── Schedule Cells ─────────────────────────────────────

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

// ─── Camp Locks ─────────────────────────────────────────

export async function acquireLock(campId: string, sessionId: string): Promise<{ success: boolean; lock?: CampLock }> {
  // Check existing lock
  const { data: existing } = await supabase
    .from('camp_locks')
    .select('*, profiles!camp_locks_locked_by_fkey(display_name)')
    .eq('camp_id', campId)
    .single();

  if (existing) {
    const heartbeatAge = Date.now() - new Date(existing.heartbeat).getTime();
    if (heartbeatAge < 45000) {
      // Active lock by someone else
      const userId = (await supabase.auth.getUser()).data.user?.id;
      if (existing.locked_by === userId) {
        // My own lock — refresh
        await supabase.from('camp_locks').update({ heartbeat: new Date().toISOString(), session_id: sessionId }).eq('camp_id', campId);
        return { success: true };
      }
      return {
        success: false,
        lock: {
          campId: existing.camp_id,
          lockedBy: existing.locked_by,
          lockedAt: existing.locked_at,
          heartbeat: existing.heartbeat,
          sessionId: existing.session_id,
          displayName: existing.profiles?.display_name,
        },
      };
    }
    // Stale lock — delete it
    await supabase.from('camp_locks').delete().eq('camp_id', campId);
  }

  // Insert new lock
  const userId = (await supabase.auth.getUser()).data.user?.id;
  const { error } = await supabase.from('camp_locks').insert({
    camp_id: campId,
    locked_by: userId,
    session_id: sessionId,
    heartbeat: new Date().toISOString(),
  });

  if (error) {
    // Race condition — someone else grabbed it
    return { success: false };
  }
  return { success: true };
}

export async function releaseLock(campId: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  await supabase.from('camp_locks').delete().eq('camp_id', campId).eq('locked_by', userId);
}

export async function heartbeatLock(campId: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  await supabase.from('camp_locks').update({ heartbeat: new Date().toISOString() }).eq('camp_id', campId).eq('locked_by', userId);
}

export async function getAllLocks(): Promise<CampLock[]> {
  const { data, error } = await supabase
    .from('camp_locks')
    .select('*');
  if (error) throw error;
  return (data ?? []).map(r => ({
    campId: r.camp_id,
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
