import { create } from 'zustand';
import type { Worker, Route, ScheduleCell, Camp } from '../types';
import { useWorkerStore } from './useWorkerStore';
import { useScheduleStore } from './useScheduleStore';
import { registerPushSnapshot, registerMarkDirty } from './historyBridge';
import { supabase } from '../lib/supabase';

interface OrderMap {
  sidebarRegular: string[];
  sidebarBackup: string[];
  tableRegular: string[];
  tableBackup: string[];
}

interface Snapshot {
  workers: Worker[];
  routes: Record<string, Route[]>;
  cells: Record<string, ScheduleCell>;
  orders?: Record<string, OrderMap>;
  camps?: Camp[];
}

const MAX_HISTORY = 50;
const STORAGE_KEY = 'schedule-saved-data';
let _abortController: AbortController | null = null;

/** 캠프별 스냅샷 */
interface CampSnapshot {
  workers: Worker[];
  routes: Route[];
  cells: Record<string, ScheduleCell>;
}

/** 메타 정보 (캠프 목록, 정렬 등) */
interface MetaSnapshot {
  camps: Camp[];
  orders: Record<string, OrderMap>;
}

/** 캠프별 dirty 감지 — loaded 시점과 비교 */
function getDirtyCampIds(loaded: Snapshot | null, current: Snapshot): string[] {
  if (!loaded) {
    // 최초 저장 — 모든 캠프가 dirty
    return (current.camps ?? []).map((c) => c.id);
  }
  const allCampIds = new Set([
    ...(loaded.camps ?? []).map((c) => c.id),
    ...(current.camps ?? []).map((c) => c.id),
  ]);
  const dirty: string[] = [];
  for (const campId of allCampIds) {
    const loadedWorkers = loaded.workers.filter((w) => w.campId === campId);
    const currentWorkers = current.workers.filter((w) => w.campId === campId);
    if (JSON.stringify(loadedWorkers) !== JSON.stringify(currentWorkers)) {
      dirty.push(campId);
      continue;
    }
    const loadedRoutes = loaded.routes[campId] ?? [];
    const currentRoutes = current.routes[campId] ?? [];
    if (JSON.stringify(loadedRoutes) !== JSON.stringify(currentRoutes)) {
      dirty.push(campId);
      continue;
    }
    const workerIds = new Set(currentWorkers.map((w) => w.id));
    const loadedCells = Object.entries(loaded.cells)
      .filter(([k]) => workerIds.has(k.split('::')[0]))
      .sort(([a], [b]) => a.localeCompare(b));
    const currentCells = Object.entries(current.cells)
      .filter(([k]) => workerIds.has(k.split('::')[0]))
      .sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(loadedCells) !== JSON.stringify(currentCells)) {
      dirty.push(campId);
      continue;
    }
  }
  return dirty;
}

interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  cloudSynced: boolean;   // Supabase 동기화 상태
  cloudLoading: boolean;
  loadedSnapshot: Snapshot | null;  // 로드 시점 스냅샷 (dirty 비교용)

  pushSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  save: () => void;
  load: () => void;
  saveToCloud: () => Promise<void>;
  loadFromCloud: () => Promise<boolean>;
}

function captureSnapshot(): Snapshot {
  const ws = useWorkerStore.getState();
  const ss = useScheduleStore.getState();
  return {
    workers: JSON.parse(JSON.stringify(ws.workers)),
    routes: JSON.parse(JSON.stringify(ws.routes)),
    cells: JSON.parse(JSON.stringify(ss.cells)),
    orders: JSON.parse(JSON.stringify(ws.orders)),
    camps: JSON.parse(JSON.stringify(ws.camps)),
  };
}

function restoreSnapshot(snap: Snapshot) {
  useWorkerStore.setState({
    workers: snap.workers,
    routes: snap.routes,
    ...(snap.orders ? { orders: snap.orders } : {}),
    ...(snap.camps ? { camps: snap.camps } : {}),
  });
  useScheduleStore.setState({ cells: snap.cells });
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  dirty: false,
  cloudSynced: false,
  cloudLoading: false,
  loadedSnapshot: null,

  pushSnapshot: () => {
    const snap = captureSnapshot();
    set((state) => ({
      past: [...state.past.slice(-(MAX_HISTORY - 1)), snap],
      future: [],
      dirty: true,
      cloudSynced: false,
    }));
  },

  undo: () => {
    const { past } = get();
    if (past.length === 0) return;
    const current = captureSnapshot();
    const prev = past[past.length - 1];
    restoreSnapshot(prev);
    set((state) => ({
      past: state.past.slice(0, -1),
      future: [current, ...state.future],
      dirty: true,
      cloudSynced: false,
    }));
  },

  redo: () => {
    const { future } = get();
    if (future.length === 0) return;
    const current = captureSnapshot();
    const next = future[0];
    restoreSnapshot(next);
    set((state) => ({
      past: [...state.past, current],
      future: state.future.slice(1),
      dirty: true,
      cloudSynced: false,
    }));
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  // localStorage 저장 (로컬 캐시, 사용자별)
  save: () => {
    const snap = captureSnapshot();
    try {
      // 사용자별 키 사용
      supabase.auth.getUser().then(({ data: { user } }) => {
        const key = user ? `${STORAGE_KEY}-${user.id}` : STORAGE_KEY;
        localStorage.setItem(key, JSON.stringify(snap));
      });
      set({ dirty: false });
    } catch {
      // storage quota exceeded
    }
  },

  // localStorage 로드 (폴백, 사용자별)
  load: () => {
    try {
      supabase.auth.getUser().then(({ data: { user } }) => {
        const key = user ? `${STORAGE_KEY}-${user.id}` : STORAGE_KEY;
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const snap: Snapshot = JSON.parse(raw);
        if (snap.workers && snap.routes && snap.cells) {
          restoreSnapshot(snap);
          useHistoryStore.setState({ past: [], future: [], dirty: false });
        }
      });
    } catch {
      // invalid data
    }
  },

  // Supabase Storage에 캠프별 분리 저장
  saveToCloud: async () => {
    if (get().cloudLoading) {
      if (_abortController) _abortController.abort();
      set({ cloudLoading: false });
      return;
    }
    set({ cloudLoading: true });
    const snap = captureSnapshot();
    const camps = snap.camps ?? [];

    _abortController = new AbortController();
    const timer = setTimeout(() => _abortController?.abort(), 30000);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('로그인 필요');

      // localStorage 캐시 (전체 스냅샷)
      try {
        localStorage.setItem(`${STORAGE_KEY}-${user.id}`, JSON.stringify(snap));
      } catch { /* ignore */ }

      const uid = user.id;

      // 1) 메타 저장 (캠프 목록 + 정렬)
      const meta: MetaSnapshot = { camps, orders: snap.orders ?? {} };
      const metaBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
      const { error: metaErr } = await supabase.storage
        .from('snapshots')
        .upload(`${uid}/meta.json`, metaBlob, { upsert: true, contentType: 'application/json' });
      if (metaErr) throw new Error(`meta 저장 실패: ${metaErr.message}`);

      // 2) 변경된 캠프만 저장
      const dirtyCamps = getDirtyCampIds(get().loadedSnapshot, snap);
      console.log(`저장: 전체 ${camps.length}캠프 중 ${dirtyCamps.length}캠프 변경 → [${dirtyCamps.map((id) => camps.find((c) => c.id === id)?.name ?? id).join(', ')}]`);

      for (const campId of dirtyCamps) {
        const campWorkers = snap.workers.filter((w) => w.campId === campId);
        const workerIds = new Set(campWorkers.map((w) => w.id));
        const campCells: Record<string, ScheduleCell> = {};
        for (const [k, v] of Object.entries(snap.cells)) {
          if (workerIds.has(k.split('::')[0])) campCells[k] = v;
        }
        const campData: CampSnapshot = {
          workers: campWorkers,
          routes: snap.routes[campId] ?? [],
          cells: campCells,
        };
        const blob = new Blob([JSON.stringify(campData)], { type: 'application/json' });
        const { error } = await supabase.storage
          .from('snapshots')
          .upload(`${uid}/camp_${campId}.json`, blob, { upsert: true, contentType: 'application/json' });
        if (error) throw new Error(`${campId} 저장 실패: ${error.message}`);
      }

      clearTimeout(timer);

      // 저장 완료 → loadedSnapshot 갱신
      const newLoaded = JSON.parse(JSON.stringify(snap)) as Snapshot;
      set({ dirty: false, cloudSynced: true, cloudLoading: false, loadedSnapshot: newLoaded });
    } catch (err: any) {
      clearTimeout(timer);
      set({ cloudLoading: false });
      if (err?.name === 'AbortError' || err?.message?.includes('abort')) {
        alert('저장 시간 초과. 다시 시도해주세요.');
      } else {
        console.error('Cloud save failed:', err);
        const msg = err?.message || err?.toString?.() || JSON.stringify(err) || '원인 불명';
        alert(`저장 실패:\n${msg}`);
      }
    } finally {
      _abortController = null;
    }
  },

  // Supabase Storage에서 캠프별 로드 (meta.json 없으면 기존 schedule.json 폴백)
  loadFromCloud: async () => {
    set({ cloudLoading: true });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        set({ cloudLoading: false });
        return false;
      }
      const uid = user.id;

      // 1) meta.json 시도
      const { data: metaData } = await supabase.storage
        .from('snapshots')
        .download(`${uid}/meta.json`);

      if (metaData) {
        // 캠프별 로드
        const meta = JSON.parse(await metaData.text()) as MetaSnapshot;
        const allWorkers: Worker[] = [];
        const allRoutes: Record<string, Route[]> = {};
        const allCells: Record<string, ScheduleCell> = {};

        // 각 캠프 파일 병렬 다운로드
        const results = await Promise.allSettled(
          meta.camps.map(async (camp) => {
            const { data } = await supabase.storage
              .from('snapshots')
              .download(`${uid}/camp_${camp.id}.json`);
            if (!data) return null;
            return { campId: camp.id, ...(JSON.parse(await data.text()) as CampSnapshot) };
          }),
        );

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { campId, workers, routes, cells } = r.value;
          allWorkers.push(...workers);
          allRoutes[campId] = routes;
          Object.assign(allCells, cells);
        }

        const snap: Snapshot = {
          workers: allWorkers,
          routes: allRoutes,
          cells: allCells,
          orders: meta.orders,
          camps: meta.camps,
        };

        restoreSnapshot(snap);
        const loadedCopy = JSON.parse(JSON.stringify(snap)) as Snapshot;
        try {
          localStorage.setItem(`${STORAGE_KEY}-${uid}`, JSON.stringify(snap));
        } catch { /* ignore */ }
        set({ past: [], future: [], dirty: false, cloudSynced: true, cloudLoading: false, loadedSnapshot: loadedCopy });
        console.log(`로드: ${meta.camps.length}캠프 로드 완료`);
        return true;
      }

      // 2) 기존 schedule.json 폴백 (마이그레이션)
      const { data: legacyData, error: legacyErr } = await supabase.storage
        .from('snapshots')
        .download(`${uid}/schedule.json`);

      if (legacyErr || !legacyData) {
        set({ cloudLoading: false });
        return false;
      }

      const jsonStr = await legacyData.text();
      const snap = JSON.parse(jsonStr) as Snapshot;

      if (snap.workers && snap.routes && snap.cells) {
        restoreSnapshot(snap);
        const loadedCopy = JSON.parse(JSON.stringify(snap)) as Snapshot;
        try {
          localStorage.setItem(`${STORAGE_KEY}-${uid}`, jsonStr);
        } catch { /* ignore */ }
        set({ past: [], future: [], dirty: false, cloudSynced: true, cloudLoading: false, loadedSnapshot: loadedCopy });
        console.log('로드: 기존 schedule.json에서 로드 (마이그레이션 필요)');
        return true;
      }
      set({ cloudLoading: false });
      return false;
    } catch (err) {
      console.error('Cloud load failed:', err);
      set({ cloudLoading: false });
      return false;
    }
  },
}));

// Register bridge so stores can call pushHistory() without importing this file
registerPushSnapshot(() => useHistoryStore.getState().pushSnapshot());
registerMarkDirty(() => useHistoryStore.setState({ dirty: true, cloudSynced: false }));
