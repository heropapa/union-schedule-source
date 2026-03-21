import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useScheduleStore } from '../../store/useScheduleStore';
import { useWorkerStore } from '../../store/useWorkerStore';
import { markDirty } from '../../store/historyBridge';
import type { Worker, WorkerRole } from '../../types';
import { ROTATIONS_BY_WAVE, COMPANIES } from '../../types';
import { useAuthStore } from '../../store/useAuthStore';
import './Sidebar.css';

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

/** 드래그 재정렬 훅 (삽입 위치 표시 포함) */
function useDragReorder(onReorder: (dragId: string, overId: string) => void) {
  const dragIdRef = useRef<string | null>(null);
  const overIdRef = useRef<string | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const [dragOver, setDragOver] = useState<{ id: string; pos: 'above' | 'below' } | null>(null);

  const reset = useCallback(() => {
    dragIdRef.current = null;
    overIdRef.current = null;
    setDragOver(null);
  }, []);

  const onDragStart = useCallback((id: string, e: React.DragEvent) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const onDragOver = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    if (!dragIdRef.current || dragIdRef.current === id) return;
    overIdRef.current = id;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    setDragOver({ id, pos });
  }, []);

  const onDrop = useCallback(() => {
    const dragId = dragIdRef.current;
    const overId = overIdRef.current;
    reset();
    if (!dragId || !overId || dragId === overId) return;
    onReorderRef.current(dragId, overId);
  }, [reset]);

  const onDragEnd = useCallback(() => { reset(); }, [reset]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (!e.currentTarget.contains(related)) setDragOver(null);
  }, []);

  return { onDragStart, onDragOver, onDrop, onDragEnd, onDragLeave, dragOver };
}

/** "707ABC" → { routeId: "707", suffixes: ["A","B","C"] } */
function parseRouteInput(input: string): { routeId: string; suffixes: string[] } {
  const trimmed = input.trim().replace(/\s+/g, '');
  const match = trimmed.match(/^(\d+)([A-Da-d]*)$/);
  if (!match) return { routeId: trimmed, suffixes: ['A', 'B', 'C', 'D'] };
  const routeId = match[1];
  const suffixStr = match[2].toUpperCase();
  const suffixes = suffixStr.length > 0 ? suffixStr.split('') : ['A', 'B', 'C', 'D'];
  return { routeId, suffixes };
}

export default function Sidebar() {
  const { selectedCampId, setcamp } = useScheduleStore();
  const store = useWorkerStore();

  const _isAdmin = useAuthStore().isAdmin(); // 나중에 권한 분리 시 사용
  const [selectedCompanyId, setSelectedCompanyId] = useState('union');
  const selectedCompany = COMPANIES.find((c) => c.id === selectedCompanyId) ?? COMPANIES[0];
  const [sidebarWave, setSidebarWave] = useState<'WAVE2' | 'WAVE1'>('WAVE2');
  const camps = store.camps.filter((c) => (c.companyId ?? 'union') === selectedCompanyId && (c.wave || 'WAVE1') === sidebarWave);
  const selectedCamp = camps.find((c) => c.id === selectedCampId);
  const hasCampInCompany = !!selectedCamp; // 현재 업체에 선택된 캠프가 있는지
  const campWave = selectedCamp?.wave ?? 'WAVE1';
  const allRotations = ROTATIONS_BY_WAVE[campWave] ?? [];
  const regulars = hasCampInCompany ? store.getRegularWorkers(selectedCampId) : [];
  const backups = hasCampInCompany ? store.getBackupWorkers(selectedCampId) : [];
  const campRoutes = hasCampInCompany ? store.getRoutes(selectedCampId) : [];

  // ── 캠프 추가 ──
  const [addingCamp, setAddingCamp] = useState(false);
  const [newCampName, setNewCampName] = useState('');
  const [newCampWave, setNewCampWave] = useState('WAVE1');
  const campInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (addingCamp) campInputRef.current?.focus(); }, [addingCamp]);

  // ── 캠프 편집 (이름 + wave) ──
  const [editingCamp, setEditingCamp] = useState<{ id: string; name: string; wave: string } | null>(null);
  const campEditNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingCamp) campEditNameRef.current?.focus(); }, [editingCamp?.id]);

  // ── 로컬 순서 상태 (사이드바 전용) ──
  const [regularOrder, setRegularOrder] = useState<string[]>([]);
  const [backupOrder, setBackupOrder] = useState<string[]>([]);

  // 정렬 방향 표시용 (아이콘 전용, 정렬 자체는 order 배열로 처리)
  const [regularSortDir, setRegularSortDir] = useState<{ by: 'name' | 'routes'; dir: 'asc' | 'desc' } | null>(null);
  const [backupSortDir, setBackupSortDir] = useState<{ dir: 'asc' | 'desc' } | null>(null);

  // 캠프 변경 시 스토어에서 로컬 순서 복원
  useEffect(() => {
    setRegularOrder(store.getOrder(selectedCampId, 'sidebar', 'regular'));
    setBackupOrder(store.getOrder(selectedCampId, 'sidebar', 'backup'));
    setRegularSortDir(null);
    setBackupSortDir(null);
  }, [selectedCampId]);

  const orderedRegulars = useMemo(() => applyOrder(regulars, regularOrder), [regulars, regularOrder]);
  const orderedBackups = useMemo(() => applyOrder(backups, backupOrder), [backups, backupOrder]);

  /** 순서를 로컬 + 스토어에 동시 저장하고 dirty 표시 */
  function syncRegularOrder(ids: string[]) {
    setRegularOrder(ids);
    store.setOrder(selectedCampId, 'sidebar', 'regular', ids);
    markDirty();
  }
  function syncBackupOrder(ids: string[]) {
    setBackupOrder(ids);
    store.setOrder(selectedCampId, 'sidebar', 'backup', ids);
    markDirty();
  }

  // ── 드래그 재정렬 ──
  const regularDrag = useDragReorder((dragId, overId) => {
    // orderedRegulars는 이미 저장된 순서 + 새 인원 포함
    const order = orderedRegulars.map((w) => w.id);
    syncRegularOrder(reorderIds(order, dragId, overId));
    setRegularSortDir(null);
  });

  const backupDrag = useDragReorder((dragId, overId) => {
    const order = orderedBackups.map((w) => w.id);
    syncBackupOrder(reorderIds(order, dragId, overId));
    setBackupSortDir(null);
  });

  const campDrag = useDragReorder((dragId, overId) => {
    store.reorderCamps(dragId, overId);
  });

  const routeDrag = useDragReorder((dragId, overId) => {
    const ids = campRoutes.map((r) => r.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1) return;
    const dir = to < from ? 'up' : 'down';
    const steps = Math.abs(to - from);
    for (let i = 0; i < steps; i++) store.moveRoute(selectedCampId, dragId, dir);
  });

  // ── 사이드바 정렬 (3-state 토글: null → asc → desc → null) ──
  function handleSortRegulars(by: 'name' | 'routes') {
    const next = (!regularSortDir || regularSortDir.by !== by)
      ? { by, dir: 'asc' as const }
      : regularSortDir.dir === 'asc'
        ? { by, dir: 'desc' as const }
        : null;

    setRegularSortDir(next);

    if (!next) {
      // 원래 순서로 복원
      syncRegularOrder([]);
      return;
    }

    const base = orderedRegulars;
    const sorted = [...base].sort((a, b) => {
      const cmp = next.by === 'name'
        ? a.name.localeCompare(b.name, 'ko')
        : a.assignedRoutes.join(',').localeCompare(b.assignedRoutes.join(','));
      return next.dir === 'asc' ? cmp : -cmp;
    });
    syncRegularOrder(sorted.map((w) => w.id));
  }

  function handleSortBackups() {
    const next = !backupSortDir
      ? { dir: 'asc' as const }
      : backupSortDir.dir === 'asc'
        ? { dir: 'desc' as const }
        : null;

    setBackupSortDir(next);

    if (!next) {
      syncBackupOrder([]);
      return;
    }

    const sorted = [...orderedBackups].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, 'ko');
      return next.dir === 'asc' ? cmp : -cmp;
    });
    syncBackupOrder(sorted.map((w) => w.id));
  }

  function regularSortIcon(col: 'name' | 'routes') {
    if (regularSortDir?.by !== col) return '\u2195';
    return regularSortDir.dir === 'asc' ? '\u2191' : '\u2193';
  }

  function backupSortIcon() {
    if (!backupSortDir) return '\u2195';
    return backupSortDir.dir === 'asc' ? '\u2191' : '\u2193';
  }

  // ── 인원 추가 폼 ──
  const [addingType, setAddingType] = useState<'regular' | 'backup' | 'route' | null>(null);
  const [addName, setAddName] = useState('');
  const [addLoginId, setAddLoginId] = useState('');
  const [addRouteValue, setAddRouteValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const routeAddRef = useRef<HTMLInputElement>(null);

  // ── 인원 편집 (우클릭) ──
  const [editingWorker, setEditingWorker] = useState<{
    id: string; name: string; loginId: string; routes: string; rotations: string[];
  } | null>(null);
  const workerEditNameRef = useRef<HTMLInputElement>(null);

  // ── 서브라우트 편집 ──
  const [editingSubRoutes, setEditingSubRoutes] = useState<{ routeId: string; value: string } | null>(null);
  const subRouteEditRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingType === 'route' && routeAddRef.current) routeAddRef.current.focus();
    else if (addingType && nameInputRef.current) nameInputRef.current.focus();
  }, [addingType]);

  useEffect(() => {
    if (editingWorker) workerEditNameRef.current?.focus();
  }, [editingWorker?.id]);

  useEffect(() => {
    if (editingSubRoutes && subRouteEditRef.current) {
      subRouteEditRef.current.focus();
      subRouteEditRef.current.select();
    }
  }, [editingSubRoutes?.routeId]);

  function handleAdd(type: 'regular' | 'backup' | 'route') {
    setAddingType(type);
    setAddName('');
    setAddLoginId('');
    setAddRouteValue('');
  }

  function commitWorkerAdd() {
    const name = addName.trim();
    if (!name) { cancelAdd(); return; }
    store.addWorker(name, selectedCampId, addingType as WorkerRole, addLoginId.trim());
    cancelAdd();
  }

  function commitRouteAdd() {
    const val = addRouteValue.trim();
    if (!val) { cancelAdd(); return; }
    const { routeId, suffixes } = parseRouteInput(val);
    store.addRoute(selectedCampId, routeId, suffixes);
    cancelAdd();
  }

  function cancelAdd() { setAddingType(null); }

  // ── 인원 우클릭 편집 ──
  function startEditWorker(w: Worker) {
    const rots = w.rotations && w.rotations.length > 0 ? w.rotations : [...allRotations];
    setEditingWorker({
      id: w.id,
      name: w.name,
      loginId: w.loginId,
      routes: w.assignedRoutes.join(', '),
      rotations: [...rots],
    });
  }

  function commitEditWorker() {
    if (!editingWorker) return;
    const { id, name, loginId, routes, rotations } = editingWorker;
    const trimName = name.trim();
    if (!trimName) { setEditingWorker(null); return; }
    const w = store.getWorkerById(id);
    if (!w) { setEditingWorker(null); return; }
    if (w.name !== trimName) store.setWorkerName(id, trimName);
    if (w.loginId !== loginId.trim()) store.setWorkerLoginId(id, loginId.trim());
    const newRoutes = routes.split(',').map((s) => s.trim()).filter(Boolean);
    if (w.assignedRoutes.join(',') !== newRoutes.join(',')) store.updateWorkerRoutes(id, newRoutes);
    if ((w.rotations ?? []).join(',') !== rotations.join(',')) store.setWorkerRotations(id, rotations);
    setEditingWorker(null);
  }

  function toggleEditRotation(rot: string) {
    if (!editingWorker) return;
    const next = editingWorker.rotations.includes(rot)
      ? editingWorker.rotations.filter((r) => r !== rot)
      : [...editingWorker.rotations, rot];
    setEditingWorker({ ...editingWorker, rotations: next });
  }

  // ── 서브라우트 편집 ──
  function startEditSubRoutes(routeId: string, currentSubRoutes: string[]) {
    setEditingSubRoutes({ routeId, value: currentSubRoutes.join(', ') });
  }

  function commitEditSubRoutes() {
    if (!editingSubRoutes) return;
    const subRoutes = editingSubRoutes.value.split(',').map((s) => s.trim()).filter(Boolean);
    store.updateRouteSubRoutes(selectedCampId, editingSubRoutes.routeId, subRoutes);
    setEditingSubRoutes(null);
  }

  /** 드래그 삽입 위치 CSS 클래스 */
  function insertClass(dragState: typeof regularDrag.dragOver, id: string) {
    return dragState?.id === id ? `drag-insert-${dragState.pos}` : '';
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">스케쥴 관리</h1>
      </div>

      {/* 업체 탭 */}
      <div className="sidebar-section company-section">
        <div className="company-tabs">
          {COMPANIES.map((co) => (
            <button
              key={co.id}
              className={`company-tab ${selectedCompanyId === co.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedCompanyId(co.id);
                // 업체 변경 시: 해당 업체+현재 웨이브의 첫 캠프 선택, 없으면 빈 값
                const companyCamps = store.camps.filter((c) => (c.companyId ?? 'union') === co.id && (c.wave || 'WAVE1') === sidebarWave);
                setcamp(companyCamps.length > 0 ? companyCamps[0].id : '');
              }}
            >
              {co.label}
            </button>
          ))}
        </div>
        <div className="company-info-preview">
          <span>{selectedCompany.vendorName}</span>
          <span>사업자번호: {selectedCompany.businessNumber}</span>
        </div>
      </div>

      {/* 캠프 선택 */}
      <div className="sidebar-section">
        <h3 className="section-title">
          캠프 선택
          {<button className="add-btn" onClick={() => setAddingCamp(true)} title="캠프 추가">+</button>}
        </h3>
        <div className="wave-tabs-sidebar">
          <button className={`wave-tab-sidebar ${sidebarWave === 'WAVE2' ? 'active' : ''}`} onClick={() => { setSidebarWave('WAVE2'); setcamp(''); }}>주간</button>
          <button className={`wave-tab-sidebar ${sidebarWave === 'WAVE1' ? 'active' : ''}`} onClick={() => { setSidebarWave('WAVE1'); setcamp(''); }}>야간</button>
        </div>
        <div className="camp-filter">
          {camps.map((camp) => (
            <div
              key={camp.id}
              className={`camp-btn-wrap ${selectedCampId === camp.id ? 'active' : ''} ${insertClass(campDrag.dragOver, camp.id)}`}
              draggable={!editingCamp}
              onDragStart={(e) => campDrag.onDragStart(camp.id, e)}
              onDragOver={(e) => campDrag.onDragOver(camp.id, e)}
              onDrop={campDrag.onDrop}
              onDragEnd={campDrag.onDragEnd}
              onDragLeave={campDrag.onDragLeave}
            >
              {editingCamp?.id === camp.id ? (
                <div className="camp-add-form" style={{ flex: 1 }}>
                  <input
                    ref={campEditNameRef}
                    className="camp-add-input"
                    value={editingCamp.name}
                    onChange={(e) => setEditingCamp({ ...editingCamp, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditingCamp(null);
                    }}
                    placeholder="캠프명"
                  />
                  <select
                    className="camp-wave-select"
                    value={editingCamp.wave}
                    onChange={(e) => setEditingCamp({ ...editingCamp, wave: e.target.value })}
                  >
                    <option value="WAVE1">WAVE1 (야간)</option>
                    <option value="WAVE2">WAVE2 (주간)</option>
                  </select>
                  <div className="camp-add-actions">
                    <button
                      className="camp-save-btn"
                      onClick={() => {
                        const name = editingCamp.name.trim();
                        if (name) store.renameCamp(camp.id, name, editingCamp.wave);
                        setEditingCamp(null);
                      }}
                    >
                      저장
                    </button>
                    <button className="camp-cancel-btn" onClick={() => setEditingCamp(null)}>
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className={`camp-btn ${selectedCampId === camp.id ? 'active' : ''}`}
                  onClick={() => setcamp(camp.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setEditingCamp({ id: camp.id, name: camp.name, wave: camp.wave ?? 'WAVE1' });
                  }}
                  title="우클릭: 캠프 편집"
                >
                  <span className="camp-dot" style={{ background: camp.color || '#888' }} />
                  {camp.name}
                  <span className={`wave-badge ${camp.wave === 'WAVE2' ? 'wave2' : ''}`}>
                    {camp.wave === 'WAVE2' ? '주간' : '야간'}
                  </span>
                </button>
              )}
              {camps.length > 1 && selectedCampId !== camp.id && !editingCamp && (
                <button
                  className="camp-del-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.removeCamp(camp.id);
                  }}
                  title="캠프 삭제"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
          {addingCamp && (
            <div className="camp-add-form">
              <input
                ref={campInputRef}
                className="camp-add-input"
                value={newCampName}
                onChange={(e) => setNewCampName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newCampName.trim()) {
                    store.addCamp(newCampName.trim(), newCampWave, selectedCompanyId);
                    setNewCampName('');
                    setNewCampWave('WAVE1');
                    setAddingCamp(false);
                  } else if (e.key === 'Escape') {
                    setNewCampName('');
                    setNewCampWave('WAVE1');
                    setAddingCamp(false);
                  }
                }}
                placeholder="캠프명 입력"
              />
              <select
                className="camp-wave-select"
                value={newCampWave}
                onChange={(e) => setNewCampWave(e.target.value)}
              >
                <option value="WAVE1">WAVE1 (야간)</option>
                <option value="WAVE2">WAVE2 (주간)</option>
              </select>
              <div className="camp-add-actions">
                <button
                  className="camp-save-btn"
                  onClick={() => {
                    if (newCampName.trim()) {
                      store.addCamp(newCampName.trim(), newCampWave, selectedCompanyId);
                    }
                    setNewCampName('');
                    setNewCampWave('WAVE1');
                    setAddingCamp(false);
                  }}
                >
                  저장
                </button>
                <button
                  className="camp-cancel-btn"
                  onClick={() => {
                    setNewCampName('');
                    setNewCampWave('WAVE1');
                    setAddingCamp(false);
                  }}
                >
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 고정 기사 */}
      {hasCampInCompany && <div className="sidebar-section">
        <h3 className="section-title">
          고정 기사 ({regulars.length}명)
          <button className="add-btn" onClick={() => handleSortRegulars('name')} title="이름순 정렬">{regularSortIcon('name')}</button>
          <button className="add-btn" onClick={() => handleSortRegulars('routes')} title="라우트순 정렬">R{regularSortIcon('routes')}</button>
          {<button className="add-btn" onClick={() => handleAdd('regular')} title="고정 기사 추가">+</button>}
        </h3>
        <ul className="worker-list">
          {orderedRegulars.map((w) => (
            <li
              key={w.id}
              className={`worker-item ${insertClass(regularDrag.dragOver, w.id)}`}
              draggable={!editingWorker}
              onDragStart={(e) => regularDrag.onDragStart(w.id, e)}
              onDragOver={(e) => regularDrag.onDragOver(w.id, e)}
              onDrop={regularDrag.onDrop}
              onDragEnd={regularDrag.onDragEnd}
              onDragLeave={regularDrag.onDragLeave}
            >
              {editingWorker?.id === w.id ? (
                <div className="worker-edit-form">
                  <label>이름
                    <input
                      ref={workerEditNameRef}
                      className="add-input"
                      value={editingWorker.name}
                      onChange={(e) => setEditingWorker({ ...editingWorker, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingWorker(null); }}
                    />
                  </label>
                  <label>아이디
                    <input
                      className="add-input"
                      value={editingWorker.loginId}
                      onChange={(e) => setEditingWorker({ ...editingWorker, loginId: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingWorker(null); }}
                      placeholder="아이디"
                    />
                  </label>
                  <label>라우트
                    <input
                      className="add-input"
                      value={editingWorker.routes}
                      onChange={(e) => setEditingWorker({ ...editingWorker, routes: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingWorker(null); }}
                      placeholder="701A, 701B"
                    />
                  </label>
                  <div className="rotation-checkboxes">
                    {allRotations.map((rot) => (
                      <label key={rot} className="rotation-label">
                        <input
                          type="checkbox"
                          checked={editingWorker.rotations.includes(rot)}
                          onChange={() => toggleEditRotation(rot)}
                        />
                        {rot}
                      </label>
                    ))}
                  </div>
                  <div className="camp-add-actions">
                    <button className="camp-save-btn" onClick={commitEditWorker}>저장</button>
                    <button className="camp-cancel-btn" onClick={() => setEditingWorker(null)}>취소</button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="drag-handle" title="드래그하여 순서 변경">&#x2630;</span>
                  <span
                    className="worker-name clickable"
                    onContextMenu={(e) => { e.preventDefault(); startEditWorker(w); }}
                    title="우클릭: 정보 수정"
                  >
                    {w.name}
                    {w.loginId && <span className="login-id-badge">ID</span>}
                  </span>
                  <span className="worker-routes" title={w.assignedRoutes.join(', ')}>
                    {w.assignedRoutes.length > 0 ? w.assignedRoutes.join(', ') : '-'}
                  </span>
                  {<button className="remove-btn" onClick={() => store.removeWorker(w.id)} title="삭제">&times;</button>}
                </>
              )}
            </li>
          ))}
        </ul>
        {addingType === 'regular' && (
          <div
            className="add-form"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) commitWorkerAdd();
            }}
          >
            <input
              ref={nameInputRef}
              className="add-input"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitWorkerAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              placeholder="이름"
            />
            <input
              className="add-input"
              value={addLoginId}
              onChange={(e) => setAddLoginId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitWorkerAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              placeholder="아이디 (선택)"
            />
          </div>
        )}
      </div>}

      {/* 백업 인원 */}
      {hasCampInCompany && <div className="sidebar-section">
        <h3 className="section-title">
          백업 인원 ({backups.length}명)
          <button className="add-btn" onClick={handleSortBackups} title="이름순 정렬">{backupSortIcon()}</button>
          {<button className="add-btn" onClick={() => handleAdd('backup')} title="백업 인원 추가">+</button>}
        </h3>
        <ul className="worker-list">
          {orderedBackups.map((w) => (
            <li
              key={w.id}
              className={`worker-item backup ${insertClass(backupDrag.dragOver, w.id)}`}
              draggable={!editingWorker}
              onDragStart={(e) => backupDrag.onDragStart(w.id, e)}
              onDragOver={(e) => backupDrag.onDragOver(w.id, e)}
              onDrop={backupDrag.onDrop}
              onDragEnd={backupDrag.onDragEnd}
              onDragLeave={backupDrag.onDragLeave}
            >
              {editingWorker?.id === w.id ? (
                <div className="worker-edit-form">
                  <label>이름
                    <input
                      ref={workerEditNameRef}
                      className="add-input"
                      value={editingWorker.name}
                      onChange={(e) => setEditingWorker({ ...editingWorker, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingWorker(null); }}
                    />
                  </label>
                  <label>아이디
                    <input
                      className="add-input"
                      value={editingWorker.loginId}
                      onChange={(e) => setEditingWorker({ ...editingWorker, loginId: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingWorker(null); }}
                      placeholder="아이디"
                    />
                  </label>
                  <label>담당 라우트</label>
                  <div className="rotation-checkboxes">
                    {campRoutes.flatMap((r) => r.subRoutes).map((sr) => (
                      <label key={sr} className="rotation-label">
                        <input
                          type="checkbox"
                          checked={editingWorker.routes.split(',').map(s => s.trim()).filter(Boolean).includes(sr)}
                          onChange={() => {
                            const current = editingWorker.routes.split(',').map(s => s.trim()).filter(Boolean);
                            const next = current.includes(sr)
                              ? current.filter(r => r !== sr)
                              : [...current, sr];
                            setEditingWorker({ ...editingWorker, routes: next.join(', ') });
                          }}
                        />
                        {sr}
                      </label>
                    ))}
                  </div>
                  <div className="rotation-checkboxes">
                    {allRotations.map((rot) => (
                      <label key={rot} className="rotation-label">
                        <input
                          type="checkbox"
                          checked={editingWorker.rotations.includes(rot)}
                          onChange={() => toggleEditRotation(rot)}
                        />
                        {rot}
                      </label>
                    ))}
                  </div>
                  <div className="camp-add-actions">
                    <button className="camp-save-btn" onClick={commitEditWorker}>저장</button>
                    <button className="camp-cancel-btn" onClick={() => setEditingWorker(null)}>취소</button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="drag-handle" title="드래그하여 순서 변경">&#x2630;</span>
                  <span
                    className="worker-name clickable"
                    onContextMenu={(e) => { e.preventDefault(); startEditWorker(w); }}
                    title="우클릭: 정보 수정"
                  >
                    {w.name}
                    {w.loginId && <span className="login-id-badge">ID</span>}
                  </span>
                  <span className="worker-routes" title={w.assignedRoutes.join(', ')}>
                    {w.assignedRoutes.length > 0 ? w.assignedRoutes.join(', ') : '-'}
                  </span>
                  {<button className="remove-btn" onClick={() => store.removeWorker(w.id)} title="삭제">&times;</button>}
                </>
              )}
            </li>
          ))}
        </ul>
        {addingType === 'backup' && (
          <div
            className="add-form"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) commitWorkerAdd();
            }}
          >
            <input
              ref={nameInputRef}
              className="add-input"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitWorkerAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              placeholder="이름"
            />
            <input
              className="add-input"
              value={addLoginId}
              onChange={(e) => setAddLoginId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitWorkerAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              placeholder="아이디 (선택)"
            />
          </div>
        )}
      </div>}

      {/* 계약 라우트 */}
      {hasCampInCompany && <div className="sidebar-section">
        <h3 className="section-title">
          계약 라우트 ({campRoutes.length}개)
          {<button className="add-btn" onClick={() => handleAdd('route')} title="라우트 추가">+</button>}
        </h3>
        <ul className="worker-list">
          {campRoutes.map((r) => (
            <li
              key={r.id}
              className={`worker-item route-item ${insertClass(routeDrag.dragOver, r.id)}`}
              draggable
              onDragStart={(e) => routeDrag.onDragStart(r.id, e)}
              onDragOver={(e) => routeDrag.onDragOver(r.id, e)}
              onDrop={routeDrag.onDrop}
              onDragEnd={routeDrag.onDragEnd}
              onDragLeave={routeDrag.onDragLeave}
            >
              <span className="drag-handle" title="드래그하여 순서 변경">&#x2630;</span>
              <span className="worker-name">{r.id}</span>
              {editingSubRoutes?.routeId === r.id ? (
                <input
                  ref={subRouteEditRef}
                  className="route-edit-input"
                  value={editingSubRoutes.value}
                  onChange={(e) => setEditingSubRoutes({ ...editingSubRoutes, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEditSubRoutes();
                    if (e.key === 'Escape') setEditingSubRoutes(null);
                  }}
                  onBlur={commitEditSubRoutes}
                  placeholder="서브라우트 (예: 701A, 701B)"
                />
              ) : (
                <span
                  className="worker-routes editable"
                  onClick={() => startEditSubRoutes(r.id, r.subRoutes)}
                  title="클릭하여 서브라우트 수정"
                >
                  {r.subRoutes.join(', ')}
                </span>
              )}
              {<button className="remove-btn" onClick={() => store.removeRoute(selectedCampId, r.id)} title="삭제">&times;</button>}
            </li>
          ))}
        </ul>
        {addingType === 'route' && (
          <div className="add-form">
            <input
              ref={routeAddRef}
              className="add-input"
              value={addRouteValue}
              onChange={(e) => setAddRouteValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRouteAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              onBlur={commitRouteAdd}
              placeholder="예: 707 또는 707ABC"
            />
          </div>
        )}
      </div>}
    </aside>
  );
}
