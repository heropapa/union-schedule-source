import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useScheduleStore } from '../../store/useScheduleStore';
import { useWorkerStore } from '../../store/useWorkerStore';
import { markDirty } from '../../store/historyBridge';
import type { Worker, WorkerRole, CampPermission, WeeklyRoster } from '../../types';
import { ROTATIONS_BY_WAVE, COMPANIES } from '../../types';
import { useAuthStore } from '../../store/useAuthStore';
import * as db from '../../lib/db';
import type { UserProfile } from '../../lib/db';
import { supabase } from '../../lib/supabase';
import { parseWorkersExcel, parseRoutesExcel } from '../../utils/rosterExcel';
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
  useEffect(() => {
    onReorderRef.current = onReorder;
  }, [onReorder]);
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

/**
 * 여러 라우트/서브라우트를 한 번에 파싱.
 * "701A, 701B, 702A, 707ABC, 708" 같은 입력을 라우트번호별로 묶어
 * [{ routeId:'701', suffixes:['A','B'] }, ...] 로 반환 (순서 보존, 중복 제거).
 */
function parseRouteList(input: string): { routeId: string; suffixes: string[] }[] {
  const tokens = input.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const order: string[] = [];
  const map = new Map<string, string[]>();
  for (const tok of tokens) {
    const { routeId, suffixes } = parseRouteInput(tok);
    if (!map.has(routeId)) { map.set(routeId, []); order.push(routeId); }
    const cur = map.get(routeId)!;
    for (const s of suffixes) if (!cur.includes(s)) cur.push(s);
  }
  return order.map((routeId) => ({ routeId, suffixes: map.get(routeId)! }));
}

/** roster.source(내부값) → 사람이 읽을 라벨 */
function sourceLabel(source: string): string {
  if (source === 'fresh') return '직접 입력';
  if (source === 'excel') return '엑셀';
  if (source.startsWith('copied_from')) return '복사됨';
  return '';
}

export default function Sidebar() {
  const { selectedCampId, setcamp, loadCells } = useScheduleStore();
  const store = useWorkerStore();

  // 캠프 선택 — setcamp가 내부적으로 loadCampWeek 트리거.
  // 셀은 따로 로드 (스케쥴 셀 = workers 와 다른 테이블).
  const selectCamp = async (campId: string) => {
    setcamp(campId);
    try {
      await loadCells(campId);
    } catch (err) {
      console.error('셀 데이터 로드 실패:', err);
    }
  };

  const auth = useAuthStore();
  const isAdmin = auth.isAdmin();
  const canEditSelectedCamp = selectedCampId ? auth.canEditCamp(selectedCampId) : false;
  /** 선택된 캠프에 대한 편집 권한이 있을 때만 mutation 실행. 없으면 1회 알림. */
  function withCampPermission(action: () => void) {
    if (!canEditSelectedCamp) {
      alert('이 캠프에 대한 편집 권한이 없습니다. 관리자에게 권한을 요청하세요.');
      return;
    }
    action();
  }

  // ── 섹션별 엑셀(다운로드/업로드) + 다른 주 불러오기 ──
  type Section = 'regular' | 'backup' | 'routes';
  const sectionLabel = (s: Section) => (s === 'regular' ? '고정인원' : s === 'backup' ? '백업인원' : '계약라우트');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<Section>('regular');
  // 다른 주 불러오기 모달 (섹션 지정)
  const [weekLoad, setWeekLoad] = useState<{ section: Section; rosters: WeeklyRoster[] } | null>(null);

  async function downloadSection(section: Section) {
    setBusy(true);
    try {
      if (section === 'routes') await store.exportRoutesSection();
      else await store.exportWorkersSection(section);
    } catch (err) {
      console.error('엑셀 다운로드 실패:', err);
      alert('엑셀 다운로드에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  function triggerUpload(section: Section) {
    if (!canEditSelectedCamp) { alert('이 캠프에 대한 편집 권한이 없습니다.'); return; }
    uploadTargetRef.current = section;
    fileInputRef.current?.click();
  }

  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const section = uploadTargetRef.current;
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      if (section === 'routes') {
        const parsed = await parseRoutesExcel(buffer);
        if (!confirm(`계약라우트 ${parsed.length}개로 현재 주차를 덮어쓰시겠습니까?`)) return;
        await store.importRoutesSection(parsed);
      } else {
        const parsed = await parseWorkersExcel(buffer);
        if (!confirm(`${sectionLabel(section)} ${parsed.length}명으로 현재 주차를 덮어쓰시겠습니까?`)) return;
        await store.importWorkersSection(section, parsed);
      }
    } catch (err) {
      console.error('엑셀 업로드 실패:', err);
      alert(`엑셀 업로드에 실패했습니다.\n\n${err instanceof Error ? err.message : JSON.stringify(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openWeekLoad(section: Section) {
    if (!selectedCampId) return;
    if (!canEditSelectedCamp) { alert('이 캠프에 대한 편집 권한이 없습니다.'); return; }
    try {
      const rosters = await db.listRostersByCamp(selectedCampId);
      const current = useWorkerStore.getState().currentWeekStart;
      setWeekLoad({ section, rosters: rosters.filter((r) => r.weekStart !== current) });
    } catch (err) {
      console.error('roster 목록 로드 실패:', err);
      alert('주차 목록을 불러올 수 없습니다.');
    }
  }

  async function pickWeek(roster: WeeklyRoster) {
    if (!weekLoad) return;
    const section = weekLoad.section;
    if (!confirm(`${sectionLabel(section)}을(를) ${roster.weekStart} 주차 내용으로 덮어쓰시겠습니까?`)) return;
    setBusy(true);
    try {
      if (section === 'routes') await store.copyRoutesFromWeek(roster.id);
      else await store.copyWorkersFromWeek(section, roster.id);
      setWeekLoad(null);
    } catch (err) {
      console.error('다른 주 불러오기 실패:', err);
      alert(`다른 주 불러오기에 실패했습니다.\n\n${err instanceof Error ? err.message : JSON.stringify(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clearSection(section: Section) {
    if (!canEditSelectedCamp) { alert('이 캠프에 대한 편집 권한이 없습니다.'); return; }
    if (!confirm(`현재 주차의 ${sectionLabel(section)}을(를) 모두 비우시겠습니까?`)) return;
    setBusy(true);
    try {
      if (section === 'routes') await store.clearRoutesSection();
      else await store.clearWorkersSection(section);
    } catch (err) {
      console.error('비우기 실패:', err);
      alert(`비우기에 실패했습니다.\n\n${err instanceof Error ? err.message : JSON.stringify(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 섹션 툴바 (⬇ 다운로드 / ⬆ 업로드 / 📋 다른 주 / 🗑 비우기) */
  function SectionTools({ section }: { section: Section }) {
    return (
      <span className="section-tools">
        <button className="sec-tool-btn" disabled={busy} title="엑셀 다운로드" onClick={() => downloadSection(section)}>⬇</button>
        <button className="sec-tool-btn" disabled={busy} title="엑셀 업로드" onClick={() => triggerUpload(section)}>⬆</button>
        <button className="sec-tool-btn" disabled={busy} title="다른 주 불러오기" onClick={() => openWeekLoad(section)}>📋</button>
        <button className="sec-tool-btn" disabled={busy} title="현재 주차 비우기" onClick={() => clearSection(section)}>🗑</button>
      </span>
    );
  }

  // ── 권한 관리 (admin 전용) ──
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [permissions, setPermissions] = useState<CampPermission[]>([]);

  const [publishedCamps, setPublishedCamps] = useState<Set<string>>(new Set());

  // admin이면 유저 목록 + 권한 + 게시 상태 로드
  useEffect(() => {
    if (!isAdmin) return;
    db.fetchAllUsers().then(users => {
      // admin, atone 제외
      setAllUsers(users.filter(u => u.role !== 'admin' && u.email !== 'atone@schedule.local'));
    }).catch(() => {});
    db.fetchPermissions().then(setPermissions).catch(() => {});
    // 게시 상태 로드
    supabase.from('camps').select('id,published').then(({ data }) => {
      const rows = (data ?? []) as { id: string; published: boolean }[];
      const pubSet = new Set(rows.filter((r) => r.published).map((r) => r.id));
      setPublishedCamps(pubSet);
    });
  }, [isAdmin]);

  const togglePublish = async (campId: string) => {
    const isPublished = publishedCamps.has(campId);
    try {
      await db.setCampPublished(campId, !isPublished);
      setPublishedCamps(prev => {
        const next = new Set(prev);
        if (isPublished) next.delete(campId); else next.add(campId);
        return next;
      });
    } catch (err) {
      console.error('게시 상태 변경 실패:', err);
    }
  };

  const setUserPerm = async (userId: string, campId: string, level: 'none' | 'read' | 'write') => {
    try {
      await db.setPermission(userId, campId, level);
      setPermissions(prev => {
        const rest = prev.filter(p => !(p.userId === userId && p.campId === campId));
        if (level === 'none') return rest;
        return [...rest, { userId, campId, level, canEdit: level === 'write' }];
      });
    } catch (err) {
      console.error('권한 변경 실패:', err);
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      alert('권한 변경에 실패했습니다.\n\n' + msg + '\n\n(v1.6 권한 SQL이 적용됐는지 확인하세요.)');
    }
  };
  const [selectedCompanyId, setSelectedCompanyId] = useState('union');
  const selectedCompany = COMPANIES.find((c) => c.id === selectedCompanyId) ?? COMPANIES[0];
  const [sidebarWave, setSidebarWave] = useState<'WAVE2' | 'WAVE1'>('WAVE2');
  const camps = store.camps.filter((c) =>
    (c.companyId ?? 'union') === selectedCompanyId &&
    (c.wave || 'WAVE1') === sidebarWave &&
    (isAdmin || auth.canViewCamp(c.id))   // 비admin은 보기/편집 권한 있는 캠프만
  );
  const selectedCamp = camps.find((c) => c.id === selectedCampId);
  const hasCampInCompany = !!selectedCamp; // 현재 업체에 선택된 캠프가 있는지
  const campWave = selectedCamp?.wave ?? 'WAVE1';
  const allRotations = ROTATIONS_BY_WAVE[campWave] ?? [];
  // 아래 useMemo(orderedRegulars/Backups)의 deps 안정성을 위해 직접 메모이즈.
  // store의 getter는 같은 입력에 대해 매 호출마다 동일 참조를 보장하지 않으므로
  // 캠프/store 상태가 바뀔 때만 새 배열을 만들도록 가둔다.
  const regulars = useMemo(
    () => (hasCampInCompany ? store.getRegularWorkers(selectedCampId) : []),
    [hasCampInCompany, selectedCampId, store],
  );
  const backups = useMemo(
    () => (hasCampInCompany ? store.getBackupWorkers(selectedCampId) : []),
    [hasCampInCompany, selectedCampId, store],
  );
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
  // 편집 진입 시점에만 포커스. id가 바뀔 때만 발동시켜 name/wave 입력 중 재포커스 방지.
  useEffect(() => { if (editingCamp?.id) campEditNameRef.current?.focus(); }, [editingCamp?.id]);

  // ── 로컬 순서 상태 (사이드바 전용) ──
  // 캠프 전환 시 store의 저장된 순서로 초기화하고 정렬 표시를 리셋한다.
  // React 19 권장: useEffect + setState 대신 렌더 중 prev-state 비교로 처리해
  // 외부 store 갱신이 사용자의 로컬 정렬을 덮어쓰지 않도록 한다.
  const [regularOrder, setRegularOrder] = useState<string[]>(
    () => useWorkerStore.getState().getOrder(selectedCampId, 'sidebar', 'regular'),
  );
  const [backupOrder, setBackupOrder] = useState<string[]>(
    () => useWorkerStore.getState().getOrder(selectedCampId, 'sidebar', 'backup'),
  );

  // 정렬 방향 표시용 (아이콘 전용, 정렬 자체는 order 배열로 처리)
  const [regularSortDir, setRegularSortDir] = useState<{ by: 'name' | 'routes'; dir: 'asc' | 'desc' } | null>(null);
  const [backupSortDir, setBackupSortDir] = useState<{ dir: 'asc' | 'desc' } | null>(null);

  const [lastSyncedCampId, setLastSyncedCampId] = useState(selectedCampId);
  if (lastSyncedCampId !== selectedCampId) {
    const ws = useWorkerStore.getState();
    setLastSyncedCampId(selectedCampId);
    setRegularOrder(ws.getOrder(selectedCampId, 'sidebar', 'regular'));
    setBackupOrder(ws.getOrder(selectedCampId, 'sidebar', 'backup'));
    setRegularSortDir(null);
    setBackupSortDir(null);
  }

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

  // 편집 진입 시점에만 포커스. id가 바뀔 때만 발동시켜 입력 중 재포커스 방지.
  useEffect(() => {
    if (editingWorker?.id) workerEditNameRef.current?.focus();
  }, [editingWorker?.id]);

  useEffect(() => {
    if (editingSubRoutes?.routeId && subRouteEditRef.current) {
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
    withCampPermission(() => {
      store.addWorker(name, selectedCampId, addingType as WorkerRole, addLoginId.trim());
    });
    cancelAdd();
  }

  function commitRouteAdd() {
    const val = addRouteValue.trim();
    if (!val) { cancelAdd(); return; }
    withCampPermission(() => {
      const groups = parseRouteList(val);
      const existing = store.getRoutes(selectedCampId);
      for (const g of groups) {
        const ex = existing.find((r) => r.id === g.routeId);
        if (ex) {
          // 이미 있는 라우트면 서브라우트 합치기 (중복 제거)
          const subRoutes = g.suffixes.map((s) => `${g.routeId}${s}`);
          const merged = Array.from(new Set([...ex.subRoutes, ...subRoutes]));
          store.updateRouteSubRoutes(selectedCampId, g.routeId, merged);
        } else {
          store.addRoute(selectedCampId, g.routeId, g.suffixes);
        }
      }
    });
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
    withCampPermission(() => {
      if (w.name !== trimName) store.setWorkerName(id, trimName);
      if (w.loginId !== loginId.trim()) store.setWorkerLoginId(id, loginId.trim());
      const newRoutes = routes.split(',').map((s) => s.trim()).filter(Boolean);
      if (w.assignedRoutes.join(',') !== newRoutes.join(',')) store.updateWorkerRoutes(id, newRoutes);
      if ((w.rotations ?? []).join(',') !== rotations.join(',')) store.setWorkerRotations(id, rotations);
    });
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
    withCampPermission(() => {
      const subRoutes = editingSubRoutes.value.split(',').map((s) => s.trim()).filter(Boolean);
      store.updateRouteSubRoutes(selectedCampId, editingSubRoutes.routeId, subRoutes);
    });
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
                const companyCamps = store.camps.filter((c) =>
                  (c.companyId ?? 'union') === co.id && (c.wave || 'WAVE1') === sidebarWave &&
                  (isAdmin || auth.canViewCamp(c.id)));
                if (companyCamps.length > 0) selectCamp(companyCamps[0].id); else setcamp('');
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
          {isAdmin && <button className="add-btn" onClick={() => setAddingCamp(true)} title="캠프 추가">+</button>}
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
              draggable={isAdmin && !editingCamp}
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

                  {/* 게시 + 캠프 권한 (우클릭 한 곳에서 관리) */}
                  <label className="perm-publish-row">
                    <input
                      type="checkbox"
                      checked={publishedCamps.has(camp.id)}
                      onChange={() => togglePublish(camp.id)}
                    />
                    <span>게시판에 공개</span>
                  </label>
                  <div className="perm-dropdown-title">캠프 권한 (보기 / 편집)</div>
                  <div className="perm-user-list">
                    {allUsers.map((user) => {
                      const p = permissions.find(pp => pp.userId === user.id && pp.campId === camp.id);
                      const level: 'none' | 'read' | 'write' = p ? p.level : 'none';
                      const canView = level === 'read' || level === 'write';
                      const canEdit = level === 'write';
                      return (
                        <div key={user.id} className="perm-user-row">
                          <span className="perm-user-name">{user.displayName}</span>
                          <span className="perm-checks">
                            <label className="perm-check">
                              <input
                                type="checkbox"
                                checked={canView}
                                onChange={() => setUserPerm(user.id, camp.id, canView ? 'none' : 'read')}
                              />
                              보기
                            </label>
                            <label className="perm-check">
                              <input
                                type="checkbox"
                                checked={canEdit}
                                onChange={() => setUserPerm(user.id, camp.id, canEdit ? 'read' : 'write')}
                              />
                              편집
                            </label>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {allUsers.length === 0 && <div className="perm-empty">등록된 사용자 없음</div>}

                  <div className="camp-add-actions">
                    <button
                      className="camp-save-btn"
                      onClick={() => {
                        const name = editingCamp.name.trim();
                        if (name) {
                          if (!auth.canEditCamp(camp.id)) {
                            alert('이 캠프에 대한 편집 권한이 없습니다.');
                          } else {
                            store.renameCamp(camp.id, name, editingCamp.wave);
                          }
                        }
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
                <>
                  <button
                    className={`camp-btn ${selectedCampId === camp.id ? 'active' : ''}`}
                    onClick={() => selectCamp(camp.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!isAdmin) return;   // 캠프 편집/권한은 admin 전용
                      setEditingCamp({ id: camp.id, name: camp.name, wave: camp.wave ?? 'WAVE1' });
                    }}
                    title={isAdmin ? '우클릭: 캠프 편집·권한' : undefined}
                  >
                    <span className="camp-dot" style={{ background: camp.color || '#888' }} />
                    {camp.name}
                    <span className={`wave-badge ${camp.wave === 'WAVE2' ? 'wave2' : ''}`}>
                      {camp.wave === 'WAVE2' ? '주간' : '야간'}
                    </span>
                  </button>
                </>
              )}
              {isAdmin && camps.length > 1 && selectedCampId !== camp.id && !editingCamp && (
                <button
                  className="camp-del-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`"${camp.name}" 캠프를 삭제하시겠습니까?\n소속 기사, 라우트, 스케쥴이 모두 삭제됩니다.`)) return;
                    const pw = prompt('삭제를 확인하려면 현재 계정의 비밀번호를 입력하세요:');
                    if (!pw) return;
                    const userEmail = useAuthStore.getState().user?.email;
                    if (!userEmail) return;
                    const { error: authErr } = await supabase.auth.signInWithPassword({ email: userEmail, password: pw });
                    if (authErr) { alert('비밀번호가 일치하지 않습니다.'); return; }
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

      {/* 섹션 업로드용 공용 파일 입력 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={handleUploadFile}
      />

      {/* 다른 주 불러오기 모달 (섹션 지정) */}
      {weekLoad && (
        <div className="roster-modal-overlay" onClick={() => !busy && setWeekLoad(null)}>
          <div className="roster-modal" onClick={(e) => e.stopPropagation()}>
            <h3>다른 주 불러오기 — {sectionLabel(weekLoad.section)}</h3>
            <p>선택한 주차의 {sectionLabel(weekLoad.section)} 데이터를 현재 주차로 불러옵니다 (덮어쓰기).</p>
            {weekLoad.rosters.length === 0 ? (
              <div className="perm-empty">불러올 다른 주차가 없습니다.</div>
            ) : (
              <ul className="roster-week-list">
                {weekLoad.rosters.map((r) => (
                  <li key={r.id}>
                    <button className="roster-week-btn" onClick={() => pickWeek(r)} disabled={busy}>
                      <span className="roster-week-date">{r.weekStart}</span>
                      <span className="roster-week-src">{sourceLabel(r.source)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="camp-add-actions">
              <button className="camp-cancel-btn" onClick={() => setWeekLoad(null)} disabled={busy}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 고정 인원 */}
      {hasCampInCompany && <div className="sidebar-section">
        <h3 className="section-title">
          고정 인원 ({regulars.length}명)
          <button className="add-btn" onClick={() => handleSortRegulars('name')} title="이름순 정렬">{regularSortIcon('name')}</button>
          <button className="add-btn" onClick={() => handleSortRegulars('routes')} title="라우트순 정렬">R{regularSortIcon('routes')}</button>
          {<button className="add-btn" onClick={() => handleAdd('regular')} title="고정 인원 추가">+</button>}
          <SectionTools section="regular" />
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
                  {<button className="remove-btn" onClick={() => withCampPermission(() => store.removeWorker(w.id))} title="삭제">&times;</button>}
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
          <SectionTools section="backup" />
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
                  {<button className="remove-btn" onClick={() => withCampPermission(() => store.removeWorker(w.id))} title="삭제">&times;</button>}
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
          <SectionTools section="routes" />
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
              {<button className="remove-btn" onClick={() => withCampPermission(() => store.removeRoute(selectedCampId, r.id))} title="삭제">&times;</button>}
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
              placeholder="예: 707 / 707ABC / 701A, 701B, 702A ..."
            />
          </div>
        )}
      </div>}
    </aside>
  );
}
