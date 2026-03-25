import { create } from 'zustand';
import type { Worker, Route, ScheduleCell, Camp } from '../types';
import { useWorkerStore } from './useWorkerStore';
import { useScheduleStore } from './useScheduleStore';
import { registerPushSnapshot, registerMarkDirty } from './historyBridge';

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

interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];

  pushSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
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

  pushSnapshot: () => {
    const snap = captureSnapshot();
    set((state) => ({
      past: [...state.past.slice(-(MAX_HISTORY - 1)), snap],
      future: [],
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
    }));
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));

// Register bridge so stores can call pushHistory() without importing this file
registerPushSnapshot(() => useHistoryStore.getState().pushSnapshot());
registerMarkDirty(() => {});  // DB 자동 저장 — dirty 추적 불필요
