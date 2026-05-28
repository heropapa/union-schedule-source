# 유스프 1.0 (유니온스케쥴프로그램)

유니온물류 캠프 스케쥴 관리 웹앱. 9명 캠프 관리자 + admin 1명이 캠프별
주간 스케쥴 짜고 게시판으로 발행하는 도구.

- **이름 유래**: **유**니온**스**케쥴**프**로그램 → 유스프 1.0 (확정 2026-05-27)
- **소스 repo**: https://github.com/heropapa/union-schedule-source (이 repo)
- **배포 repo**: https://github.com/heropapa/union-schedule-test1 (GitHub Pages용 빌드 산출물)
- **배포 URL**: https://heropapa.github.io/union-schedule-test1/

## 기술 스택

- React 19 + Vite + TypeScript + Zustand
- Supabase (Auth + PostgreSQL + RLS)
- 배포: GitHub Pages (`union-schedule-test1` repo)

## 로컬 개발

```bash
# 의존성
npm install

# .env 생성 (한 번만)
echo "VITE_SUPABASE_URL=https://<your-project>.supabase.co" > .env
echo "VITE_SUPABASE_ANON_KEY=<anon-key>" >> .env

# 개발 서버
npm run dev

# 빌드
npm run build

# 타입 체크
npx tsc -p tsconfig.app.json

# Lint
npx eslint .
```

## 디렉토리 구조

```
src/
├── App.tsx                    # 라우팅 (#/board → BoardPage2, 그 외 → 메인)
├── lib/
│   ├── supabase.ts            # Supabase 클라이언트 + toEmail/toDisplayName
│   └── db.ts                  # DB CRUD + acquireLock/heartbeatLock/releaseLock
├── store/
│   ├── useAuthStore.ts        # 인증 + canEditCamp (현재 미사용 — Issue #4)
│   ├── useWorkerStore.ts      # 캠프/기사/라우트
│   ├── useScheduleStore.ts    # 셀 데이터
│   └── useHistoryStore.ts     # undo/redo
├── components/
│   ├── Auth/LoginPage.tsx     # 로그인 (signup은 admin 대시보드)
│   ├── Sidebar/Sidebar.tsx    # 캠프/기사/권한/게시 토글
│   ├── Calendar/ScheduleCalendar.tsx  # 메인 편집 + 캠프 잠금
│   └── Board/BoardPage2.tsx   # /board 익명 공개 게시판
├── types/index.ts             # Worker, Camp, ScheduleCell, CampLock, ...
└── utils/                     # exportExcel, importAdminExcel 등

supabase/
└── rls-public-board.sql       # 익명 게시판용 RLS 정책 (배포 전 적용 필요)
```

## DB 스키마 (Supabase)

| 테이블 | 역할 |
|---|---|
| `profiles` | 사용자 + role (admin/viewer) |
| `camps` | 캠프 정의 + `published` (게시 여부) |
| `workers` | 기사 (camp_id, role=regular/backup) |
| `routes` | 캠프별 라우트 |
| `schedule_cells` | 주간 셀 (worker_id + date) |
| `camp_permissions` | viewer 캠프별 편집 권한 |
| `camp_locks` | 캠프 잠금 (heartbeat 기반, 45s 타임아웃) |

## 2026-05-27 작업 (Top 3 Critical Fix)

세션이 강제 종료돼 새 세션으로 이어감. 다음 커밋들이 로컬에 있음 (push 필요):

| Commit | 내용 |
|---|---|
| `1bcf939` | **fix(lock)**: 캠프 잠금 wire-up. acquireLock/heartbeat(20s)/release를 ScheduleCalendar에 연결. blocked 시 30s 재시도 + 배너 UI + canEdit 가드 |
| `0128ec9` | **fix(auth)**: LoginPage의 dead signup 모드 제거 (-95줄). admin이 Supabase 대시보드에서 직접 계정 생성하는 워크플로우 유지 |
| `9853972` | **fix(board)**: BoardPage2의 ATONE_PW='150527' 평문 하드코딩 제거. anon key + RLS로 전환. `supabase/rls-public-board.sql` 추가. BoardPage.tsx(구버전) 삭제 |

## 다음 세션 시작 시 즉시 할 일

### 1. 커밋 push
```bash
git push origin master
```

### 2. Supabase 측 조치 (필수, 안 하면 게시판 빈 화면)
- Supabase Dashboard → SQL Editor → `supabase/rls-public-board.sql` 전체 실행
- Authentication → Users → `atone@schedule.local` 삭제

### 3. 배포
`union-schedule-test1` repo에 빌드 결과 push (기존 워크플로우대로)

## 다음 우선순위 (Issue #4, #5)

### Issue #4 🟠 권한 게이팅 (canEditCamp 활용)
`useAuthStore.canEditCamp(campId)` 함수가 정의돼 있지만 호출 0건. viewer 권한자도 모든 캠프 셀 클릭/편집 가능한 상태. 다음 위치에 게이팅 필요:
- `ScheduleCalendar.tsx`의 `handleSave`, `handleRegularClick`, `handleBackupClick`, `handleRightClick`, `startEdit`
- `Sidebar.tsx`의 캠프 추가/삭제/편집 버튼, 기사 추가/삭제, 라우트 편집

### Issue #5 🟠 React 안티패턴 정리
- `Sidebar.tsx:37` — `onReorderRef.current = onReorder;` render 중 ref 업데이트 → useEffect로 이동
- `ScheduleCalendar.tsx:184` — useEffect deps에 `workerStore` 누락
- `ScheduleCalendar.tsx:252` — `handleRowDrop`의 deps에 `syncBackupOrder`, `syncRegularOrder` 누락

### 부수 정리
- TS error 6건 (대부분 미사용 vars: exportExcel.ts, db.ts의 SubRoute, importAdminExcel.ts의 타입 단언)
- ESLint 21건 (any 타입, unused vars, react-hooks/exhaustive-deps)
- git tracked 잡파일: `_.zip`, `_ (2).zip`, `src.zip`, `_preview_dist/`, `통영*.xlsx`, `schedule-v2-*.xlsx` → `git rm` + `.gitignore` 추가

## 9명 사용자 정보

관리자 9명: 김봉상, 백승엽, 문민중, 정인호, 조용환, 이정길, 전용호, 최아라, 임지현 + admin 1명. 비밀번호 통일 `123456` (Supabase 최소 6자 요구).

## 지원 연락처

문의/권한 요청: 임지현 010-3478-4253 (LoginPage 하단에 표시)
