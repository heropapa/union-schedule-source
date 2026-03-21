import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useScheduleStore } from '../../store/useScheduleStore';
import { useWorkerStore } from '../../store/useWorkerStore';
import { useHistoryStore } from '../../store/useHistoryStore';
import { markDirty } from '../../store/historyBridge';
import { DAY_LABELS, COMPANIES } from '../../types';
import type { Worker, CellStatus } from '../../types';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale/ko';
import { exportScheduleExcel } from '../../utils/exportExcel';
import { exportAdminExcel } from '../../utils/exportAdminExcel';
import { toPng } from 'html-to-image';
import { useAuthStore } from '../../store/useAuthStore';
import { toDisplayName } from '../../lib/supabase';
import './ScheduleGrid.css';

/** 편집 중인 셀 정보 */
interface EditingCell {
  workerId: string;
  date: string;
  defaultValue: string;
}

/** ID 배열 재정렬 */
function reorderIds(currentOrder: string[], dragId: string, overId: string): string[] {
  const order = [...currentOrder];
  const fromIdx = order.indexOf(dragId);
  const toIdx = order.indexOf(overId);
  if (fromIdx === -1 || toIdx === -1) return currentOrder;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, dragId);
  return order;
}

/** 로컬 순서 적용 (추가/삭제 자동 동기화) */
function applyOrder(workers: Worker[], order: string[]): Worker[] {
  if (order.length === 0) return workers;
  const map = new Map(workers.map((w) => [w.id, w]));
  const valid = order.filter((id) => map.has(id));
  const newIds = workers.filter((w) => !valid.includes(w.id)).map((w) => w.id);
  return [...valid, ...newIds].map((id) => map.get(id)!);
}

export default function ScheduleCalendar() {
  const store = useScheduleStore();
  const workerStore = useWorkerStore();
  const history = useHistoryStore();

  const auth = useAuthStore();
  const camps = workerStore.camps;
  const _isAdmin = auth.isAdmin(); // 나중에 권한 분리 시 사용
  const regulars = workerStore.getRegularWorkers(store.selectedCampId);
  const backups = workerStore.getBackupWorkers(store.selectedCampId);

  const weekLabel = format(store.weekStart, 'yyyy년 M월 d일', { locale: ko }) + ' 주';

  // 인라인 편집 상태
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  // 토스트 메시지
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  // 드래그 중인 라우트 (단일 칩 또는 휴무 셀 전체)
  const [dragging, setDragging] = useState<{ routes: string[]; date: string } | null>(null);

  // 드래그 중 호버된 행 (하이라이트용)
  const [dragHoverWorkerId, setDragHoverWorkerId] = useState<string | null>(null);

  // 정렬 상태 (로컬 — 사이드바와 독립, 고정/백업 분리)
  const [regularSortState, setRegularSortState] = useState<{ by: 'name' | 'routes'; dir: 'asc' | 'desc' } | null>(null);
  const [backupSortState, setBackupSortState] = useState<{ by: 'name' | 'routes'; dir: 'asc' | 'desc' } | null>(null);

  // ── 로컬 행 순서 (사이드바와 완전 독립) ──
  const [regularOrder, setRegularOrder] = useState<string[]>([]);
  const [backupOrder, setBackupOrder] = useState<string[]>([]);

  // Ctrl+S 저장 단축키
  const handleSave = useCallback(async () => {
    const s = useHistoryStore.getState();
    if (s.cloudLoading) {
      useHistoryStore.setState({ cloudLoading: false });
      return;
    }
    if (!s.dirty && s.cloudSynced) return; // 변경 없으면 무시
    s.save();
    await s.saveToCloud();
    if (useHistoryStore.getState().cloudSynced) {
      setToast('저장 완료 ✓');
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── 이미지 다운로드 (이름순 정렬 후 캡처) ──
  const [capturing, setCapturing] = useState(false);

  async function handleDownloadImage() {
    if (!tableWrapRef.current || capturing) return;
    setCapturing(true);

    // 1) 이름순 정렬 저장
    const prevRegSort = regularSortState;
    const prevBackSort = backupSortState;
    const sortedRegIds = doSort([...regulars], 'name', 'asc').map((w) => w.id);
    const sortedBackIds = doSort([...backups], 'name', 'asc').map((w) => w.id);
    setRegularOrder(sortedRegIds);
    setBackupOrder(sortedBackIds);
    setRegularSortState({ by: 'name', dir: 'asc' });
    setBackupSortState({ by: 'name', dir: 'asc' });

    // 2) 렌더 대기 후 캡처
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const dataUrl = await toPng(tableWrapRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });
      const link = document.createElement('a');
      const campName = camps.find((c) => c.id === store.selectedCampId)?.name ?? 'schedule';
      link.download = `${campName}_${weekLabel.replace(/\s/g, '_')}.png`;
      link.href = dataUrl;
      link.click();
      setToast('이미지 저장 완료 ✓');
    } catch (err: any) {
      alert('이미지 생성 실패: ' + (err.message || '알 수 없는 오류'));
    }

    // 3) 원래 순서 복원
    setRegularOrder(workerStore.getOrder(store.selectedCampId, 'table', 'regular'));
    setBackupOrder(workerStore.getOrder(store.selectedCampId, 'table', 'backup'));
    setRegularSortState(prevRegSort);
    setBackupSortState(prevBackSort);
    setCapturing(false);
  }

  // 엑셀 드롭다운 바깥 클릭 시 닫기
  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.export-dropdown-wrap')) setShowExportMenu(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showExportMenu]);

  // 캠프 변경 시 스토어에서 로컬 순서 복원
  useEffect(() => {
    setRegularOrder(workerStore.getOrder(store.selectedCampId, 'table', 'regular'));
    setBackupOrder(workerStore.getOrder(store.selectedCampId, 'table', 'backup'));
    setRegularSortState(null);
    setBackupSortState(null);
  }, [store.selectedCampId]);

  // 로컬 순서 적용
  const orderedRegulars = useMemo(() => applyOrder(regulars, regularOrder), [regulars, regularOrder]);
  const orderedBackups = useMemo(() => applyOrder(backups, backupOrder), [backups, backupOrder]);

  /** 순서를 로컬 + 스토어에 동시 저장하고 dirty 표시 */
  function syncRegularOrder(ids: string[]) {
    setRegularOrder(ids);
    workerStore.setOrder(store.selectedCampId, 'table', 'regular', ids);
    markDirty();
  }
  function syncBackupOrder(ids: string[]) {
    setBackupOrder(ids);
    workerStore.setOrder(store.selectedCampId, 'table', 'backup', ids);
    markDirty();
  }

  // ── 행 드래그 (로컬 순서 변경, 스토어 불변) ──
  const rowDragIdRef = useRef<string | null>(null);
  const rowOverIdRef = useRef<string | null>(null); // ref로 overId 추적 (stale state 방지)
  const [rowDragOver, setRowDragOver] = useState<{ id: string; pos: 'above' | 'below' } | null>(null);

  const handleRowDragStart = useCallback((workerId: string, e: React.DragEvent) => {
    rowDragIdRef.current = workerId;
    rowOverIdRef.current = null;
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  }, []);

  const handleRowDragOver = useCallback((workerId: string, e: React.DragEvent) => {
    // 행 드래그가 아닌 경우 (라우트 칩 드래그 등) 무시
    if (!rowDragIdRef.current || rowDragIdRef.current === workerId) {
      rowOverIdRef.current = null;
      setRowDragOver(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    rowOverIdRef.current = workerId; // ref에 즉시 저장
    const rect = e.currentTarget.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const pos = e.clientY < mid ? 'above' : 'below';
    setRowDragOver({ id: workerId, pos });
  }, []);

  const handleRowDrop = useCallback((isRegular: boolean) => {
    const dragId = rowDragIdRef.current;
    const overId = rowOverIdRef.current;
    rowDragIdRef.current = null;
    rowOverIdRef.current = null;
    setRowDragOver(null);

    if (!dragId || !overId || dragId === overId) return;

    if (isRegular) {
      const saved = regularOrder.filter((id) => regulars.some((w) => w.id === id));
      const added = regulars.filter((w) => !regularOrder.includes(w.id)).map((w) => w.id);
      const order = saved.length > 0 ? [...saved, ...added] : regulars.map((w) => w.id);
      syncRegularOrder(reorderIds(order, dragId, overId));
      setRegularSortState(null);
    } else {
      const saved = backupOrder.filter((id) => backups.some((w) => w.id === id));
      const added = backups.filter((w) => !backupOrder.includes(w.id)).map((w) => w.id);
      const order = saved.length > 0 ? [...saved, ...added] : backups.map((w) => w.id);
      syncBackupOrder(reorderIds(order, dragId, overId));
      setBackupSortState(null);
    }
  }, [regulars, backups, regularOrder, backupOrder]);

  const handleRowDragEnd = useCallback(() => {
    rowDragIdRef.current = null;
    rowOverIdRef.current = null;
    setRowDragOver(null);
  }, []);

  // 편집 모드 진입 시 포커스
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const doSort = (workers: Worker[], by: 'name' | 'routes', dir: 'asc' | 'desc') =>
    [...workers].sort((a, b) => {
      const cmp = by === 'name'
        ? a.name.localeCompare(b.name, 'ko')
        : a.assignedRoutes.join(',').localeCompare(b.assignedRoutes.join(','));
      return dir === 'asc' ? cmp : -cmp;
    });

  /** 고정 기사 정렬 */
  function handleRegularSort(by: 'name' | 'routes') {
    const prev = regularSortState;
    const next = (!prev || prev.by !== by) ? { by, dir: 'asc' as const }
      : prev.dir === 'asc' ? { by, dir: 'desc' as const } : null;
    setRegularSortState(next);
    if (next) {
      syncRegularOrder(doSort(orderedRegulars, next.by, next.dir).map((w) => w.id));
    } else {
      // 사이드바 순서로 복원
      const sidebarOrder = workerStore.getOrder(store.selectedCampId, 'sidebar', 'regular');
      syncRegularOrder(sidebarOrder);
    }
  }

  /** 백업 기사 정렬 */
  function handleBackupSort(by: 'name' | 'routes') {
    const prev = backupSortState;
    const next = (!prev || prev.by !== by) ? { by, dir: 'asc' as const }
      : prev.dir === 'asc' ? { by, dir: 'desc' as const } : null;
    setBackupSortState(next);
    if (next) {
      syncBackupOrder(doSort(orderedBackups, next.by, next.dir).map((w) => w.id));
    } else {
      // 사이드바 순서로 복원
      const sidebarOrder = workerStore.getOrder(store.selectedCampId, 'sidebar', 'backup');
      syncBackupOrder(sidebarOrder);
    }
  }

  function regularSortIcon(col: 'name' | 'routes') {
    if (regularSortState?.by !== col) return ' \u2195';
    return regularSortState.dir === 'asc' ? ' \u2191' : ' \u2193';
  }

  function backupSortIcon(col: 'name' | 'routes') {
    if (backupSortState?.by !== col) return ' \u2195';
    return backupSortState.dir === 'asc' ? ' \u2191' : ' \u2193';
  }

  const displayRegulars = orderedRegulars;
  const displayBackups = orderedBackups;

  /** 편집 확정 */
  function commitEdit() {
    if (!editing) return;
    const val = editValue.trim();
    if (val) {
      const routes = val.split(',').map((s) => s.trim()).filter(Boolean);
      const worker = [...regulars, ...backups].find((w) => w.id === editing.workerId);
      const status: CellStatus = worker?.role === 'backup' ? 'work' : 'custom';
      store.setCell(editing.workerId, editing.date, status, routes);
    }
    setEditing(null);
  }

  function cancelEdit() { setEditing(null); }

  function startEdit(workerId: string, date: string, defaultValue: string) {
    setEditing({ workerId, date, defaultValue });
    setEditValue(defaultValue);
  }

  /** 고정 요원 좌클릭: 근무→휴무→비움→근무 */
  function handleRegularClick(w: Worker, date: string) {
    if (editing) return;
    const cell = store.getEffectiveCell(w.id, date);
    const status: CellStatus = cell?.status ?? 'work';
    switch (status) {
      case 'work': store.setCell(w.id, date, 'off', []); break;
      case 'off': store.setCell(w.id, date, 'empty', []); break;
      case 'custom': store.setCell(w.id, date, 'empty', []); break;
      case 'empty': store.clearCell(w.id, date); break;
    }
  }

  /** 백업 요원 좌클릭: 배정 해제 */
  function handleBackupClick(w: Worker, date: string) {
    if (editing) return;
    const cell = store.getEffectiveCell(w.id, date);
    if (cell && (cell.status === 'work' || cell.status === 'custom')) {
      store.clearCell(w.id, date);
    }
  }

  /** 우클릭: 직접입력 */
  function handleRightClick(w: Worker, date: string, e: React.MouseEvent) {
    e.preventDefault();
    if (editing) return;
    if (w.role === 'backup') {
      const uncovered = store.getUncoveredRoutes(date);
      startEdit(w.id, date, uncovered.join(', '));
    } else {
      startEdit(w.id, date, w.assignedRoutes.join(', '));
    }
  }

  // ── 드래그앤드롭 (라우트 칩) ──

  function handleChipDragStart(route: string, date: string, e: React.DragEvent) {
    setDragging({ routes: [route], date });
    e.dataTransfer.setData('text/plain', `${route}::${date}`);
    e.dataTransfer.effectAllowed = 'move';
  }

  /** 휴무 셀 드래그: 해당 기사의 라우트 전체를 한번에 */
  function handleOffCellDragStart(w: Worker, date: string, e: React.DragEvent) {
    if (w.assignedRoutes.length === 0) return;
    setDragging({ routes: [...w.assignedRoutes], date });
    e.dataTransfer.setData('text/plain', `${w.assignedRoutes.join(',')}::${date}`);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleChipDragEnd() {
    setDragging(null);
    setDragHoverWorkerId(null);
  }

  /** 드롭 허용 — 백업 + 고정(work/custom/empty) */
  function handleCellDragOver(w: Worker, date: string, e: React.DragEvent) {
    if (!dragging || dragging.date !== date) {
      setDragHoverWorkerId(null);
      return;
    }
    if (w.role === 'backup') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragHoverWorkerId(w.id);
      return;
    }
    // 고정: off가 아닌 셀에만 드롭 가능
    const cell = store.getEffectiveCell(w.id, date);
    const status = cell?.status ?? 'empty';
    if (status !== 'off') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragHoverWorkerId(w.id);
    }
  }

  /** 드롭 처리 — 백업 + 고정 */
  function handleCellDrop(w: Worker, date: string, e: React.DragEvent) {
    e.preventDefault();
    setDragHoverWorkerId(null);
    if (!dragging || dragging.date !== date) return;

    const cell = store.getEffectiveCell(w.id, date);
    const existing = cell?.routes ?? [];
    const newRoutes = dragging.routes.filter((r) => !existing.includes(r));

    if (newRoutes.length > 0) {
      if (w.role === 'backup') {
        store.setCell(w.id, date, 'work', [...existing, ...newRoutes]);
      } else {
        store.setCell(w.id, date, 'custom', [...existing, ...newRoutes]);
      }
    }
    setDragging(null);
  }

  /** 백업 자동채우기: 비어있는 날에 담당 미커버 라우트를 한번에 배정 */
  function handleAutoFillBackup(w: Worker) {
    if (w.assignedRoutes.length === 0) return;
    let filled = 0;
    for (const d of store.weekDates) {
      const cell = store.getEffectiveCell(w.id, d);
      // 이미 뭔가 있으면 건너뜀 (근무, 휴무, 커스텀 모두)
      if (cell && cell.status !== 'empty') continue;
      // 해당 날짜의 미커버 라우트 중 내 담당만 필터
      const uncovered = store.getUncoveredRoutes(d);
      const myUncovered = w.assignedRoutes.filter((r) => uncovered.includes(r));
      if (myUncovered.length === 0) continue;
      store.setCell(w.id, d, 'work', myUncovered);
      filled++;
    }
    return filled;
  }

  /** 행 드래그 인디케이터 CSS 클래스 */
  function rowInsertClass(workerId: string): string {
    if (!rowDragOver || rowDragOver.id !== workerId) return '';
    return rowDragOver.pos === 'above' ? 'row-insert-above' : 'row-insert-below';
  }

  /** 셀 렌더링 */
  function renderCell(w: Worker, d: string, isBackup: boolean) {
    const isEditing = editing?.workerId === w.id && editing?.date === d;

    if (isEditing) {
      return (
        <td key={d} className="cell cell-editing">
          <input
            ref={inputRef}
            className="cell-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') cancelEdit();
            }}
            onBlur={commitEdit}
            placeholder="라우트 입력"
          />
        </td>
      );
    }

    const cell = store.getEffectiveCell(w.id, d);
    const status: CellStatus = cell?.status ?? 'empty';
    const canDrop = dragging?.date === d && (isBackup || status !== 'off');
    const isDropTarget = canDrop;

    if (isBackup) {
      let label = '';
      let title = '우클릭: 라우트 배정';
      if (status === 'work' || status === 'custom') {
        label = cell?.routes.join(',') || '근';
        title = `${cell?.routes.join(', ')} (좌클릭: 해제)`;
      }
      return (
        <td
          key={d}
          className={`cell cell-${status} ${status === 'work' ? 'backup-work' : ''} ${isDropTarget ? 'cell-drop-target' : ''}`}
          onClick={() => handleBackupClick(w, d)}
          onContextMenu={(e) => handleRightClick(w, d, e)}
          onDragOver={(e) => handleCellDragOver(w, d, e)}
          onDrop={(e) => handleCellDrop(w, d, e)}
          title={title}
        >
          {label}
        </td>
      );
    }

    // 고정 요원
    let label = '';
    let title = '좌클릭: 근무→휴무→비움 / 우클릭: 직접입력';
    const isOff = status === 'off';
    // 휴무 셀 커버 상태 판별
    let offCoverClass = '';
    if (isOff && w.assignedRoutes.length > 0) {
      const uncovered = store.getUncoveredRoutes(d);
      const duplicates = store.getDuplicateRoutes(d);
      const myRoutes = w.assignedRoutes;
      const dupRoutes = duplicates.map((dup) => dup.route);
      const hasDup = myRoutes.some((r) => dupRoutes.includes(r));
      const allCovered = myRoutes.every((r) => !uncovered.includes(r));

      if (hasDup) {
        offCoverClass = 'cell-off-duplicate'; // 중복 배정
      } else if (allCovered) {
        offCoverClass = 'cell-off-covered';   // 커버 완료
      } else {
        offCoverClass = 'cell-off-uncovered'; // 미커버
      }
    }

    if (status === 'work') {
      label = '근';
      title = `${cell?.routes.join(', ')}`;
    } else if (isOff) {
      label = '휴';
      title = `${w.assignedRoutes.join(', ')} — 드래그하여 배정`;
    } else if (status === 'custom') {
      label = cell?.routes.join(',') || '직접';
      title = `${cell?.routes.join(', ')}`;
    }

    return (
      <td
        key={d}
        className={`cell cell-${status} ${isOff && w.assignedRoutes.length > 0 ? 'cell-off-draggable' : ''} ${offCoverClass} ${isDropTarget ? 'cell-drop-target' : ''}`}
        onClick={() => handleRegularClick(w, d)}
        onContextMenu={(e) => handleRightClick(w, d, e)}
        draggable={isOff && w.assignedRoutes.length > 0}
        onDragStart={isOff ? (e) => handleOffCellDragStart(w, d, e) : undefined}
        onDragEnd={isOff ? handleChipDragEnd : undefined}
        onDragOver={(e) => handleCellDragOver(w, d, e)}
        onDrop={(e) => handleCellDrop(w, d, e)}
        title={title}
      >
        {label}
      </td>
    );
  }

  // 미커버 라우트 (날짜별)
  const uncoveredByDate = store.weekDates
    .map((d) => ({ date: d, routes: store.getUncoveredRoutes(d) }))
    .filter((x) => x.routes.length > 0);

  // 중복 배정 라우트 (날짜별)
  const duplicatesByDate = store.weekDates
    .map((d) => ({ date: d, dupes: store.getDuplicateRoutes(d) }))
    .filter((x) => x.dupes.length > 0);
  const hasDuplicates = duplicatesByDate.length > 0;

  // 선택된 캠프가 없으면 안내 표시
  if (!store.selectedCampId) {
    return (
      <div className="schedule-grid" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999', fontSize: '1.1rem' }}>
        왼쪽에서 캠프를 선택하세요
      </div>
    );
  }

  return (
    <div className="schedule-grid">
      {/* 헤더 */}
      <div className="grid-header">
        <div className="grid-nav">
          <button className="nav-btn" onClick={store.prevWeek}>&larr; 이전</button>
          <button className="nav-btn today-btn" onClick={store.goToday}>오늘</button>
          <button className="nav-btn" onClick={store.nextWeek}>다음 &rarr;</button>
        </div>
        <h2 className="week-label">{weekLabel}</h2>
        <div className="grid-toolbar">
          <button
            className="toolbar-btn undo-btn"
            onClick={history.undo}
            disabled={!history.canUndo()}
            title="되돌리기 (Undo)"
          >
            &#x21A9; 되돌리기
          </button>
          <button
            className="toolbar-btn redo-btn"
            onClick={history.redo}
            disabled={!history.canRedo()}
            title="다시 실행 (Redo)"
          >
            다시 실행 &#x21AA;
          </button>
          <button
            className={`toolbar-btn save-btn ${history.dirty ? 'save-dirty' : ''}`}
            onClick={handleSave}
            disabled={!history.dirty && history.cloudSynced && !history.cloudLoading}
            title={history.cloudLoading ? '클릭하면 저장 취소' : '저장 (Ctrl+S)'}
          >
            {history.cloudLoading ? '저장 취소' : '저장'}
          </button>
          <button
            className="toolbar-btn board-btn"
            onClick={() => { window.location.hash = '#/board'; }}
            title="스케쥴 게시판"
          >
            📋 게시판
          </button>
          <div className="export-dropdown-wrap">
            <button
              className="toolbar-btn export-btn"
              onClick={() => setShowExportMenu((v) => !v)}
              title="엑셀 다운로드"
            >
              &#x1F4E5; 엑셀 &#x25BE;
            </button>
            {showExportMenu && (
              <div className="export-dropdown-menu">
                <button onClick={() => {
                  setShowExportMenu(false);
                  const campName = camps.find((c) => c.id === store.selectedCampId)?.name ?? store.selectedCampId;
                  exportScheduleExcel({
                    campName,
                    weekLabel,
                    weekDates: store.weekDates,
                    regulars: displayRegulars,
                    backups: displayBackups,
                    getEffectiveCell: store.getEffectiveCell,
                    getUncoveredRoutes: store.getUncoveredRoutes,
                    getDuplicateRoutes: store.getDuplicateRoutes,
                  });
                }}>
                  &#x1F4CA; 일반 양식
                </button>
                <button onClick={() => {
                  setShowExportMenu(false);
                  const camp = camps.find((c) => c.id === store.selectedCampId);
                  const company = COMPANIES.find((co) => co.id === (camp?.companyId ?? 'union')) ?? COMPANIES[0];
                  exportAdminExcel({
                    config: {
                      vendorName: company.vendorName,
                      businessNumber: company.businessNumber,
                      campName: camp?.name ?? store.selectedCampId,
                      wave: camp?.wave ?? 'WAVE1',
                    },
                    weekDates: store.weekDates,
                    regulars: displayRegulars,
                    backups: displayBackups,
                    getEffectiveCell: store.getEffectiveCell,
                  });
                }}>
                  &#x1F4CB; 어드민 양식
                </button>
                <hr className="export-divider" />
                <button onClick={() => {
                  setShowExportMenu(false);
                  handleDownloadImage();
                }}>
                  &#x1F4F7; 이미지 다운로드
                </button>
              </div>
            )}
          </div>
          <span className="toolbar-user" title={auth.user?.email ?? ''}>
            {auth.role === 'admin' ? '[관리자]' : '[뷰어]'} {toDisplayName(auth.user?.email ?? '')}
          </span>
          <button className="toolbar-btn logout-btn" onClick={auth.logout} title="로그아웃">
            로그아웃
          </button>
        </div>
        <div className="grid-legend">
          <span className="legend-item"><span className="legend-box work" />근무</span>
          <span className="legend-item"><span className="legend-box off-uncovered" />휴(미커버)</span>
          <span className="legend-item"><span className="legend-box off-covered" />휴(커버)</span>
          <span className="legend-item"><span className="legend-box off-duplicate" />휴(중복)</span>
          <span className="legend-item"><span className="legend-box custom" />직접</span>
          <span className="legend-item"><span className="legend-box empty" />비움</span>
        </div>
      </div>

      {/* 테이블 */}
      <div className="grid-table-wrap" ref={tableWrapRef}>
        <table className="grid-table">
          <thead>
            <tr>
              <th className="col-type">구분</th>
              <th className="col-name sortable" onClick={() => handleRegularSort('name')}>
                이름{regularSortIcon('name')}
              </th>
              <th className="col-routes sortable" onClick={() => handleRegularSort('routes')}>
                담당 라우트{regularSortIcon('routes')}
              </th>
              {store.weekDates.map((d, i) => {
                const dayNum = new Date(d).getDay();
                return (
                  <th
                    key={d}
                    className={`col-day ${dayNum === 0 ? 'sun' : ''} ${dayNum === 6 ? 'sat' : ''}`}
                  >
                    <div>{DAY_LABELS[i]}</div>
                    <div className="day-date">{d.slice(5)}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {/* 고정 기사 */}
            {displayRegulars.map((w) => {
              const violation = store.hasWeeklyOffViolation(w.id);
              return (
                <tr
                  key={w.id}
                  className={`${violation ? 'row-violation' : ''} ${rowInsertClass(w.id)} ${dragHoverWorkerId === w.id ? 'drag-hover-row' : ''}`}
                  onDragOver={(e) => handleRowDragOver(w.id, e)}
                  onDragLeave={() => setRowDragOver(null)}
                  onDrop={() => handleRowDrop(true)}
                >
                  <td className="col-type">고정</td>
                  <td className="col-name">
                    <span
                      className="row-drag-handle"
                      title="드래그하여 순서 변경"
                      draggable
                      onDragStart={(e) => handleRowDragStart(w.id, e)}
                      onDragEnd={handleRowDragEnd}
                    >
                      &#x2630;
                    </span>
                    {w.name}
                  </td>
                  <td className="col-routes">
                    {w.assignedRoutes.length > 0 ? w.assignedRoutes.join(', ') : '-'}
                  </td>
                  {store.weekDates.map((d) => renderCell(w, d, false))}
                </tr>
              );
            })}

            {/* 구분선 */}
            <tr className="separator-row">
              <td>백업 인원</td>
              <td className="sortable backup-sort" onClick={() => handleBackupSort('name')}>
                이름{backupSortIcon('name')}
              </td>
              <td className="sortable backup-sort" onClick={() => handleBackupSort('routes')}>
                라우트{backupSortIcon('routes')}
              </td>
              <td colSpan={store.weekDates.length}></td>
            </tr>

            {/* 백업 기사 */}
            {displayBackups.map((w) => {
              const violation = store.hasWeeklyOffViolation(w.id);
              return (
              <tr
                key={w.id}
                className={`${violation ? 'row-violation' : ''} ${rowInsertClass(w.id)} ${dragHoverWorkerId === w.id ? 'drag-hover-row' : ''}`}
                onDragOver={(e) => handleRowDragOver(w.id, e)}
                onDragLeave={() => setRowDragOver(null)}
                onDrop={() => handleRowDrop(false)}
              >
                <td className="col-type backup">백업</td>
                <td className="col-name">
                  <span
                    className="row-drag-handle"
                    title="드래그하여 순서 변경"
                    draggable
                    onDragStart={(e) => handleRowDragStart(w.id, e)}
                    onDragEnd={handleRowDragEnd}
                  >
                    &#x2630;
                  </span>
                  {w.name}
                </td>
                <td className="col-routes">
                  <div className="routes-with-autofill">
                    <span className="routes-text" title={w.assignedRoutes.join(', ')}>
                      {w.assignedRoutes.length > 0 ? w.assignedRoutes.join(', ') : '-'}
                    </span>
                    {w.assignedRoutes.length > 0 && (
                      <button
                        className="auto-fill-btn"
                        title="비어있는 날에 담당 미커버 라우트 자동채우기"
                        onClick={() => handleAutoFillBackup(w)}
                      >
                        자동채우기
                      </button>
                    )}
                  </div>
                </td>
                {store.weekDates.map((d) => renderCell(w, d, true))}
              </tr>
              );
            })}

            {/* 미커버 라우트 칩 — 백업 아래 */}
            {uncoveredByDate.length > 0 && (
              <tr className="uncovered-row">
                <td colSpan={3} className="uncovered-label-cell">미커버</td>
                {store.weekDates.map((d) => {
                  const routes = store.getUncoveredRoutes(d);
                  return (
                    <td key={d} className="uncovered-cell">
                      {routes.map((r) => (
                        <span
                          key={r}
                          className={`route-chip ${dragging?.routes.includes(r) && dragging?.date === d ? 'route-chip-dragging' : ''}`}
                          draggable
                          onDragStart={(e) => handleChipDragStart(r, d, e)}
                          onDragEnd={handleChipDragEnd}
                        >
                          {r}
                        </span>
                      ))}
                    </td>
                  );
                })}
              </tr>
            )}

            {/* 중복 배정 — 미커버 아래 */}
            {hasDuplicates && (
              <tr className="duplicate-row">
                <td colSpan={3} className="duplicate-label-cell">중복</td>
                {store.weekDates.map((d) => {
                  const dupes = store.getDuplicateRoutes(d);
                  return (
                    <td key={d} className="duplicate-cell">
                      {dupes.map((dp) => (
                        <div key={dp.route} className="dupe-item" title={`${dp.route}: ${dp.workers.join(', ')}`}>
                          <span className="dupe-route">{dp.route}</span>
                          <span className="dupe-names">{dp.workers.join(',')}</span>
                        </div>
                      ))}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 위반 안내 */}
      {(() => {
        const allWorkers = [...regulars, ...backups];
        const offViolation = allWorkers.some((w) => store.hasWeeklyOffViolation(w.id));
        const noLoginId = allWorkers.filter((w) => !w.loginId);
        if (!offViolation && noLoginId.length === 0) return null;
        return (
          <div className="violation-notice">
            {offViolation && <div>주간 휴무 미지정 인원이 있습니다 (빨간 행 표시)</div>}
            {noLoginId.length > 0 && (
              <div>
                아이디 미입력: {noLoginId.map((w) => w.name).join(', ')}
              </div>
            )}
          </div>
        );
      })()}

      {/* 토스트 */}
      {toast && <div className="toast-message">{toast}</div>}

      {/* 이미지 캡처 중 표시 */}
      {capturing && <div className="toast-message">이미지 생성 중...</div>}

    </div>
  );
}
