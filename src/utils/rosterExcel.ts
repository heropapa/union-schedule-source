/**
 * 캠프별·주별 roster 엑셀 백업/복구 유틸 (유스프 v1.1)
 *
 * 한 파일에 시트 4개:
 *   - 캠프목록:   캠프명 | 주야 | 업체
 *   - 고정인원:   캠프 | 이름 | 아이디 | 라우트 | 회전 | 연락처 | 차량 | 비고
 *   - 백업인원:   (고정인원과 동일 컬럼)
 *   - 계약라우트: 캠프 | 라우트번호 | 서브라우트
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

function companyLabel(companyId: string): string {
  return COMPANIES.find((c) => c.id === companyId)?.label ?? companyId;
}
function labelToCompanyId(label: string): string {
  const trimmed = label.trim();
  return COMPANIES.find((c) => c.label === trimmed || c.id === trimmed)?.id ?? 'union';
}

const WORKER_HEADER = ['캠프', '이름', '아이디', '라우트', '회전', '연락처', '차량', '비고'];

function workerRow(campName: string, w: Worker): (string)[] {
  return [
    campName,
    w.name,
    w.loginId || '',
    w.assignedRoutes.join(', '),
    (w.rotations ?? []).join(', '),
    w.phone ?? '',
    w.vehicle ?? '',
    w.note ?? '',
  ];
}

/** 현재 주차 모든 캠프 → 엑셀 파일 다운로드 */
export async function exportRosterExcel(camps: RosterExcelCamp[], weekStart: string): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();

  // 1) 캠프목록
  const campRows: string[][] = [['캠프명', '주야', '업체']];
  for (const c of camps) {
    campRows.push([c.name, WAVE_TO_LABEL[c.wave] ?? c.wave, companyLabel(c.companyId)]);
  }
  const campWs = XLSX.utils.aoa_to_sheet(campRows);
  campWs['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, campWs, '캠프목록');

  // 2) 고정인원
  const regRows: string[][] = [WORKER_HEADER];
  for (const c of camps) {
    for (const w of c.regulars) regRows.push(workerRow(c.name, w));
  }
  const regWs = XLSX.utils.aoa_to_sheet(regRows);
  regWs['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, regWs, '고정인원');

  // 3) 백업인원
  const backRows: string[][] = [WORKER_HEADER];
  for (const c of camps) {
    for (const w of c.backups) backRows.push(workerRow(c.name, w));
  }
  const backWs = XLSX.utils.aoa_to_sheet(backRows);
  backWs['!cols'] = regWs['!cols'];
  XLSX.utils.book_append_sheet(wb, backWs, '백업인원');

  // 4) 계약라우트
  const routeRows: string[][] = [['캠프', '라우트번호', '서브라우트']];
  for (const c of camps) {
    for (const r of c.routes) routeRows.push([c.name, r.id, r.subRoutes.join(', ')]);
  }
  const routeWs = XLSX.utils.aoa_to_sheet(routeRows);
  routeWs['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, routeWs, '계약라우트');

  XLSX.writeFile(wb, `유스프_백업_${weekStart}.xlsx`);
}

/** 셀 값을 문자열로 */
function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
/** 쉼표 구분 → 배열 */
function splitList(v: unknown): string[] {
  return str(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 헤더 행에서 컬럼 인덱스를 키워드로 찾음 */
function indexer(header: unknown[]) {
  const cols = header.map((h) => str(h));
  return (keyword: string) => cols.findIndex((h) => h.includes(keyword));
}

function parseWorkerSheet(
  XLSX: typeof import('xlsx'),
  wb: import('xlsx').WorkBook,
  sheetName: string,
): Map<string, ParsedRosterWorker[]> {
  const result = new Map<string, ParsedRosterWorker[]>();
  const ws = wb.Sheets[sheetName];
  if (!ws) return result;
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
  if (raw.length < 2) return result;

  const idx = indexer(raw[0]);
  const c = {
    camp: idx('캠프'),
    name: idx('이름'),
    loginId: idx('아이디'),
    routes: idx('라우트'),
    rotations: idx('회전'),
    phone: idx('연락처'),
    vehicle: idx('차량'),
    note: idx('비고'),
  };

  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.length === 0) continue;
    const campName = c.camp >= 0 ? str(r[c.camp]) : '';
    const name = c.name >= 0 ? str(r[c.name]) : '';
    if (!campName || !name) continue;
    const worker: ParsedRosterWorker = {
      name,
      loginId: c.loginId >= 0 ? str(r[c.loginId]) : '',
      assignedRoutes: c.routes >= 0 ? splitList(r[c.routes]) : [],
      rotations: c.rotations >= 0 ? splitList(r[c.rotations]) : [],
      phone: c.phone >= 0 ? str(r[c.phone]) || undefined : undefined,
      vehicle: c.vehicle >= 0 ? str(r[c.vehicle]) || undefined : undefined,
      note: c.note >= 0 ? str(r[c.note]) || undefined : undefined,
    };
    const list = result.get(campName) ?? [];
    list.push(worker);
    result.set(campName, list);
  }
  return result;
}

/** 엑셀 파일 → 캠프별 파싱 결과 (캠프목록 시트 기준) */
export async function parseRosterExcel(buffer: ArrayBuffer): Promise<ParsedRosterCamp[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });

  // 캠프목록 시트
  const campWs = wb.Sheets['캠프목록'];
  if (!campWs) throw new Error("'캠프목록' 시트가 없습니다.");
  const campRaw = XLSX.utils.sheet_to_json<unknown[]>(campWs, { header: 1 });
  if (campRaw.length < 2) throw new Error('캠프목록이 비어 있습니다.');

  const campIdx = indexer(campRaw[0]);
  const cName = campIdx('캠프');
  const cWave = campIdx('주야');
  const cCompany = campIdx('업체');

  const regByCamp = parseWorkerSheet(XLSX, wb, '고정인원');
  const backByCamp = parseWorkerSheet(XLSX, wb, '백업인원');

  // 계약라우트 시트
  const routeByCamp = new Map<string, { routeId: string; subRoutes: string[] }[]>();
  const routeWs = wb.Sheets['계약라우트'];
  if (routeWs) {
    const routeRaw = XLSX.utils.sheet_to_json<unknown[]>(routeWs, { header: 1 });
    if (routeRaw.length >= 2) {
      const rIdx = indexer(routeRaw[0]);
      const rCamp = rIdx('캠프');
      const rNum = rIdx('라우트번호');
      const rSub = rIdx('서브라우트');
      for (let i = 1; i < routeRaw.length; i++) {
        const r = routeRaw[i];
        if (!r || r.length === 0) continue;
        const campName = rCamp >= 0 ? str(r[rCamp]) : '';
        const routeId = rNum >= 0 ? str(r[rNum]) : '';
        if (!campName || !routeId) continue;
        const list = routeByCamp.get(campName) ?? [];
        list.push({ routeId, subRoutes: rSub >= 0 ? splitList(r[rSub]) : [] });
        routeByCamp.set(campName, list);
      }
    }
  }

  const camps: ParsedRosterCamp[] = [];
  for (let i = 1; i < campRaw.length; i++) {
    const r = campRaw[i];
    if (!r || r.length === 0) continue;
    const name = cName >= 0 ? str(r[cName]) : '';
    if (!name) continue;
    const waveLabel = cWave >= 0 ? str(r[cWave]) : '';
    camps.push({
      name,
      wave: LABEL_TO_WAVE[waveLabel] ?? (waveLabel || 'WAVE1'),
      companyId: cCompany >= 0 ? labelToCompanyId(str(r[cCompany])) : 'union',
      regulars: regByCamp.get(name) ?? [],
      backups: backByCamp.get(name) ?? [],
      routes: routeByCamp.get(name) ?? [],
    });
  }
  return camps;
}
