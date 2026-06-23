import { create } from 'zustand';
import type { Worker, WorkerRole, Route, Camp, WeeklyRoster } from '../types';
import { ROTATIONS_BY_WAVE } from '../types';
import { pushHistory } from './historyBridge';
import * as db from '../lib/db';
import { exportRosterExcel, type ParsedRosterCamp, type RosterExcelCamp } from '../utils/rosterExcel';

interface OrderMap {
  sidebarRegular: string[];
  sidebarBackup: string[];
  tableRegular: string[];
  tableBackup: string[];
}

type OrderSection = 'sidebar' | 'table';
type OrderType = 'regular' | 'backup';

/**
 * v1.1: 단일 (campId, weekStart) 컨텍스트를 보유.
 * 캠프나 주차가 바뀌면 loadCampWeek가 호출되어 전체를 새로 로드.
 *
 * 콜사이트가 호환되도록 routes/orders 는 여전히 campId-keyed Record 모양을
 * 유지하지만 사실상 currentCampId 키 하나만 채워짐.
 */
interface WorkerState {
  camps: Camp[];

  // 활성 컨텍스트
  currentCampId: string;
  currentWeekStart: string;       // 'YYYY-MM-DD'
  currentRoster: WeeklyRoster | null;

  workers: Worker[];                          // currentRoster의 인원
  routes: Record<string, Route[]>;            // campId → Route[] (currentCampId만 채워짐)
  orders: Record<string, OrderMap>;           // 동일

  loading: boolean;

  // ─── 로드 ────────────────────────────────────
  loadCamps: () => Promise<void>;
  /** (campId, weekStart) 컨텍스트로 전환 — roster 있으면 채우고, 없으면 빈 상태 */
  loadCampWeek: (campId: string, weekStart: string) => Promise<void>;

  // ─── Roster 관리 ─────────────────────────────
  /** 현재 (camp, week)에 빈 roster 생성 */
  createRosterFresh: () => Promise<void>;
  /** 다른 roster를 복사해서 현재 (camp, week) roster 생성 (인원/라우트만, 셀은 복제 안 함) */
  copyRosterFrom: (sourceRosterId: string) => Promise<void>;
  /** 다른 주차의 roster(인원/라우트)를 현재 (camp, week)로 불러오기 (덮어쓰기). */
  loadRosterFromWeek: (sourceRosterId: string) => Promise<void>;

  // ─── 엑셀 백업/복구 (전체 캠프, 현재 주차) ────
  /** 현재 주차의 모든 캠프 roster를 엑셀 한 파일로 백업 다운로드. */
  exportAllCamps: () => Promise<void>;
  /** 엑셀에서 파싱한 캠프들을 현재 주차에 복구 (캠프 upsert + 언급된 캠프의 roster 덮어쓰기). */
  importAllCamps: (parsed: ParsedRosterCamp[]) => Promise<void>;

  // ─── 조회 ────────────────────────────────────
  getWorkersByCamp: (campId: string) => Worker[];
  getRegularWorkers: (campId: string) => Worker[];
  getBackupWorkers: (campId: string) => Worker[];
  getWorkerById: (id: string) => Worker | undefined;
  getRoutes: (campId: string) => Route[];
  getOrder: (campId: string, section: OrderSection, type: OrderType) => string[];
  setOrder: (campId: string, section: OrderSection, type: OrderType, ids: string[]) => void;

  // ─── 캠프 CRUD ───────────────────────────────
  addCamp: (name: string, wave?: string, companyId?: string) => void;
  removeCamp: (campId: string) => void;
  renameCamp: (campId: string, name: string, wave?: string) => void;
  reorderCamps: (fromId: string, toId: string) => void;

  // ─── 인원 CRUD (currentRoster 자동 생성) ────
  addWorker: (name: string, campId: string, role: WorkerRole, loginId?: string) => void;
  removeWorker: (workerId: string) => void;
  updateWorkerRoutes: (workerId: string, routes: string[]) => void;
  setWorkerName: (workerId: string, name: string) => void;
  setWorkerLoginId: (workerId: string, loginId: string) => void;
  setWorkerRotations: (workerId: string, rotations: string[]) => void;
  moveWorker: (workerId: string, direction: 'up' | 'down') => void;
  sortWorkers: (campId: string, by: 'name' | 'routes', dir: 'asc' | 'desc') => void;

  // ─── 라우트 CRUD ─────────────────────────────
  addRoute: (campId: string, routeId: string, suffixes?: string[]) => void;
  removeRoute: (campId: string, routeId: string) => void;
  moveRoute: (campId: string, routeId: string, direction: 'up' | 'down') => void;
  updateRouteSubRoutes: (campId: string, routeId: string, subRoutes: string[]) => void;
}

let idCounter = Date.now();

const emptyOrderMap: OrderMap = {
  sidebarRegular: [], sidebarBackup: [],
  tableRegular: [], tableBackup: [],
};

const orderKey = (section: OrderSection, type: OrderType): keyof OrderMap =>
  `${section}${type.charAt(0).toUpperCase()}${type.slice(1)}` as keyof OrderMap;

const CAMP_COLORS = ['#3174ad', '#e67c73', '#33b679', '#f6bf26', '#8e24aa', '#e67c73', '#039be5', '#616161'];

function saveWorkerToDB(worker: Worker, sortOrder: number) {
  db.upsertWorker(worker, sortOrder).catch(e => console.error('DB worker save failed:', e));
}

function syncWorkerOrdersToDB(workers: Worker[]) {
  workers.forEach((w, i) => {
    db.upsertWorker(w, i).catch(e => console.error('DB worker order sync failed:', e));
  });
}

export const useWorkerStore = create<WorkerState>()((set, get) => ({
  camps: [],
  currentCampId: '',
  currentWeekStart: '',
  currentRoster: null,
  workers: [],
  routes: {},
  orders: {},
  loading: false,

  // ─── 로드 ────────────────────────────────────

  loadCamps: async () => {
    const camps = await db.fetchCamps();
    set({ camps });
  },

  loadCampWeek: async (campId, weekStart) => {
    set({
      loading: true,
      currentCampId: campId,
      currentWeekStart: weekStart,
    });

    try {
      const roster = await db.fetchRoster(campId, weekStart);

      if (!roster) {
        // roster 없음 — 빈 컨텍스트
        set({
          currentRoster: null,
          workers: [],
          routes: { [campId]: [] },
          orders: { [campId]: { ...emptyOrderMap } },
          loading: false,
        });
        return;
      }

      const [workers, routes, ordersRaw] = await Promise.all([
        db.fetchWorkersByRoster(roster.id),
        db.fetchRoutesByRoster(roster.id),
        db.fetchWorkerOrders(campId, weekStart),
      ]);

      const orderMap: OrderMap = {
        sidebarRegular: ordersRaw.sidebar?.regular ?? [],
        sidebarBackup: ordersRaw.sidebar?.backup ?? [],
        tableRegular: ordersRaw.table?.regular ?? [],
        tableBackup: ordersRaw.table?.backup ?? [],
      };

      set({
        currentRoster: roster,
        workers,
        routes: { [campId]: routes },
        orders: { [campId]: orderMap },
        loading: false,
      });
    } catch (e) {
      console.error('loadCampWeek failed:', e);
      set({ loading: false });
    }
  },

  // ─── Roster 관리 ─────────────────────────────

  createRosterFresh: async () => {
    const { currentCampId, currentWeekStart } = get();
    if (!currentCampId || !currentWeekStart) return;
    const roster = await db.createRoster({
      campId: currentCampId,
      weekStart: currentWeekStart,
      source: 'fresh',
    });
    set({
      currentRoster: roster,
      workers: [],
      routes: { [currentCampId]: [] },
      orders: { [currentCampId]: { ...emptyOrderMap } },
    });
  },

  copyRosterFrom: async (sourceRosterId) => {
    const { currentCampId, currentWeekStart } = get();
    if (!currentCampId || !currentWeekStart) return;

    // 1) source roster 의 workers/routes 가져오기
    const [srcWorkers, srcRoutes] = await Promise.all([
      db.fetchWorkersByRoster(sourceRosterId),
      db.fetchRoutesByRoster(sourceRosterId),
    ]);

    // 2) 새 roster 생성
    const newRoster = await db.createRoster({
      campId: currentCampId,
      weekStart: currentWeekStart,
      source: `copied_from:${sourceRosterId}`,
    });

    // 3) workers 복사 (새 id 부여, 새 roster에 attach)
    const copiedWorkers: Worker[] = srcWorkers.map((w) => ({
      ...w,
      id: `w_${++idCounter}`,
      weeklyRosterId: newRoster.id,
      campId: currentCampId,
    }));
    await Promise.all(copiedWorkers.map((w, i) => db.upsertWorker(w, i)));

    // 4) routes 복사
    await Promise.all(srcRoutes.map((r, i) =>
      db.upsertRoute(newRoster.id, currentCampId, r, i),
    ));

    set({
      currentRoster: newRoster,
      workers: copiedWorkers,
      routes: { [currentCampId]: srcRoutes },
      orders: { [currentCampId]: { ...emptyOrderMap } },
    });
  },

  loadRosterFromWeek: async (sourceRosterId) => {
    const { currentCampId, currentWeekStart } = get();
    if (!currentCampId || !currentWeekStart) return;

    // 1) source roster 의 인원/라우트
    const [srcWorkers, srcRoutes] = await Promise.all([
      db.fetchWorkersByRoster(sourceRosterId),
      db.fetchRoutesByRoster(sourceRosterId),
    ]);

    // 2) 현재 (camp, week) roster 확보 — state 대신 DB에서 직접 조회 (중복 생성 방지).
    //    있으면 기존 인원/라우트 비우고, 없으면 새로 생성.
    let roster = await db.fetchRoster(currentCampId, currentWeekStart);
    if (!roster) {
      roster = await db.createRoster({
        campId: currentCampId,
        weekStart: currentWeekStart,
        source: `copied_from:${sourceRosterId}`,
      });
    } else {
      await Promise.all([
        db.deleteWorkersByRoster(roster.id),
        db.deleteRoutesByRoster(roster.id),
      ]);
    }

    // 3) source 인원/라우트를 새 id로 복사
    const copiedWorkers: Worker[] = srcWorkers.map((w) => ({
      ...w,
      id: `w_${++idCounter}`,
      weeklyRosterId: roster!.id,
      campId: currentCampId,
    }));
    await Promise.all(copiedWorkers.map((w, i) => db.upsertWorker(w, i)));
    await Promise.all(srcRoutes.map((r, i) =>
      db.upsertRoute(roster!.id, currentCampId, r, i),
    ));

    // 4) 현재 (camp, week)로 새로고침
    await get().loadCampWeek(currentCampId, currentWeekStart);
  },

  // ─── 엑셀 백업/복구 ──────────────────────────

  exportAllCamps: async () => {
    const { camps, currentWeekStart } = get();
    if (!currentWeekStart) return;

    const out: RosterExcelCamp[] = [];
    for (const camp of camps) {
      const roster = await db.fetchRoster(camp.id, currentWeekStart);
      let workers: Worker[] = [];
      let routes: Route[] = [];
      if (roster) {
        [workers, routes] = await Promise.all([
          db.fetchWorkersByRoster(roster.id),
          db.fetchRoutesByRoster(roster.id),
        ]);
      }
      out.push({
        name: camp.name,
        wave: camp.wave,
        companyId: camp.companyId,
        regulars: workers.filter((w) => w.role === 'regular'),
        backups: workers.filter((w) => w.role === 'backup'),
        routes,
      });
    }

    await exportRosterExcel(out, currentWeekStart);
  },

  importAllCamps: async (parsed) => {
    const { currentWeekStart, currentCampId } = get();
    if (!currentWeekStart) return;

    for (const pc of parsed) {
      // 1) 캠프 매칭 (이름) — 없으면 추가, 있으면 wave/업체 갱신. 삭제는 절대 안 함.
      let camp = get().camps.find((c) => c.name === pc.name);
      if (!camp) {
        const id = `camp_${++idCounter}`;
        const colorIdx = get().camps.length % CAMP_COLORS.length;
        camp = { id, name: pc.name, wave: pc.wave, color: CAMP_COLORS[colorIdx], companyId: pc.companyId };
        const newCamp = camp;
        set((state) => ({ camps: [...state.camps, newCamp] }));
        await db.upsertCamp(newCamp, get().camps.length - 1);
      } else if (camp.wave !== pc.wave || camp.companyId !== pc.companyId) {
        const updated = { ...camp, wave: pc.wave, companyId: pc.companyId };
        const idx = get().camps.findIndex((c) => c.id === camp!.id);
        set((state) => ({ camps: state.camps.map((c) => (c.id === updated.id ? updated : c)) }));
        await db.upsertCamp(updated, idx);
        camp = updated;
      }

      // 2) 현재 주차 roster 확보 — 없으면 생성, 있으면 비우기
      let roster = await db.fetchRoster(camp.id, currentWeekStart);
      if (!roster) {
        roster = await db.createRoster({ campId: camp.id, weekStart: currentWeekStart, source: 'excel' });
      } else {
        await Promise.all([
          db.deleteWorkersByRoster(roster.id),
          db.deleteRoutesByRoster(roster.id),
        ]);
      }

      // 3) 인원 insert (회전 비어있으면 wave 기본값)
      const defaultRotations = ROTATIONS_BY_WAVE[camp.wave] ?? [];
      const makeWorker = (pw: ParsedRosterCamp['regulars'][number], role: WorkerRole): Worker => ({
        id: `w_${++idCounter}`,
        weeklyRosterId: roster!.id,
        campId: camp!.id,
        name: pw.name,
        loginId: pw.loginId,
        role,
        assignedRoutes: pw.assignedRoutes,
        rotations: pw.rotations.length > 0 ? pw.rotations : [...defaultRotations],
        phone: pw.phone,
        vehicle: pw.vehicle,
        note: pw.note,
      });
      const newWorkers = [
        ...pc.regulars.map((pw) => makeWorker(pw, 'regular')),
        ...pc.backups.map((pw) => makeWorker(pw, 'backup')),
      ];
      await Promise.all(newWorkers.map((w, i) => db.upsertWorker(w, i)));

      // 4) 라우트 insert
      await Promise.all(pc.routes.map((r, i) =>
        db.upsertRoute(roster!.id, camp!.id, { id: r.routeId, subRoutes: r.subRoutes }, i),
      ));
    }

    // 5) 현재 보고 있는 캠프/주차 새로고침
    if (currentCampId) {
      await get().loadCampWeek(currentCampId, currentWeekStart);
    }
  },

  // ─── 조회 ────────────────────────────────────

  getWorkersByCamp: (campId) =>
    get().workers.filter((w) => w.campId === campId),

  getRegularWorkers: (campId) =>
    get().workers.filter((w) => w.campId === campId && w.role === 'regular'),

  getBackupWorkers: (campId) =>
    get().workers.filter((w) => w.campId === campId && w.role === 'backup'),

  getWorkerById: (id) => get().workers.find((w) => w.id === id),

  getRoutes: (campId) => get().routes[campId] ?? [],

  getOrder: (campId, section, type) => {
    const camp = get().orders[campId] ?? emptyOrderMap;
    return camp[orderKey(section, type)];
  },

  setOrder: (campId, section, type, ids) => {
    set((state) => {
      const camp = state.orders[campId] ?? { ...emptyOrderMap };
      return {
        orders: {
          ...state.orders,
          [campId]: { ...camp, [orderKey(section, type)]: ids },
        },
      };
    });
    // DB 저장
    const { currentWeekStart } = get();
    if (currentWeekStart) {
      db.updateWorkerOrders(campId, currentWeekStart, section, type, ids)
        .catch(e => console.error('DB order save failed:', e));
    }
  },

  // ─── 캠프 CRUD ───────────────────────────────

  addCamp: (name, wave, companyId) => {
    pushHistory();
    const id = `camp_${++idCounter}`;
    const colorIdx = get().camps.length % CAMP_COLORS.length;
    const newCamp: Camp = { id, name, wave: wave ?? 'WAVE1', color: CAMP_COLORS[colorIdx], companyId: companyId ?? 'union' };
    set((state) => ({ camps: [...state.camps, newCamp] }));
    db.upsertCamp(newCamp, get().camps.length - 1).catch(e => console.error('DB camp add failed:', e));
  },

  renameCamp: (campId, name, wave) => {
    pushHistory();
    set((state) => ({
      camps: state.camps.map((c) =>
        c.id === campId ? { ...c, name, ...(wave ? { wave } : {}) } : c,
      ),
    }));
    const camp = get().camps.find(c => c.id === campId);
    if (camp) {
      const idx = get().camps.indexOf(camp);
      db.upsertCamp(camp, idx).catch(e => console.error('DB camp rename failed:', e));
    }
  },

  reorderCamps: (fromId, toId) => {
    pushHistory();
    set((state) => {
      const camps = [...state.camps];
      const fromIdx = camps.findIndex((c) => c.id === fromId);
      const toIdx = camps.findIndex((c) => c.id === toId);
      if (fromIdx === -1 || toIdx === -1) return state;
      const [moved] = camps.splice(fromIdx, 1);
      camps.splice(toIdx, 0, moved);
      return { camps };
    });
    get().camps.forEach((c, i) => {
      db.upsertCamp(c, i).catch(e => console.error('DB camp reorder failed:', e));
    });
  },

  removeCamp: (campId) => {
    if (get().camps.length <= 1) return;
    pushHistory();
    set((state) => ({
      camps: state.camps.filter((c) => c.id !== campId),
      workers: state.workers.filter((w) => w.campId !== campId),
      routes: Object.fromEntries(
        Object.entries(state.routes).filter(([k]) => k !== campId),
      ),
      orders: Object.fromEntries(
        Object.entries(state.orders).filter(([k]) => k !== campId),
      ),
    }));
    db.deleteCamp(campId).catch(e => console.error('DB camp delete failed:', e));
  },

  // ─── 인원 CRUD ───────────────────────────────

  addWorker: (name, campId, role, loginId) => {
    pushHistory();
    const { currentCampId, currentWeekStart, currentRoster } = get();

    // 다른 캠프/주차 추가 요청은 무시 (단일 컨텍스트 보장)
    if (campId !== currentCampId) {
      console.warn('addWorker: campId mismatch', { campId, currentCampId });
      return;
    }

    const doAdd = (rosterId: string) => {
      const id = `w_${++idCounter}`;
      const camp = get().camps.find((c) => c.id === campId);
      const defaultRotations = ROTATIONS_BY_WAVE[camp?.wave ?? 'WAVE1'] ?? [];
      const newWorker: Worker = {
        id,
        weeklyRosterId: rosterId,
        name,
        loginId: loginId || '',
        campId,
        role,
        assignedRoutes: [],
        rotations: [...defaultRotations],
      };
      set((state) => ({ workers: [...state.workers, newWorker] }));
      const sortOrder = get().workers.filter(w => w.campId === campId).length - 1;
      saveWorkerToDB(newWorker, sortOrder);
    };

    if (currentRoster) {
      doAdd(currentRoster.id);
    } else {
      // roster 없으면 자동 생성 (fresh)
      db.createRoster({ campId, weekStart: currentWeekStart, source: 'fresh' })
        .then((roster) => {
          set({ currentRoster: roster });
          doAdd(roster.id);
        })
        .catch(e => console.error('auto-create roster failed:', e));
    }
  },

  removeWorker: (workerId) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.filter((w) => w.id !== workerId),
    }));
    db.deleteWorker(workerId).catch(e => console.error('DB worker delete failed:', e));
  },

  updateWorkerRoutes: (workerId, newRoutes) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, assignedRoutes: newRoutes } : w,
      ),
    }));
    const w = get().workers.find(w => w.id === workerId);
    if (w) {
      const idx = get().workers.filter(ww => ww.campId === w.campId).indexOf(w);
      saveWorkerToDB(w, idx);
    }
  },

  setWorkerName: (workerId, name) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, name } : w,
      ),
    }));
    const w = get().workers.find(w => w.id === workerId);
    if (w) {
      const idx = get().workers.filter(ww => ww.campId === w.campId).indexOf(w);
      saveWorkerToDB(w, idx);
    }
  },

  setWorkerLoginId: (workerId, loginId) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, loginId } : w,
      ),
    }));
    const w = get().workers.find(w => w.id === workerId);
    if (w) {
      const idx = get().workers.filter(ww => ww.campId === w.campId).indexOf(w);
      saveWorkerToDB(w, idx);
    }
  },

  setWorkerRotations: (workerId, rotations) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, rotations } : w,
      ),
    }));
    const w = get().workers.find(w => w.id === workerId);
    if (w) {
      const idx = get().workers.filter(ww => ww.campId === w.campId).indexOf(w);
      saveWorkerToDB(w, idx);
    }
  },

  moveWorker: (workerId, direction) => {
    pushHistory();
    set((state) => {
      const workers = [...state.workers];
      const idx = workers.findIndex((w) => w.id === workerId);
      if (idx === -1) return state;
      const worker = workers[idx];
      if (direction === 'up') {
        for (let i = idx - 1; i >= 0; i--) {
          if (workers[i].campId === worker.campId && workers[i].role === worker.role) {
            [workers[idx], workers[i]] = [workers[i], workers[idx]];
            return { workers };
          }
        }
      } else {
        for (let i = idx + 1; i < workers.length; i++) {
          if (workers[i].campId === worker.campId && workers[i].role === worker.role) {
            [workers[idx], workers[i]] = [workers[i], workers[idx]];
            return { workers };
          }
        }
      }
      return state;
    });
    syncWorkerOrdersToDB(get().workers);
  },

  sortWorkers: (campId, by, dir) => {
    pushHistory();
    set((state) => {
      const workers = [...state.workers];
      const sortGroup = (role: WorkerRole) => {
        const indices: number[] = [];
        workers.forEach((w, i) => {
          if (w.campId === campId && w.role === role) indices.push(i);
        });
        const group = indices.map((i) => workers[i]);
        group.sort((a, b) => {
          const cmp = by === 'name'
            ? a.name.localeCompare(b.name, 'ko')
            : a.assignedRoutes.join(',').localeCompare(b.assignedRoutes.join(','));
          return dir === 'asc' ? cmp : -cmp;
        });
        indices.forEach((origIdx, sortIdx) => {
          workers[origIdx] = group[sortIdx];
        });
      };
      sortGroup('regular');
      sortGroup('backup');
      return { workers };
    });
    syncWorkerOrdersToDB(get().workers);
  },

  // ─── 라우트 CRUD ─────────────────────────────

  addRoute: (campId, routeId, suffixes) => {
    pushHistory();
    const { currentCampId, currentWeekStart, currentRoster } = get();
    if (campId !== currentCampId) {
      console.warn('addRoute: campId mismatch', { campId, currentCampId });
      return;
    }

    const subs = (suffixes || ['A', 'B', 'C', 'D']).map((s) => `${routeId}${s}`);
    const newRoute: Route = { id: routeId, subRoutes: subs };

    const doAdd = (rosterId: string) => {
      set((state) => {
        const campRoutes = state.routes[campId] ?? [];
        return {
          routes: { ...state.routes, [campId]: [...campRoutes, newRoute] },
        };
      });
      const sortOrder = (get().routes[campId] ?? []).length - 1;
      db.upsertRoute(rosterId, campId, newRoute, sortOrder)
        .catch(e => console.error('DB route add failed:', e));
    };

    if (currentRoster) {
      doAdd(currentRoster.id);
    } else {
      db.createRoster({ campId, weekStart: currentWeekStart, source: 'fresh' })
        .then((roster) => {
          set({ currentRoster: roster });
          doAdd(roster.id);
        })
        .catch(e => console.error('auto-create roster failed:', e));
    }
  },

  moveRoute: (campId, routeId, direction) => {
    pushHistory();
    const { currentRoster } = get();
    if (!currentRoster) return;

    set((state) => {
      const campRoutes = [...(state.routes[campId] ?? [])];
      const idx = campRoutes.findIndex((r) => r.id === routeId);
      if (idx === -1) return state;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= campRoutes.length) return state;
      [campRoutes[idx], campRoutes[swapIdx]] = [campRoutes[swapIdx], campRoutes[idx]];
      return { routes: { ...state.routes, [campId]: campRoutes } };
    });
    (get().routes[campId] ?? []).forEach((r, i) => {
      db.upsertRoute(currentRoster.id, campId, r, i)
        .catch(e => console.error('DB route reorder failed:', e));
    });
  },

  updateRouteSubRoutes: (campId, routeId, subRoutes) => {
    pushHistory();
    const { currentRoster } = get();
    if (!currentRoster) return;

    set((state) => ({
      routes: {
        ...state.routes,
        [campId]: (state.routes[campId] ?? []).map((r) =>
          r.id === routeId ? { ...r, subRoutes } : r,
        ),
      },
    }));
    const route = (get().routes[campId] ?? []).find(r => r.id === routeId);
    if (route) {
      const idx = (get().routes[campId] ?? []).indexOf(route);
      db.upsertRoute(currentRoster.id, campId, route, idx)
        .catch(e => console.error('DB route update failed:', e));
    }
  },

  removeRoute: (campId, routeId) => {
    pushHistory();
    const { currentRoster } = get();
    if (!currentRoster) return;

    set((state) => {
      const campRoutes = (state.routes[campId] ?? []).filter((r) => r.id !== routeId);
      const removedSubs = new Set(
        (state.routes[campId] ?? [])
          .filter((r) => r.id === routeId)
          .flatMap((r) => r.subRoutes),
      );
      const workers = state.workers.map((w) => {
        if (w.campId !== campId) return w;
        const filtered = w.assignedRoutes.filter((r) => !removedSubs.has(r));
        if (filtered.length === w.assignedRoutes.length) return w;
        return { ...w, assignedRoutes: filtered };
      });
      return {
        routes: { ...state.routes, [campId]: campRoutes },
        workers,
      };
    });
    db.deleteRoute(currentRoster.id, routeId)
      .catch(e => console.error('DB route delete failed:', e));
    // worker assignedRoutes 변경도 DB에 반영
    const campWorkers = get().workers.filter(w => w.campId === campId);
    campWorkers.forEach((w, i) => saveWorkerToDB(w, i));
  },
}));
