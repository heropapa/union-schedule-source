import type { Camp, Route, Worker } from '../types';
import { ROTATIONS_BY_WAVE } from '../types';

// ── 캠프 ──
export const camps: Camp[] = [
  { id: 'M_통영1', name: 'M_통영1', wave: 'WAVE1', color: '#3174ad', companyId: 'union' },
  { id: 'M_거제1', name: 'M_거제1', wave: 'WAVE1', color: '#e67c73', companyId: 'union' },
];

// ── 계약라우트 ──
export const routes: Record<string, Route[]> = {
  M_통영1: [
    { id: '701', subRoutes: ['701A', '701B', '701C', '701D'] },
    { id: '702', subRoutes: ['702A', '702B', '702C', '702D'] },
    { id: '703', subRoutes: ['703A', '703B', '703C', '703D'] },
    { id: '704', subRoutes: ['704A', '704B', '704C', '704D'] },
    { id: '705', subRoutes: ['705A', '705B', '705C', '705D'] },
    { id: '706', subRoutes: ['706A', '706B', '706C', '706D'] },
  ],
  M_거제1: [
    { id: '610', subRoutes: ['610A', '610B', '610C', '610D'] },
    { id: '611', subRoutes: ['611A', '611B', '611C', '611D'] },
    { id: '612', subRoutes: ['612A', '612B', '612C', '612D'] },
  ],
};

// ── 인원 (통영1) ──
const w1rot = [...ROTATIONS_BY_WAVE.WAVE1];
const tongyeongWorkers: Worker[] = [
  { id: 'ty1', name: '공재식', loginId: 'kjsrhd', campId: 'M_통영1', role: 'regular', assignedRoutes: ['701A', '701C', '701D'], rotations: [...w1rot], phone: '35548326', vehicle: '87두7336' },
  { id: 'ty2', name: '김노은', loginId: 'byun2212', campId: 'M_통영1', role: 'regular', assignedRoutes: ['702A', '703B'], rotations: [...w1rot], phone: '65524253', vehicle: '경남80배7220' },
  { id: 'ty3', name: '이송원', loginId: 'khyproject', campId: 'M_통영1', role: 'regular', assignedRoutes: ['702B', '702D'], rotations: [...w1rot], phone: '21100765', vehicle: '90무3133' },
  { id: 'ty4', name: '한규철', loginId: 'hgch377', campId: 'M_통영1', role: 'regular', assignedRoutes: ['703A', '703C', '703D'], rotations: [...w1rot], phone: '30684353', vehicle: '88수0726' },
  { id: 'ty5', name: '임홍섭', loginId: 'dla10131', campId: 'M_통영1', role: 'regular', assignedRoutes: ['704A', '704B', '704C', '704D'], rotations: [...w1rot], phone: '53433581', vehicle: '부산90배5868' },
  { id: 'ty6', name: '박명제', loginId: 'Gs12345@@', campId: 'M_통영1', role: 'regular', assignedRoutes: ['705C', '705D', '706A'], rotations: [...w1rot], phone: '76746616', vehicle: '경남80배3842' },
  { id: 'ty7', name: '김민성', loginId: 'alstjd587', campId: 'M_통영1', role: 'regular', assignedRoutes: ['706B', '706C', '706D'], rotations: [...w1rot], phone: '91640745', vehicle: '812고3562' },
  { id: 'ty8', name: '김봉상', loginId: 'bestangel33', campId: 'M_통영1', role: 'backup', assignedRoutes: [], rotations: [...w1rot], phone: '71425433', vehicle: '부산90배4971' },
  { id: 'ty9', name: '미정1', loginId: '', campId: 'M_통영1', role: 'regular', assignedRoutes: ['705A', '705B'], rotations: [...w1rot] },
  { id: 'ty10', name: '미정2', loginId: '', campId: 'M_통영1', role: 'backup', assignedRoutes: [], rotations: [...w1rot] },
  { id: 'ty11', name: '미정3', loginId: '', campId: 'M_통영1', role: 'regular', assignedRoutes: [], rotations: [...w1rot] },
];

// ── 인원 (거제1) ──
const geojeWorkers: Worker[] = [
  { id: 'gj1', name: '김성림', loginId: 'bloom22', campId: 'M_거제1', role: 'regular', assignedRoutes: ['610A', '610B', '610C'], rotations: [...w1rot], phone: '76231295', vehicle: '경남80배6040' },
  { id: 'gj2', name: '송현진', loginId: 'song6782!@!@', campId: 'M_거제1', role: 'regular', assignedRoutes: ['610D', '612A', '611C'], rotations: [...w1rot], phone: '46711449', vehicle: '836머6782' },
  { id: 'gj3', name: '전해리', loginId: 'kims948900!!', campId: 'M_거제1', role: 'regular', assignedRoutes: ['611D'], rotations: [...w1rot], phone: '83572310', vehicle: '90소3766', note: '백업지원' },
  { id: 'gj4', name: '김유승', loginId: 'kerroz', campId: 'M_거제1', role: 'regular', assignedRoutes: ['612B', '611A', '611B'], rotations: [...w1rot], phone: '62931747', vehicle: '경남80배5510' },
  { id: 'gj5', name: '김정선', loginId: 'tjstn72', campId: 'M_거제1', role: 'regular', assignedRoutes: [], rotations: [...w1rot], phone: '93557328', vehicle: '경남80배1665' },
  { id: 'gj6', name: '김태욱', loginId: 'a89156', campId: 'M_거제1', role: 'backup', assignedRoutes: [], rotations: [...w1rot], phone: '44825353', vehicle: '경남80배5628' },
];

// ── 미배정 서브라우트 랜덤 배정 ──
function assignUnassigned(workers: Worker[], allSubRoutes: string[]) {
  const assigned = new Set(workers.flatMap((w) => w.assignedRoutes));
  const unassigned = allSubRoutes.filter((r) => !assigned.has(r));

  if (unassigned.length === 0) return;

  // 라우트가 없는 regular 인원 찾기
  const available = workers.filter(
    (w) => w.role === 'regular' && w.assignedRoutes.length === 0,
  );

  // 랜덤 배정
  const shuffled = [...unassigned].sort(() => Math.random() - 0.5);
  if (available.length > 0) {
    const perWorker = Math.ceil(shuffled.length / available.length);
    available.forEach((w, i) => {
      w.assignedRoutes = shuffled.slice(i * perWorker, (i + 1) * perWorker);
    });
  }
}

// 통영1 미배정 처리: 701B, 702C → 미정3
const tyAllSubs = routes.M_통영1.flatMap((r) => r.subRoutes);
assignUnassigned(tongyeongWorkers, tyAllSubs);

// 거제1 미배정 처리: 612C, 612D → 김정선
const gjAllSubs = routes.M_거제1.flatMap((r) => r.subRoutes);
assignUnassigned(geojeWorkers, gjAllSubs);

export const workers: Worker[] = [...tongyeongWorkers, ...geojeWorkers];

// campColors는 Camp.color 필드로 통합됨 — 하위 호환용 export
export const campColors: Record<string, string> = Object.fromEntries(
  camps.map((c) => [c.id, c.color]),
);
