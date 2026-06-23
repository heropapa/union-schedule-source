import { create } from 'zustand';
import type { CellStatus, ScheduleCell, SubRoute, Worker } from '../types';
import { useWorkerStore } from './useWorkerStore';
import { pushHistory } from './historyBridge';
import { format, addDays, startOfWeek } from 'date-fns';
import * as db from '../lib/db';

/** 셀 키 생성 */
function cellKey(workerId: string, date: string) {
  return `${workerId}::${date}`;
}

/** 주의 시작일(일요일) 구하기 */
function getWeekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 0 });
}

/** 주의 날짜 배열 (일~토) */
function getWeekDates(ws: Date): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    format(addDays(ws, i), 'yyyy-MM-dd'),
  );
}

interface ScheduleState {
  /** 셀 데이터: key = "workerId::yyyy-MM-dd" — 기본값과 다른 것만 저장 */
  cells: Record<string, ScheduleCell>;
  selectedCampId: string;
  weekStart: Date;
  weekDates: string[];

  // DB 로드
  loadCells: (campId: string, dateRange?: { start: string; end: string }) => Promise<void>;

  // 네비게이션
  setcamp: (campId: string) => void;
  setWeek: (date: Date) => void;
  prevWeek: () => void;
  nextWeek: () => void;
  goToday: () => void;

  // 셀 조작
  setCell: (workerId: string, date: string, status: CellStatus, cellRoutes: SubRoute[]) => void;
  clearCell: (workerId: string, date: string) => void;
  /** 엑셀 업로드 등으로 여러 셀을 한 번에 반영 (undo 1회로 묶임) */
  applyImportedCells: (cells: ScheduleCell[]) => void;

  // 셀 조회 (저장된 값만)
  getCell: (workerId: string, date: string) => ScheduleCell | undefined;
  // 기본값 포함 실질 셀 (고정=근무, 백업=undefined)
  getEffectiveCell: (workerId: string, date: string) => ScheduleCell | undefined;

  // 분석
  hasWeeklyOffViolation: (workerId: string) => boolean;
  getUncoveredRoutes: (date: string) => SubRoute[];
  getOffWorkersForDate: (date: string) => Array<{ worker: Worker; routes: SubRoute[] }>;
  getDuplicateRoutes: (date: string) => Array<{ route: SubRoute; workers: string[] }>;
}

const initialWeekStart = getWeekStart(new Date());

/** 주차 변경 시 워커 스토어를 (current camp, 새 주차) 로 재로드 */
function reloadWorkersForCurrent(newWeekStart: Date) {
  const ss = useScheduleStore.getState();
  if (!ss.selectedCampId) return;
  useWorkerStore.getState().loadCampWeek(ss.selectedCampId, format(newWeekStart, 'yyyy-MM-dd'))
    .catch(e => console.error('loadCampWeek on week change failed:', e));
}

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  cells: {},
  selectedCampId: '',
  weekStart: initialWeekStart,
  weekDates: getWeekDates(initialWeekStart),

  loadCells: async (campId, dateRange) => {
    const cells = await db.fetchCellsByCamp(campId, dateRange);
    set((state) => ({
      cells: { ...state.cells, ...cells },
    }));
  },

  setcamp: (campId) => {
    set({ selectedCampId: campId });
    // 캠프 전환 시 워커 스토어도 (campId, currentWeekStart) 컨텍스트로 동기화
    const ws = get().weekStart;
    useWorkerStore.getState().loadCampWeek(campId, format(ws, 'yyyy-MM-dd'))
      .catch(e => console.error('loadCampWeek on setcamp failed:', e));
  },

  setWeek: (date) => {
    const ws = getWeekStart(date);
    set({ weekStart: ws, weekDates: getWeekDates(ws) });
    reloadWorkersForCurrent(ws);
  },

  prevWeek: () => {
    const ws = addDays(get().weekStart, -7);
    set({ weekStart: ws, weekDates: getWeekDates(ws) });
    reloadWorkersForCurrent(ws);
  },

  nextWeek: () => {
    const ws = addDays(get().weekStart, 7);
    set({ weekStart: ws, weekDates: getWeekDates(ws) });
    reloadWorkersForCurrent(ws);
  },

  goToday: () => {
    const ws = getWeekStart(new Date());
    set({ weekStart: ws, weekDates: getWeekDates(ws) });
    reloadWorkersForCurrent(ws);
  },

  setCell: (workerId, date, status, cellRoutes) => {
    pushHistory();
    const key = cellKey(workerId, date);
    const cell: ScheduleCell = { workerId, date, status, routes: cellRoutes };
    set((state) => ({
      cells: { ...state.cells, [key]: cell },
    }));
    // DB 저장은 저장 버튼 클릭 시에만 (ScheduleCalendar.handleSave)
  },

  clearCell: (workerId, date) => {
    pushHistory();
    const key = cellKey(workerId, date);
    set((state) => {
      const next = { ...state.cells };
      delete next[key];
      return { cells: next };
    });
    // DB 저장은 저장 버튼 클릭 시에만
  },

  applyImportedCells: (cells) => {
    if (!cells.length) return;
    pushHistory();
    set((state) => {
      const next = { ...state.cells };
      for (const c of cells) next[cellKey(c.workerId, c.date)] = c;
      return { cells: next };
    });
    // DB 저장은 저장 버튼 클릭 시에만 (사용자가 검토 후 저장)
  },

  getCell: (workerId, date) => {
    return get().cells[cellKey(workerId, date)];
  },

  getEffectiveCell: (workerId, date) => {
    const cell = get().cells[cellKey(workerId, date)];
    if (cell) return cell;
    // 고정(regular) 기본값 = 근무 (자기 라우트)
    const worker = useWorkerStore.getState().workers.find((w) => w.id === workerId);
    if (worker?.role === 'regular') {
      return { workerId, date, status: 'work', routes: worker.assignedRoutes };
    }
    // 백업 기본값 = 비움
    return undefined;
  },

  hasWeeklyOffViolation: (workerId) => {
    const { weekDates } = get();
    const worker = useWorkerStore.getState().workers.find((w) => w.id === workerId);
    if (!worker || worker.role !== 'regular') return false;

    const hasOff = weekDates.some((d) => {
      const cell = get().cells[cellKey(workerId, d)];
      return cell?.status === 'off';
    });
    return !hasOff;
  },

  getUncoveredRoutes: (date) => {
    const { selectedCampId } = get();
    const workerState = useWorkerStore.getState();
    const campRoutes = workerState.routes[selectedCampId];
    if (!campRoutes) return [];

    const allSubRoutes = campRoutes.flatMap((r) => r.subRoutes);

    // 이 날 커버되는 라우트 수집
    const coveredRoutes = new Set<string>();
    const campWorkers = workerState.workers.filter((w) => w.campId === selectedCampId);

    for (const w of campWorkers) {
      const cell = get().getEffectiveCell(w.id, date);
      if (cell && (cell.status === 'work' || cell.status === 'custom')) {
        cell.routes.forEach((r) => coveredRoutes.add(r));
      }
    }

    return allSubRoutes.filter((r) => !coveredRoutes.has(r));
  },

  getOffWorkersForDate: (date) => {
    const { selectedCampId, cells } = get();
    const campWorkers = useWorkerStore.getState().workers.filter(
      (w) => w.campId === selectedCampId && w.role === 'regular',
    );

    return campWorkers
      .filter((w) => {
        const cell = cells[cellKey(w.id, date)];
        return cell?.status === 'off';
      })
      .map((w) => ({ worker: w, routes: w.assignedRoutes }));
  },

  getDuplicateRoutes: (date) => {
    const { selectedCampId } = get();
    const campWorkers = useWorkerStore.getState().workers.filter((w) => w.campId === selectedCampId);

    // 라우트별로 배정된 기사 목록 수집 (이름 + 회전정보)
    const routeMap = new Map<string, Array<{ name: string; rotations: string[] }>>();
    for (const w of campWorkers) {
      const cell = get().getEffectiveCell(w.id, date);
      if (cell && (cell.status === 'work' || cell.status === 'custom')) {
        for (const r of cell.routes) {
          const list = routeMap.get(r) ?? [];
          list.push({ name: w.name, rotations: w.rotations });
          routeMap.set(r, list);
        }
      }
    }

    // 같은 라우트에 2명 이상이고, 회전이 겹치는 쌍이 있으면 중복
    const dupes: Array<{ route: SubRoute; workers: string[] }> = [];
    for (const [route, entries] of routeMap) {
      if (entries.length <= 1) continue;

      // 회전이 겹치는 기사들만 중복으로 판단
      const dupWorkers = new Set<string>();
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i];
          const b = entries[j];
          // 회전 목록이 하나라도 겹치면 진짜 중복
          const hasOverlap = a.rotations.some((r) => b.rotations.includes(r));
          if (hasOverlap) {
            dupWorkers.add(a.name);
            dupWorkers.add(b.name);
          }
        }
      }
      if (dupWorkers.size > 0) {
        dupes.push({ route, workers: Array.from(dupWorkers) });
      }
    }
    return dupes;
  },
}));
