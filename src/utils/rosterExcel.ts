/**
 * 섹션(고정인원/백업인원/계약라우트)별 엑셀 백업/복구 유틸 (유스프 v1.1)
 *
 * 선택한 캠프 × 현재 주차의 한 섹션만 담은 단일 시트 엑셀.
 *   - 인원(고정/백업): 이름 | 아이디 | 라우트 | 회전 | 연락처 | 차량 | 비고
 *   - 계약라우트:       라우트번호 | 서브라우트
 *
 * xlsx 는 번들 분리를 위해 lazy import.
 */
import type { Worker, Route } from '../types';

/** 복구 시 한 명의 인원 (id 미포함 — 복구 측에서 새로 부여) */
export interface ParsedRosterWorker {
  name: string;
  loginId: string;
  assignedRoutes: string[];
  rotations: string[];
  phone?: string;
  vehicle?: string;
  note?: string;
}

/** 복구 시 한 라우트 */
export interface ParsedRoute {
  routeId: string;
  subRoutes: string[];
}

const WORKER_HEADER = ['이름', '아이디', '라우트', '회전', '비고'];
const ROUTE_HEADER = ['라우트번호', '서브라우트'];

/** 셀 값 → 문자열 */
function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
/** 쉼표 구분 → 배열 */
function splitList(v: unknown): string[] {
  return str(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 파일명 안전화 */
function safeFile(s: string): string {
  return s.replace(/[\\/?*:[\]]/g, '_');
}

// ─── 인원 (고정/백업) ────────────────────────────────────

/** 인원 목록 → 엑셀 다운로드. roleLabel 예: '고정인원' | '백업인원' */
export async function exportWorkersExcel(
  workers: Worker[],
  campName: string,
  weekStart: string,
  roleLabel: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const rows: string[][] = [[...WORKER_HEADER]];
  for (const w of workers) {
    rows.push([
      w.name,
      w.loginId || '',
      w.assignedRoutes.join(', '),
      (w.rotations ?? []).join(', '),
      w.note ?? '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, roleLabel.slice(0, 31));
  XLSX.writeFile(wb, safeFile(`유스프_${campName}_${roleLabel}_${weekStart}.xlsx`));
}

/** 인원 엑셀 → ParsedRosterWorker[] */
export async function parseWorkersExcel(buffer: ArrayBuffer): Promise<ParsedRosterWorker[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
  const out: ParsedRosterWorker[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = str(r[0]);
    if (!name || name === '이름') continue;  // 헤더/빈 행 스킵
    out.push({
      name,
      loginId: str(r[1]),
      assignedRoutes: splitList(r[2]),
      rotations: splitList(r[3]),
      note: str(r[4]) || undefined,
    });
  }
  return out;
}

// ─── 계약라우트 ──────────────────────────────────────────

export async function exportRoutesExcel(
  routes: Route[],
  campName: string,
  weekStart: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const rows: string[][] = [[...ROUTE_HEADER]];
  for (const r of routes) rows.push([r.id, r.subRoutes.join(', ')]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '계약라우트');
  XLSX.writeFile(wb, safeFile(`유스프_${campName}_계약라우트_${weekStart}.xlsx`));
}

export async function parseRoutesExcel(buffer: ArrayBuffer): Promise<ParsedRoute[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
  const out: ParsedRoute[] = [];
  for (const r of rows) {
    const routeId = str(r[0]);
    if (!routeId || routeId === '라우트번호') continue;
    out.push({ routeId, subRoutes: splitList(r[1]) });
  }
  return out;
}
