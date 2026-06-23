/**
 * 캠프별·주별 roster 엑셀 백업/복구 유틸 (유스프 v1.1)
 *
 * 구조: 캠프(+주야)마다 시트 1개. 시트 이름 = "캠프명 주야".
 * 각 시트 안에 섹션 3개:
 *   ■ 계약라우트   : 라우트번호 | 서브라우트
 *   ■ 고정인원     : 이름 | 아이디 | 라우트 | 회전 | 연락처 | 차량 | 비고
 *   ■ 백업인원     : (고정인원과 동일 컬럼)
 * 시트 첫 줄에 캠프 메타: 캠프 | <이름> | 주야 | <주간/야간> | 업체 | <업체명>
 *
 * xlsx 는 번들 분리를 위해 lazy import.
 */
import type { Worker, Route } from '../types';
import { COMPANIES } from '../types';

/** 한 캠프의 현재 주차 roster 스냅샷 (export 입력) */
export interface RosterExcelCamp {
  name: string;
  wave: string;            // 'WAVE1' (야간) | 'WAVE2' (주간)
  companyId: string;
  regulars: Worker[];
  backups: Worker[];
  routes: Route[];
}

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

/** 복구 시 한 캠프 */
export interface ParsedRosterCamp {
  name: string;
  wave: string;
  companyId: string;
  regulars: ParsedRosterWorker[];
  backups: ParsedRosterWorker[];
  routes: { routeId: string; subRoutes: string[] }[];
}

const WAVE_TO_LABEL: Record<string, string> = { WAVE1: '야간', WAVE2: '주간' };
const LABEL_TO_WAVE: Record<string, string> = { 야간: 'WAVE1', 주간: 'WAVE2' };

const SEC_ROUTES = '■ 계약라우트';
const SEC_REGULAR = '■ 고정인원';
const SEC_BACKUP = '■ 백업인원';
const WORKER_HEADER = ['이름', '아이디', '라우트', '회전', '연락처', '차량', '비고'];

function companyLabel(companyId: string): string {
  return COMPANIES.find((c) => c.id === companyId)?.label ?? companyId;
}
function labelToCompanyId(label: string): string {
  const trimmed = label.trim();
  return COMPANIES.find((c) => c.label === trimmed || c.id === trimmed)?.id ?? 'union';
}

/** 셀 값 → 문자열 */
function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
/** 쉼표 구분 → 배열 */
function splitList(v: unknown): string[] {
  return str(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 엑셀 시트 이름 규칙: 31자 이하 + 금지문자 제거 + 중복 회피 */
function safeSheetName(base: string, used: Set<string>): string {
  let name = base.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'sheet';
  if (used.has(name)) {
    for (let i = 2; ; i++) {
      const suffix = ` (${i})`;
      const candidate = name.slice(0, 31 - suffix.length) + suffix;
      if (!used.has(candidate)) { name = candidate; break; }
    }
  }
  used.add(name);
  return name;
}

function workerRow(w: Worker): string[] {
  return [
    w.name,
    w.loginId || '',
    w.assignedRoutes.join(', '),
    (w.rotations ?? []).join(', '),
    w.phone ?? '',
    w.vehicle ?? '',
    w.note ?? '',
  ];
}

/** 현재 주차 모든 캠프 → 엑셀 파일 다운로드 (캠프마다 시트 1개) */
export async function exportRosterExcel(camps: RosterExcelCamp[], weekStart: string): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();

  for (const c of camps) {
    const waveLabel = WAVE_TO_LABEL[c.wave] ?? c.wave;
    const rows: string[][] = [];

    // 캠프 메타
    rows.push(['캠프', c.name, '주야', waveLabel, '업체', companyLabel(c.companyId)]);
    rows.push([]);

    // 계약라우트
    rows.push([SEC_ROUTES]);
    rows.push(['라우트번호', '서브라우트']);
    for (const r of c.routes) rows.push([r.id, r.subRoutes.join(', ')]);
    rows.push([]);

    // 고정인원
    rows.push([SEC_REGULAR]);
    rows.push([...WORKER_HEADER]);
    for (const w of c.regulars) rows.push(workerRow(w));
    rows.push([]);

    // 백업인원
    rows.push([SEC_BACKUP]);
    rows.push([...WORKER_HEADER]);
    for (const w of c.backups) rows.push(workerRow(w));

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 20 }];
    const sheetName = safeSheetName(`${c.name} ${waveLabel}`, usedNames);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  // 캠프가 하나도 없으면 빈 시트라도
  if (camps.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['데이터 없음']]), 'empty');
  }

  XLSX.writeFile(wb, `유스프_백업_${weekStart}.xlsx`);
}

/** 한 행에서 라벨 다음 칸 값을 찾음 (예: ['캠프','부산2',...] 에서 '캠프'→'부산2') */
function valueAfter(row: unknown[], label: string): string {
  for (let i = 0; i < row.length; i++) {
    if (str(row[i]) === label) return str(row[i + 1]);
  }
  return '';
}

/** 한 시트 → ParsedRosterCamp (없으면 null) */
function parseSheet(rows: unknown[][]): ParsedRosterCamp | null {
  if (!rows.length) return null;

  // 캠프 메타 (보통 첫 줄)
  let name = '';
  let waveLabel = '';
  let companyText = '';
  for (const r of rows.slice(0, 3)) {
    if (!name) name = valueAfter(r, '캠프');
    if (!waveLabel) waveLabel = valueAfter(r, '주야');
    if (!companyText) companyText = valueAfter(r, '업체');
  }
  if (!name) return null;

  const routes: { routeId: string; subRoutes: string[] }[] = [];
  const regulars: ParsedRosterWorker[] = [];
  const backups: ParsedRosterWorker[] = [];

  type Section = 'none' | 'routes' | 'regular' | 'backup';
  let section: Section = 'none';
  let expectHeader = false;

  for (const r of rows) {
    const first = str(r[0]);

    // 섹션 마커 감지
    if (first.includes('계약라우트')) { section = 'routes'; expectHeader = true; continue; }
    if (first.includes('고정인원')) { section = 'regular'; expectHeader = true; continue; }
    if (first.includes('백업인원')) { section = 'backup'; expectHeader = true; continue; }

    // 빈 행 → 섹션 종료
    if (r.every((c) => str(c) === '')) { section = 'none'; continue; }

    // 섹션 헤더 행 건너뛰기
    if (expectHeader) { expectHeader = false; continue; }

    if (section === 'routes') {
      const routeId = str(r[0]);
      if (routeId) routes.push({ routeId, subRoutes: splitList(r[1]) });
    } else if (section === 'regular' || section === 'backup') {
      const wName = str(r[0]);
      if (!wName) continue;
      const worker: ParsedRosterWorker = {
        name: wName,
        loginId: str(r[1]),
        assignedRoutes: splitList(r[2]),
        rotations: splitList(r[3]),
        phone: str(r[4]) || undefined,
        vehicle: str(r[5]) || undefined,
        note: str(r[6]) || undefined,
      };
      (section === 'regular' ? regulars : backups).push(worker);
    }
  }

  return {
    name,
    wave: LABEL_TO_WAVE[waveLabel] ?? (waveLabel || 'WAVE1'),
    companyId: companyText ? labelToCompanyId(companyText) : 'union',
    regulars,
    backups,
    routes,
  };
}

/** 엑셀 파일 → 캠프별 파싱 결과 (시트마다 캠프 1개) */
export async function parseRosterExcel(buffer: ArrayBuffer): Promise<ParsedRosterCamp[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });

  const camps: ParsedRosterCamp[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true });
    const camp = parseSheet(rows);
    if (camp) camps.push(camp);
  }

  if (camps.length === 0) {
    throw new Error('캠프 시트를 찾을 수 없습니다. 시트 첫 줄에 "캠프 | <이름>" 형식이 필요합니다.');
  }
  return camps;
}
