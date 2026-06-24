/**
 * 스케쥴 보드 엑셀 업로드(복원) — 일반 양식 / 어드민 양식 둘 다 지원.
 *
 * 다운로드한 엑셀을 다시 올려 현재 캠프·주차의 셀(근무/휴무/라우트)에 반영.
 * 사이드바에 없는 인원 등 적용 불가 행은 "몇 번째 줄: 사유" 로 모아 보고.
 *
 * xlsx 는 lazy import.
 */
import type { ScheduleCell, Worker, CellStatus } from '../types';
import { parseAdminExcel, matchImportRows } from './importAdminExcel';

export interface ImportError {
  row: number;       // 엑셀 행 번호 (1-based)
  reason: string;
}

export interface ScheduleImportResult {
  applicable: ScheduleCell[];   // 적용 가능한 셀
  errors: ImportError[];        // 적용 불가 행 + 사유
  appliedCount: number;         // = applicable.length
  format: '일반' | '어드민';
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** 일반 양식 셀 텍스트 → 셀 상태/라우트 (없으면 null = 변경 없음) */
function parseGeneralCellText(text: string): { status: CellStatus; routes: string[] } | null {
  const t = text.trim();
  if (t === '') return null;            // 빈 칸 = 변경 없음
  if (t === '휴') return { status: 'off', routes: [] };
  if (t === '근') return { status: 'work', routes: [] };
  if (t === '직접') return { status: 'custom', routes: [] };
  // 라우트 목록
  const routes = t.split(',').map((s) => s.trim()).filter(Boolean);
  return { status: 'work', routes };
}

/**
 * 일반 양식(그리드) 파싱. 요일 컬럼은 위치순으로 현재 주차 날짜(weekDates)에 매핑.
 * 인원은 현재 캠프 workers 와 아이디/이름으로 매칭.
 */
async function parseGeneral(
  buffer: ArrayBuffer,
  weekDates: string[],
  workers: Worker[],
): Promise<ScheduleImportResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = ws ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true }) : [];

  const applicable: ScheduleCell[] = [];
  const errors: ImportError[] = [];

  // 헤더: [구분, 이름, 아이디, 담당 라우트, 요일0..6]
  // 데이터는 2행부터. 요일 컬럼은 index 4..
  const byLoginId = new Map<string, Worker>();
  const byName = new Map<string, Worker[]>();
  for (const w of workers) {
    if (w.loginId) byLoginId.set(w.loginId.toLowerCase(), w);
    const l = byName.get(w.name) ?? []; l.push(w); byName.set(w.name, l);
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const gubun = str(r[0]);
    const name = str(r[1]);
    const loginId = str(r[2]);
    // 구분/통계 행 스킵
    if (!name) continue;
    if (gubun.includes('백업 인원') || gubun === '미커버' || gubun === '중복') continue;

    // 인원 매칭
    let worker: Worker | undefined;
    if (loginId) worker = byLoginId.get(loginId.toLowerCase());
    if (!worker) {
      const cands = byName.get(name);
      if (cands && cands.length === 1) worker = cands[0];
      else if (cands && cands.length > 1) {
        errors.push({ row: i + 1, reason: `동명이인 "${name}" — 아이디로 구분 필요` });
        continue;
      }
    }
    if (!worker) {
      errors.push({ row: i + 1, reason: `사이드바에 없는 인원: "${name}"${loginId ? ` (${loginId})` : ''}` });
      continue;
    }

    // 요일 셀
    for (let d = 0; d < weekDates.length; d++) {
      const cellText = str(r[4 + d]);
      const parsed = parseGeneralCellText(cellText);
      if (!parsed) continue;
      applicable.push({ workerId: worker.id, date: weekDates[d], status: parsed.status, routes: parsed.routes });
    }
  }

  return { applicable, errors, appliedCount: applicable.length, format: '일반' };
}

/** 어드민 양식 파싱 — 기존 parseAdminExcel + matchImportRows 재사용 + 안전장치 */
async function parseAdmin(
  buffer: ArrayBuffer,
  campId: string,
  campName: string,
  weekDates: string[],
  workers: Worker[],
): Promise<ScheduleImportResult> {
  const rows = parseAdminExcel(buffer);
  const result = matchImportRows(rows, workers, campId);

  // 안전장치 1: 파일 캠프명이 현재 캠프와 다르면 전체 거부 (다른 캠프 오적용 방지)
  if (result.campName && campName && result.campName !== campName) {
    return {
      applicable: [],
      errors: [{ row: 1, reason: `파일 캠프(${result.campName})가 현재 캠프(${campName})와 다릅니다. 해당 캠프를 선택 후 올려주세요.` }],
      appliedCount: 0,
      format: '어드민',
    };
  }

  const weekSet = new Set(weekDates);
  const applicable: ScheduleCell[] = [];
  const errors: ImportError[] = result.mismatched.map((mm) => ({ row: mm.row.rowNum, reason: mm.reason }));

  for (const m of result.matched) {
    // 안전장치 2: 현재 주차 밖 날짜는 무시 + 보고 (다른 주에 조용히 써지는 것 방지)
    if (!weekSet.has(m.row.date)) {
      errors.push({ row: m.row.rowNum, reason: `현재 주차(${weekDates[0]}~) 밖 날짜 ${m.row.date} — 무시됨` });
      continue;
    }
    applicable.push({
      workerId: m.worker.id,
      date: m.row.date,
      status: (m.row.status === '휴무' ? 'off' : 'work') as CellStatus,
      routes: m.row.status === '휴무' ? [] : m.row.routes,
    });
  }

  return { applicable, errors, appliedCount: applicable.length, format: '어드민' };
}

/** 엑셀 업로드 → 적용 가능한 셀 + 오류 보고 */
export async function importScheduleExcel(
  buffer: ArrayBuffer,
  format: '일반' | '어드민',
  ctx: { campId: string; campName: string; weekDates: string[]; workers: Worker[] },
): Promise<ScheduleImportResult> {
  if (format === '어드민') return parseAdmin(buffer, ctx.campId, ctx.campName, ctx.weekDates, ctx.workers);
  return parseGeneral(buffer, ctx.weekDates, ctx.workers);
}
