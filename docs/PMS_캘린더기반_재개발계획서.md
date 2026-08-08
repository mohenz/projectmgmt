# PMS 재개발계획서 — Firebase 제거 및 Supabase/PostgreSQL 전환

> 문서 상태: **Phase 0~7 전체 완료** (2026-08-07 기준)
> 작성일: 2026-08-07
> 기준 자료: `docs/calendar/00-README.md` ~ `06-roadmap.md`, 현재 `project-tool` 코드베이스

## 진행 현황 (2026-08-07)

| Phase | 상태 | 비고 |
|---|---|---|
| Phase 0 (인프라 전환 기반) | ✅ 완료 | Supabase 프로비저닝, 통합 Prisma 스키마, Auth.js 로그인/역할, 세션 기반 컨텍스트 |
| Phase 1 (기존 모듈 이관) | ✅ 완료 | 이슈·주간보고·주간실적·인력변동·프로젝트정보·공통코드·캘린더 전부 Prisma로 이관, `firebase-admin` 제거 |
| Phase 2 (사용자·감사로그 관리 화면) | ✅ 완료 | 사용자 목록/역할변경/계정잠금/비밀번호 강제초기화(`/settings/users`), 그룹 관리(`/settings/groups`), 감사로그 필터 조회(`/activity-logs`, 관리자 전용) |
| Phase 3 (캘린더 — 우선순위·마일스톤) | ✅ 완료 | `CalendarEvent.priority/isMilestone`, 우선순위 색상체계, `/calendar/milestones` 모아보기(프로젝트 오픈일자 자동 반영 포함) |
| Phase 4 (캘린더 — 반복일정) | ✅ 완료 | RRULE 기반 등록/전개(`lib/domain/recurrence.ts`), `EventException`으로 단일회차 수정/삭제(scope=all\|single), 시리즈 전체 수정 시 개별 예외가 우선 적용됨을 e2e 확인 |
| Phase 5 (캘린더 — 다중담당자·검색·뷰 확장) | ✅ 완료 | `EventAssignee`/`EventGroupTag` 다중 지정, `/calendar/search`(기간·담당자·그룹·우선순위 조합), 년간/모바일 Agenda 뷰 추가 |
| Phase 6 (부가기능: 엑셀/첨부파일/쪽지) | ✅ 완료 | 월단위 엑셀 다운로드/업로드(Dry-run 검증, `/calendar/excel`), Supabase Storage 첨부파일(서명 URL 다운로드), 쪽지(AES-256-GCM + 조회 비밀번호, `/messages`) |
| Phase 7 (운영 안정화) | ✅ 완료(코드 범위) | 전 테이블 RLS 활성화(anon 키로 REST 접근 차단 e2e 확인), 캘린더/첨부파일/엑셀 쓰기에 운영자 이상 권한 적용(화면+API 이중 차단), Prisma 트랜잭션 타임아웃 여유 확대. **백업(PITR)·모니터링 대시보드 설정은 Supabase/Vercel 대시보드에서 수동으로 진행 필요**(코드로 자동화 불가) |

## 남은 것 (범위 밖으로 의도적으로 제외)
- 조직 그룹(회사/부서) 소속 멤버 추가/제거 UI(`POST /api/groups/{id}/members`)
- 쪽지 발신 취소, 만료 자동 삭제 등 부가 옵션
- Supabase PITR 백업 활성화(플랜 업그레이드 필요할 수 있음), Vercel/Supabase 모니터링 대시보드 구성 — 실제 배포 후 대시보드에서 진행

## 문서 변경 이력
| 버전 | 범위 | 비고 |
|---|---|---|
| v1 | 플랫폼(인증/역할/그룹) 우선 구축 후 캘린더 고도화, 전체 Postgres 전환 | |
| v2 | 캘린더 모듈만 Postgres로, 나머지는 Firestore 유지(듀얼 DB) | 폐기 |
| **v3(현재)** | **모든 데이터·파일 스토리지에서 Firebase를 완전히 제거**하고 Supabase(PostgreSQL + Storage 버킷)로 일원화. 인증도 이번에 정식으로 구축(Auth.js + 역할). 그 위에 `docs/calendar` 스펙 수준의 캘린더 고도화를 얹는다. | 확정 |

v2의 "듀얼 DB" 구조는 이번 결정으로 폐기한다 — 캘린더뿐 아니라 이슈·주간보고·인력변동·공통코드·프로필 등 **모든 Firestore 컬렉션을 Postgres로 이관**하고, `firebase-admin` 의존성 자체를 제거한다.

---

## 1. 마이그레이션 원칙

1. **Firebase 완전 제거** — `firebase-admin` 패키지, `apphosting.yaml`(Firebase App Hosting), Firestore(`projectmgmtdb`) 연결, 관련 환경변수(`GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID`)를 전부 제거한다. 파일 저장이 필요한 기능(첨부파일 등)도 Firebase Storage가 아니라 **Supabase Storage 버킷**만 사용한다.
2. **기능 동작 유지가 우선** — 기존 이슈·주간보고·공정율·인력변동·캘린더 화면은 마이그레이션 전후로 동작이 같아야 한다(회귀 없음). 새 기능(`docs/calendar` 고도화)은 마이그레이션이 끝난 뒤 얹는다.
3. **인증은 이번에 정식으로** — `getLocalContext()`의 하드코딩된 단일 사용자를 Auth.js 세션으로 교체하고, `docs/01-requirements.md`의 역할 체계(ADMIN/OPERATOR/MEMBER)를 전체 모듈에 적용한다.
4. **Vercel Marketplace 경유 프로비저닝 우선** — Supabase Postgres/Storage는 자격증명을 직접 하드코딩하지 않고 Vercel 통합 경로로 연결한다.

---

## 2. 목표 아키텍처

| 영역 | 현재(제거 대상) | 전환 후 |
|---|---|---|
| DB | Cloud Firestore(`projectmgmtdb`), `firebase-admin` | Supabase PostgreSQL, Prisma |
| 파일 저장 | (미사용, 향후 계획도 Firebase Storage였다면 폐기) | Supabase Storage 버킷 |
| 인증 | 없음(`LOCAL_USER_ID` 하드코딩) | Auth.js(NextAuth) Credentials + bcrypt, 세션 기반 `role` |
| 배포 | Firebase App Hosting(`apphosting.yaml`) | Vercel(GitHub 연동, Preview/Production), `vercel.ts` |
| 감사 로그 | `writeAuditLog()`(Firestore) | Prisma `AuditLog` 모델 + 관리자 조회 화면 신설 |
| 엑셀 | 없음(CSV만 `lib/domain/csv.ts`) | `exceljs` 기반 월단위 업/다운로드 추가(Phase 6) |
| 암호화 | 없음 | 비밀번호 bcrypt, (쪽지 도입 시) AES-256-GCM |

---

## 3. 통합 Prisma 스키마 매핑

기존 Firestore 컬렉션(`lib/domain/firestore-model.ts`의 `FIRESTORE_COLLECTIONS`) 전부를 Prisma 모델로 옮기고, `docs/calendar/03-database-schema.md`의 신규 엔티티를 병합한다.

| Firestore 컬렉션 | Prisma 모델 | 변경 사항 |
|---|---|---|
| `profiles`, `members`(서브컬렉션) | `User`, `ProjectMember` | `User`에 `userId`(로그인 ID), `passwordHash`, `role`, `theme`, `status` 추가(docs `USERS` 반영). 프로젝트별 역할 오버라이드는 `ProjectMember` |
| `projects` | `Project` | 기존 필드(오픈방식/기간/조직/등급) 유지 + docs `open_date`/`description` 병합 |
| `commonCodeGroups`, `commonCodes`(Track만) | `Groups`(`group_type=WORK_MODULE`) | **통합 확정(6장 #3)** — Track은 `Groups`로 흡수. 이슈·주간실적·인력변동의 `trackCodeId`/`areaCodeId` 참조를 `groupId`로 변경. 조직그룹(회사/부서)은 `group_type=COMPANY`로 신규 추가 |
| `commonCodeGroups`, `commonCodes`(유형/에스컬레이션) | `CommonCodeGroup`, `CommonCode` | 그룹 개념이 아니므로 기존 체계 그대로 존속 |
| `items`, `itemEvents` | `Item`, `ItemEvent` | 그대로 이관(참조 필드명만 `groupId`로 변경) |
| `weeks`, `weeklyReports`, `weeklyProgress`, `staffChanges` | `Week`, `WeeklyReport`, `WeeklyProgress`, `StaffChange` | 그대로 이관(참조 필드명만 `groupId`로 변경) |
| `calendarEvents` | `CalendarEvent` | 우선순위/마일스톤/반복규칙 필드 추가(4장 Phase 3 이후) |
| (신규) | `EventException`, `EventAssignee`, `EventGroupTag`, `EventAttachment` | `docs/03` 반영, `EventAssignee`는 이제 실제 `User` FK(듀얼 DB가 아니므로 진짜 외래키 가능) |
| (신규) | `Message`, `NotificationSetting` | **범위 포함 확정(6장 #2)** — `docs/03-database-schema.md` `MESSAGES`/`NOTIFICATION_SETTINGS` 그대로, Phase 6에서 구현 |
| `auditLogs` | `AuditLog` | 그대로 이관 + 관리자 조회 화면 신설 |
| `meta`(시퀀스 등) | Postgres 시퀀스/`meta` 테이블 | 이슈 표시번호(`IR-2026-000001`) 채번 로직 재구현 |

---

## 4. 단계별 로드맵

### Phase 0. 인프라 전환 기반
- Supabase 프로젝트 생성(Postgres + Storage 버킷), Vercel Marketplace 연동
- 로컬 Docker Postgres 구성, Prisma 스키마(3장 전체 모델) 작성 및 초기 마이그레이션
- Auth.js Credentials Provider: 회원가입(ID/이름/비밀번호), 로그인/로그아웃, 본인 비밀번호 변경, 관리자 강제 초기화, JWT 세션
- `getLocalContext()` → 세션 기반 `{ userId, projectId, role }`로 교체(모든 서버 함수의 진입점)
- Vercel 프로젝트 연결(GitHub, Preview/Production 분리)

### Phase 1. 기존 모듈 이관 (Firestore → Prisma, 기능 동결)
- `lib/server/db.ts`(Firestore 접근 계층)를 Prisma Client 기반으로 전면 교체
- `items`, `weeks`, `weeklyReports`, `weeklyProgress`, `staffChanges`, `project-settings`, `common-codes`, `activity-logs`(감사로그) 순으로 이관 — 각 모듈 이관 후 기존 vitest 스위트로 회귀 검증
- 역할 기반 쓰기 제한(관리자/운영자만 등록·수정) 적용 — 지금까지는 권한 구분이 전혀 없었으므로 이 단계에서 처음 생김
- **Firebase 제거 체크리스트 실행**(5장) — `firebase-admin`, `apphosting.yaml`, 관련 env 삭제

### Phase 2. 감사 로그·사용자 관리 화면
- 관리자 대상 사용자 목록/역할변경/계정잠금, 그룹(조직/업무모듈) 관리 화면
- 감사 로그 조회 화면(`/admin/audit-logs`)

### Phase 3. 캘린더 — 우선순위·마일스톤
- `CalendarEvent`에 `priority`(HIGH/MEDIUM/LOW), `isMilestone` 추가, 색상 체계(`docs/05-design-guide.md`)를 Bloom UI 토큰에 매핑
- "주요 이벤트 모아보기" 위젯, 프로젝트 오픈일자 자동 마일스톤 반영(`Project` 테이블에서 직접 JOIN — 이제 같은 DB이므로 단순 쿼리)

### Phase 4. 캘린더 — 반복 일정
- `recurrenceRule`(RRULE, `rrule` 라이브러리) 등록/전개, `EventException`으로 단일회차 수정/삭제

### Phase 5. 캘린더 — 담당자·그룹 다중 지정 + 검색
- `EventAssignee`(실제 `User` FK), `EventGroupTag` 다중 지정
- 검색/필터(기간·담당자·그룹·우선순위) — 단일 Postgres 쿼리로 처리(더 이상 Firestore 병합 불필요)
- 년간 뷰, 모바일 Agenda 뷰 추가

### Phase 6. 부가 기능
- Supabase Storage 버킷 연동 — 캘린더 `EventAttachment`, 필요 시 다른 모듈 첨부파일도 동일 버킷 구조 재사용
- 엑셀 월단위 업/다운로드(`exceljs`, Dry-run 검증)
- 이벤트 리마인더 알림(이메일, Resend/SMTP)
- (선택) 쪽지 기능 — 이번 재개발 핵심 범위는 아니므로 필요 시 별도 논의

### Phase 7. 운영 안정화
- Supabase Connection Pooling(PgBouncer), 인덱스 점검(3장 테이블 기준)
- RBAC 3중 체크(화면/버튼/API) 재검증, RLS 최소 방어선
- 백업(PITR), 모니터링(Vercel/Supabase Logs)
- Firebase 프로젝트(`projectmgmt-e7dfd`) 리소스 완전 폐기

---

## 5. Firebase 제거 체크리스트

| 항목 | 위치 | 조치 |
|---|---|---|
| `firebase-admin` 의존성 | `package.json` | 제거 |
| Firebase App Hosting 설정 | `apphosting.yaml` | 삭제, Vercel 설정으로 대체 |
| Firestore 접근 계층 | `lib/server/db.ts` | Prisma 기반으로 전면 재작성 |
| Firestore 모델 상수 | `lib/domain/firestore-model.ts` | Prisma 모델/seed로 대체 |
| 환경변수 | `.env.example`, `apphosting.yaml`의 `env` | `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID` 제거, `DATABASE_URL`(Supabase), `AUTH_SECRET` 등 추가 |
| 문서 배너 | `docs/FIREBASE_FIRESTORE_ARCHITECTURE.md`, `docs/SYSTEM_DESIGN.md`, `docs/PMS_개발작업계획서.md`, `docs/PMS_개발환경_아키텍처.md` | ✅ 완료 — 상단에 "현재 기준은 본 문서(v3)" 배너로 갱신 |
| README | `README.md` | Firebase 관련 설명을 Supabase/Postgres 기준으로 재작성 |

---

## 6. 열린 질문 — 확정 결과

| # | 질문 | 결정 |
|---|---|---|
| 1 | 기존 Firestore에 seed 데이터 외 실제 운영 데이터가 있는가 | **없음** — seed/데모 데이터뿐. Phase 1은 데이터 정합성 검증 절차 없이 **스키마 이관만** 하면 된다(내보내기/가져오기 스크립트 불필요, Prisma seed로 동일 데모 데이터 재작성) |
| 2 | 쪽지(메시지) 기능 포함 여부 | **포함** — Phase 6에 `docs/03-database-schema.md`의 `MESSAGES`(AES-256-GCM 암호화 + 조회 비밀번호) 그대로 추가 |
| 3 | 조직그룹(회사/부서)과 Track 통합 여부 | **하나로 통합** — `Groups` 테이블에 `group_type`(`WORK_MODULE`/`COMPANY`)으로 구분. 기존 `CommonCodeGroup`/`CommonCode`(Track)는 `Groups`로 흡수되고, 이슈·주간보고 등에서 참조하던 `trackCodeId`/`areaCodeId`는 `groupId`로 명칭·참조 변경 |

위 결정은 3장 표에 반영 완료. 로드맵(4장)은 다음과 같이 조정된다.
- Phase 1(기존 모듈 이관): 데이터 정합성 검증 단계 불필요(#1). Track→`Groups(WORK_MODULE)` 이관을 이 단계에서 함께 수행(이슈·주간실적·인력변동의 참조 필드명도 함께 변경, #3)
- Phase 6(부가 기능): 첨부파일·엑셀·리마인더에 **쪽지 기능 추가**(#2) — 사용자 검색, 발송, 암호화 저장/조회 비밀번호 검증 API·화면

## 7. 다음 액션 제안
- (승인 시) Phase 0 착수: Supabase 프로비저닝 + 전체 Prisma 스키마(통합 `Groups` 포함) 초안 작성부터 시작
- 5장 체크리스트를 Phase 1의 완료 기준(Definition of Done)으로 그대로 사용 가능
