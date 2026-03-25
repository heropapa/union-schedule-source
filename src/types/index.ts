/** 업체 정보 */
export interface Company {
  id: string;               // 'union', 'baro'
  vendorName: string;       // 벤더명: "(주)넥스트 유니온/NEXTU"
  businessNumber: string;   // 사업자등록번호: "5258603344"
  label: string;            // 탭에 표시할 이름
}

/** 업체 목록 (고정값) */
export const COMPANIES: Company[] = [
  { id: 'union', vendorName: '(주)넥스트 유니온/NEXTU', businessNumber: '5258603344', label: '유니온물류' },
  { id: 'baro',  vendorName: '바로물류/BARO',           businessNumber: '6080335755', label: '바로물류' },
];

/** 하위호환용 */
export interface CompanyInfo {
  vendorName: string;
  businessNumber: string;
}

/** 캠프 정보 */
export interface Camp {
  id: string;          // 'M_통영1', 'M_거제1'
  name: string;        // '통영1', '거제1'
  wave: string;        // 'WAVE1' (야간)
  color: string;       // '#3174ad' (캠프 색상)
  companyId: string;   // 'union', 'baro'
}

/** 서브라우트 (최소 배정 단위) */
export type SubRoute = string; // '701A', '701B', ...

/** 라우트 (서브라우트 그룹) */
export interface Route {
  id: string;          // '701', '702', ...
  subRoutes: SubRoute[];
}

/** 기사 역할 */
export type WorkerRole = 'regular' | 'backup';

/** 회전 정보 (wave별 기본값) */
export const ROTATIONS_BY_WAVE: Record<string, string[]> = {
  WAVE1: ['D1', 'D2', 'F3'],       // 야간
  WAVE2: ['1회전', '2회전'],         // 주간
};

/** 기사 정보 */
export interface Worker {
  id: string;
  name: string;
  loginId: string;
  campId: string;
  role: WorkerRole;
  assignedRoutes: SubRoute[];
  rotations: string[];    // 담당 회전 목록 (기본: wave 전체)
  phone?: string;
  vehicle?: string;
  note?: string;
}

/** 요일 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 스케줄 셀 상태 */
export type CellStatus = 'work' | 'off' | 'custom' | 'empty';

/** 스케줄 셀 */
export interface ScheduleCell {
  workerId: string;
  date: string;           // 'YYYY-MM-DD'
  status: CellStatus;
  routes: SubRoute[];     // 이 날 담당할 서브라우트
}

/** 1주일 스케줄 */
export interface WeekSchedule {
  weekStart: string;      // 일요일 날짜 'YYYY-MM-DD'
  cells: ScheduleCell[];
}

/** 전체 스케줄 데이터 */
export interface ScheduleData {
  campId: string;
  weeks: WeekSchedule[];
}

/** 캠프 권한 */
export interface CampPermission {
  userId: string;
  campId: string;
  canEdit: boolean;
}

/** 캠프 잠금 정보 */
export interface CampLock {
  campId: string;
  lockedBy: string;
  lockedAt: string;
  heartbeat: string;
  sessionId: string;
  displayName?: string;  // UI 표시용
}
