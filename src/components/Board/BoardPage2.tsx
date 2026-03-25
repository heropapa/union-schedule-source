import React, { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, isSameMonth } from 'date-fns';
import { ko } from 'date-fns/locale/ko';
import type { Worker, Route, ScheduleCell, Camp } from '../../types';
import './BoardPage.css';
import './BoardPage2.css';

/* ── atone 계정 정보 ── */
const ATONE_EMAIL = 'atone@schedule.local';
const ATONE_PW = '150527';
const ATONE_UID = 'a3451236-bf21-410f-96e3-57883c252025';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const boardSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Snapshot {
  workers: Worker[];
  routes: Record<string, Route[]>;
  cells: Record<string, ScheduleCell>;
  camps?: Camp[];
}

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

type WaveTab = 'WAVE1' | 'WAVE2';
const WAVE_LABELS: Record<WaveTab, string> = { WAVE1: '야간', WAVE2: '주간' };

/** 달력 그리드용 날짜 배열 */
function buildCalendarDates(year: number, month: number): Date[] {
  const monthStart = startOfMonth(new Date(year, month, 1));
  const monthEnd = endOfMonth(monthStart);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const dates: Date[] = [];
  let d = calStart;
  while (d <= calEnd) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

/** 주 단위 배열 생성 (일~토) — 두 달치 */
function buildWeeks(today: Date): Date[][] {
  const m1Start = startOfMonth(today);
  const m2End = endOfMonth(addMonths(today, 1));
  const calStart = startOfWeek(m1Start, { weekStartsOn: 0 });
  const calEnd = endOfWeek(m2End, { weekStartsOn: 0 });
  const weeks: Date[][] = [];
  let d = calStart;
  while (d <= calEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) { week.push(d); d = addDays(d, 1); }
    weeks.push(week);
  }
  return weeks;
}

export default function BoardPage2() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCamp, setExpandedCamp] = useState<string | null>(null);
  const [waveTab, setWaveTab] = useState<WaveTab>('WAVE2');
  const [viewMode, setViewMode] = useState<'calendar' | 'table'>('calendar');
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<number>>(new Set());

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayStr = format(today, 'yyyy-MM-dd');
  const v2Weeks = useMemo(() => buildWeeks(today), [today]);

  const months = useMemo(() => {
    const m1 = { year: today.getFullYear(), month: today.getMonth() };
    const next = addMonths(today, 1);
    const m2 = { year: next.getFullYear(), month: next.getMonth() };
    return [m1, m2];
  }, [today]);

  /* 데이터 로드 — DB에서 published 캠프만 로드 */
  useEffect(() => {
    (async () => {
      try {
        // atone 계정으로 로그인 (DB 읽기 권한)
        const { error: authErr } = await boardSupabase.auth.signInWithPassword({
          email: ATONE_EMAIL, password: ATONE_PW,
        });
        if (authErr) throw new Error('인증 실패: ' + authErr.message);

        // 1) published 캠프 목록 로드
        const { data: campRows, error: campErr } = await boardSupabase
          .from('camps')
          .select('*')
          .eq('published', true)
          .order('sort_order');
        if (campErr) throw new Error('캠프 로드 실패: ' + campErr.message);

        const camps: Camp[] = (campRows ?? []).map((r: any) => ({
          id: r.id, name: r.name, wave: r.wave, color: r.color, companyId: r.company_id,
        }));

        if (camps.length === 0) {
          // published 캠프가 없으면 전체 캠프 로드 (하위호환)
          const { data: allCampRows } = await boardSupabase.from('camps').select('*').order('sort_order');
          camps.push(...(allCampRows ?? []).map((r: any) => ({
            id: r.id, name: r.name, wave: r.wave, color: r.color, companyId: r.company_id,
          })));
        }

        // 2) 각 캠프의 workers, routes, cells 병렬 로드
        const allWorkers: Worker[] = [];
        const allRoutes: Record<string, Route[]> = {};
        const allCells: Record<string, ScheduleCell> = {};

        await Promise.all(camps.map(async (camp) => {
          const [wRes, rRes, cRes] = await Promise.all([
            boardSupabase.from('workers').select('*').eq('camp_id', camp.id).order('sort_order'),
            boardSupabase.from('routes').select('*').eq('camp_id', camp.id).order('sort_order'),
            boardSupabase.from('schedule_cells').select('*').eq('camp_id', camp.id),
          ]);

          const workers = (wRes.data ?? []).map((r: any) => ({
            id: r.id, name: r.name, loginId: r.login_id, campId: r.camp_id,
            role: r.role, assignedRoutes: r.assigned_routes ?? [], rotations: r.rotations ?? [],
          }));
          allWorkers.push(...workers);

          allRoutes[camp.id] = (rRes.data ?? []).map((r: any) => ({
            id: r.route_id, subRoutes: r.sub_routes ?? [],
          }));

          for (const r of cRes.data ?? []) {
            allCells[`${r.worker_id}::${r.date}`] = {
              workerId: r.worker_id, date: r.date, status: r.status, routes: r.routes ?? [],
            };
          }
        }));

        setSnap({ workers: allWorkers, routes: allRoutes, cells: allCells, camps });
      } catch (e: any) {
        setError(e.message || '알 수 없는 오류');
      } finally {
        setLoading(false);
        boardSupabase.auth.signOut();
      }
    })();
  }, []);

  function getEffectiveCell(worker: Worker, date: string): { status: string; routes: string[] } | undefined {
    if (!snap) return undefined;
    const cell = snap.cells[`${worker.id}::${date}`];
    if (cell) return cell;
    if (worker.role === 'regular') return { status: 'work', routes: worker.assignedRoutes };
    return undefined;
  }

  function getDaySummary(date: string, regulars: Worker[], backups: Worker[], camp: Camp) {
    const offWorkers = regulars.filter((w) => getEffectiveCell(w, date)?.status === 'off')
      .sort((a, b) => a.name.localeCompare(b.name));
    const activeBackups = backups.filter((w) => {
      const cell = getEffectiveCell(w, date);
      return cell && (cell.status === 'work' || cell.status === 'custom') && cell.routes.length > 0;
    });
    const campRoutes = snap!.routes[camp.id];
    const allSubs = campRoutes ? campRoutes.flatMap((r) => r.subRoutes) : [];
    const covered = new Set<string>();
    [...regulars, ...backups].forEach((w) => {
      const cell = getEffectiveCell(w, date);
      if (cell && (cell.status === 'work' || cell.status === 'custom')) {
        cell.routes.forEach((r) => covered.add(r));
      }
    });
    const uncovered = allSubs.filter((r) => !covered.has(r));
    return { offWorkers, activeBackups, uncovered };
  }

  const campGroups = useMemo(() => {
    if (!snap) return [];
    return (snap.camps || [])
      .filter((camp) => (camp.wave || 'WAVE1') === waveTab)
      .map((camp) => {
        const workers = snap.workers.filter((w) => w.campId === camp.id);
        const workerIds = new Set(workers.map((w) => w.id));
        const hasCells = Object.keys(snap.cells).some((k) => workerIds.has(k.split('::')[0]));
        return { camp, regulars: workers.filter((w) => w.role === 'regular'), backups: workers.filter((w) => w.role === 'backup'), hasCells };
      });
  }, [snap, waveTab]);

  useEffect(() => { setExpandedCamp(null); setDetailDate(null); }, [waveTab]);

  if (loading) return <div className="board-loading"><div className="board-spinner" /><p>스케쥴 불러오는 중...</p></div>;
  if (error) return <div className="board-error"><p>⚠️ {error}</p><button onClick={() => window.location.reload()}>새로고침</button></div>;

  return (
    <div className="board-container">
      <header className="board-header">
        <h1>📋 스케쥴 게시판</h1>
      </header>

      <div className="wave-tabs">
        {(['WAVE2', 'WAVE1'] as WaveTab[]).map((w) => (
          <button key={w} className={`wave-tab ${waveTab === w ? 'active' : ''}`} onClick={() => setWaveTab(w)}>
            {WAVE_LABELS[w]}
          </button>
        ))}
      </div>

      <div className="board-camps">
        {campGroups.length === 0 && <div className="board-empty">등록된 캠프가 없습니다</div>}
        {campGroups.map(({ camp, regulars, backups, hasCells }) => {
          const isExpanded = expandedCamp === camp.id;
          const hasWorkers = regulars.length > 0 || backups.length > 0;
          const showContent = hasWorkers && hasCells;
          return (
            <section key={camp.id} className="board-camp">
              <button
                className={`camp-toggle ${isExpanded ? 'expanded' : ''} ${!showContent ? 'empty-camp' : ''}`}
                style={{ borderLeftColor: camp.color }}
                onClick={() => { setExpandedCamp(isExpanded ? null : camp.id); setDetailDate(null); }}
              >
                <span className="camp-name">{camp.name}</span>
                <span className="camp-arrow">{isExpanded ? '▲' : '▼'}</span>
              </button>

              {isExpanded && (
                <div className="camp-calendar-wrap">
                  {!showContent ? (
                    <div className="camp-no-workers">등록된 스케쥴이 없습니다</div>
                  ) : (<>
                    {/* 달력/테이블 전환 */}
                    <div className="view-toggle">
                      <button className={`view-btn ${viewMode === 'calendar' ? 'active' : ''}`} onClick={() => { setViewMode('calendar'); setDetailDate(null); }}>월간뷰</button>
                      <button className={`view-btn ${viewMode === 'table' ? 'active' : ''}`} onClick={() => { setViewMode('table'); setDetailDate(null); }}>주간뷰</button>
                    </div>

                    {/* ── 달력 뷰 ── */}
                    {viewMode === 'calendar' && months.map(({ year, month }) => {
                      const calDates = buildCalendarDates(year, month);
                      const monthRef = new Date(year, month, 1);
                      const weeks: Date[][] = [];
                      for (let i = 0; i < calDates.length; i += 7) weeks.push(calDates.slice(i, i + 7));

                      return (
                        <div key={`${year}-${month}`} className="cal-month">
                          <div className="cal-month-title">{format(monthRef, 'yyyy년 M월')}</div>
                          <table className="cal-table">
                            <thead>
                              <tr>
                                {DAY_LABELS.map((label, i) => (
                                  <th key={i} className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''}>{label}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {weeks.map((week, wi) => {
                                const weekDates = week.map((wd) => format(wd, 'yyyy-MM-dd'));
                                const hasDetail = detailDate && weekDates.includes(detailDate);

                                const weekSummaries = week.map((d, i) => {
                                  const inMonth = isSameMonth(d, monthRef);
                                  return inMonth && hasWorkers ? getDaySummary(weekDates[i], regulars, backups, camp) : null;
                                });
                                const maxOff = Math.max(0, ...weekSummaries.map((s) => s?.offWorkers.length ?? 0));
                                const maxBackup = Math.max(0, ...weekSummaries.map((s) => s?.activeBackups.length ?? 0));
                                const maxUncovered = Math.max(0, ...weekSummaries.map((s) => s?.uncovered.length ?? 0));

                                const CHIP_H = 17;
                                const LABEL_H = 14;
                                const offMinH = maxOff > 0 ? LABEL_H + maxOff * CHIP_H : 0;
                                const backupMinH = maxBackup > 0 ? LABEL_H + maxBackup * CHIP_H : 0;
                                const uncoveredMinH = maxUncovered > 0 ? LABEL_H + maxUncovered * CHIP_H : 0;

                                return (
                                  <React.Fragment key={wi}>
                                    <tr>
                                      {week.map((d, di) => {
                                        const dateStr = weekDates[di];
                                        const inMonth = isSameMonth(d, monthRef);
                                        const isToday = dateStr === todayStr;
                                        const dayIdx = d.getDay();
                                        const summary = weekSummaries[di];

                                        return (
                                          <td
                                            key={di}
                                            className={[
                                              !inMonth ? 'out-month' : '',
                                              isToday ? 'cal-today' : '',
                                              dateStr === detailDate ? 'cal-selected' : '',
                                              dayIdx === 0 ? 'sun' : dayIdx === 6 ? 'sat' : '',
                                            ].filter(Boolean).join(' ')}
                                            onClick={() => { if (inMonth) setDetailDate(dateStr === detailDate ? null : dateStr); }}
                                          >
                                            <div className="cal-day-num-wrap">
                                              <span className={`cal-day-num ${isToday ? 'today-circle' : ''}`}>
                                                {d.getDate()}
                                              </span>
                                            </div>
                                            {summary && inMonth && (
                                              <div className="cal-cell-content">
                                                {maxOff > 0 && (
                                                  <div className="cell-section cell-off" style={{ minHeight: offMinH }}>
                                                    {summary.offWorkers.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label off-label">휴무</span>
                                                        <div className="cell-names">
                                                          {summary.offWorkers.map((w) => (
                                                            <span key={w.id} className="cell-off-name">{w.name}</span>
                                                          ))}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                                {maxBackup > 0 && (
                                                  <div className="cell-section cell-backup" style={{ minHeight: backupMinH }}>
                                                    {summary.activeBackups.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label backup-label">백업</span>
                                                        <div className="cell-names">
                                                          {summary.activeBackups.map((w) => (
                                                            <span key={w.id} className="cell-backup-name">{w.name}</span>
                                                          ))}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                                {maxUncovered > 0 && (
                                                  <div className="cell-section cell-uncovered" style={{ minHeight: uncoveredMinH }}>
                                                    {summary.uncovered.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label uncovered-label">미커버</span>
                                                        <div className="cell-names">
                                                          {summary.uncovered.map((r) => (
                                                            <span key={r} className="cell-uncovered-route">{r}</span>
                                                          ))}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        );
                                      })}
                                    </tr>

                                    {/* 상세 패널: 해당 주 바로 아래 */}
                                    {hasDetail && (() => {
                                      const dd = new Date(detailDate + 'T00:00:00');
                                      const s = getDaySummary(detailDate, regulars, backups, camp);
                                      return (
                                        <tr className="detail-row">
                                          <td colSpan={7}>
                                            <div className="cal-detail">
                                              <div className="cal-detail-header">
                                                <span className="cal-detail-date">
                                                  {format(dd, 'M월 d일 (EEE)', { locale: ko })}
                                                </span>
                                                <button className="cal-detail-close" onClick={() => setDetailDate(null)}>✕</button>
                                              </div>
                                              {s.offWorkers.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label off-label">🏖️ 휴무 ({s.offWorkers.length}명)</div>
                                                  <div className="detail-chips">
                                                    {s.offWorkers.map((w) => (
                                                      <span key={w.id} className="chip chip-off">{w.name} <span className="chip-route">{w.assignedRoutes.join(', ')}</span></span>
                                                    ))}
                                                  </div>
                                                </div>
                                              )}
                                              {s.activeBackups.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label backup-label">🔄 백업 현황 ({s.activeBackups.length}명)</div>
                                                  <div className="detail-chips">
                                                    {s.activeBackups.map((w) => {
                                                      const cell = getEffectiveCell(w, detailDate)!;
                                                      return (
                                                        <span key={w.id} className="chip chip-backup">
                                                          {w.name} → <span className="chip-route">{cell.routes.join(', ')}</span>
                                                        </span>
                                                      );
                                                    })}
                                                  </div>
                                                </div>
                                              )}
                                              {s.uncovered.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label uncovered-label">⚠️ 미커버 ({s.uncovered.length}개)</div>
                                                  <div className="detail-chips">
                                                    {s.uncovered.map((r) => (
                                                      <span key={r} className="chip chip-uncovered">{r}</span>
                                                    ))}
                                                  </div>
                                                </div>
                                              )}
                                              {s.offWorkers.length === 0 && s.activeBackups.length === 0 && s.uncovered.length === 0 && (
                                                <div className="detail-nothing">휴무자 없음</div>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })()}
                                  </React.Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}

                    {/* ── 테이블 뷰 ── */}
                    {viewMode === 'table' && (
                      <div className="v2-wrap">
                        {v2Weeks.map((week, wi) => {
                          const weekDates = week.map((d) => format(d, 'yyyy-MM-dd'));
                          const weekLabel = `${format(week[0], 'M/d')} ~ ${format(week[6], 'M/d')}`;

                          const offByDate: Record<string, string[]> = {};
                          weekDates.forEach((d) => {
                            offByDate[d] = regulars
                              .filter((w) => getEffectiveCell(w, d)?.status === 'off')
                              .map((w) => w.name)
                              .sort((a, b) => a.localeCompare(b));
                          });
                          const maxOff = Math.max(0, ...Object.values(offByDate).map((a) => a.length));

                          /* 이 주에 실제 스케쥴이 있는 백업만 필터 */
                          const sortedBackups = [...backups]
                            .filter((w) => weekDates.some((d) => {
                              const cell = getEffectiveCell(w, d);
                              return cell && (cell.status === 'work' || cell.status === 'custom') && cell.routes.length > 0;
                            }))
                            .sort((a, b) => a.name.localeCompare(b.name));

                          const hasData = maxOff > 0 || sortedBackups.length > 0;

                          /* 오늘 이전 주 또는 데이터 없는 주 → 기본 접기 */
                          const weekEnd = weekDates[6];
                          const isPast = weekEnd < todayStr;
                          const defaultCollapsed = isPast || !hasData;
                          const isCollapsed = collapsedWeeks.has(wi) ? !defaultCollapsed : defaultCollapsed;

                          return (
                            <div key={wi} className={`v2-week-block ${defaultCollapsed ? 'v2-past' : ''}`}>
                              <div
                                className="v2-week-label"
                                onClick={() => {
                                  setCollapsedWeeks((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(wi)) next.delete(wi); else next.add(wi);
                                    return next;
                                  });
                                }}
                                style={{ cursor: 'pointer' }}
                              >
                                {weekLabel}
                                <span className="v2-collapse-icon">{isCollapsed ? '▼' : '▲'}</span>
                              </div>
                              {!isCollapsed && (!hasData ? (
                                <div className="v2-empty-week">등록된 스케쥴 없음</div>
                              ) : <div className="v2-table-scroll">
                                <table className="v2-table">
                                  <thead>
                                    <tr>
                                      <th className="v2-header-cell v2-name-col">휴무자</th>
                                      {week.map((d, di) => {
                                        const dayIdx = d.getDay();
                                        const dateStr = weekDates[di];
                                        const isToday = dateStr === todayStr;
                                        return (
                                          <th
                                            key={di}
                                            className={`v2-header-cell v2-header-clickable ${dayIdx === 0 ? 'sun' : dayIdx === 6 ? 'sat' : ''} ${isToday ? 'v2-today' : ''} ${dateStr === detailDate ? 'v2-selected' : ''}`}
                                            onClick={() => setDetailDate(dateStr === detailDate ? null : dateStr)}
                                          >
                                            <div>{format(d, 'M/d')}</div>
                                            <div className="v2-day-label">{DAY_LABELS[dayIdx]}</div>
                                          </th>
                                        );
                                      })}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {maxOff > 0 && Array.from({ length: maxOff }).map((_, i) => (
                                      <tr key={`off-${i}`} className="v2-off-row">
                                        <td className="v2-cell v2-name-col v2-row-num">{i + 1}</td>
                                        {weekDates.map((d) => (
                                          <td key={d} className="v2-cell v2-off-cell v2-cell-clickable" onClick={() => setDetailDate(d === detailDate ? null : d)}>{offByDate[d][i] || ''}</td>
                                        ))}
                                      </tr>
                                    ))}

                                    <tr className="v2-section-header v2-backup-header">
                                      <th className="v2-header-cell v2-name-col">백업</th>
                                      {weekDates.map((d) => (
                                        <th key={d} className="v2-header-cell">백업대상</th>
                                      ))}
                                    </tr>

                                    {sortedBackups.map((w) => (
                                      <tr key={w.id} className="v2-backup-row">
                                        <td className="v2-cell v2-name-col v2-backup-name">{w.name}</td>
                                        {weekDates.map((d) => {
                                          const cell = getEffectiveCell(w, d);
                                          const hasWork = cell && (cell.status === 'work' || cell.status === 'custom') && cell.routes.length > 0;
                                          return (
                                            <td key={d} className={`v2-cell v2-cell-clickable ${hasWork ? 'v2-route-cell' : 'v2-empty-cell'}`} onClick={() => setDetailDate(d === detailDate ? null : d)}>
                                              {hasWork ? cell!.routes.join(',') : ''}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    ))}

                                  </tbody>
                                </table>
                              </div>)}

                              {/* 주간뷰 상세 패널 */}
                              {detailDate && weekDates.includes(detailDate) && (() => {
                                const dd = new Date(detailDate + 'T00:00:00');
                                const s = getDaySummary(detailDate, regulars, backups, camp);
                                return (
                                  <div className="cal-detail">
                                    <div className="cal-detail-header">
                                      <span className="cal-detail-date">
                                        {format(dd, 'M월 d일 (EEE)', { locale: ko })}
                                      </span>
                                      <button className="cal-detail-close" onClick={() => setDetailDate(null)}>✕</button>
                                    </div>
                                    {s.offWorkers.length > 0 && (
                                      <div className="detail-section">
                                        <div className="detail-label off-label">🏖️ 휴무 ({s.offWorkers.length}명)</div>
                                        <div className="detail-chips">
                                          {s.offWorkers.map((w) => (
                                            <span key={w.id} className="chip chip-off">{w.name} <span className="chip-route">{w.assignedRoutes.join(', ')}</span></span>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {s.activeBackups.length > 0 && (
                                      <div className="detail-section">
                                        <div className="detail-label backup-label">🔄 백업 ({s.activeBackups.length}명)</div>
                                        <div className="detail-chips">
                                          {s.activeBackups.map((w) => {
                                            const cell = getEffectiveCell(w, detailDate)!;
                                            return (
                                              <span key={w.id} className="chip chip-backup">
                                                {w.name} → <span className="chip-route">{cell.routes.join(', ')}</span>
                                              </span>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    )}
                                    {s.uncovered.length > 0 && (
                                      <div className="detail-section">
                                        <div className="detail-label uncovered-label">⚠️ 미커버 ({s.uncovered.length}개)</div>
                                        <div className="detail-chips">
                                          {s.uncovered.map((r) => (
                                            <span key={r} className="chip chip-uncovered">{r}</span>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {s.offWorkers.length === 0 && s.activeBackups.length === 0 && s.uncovered.length === 0 && (
                                      <div className="detail-nothing">휴무자 없음</div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>)}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <footer className="board-footer">
        <a href="#/" className="back-link">관리 페이지</a>
      </footer>
    </div>
  );
}
