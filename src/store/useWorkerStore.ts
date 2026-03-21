import { create } from 'zustand';
import type { Worker, WorkerRole, Route, Camp } from '../types';
import { ROTATIONS_BY_WAVE } from '../types';
import { workers as initialWorkers, routes as initialRoutes, camps as initialCamps } from '../data/sampleWorkers';
import { pushHistory } from './historyBridge';

interface OrderMap {
  sidebarRegular: string[];
  sidebarBackup: string[];
  tableRegular: string[];
  tableBackup: string[];
}

type OrderSection = 'sidebar' | 'table';
type OrderType = 'regular' | 'backup';

interface WorkerState {
  workers: Worker[];
  routes: Record<string, Route[]>;
  orders: Record<string, OrderMap>;
  camps: Camp[];

  // 조회
  getWorkersByCamp: (campId: string) => Worker[];
  getRegularWorkers: (campId: string) => Worker[];
  getBackupWorkers: (campId: string) => Worker[];
  getWorkerById: (id: string) => Worker | undefined;
  getRoutes: (campId: string) => Route[];
  getOrder: (campId: string, section: OrderSection, type: OrderType) => string[];
  setOrder: (campId: string, section: OrderSection, type: OrderType, ids: string[]) => void;

  // 캠프 CRUD
  addCamp: (name: string, wave?: string, companyId?: string) => void;
  removeCamp: (campId: string) => void;
  renameCamp: (campId: string, name: string, wave?: string) => void;
  reorderCamps: (fromId: string, toId: string) => void;

  // 인원 CRUD
  addWorker: (name: string, campId: string, role: WorkerRole, loginId?: string) => void;
  removeWorker: (workerId: string) => void;
  updateWorkerRoutes: (workerId: string, routes: string[]) => void;

  // 인원 편집
  setWorkerName: (workerId: string, name: string) => void;
  setWorkerLoginId: (workerId: string, loginId: string) => void;
  setWorkerRotations: (workerId: string, rotations: string[]) => void;
  moveWorker: (workerId: string, direction: 'up' | 'down') => void;
  sortWorkers: (campId: string, by: 'name' | 'routes', dir: 'asc' | 'desc') => void;

  // 라우트 CRUD
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

export const useWorkerStore = create<WorkerState>()((set, get) => ({
  workers: initialWorkers,
  routes: initialRoutes,
  orders: {},
  camps: initialCamps,

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
  },

  addCamp: (name, wave, companyId) => {
    pushHistory();
    const id = `camp_${++idCounter}`;
    const colorIdx = get().camps.length % CAMP_COLORS.length;
    const newCamp: Camp = { id, name, wave: wave ?? 'WAVE1', color: CAMP_COLORS[colorIdx], companyId: companyId ?? 'union' };
    set((state) => ({ camps: [...state.camps, newCamp] }));
  },

  renameCamp: (campId, name, wave) => {
    pushHistory();
    set((state) => ({
      camps: state.camps.map((c) =>
        c.id === campId ? { ...c, name, ...(wave ? { wave } : {}) } : c,
      ),
    }));
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
  },

  removeCamp: (campId) => {
    if (get().camps.length <= 1) return; // 최소 1개 유지
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
  },

  addWorker: (name, campId, role, loginId) => {
    pushHistory();
    const id = `w_${++idCounter}`;
    const camp = get().camps.find((c) => c.id === campId);
    const defaultRotations = ROTATIONS_BY_WAVE[camp?.wave ?? 'WAVE1'] ?? [];
    const newWorker: Worker = {
      id,
      name,
      loginId: loginId || '',
      campId,
      role,
      assignedRoutes: [],
      rotations: [...defaultRotations],
    };
    set((state) => ({ workers: [...state.workers, newWorker] }));
  },

  removeWorker: (workerId) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.filter((w) => w.id !== workerId),
    }));
  },

  updateWorkerRoutes: (workerId, newRoutes) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, assignedRoutes: newRoutes } : w,
      ),
    }));
  },

  setWorkerName: (workerId, name) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, name } : w,
      ),
    }));
  },

  setWorkerLoginId: (workerId, loginId) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, loginId } : w,
      ),
    }));
  },

  setWorkerRotations: (workerId, rotations) => {
    pushHistory();
    set((state) => ({
      workers: state.workers.map((w) =>
        w.id === workerId ? { ...w, rotations } : w,
      ),
    }));
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
  },

  addRoute: (campId, routeId, suffixes) => {
    pushHistory();
    const subs = (suffixes || ['A', 'B', 'C', 'D']).map((s) => `${routeId}${s}`);
    const newRoute: Route = { id: routeId, subRoutes: subs };
    set((state) => {
      const campRoutes = state.routes[campId] ?? [];
      return {
        routes: {
          ...state.routes,
          [campId]: [...campRoutes, newRoute],
        },
      };
    });
  },

  moveRoute: (campId, routeId, direction) => {
    pushHistory();
    set((state) => {
      const campRoutes = [...(state.routes[campId] ?? [])];
      const idx = campRoutes.findIndex((r) => r.id === routeId);
      if (idx === -1) return state;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= campRoutes.length) return state;
      [campRoutes[idx], campRoutes[swapIdx]] = [campRoutes[swapIdx], campRoutes[idx]];
      return { routes: { ...state.routes, [campId]: campRoutes } };
    });
  },

  updateRouteSubRoutes: (campId, routeId, subRoutes) => {
    pushHistory();
    set((state) => ({
      routes: {
        ...state.routes,
        [campId]: (state.routes[campId] ?? []).map((r) =>
          r.id === routeId ? { ...r, subRoutes } : r,
        ),
      },
    }));
  },

  removeRoute: (campId, routeId) => {
    pushHistory();
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
  },
}));
