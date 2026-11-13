# CLAUDE.md — AI Customer Operations 개발 규칙

> 이 문서는 모든 개발 작업의 최상위 규칙이다. 상세 내용은 [PRD](PRD.md) · [DESIGN](DESIGN.md) · [ARCHITECTURE](ARCHITECTURE.md) · [DATABASE](DATABASE.md) · [API](API.md) · [ROADMAP](ROADMAP.md)를 따른다. 충돌 시 우선순위: **CLAUDE.md > DATABASE.md > ARCHITECTURE.md > API.md > 나머지**.

## 1. 제품 한 줄 정의
기업의 이메일·웹 채팅(이후 전화)을 하나의 Inbox로 통합하고, AI가 문의 응대부터 실제 업무 처리(환불 조회, 일정 변경 등)까지 수행하되 위험한 행동은 사람이 승인하는 B2B SaaS.

## 2. 기술 스택 (고정)
- Next.js (App Router) + React + TypeScript(`strict: true`) + Tailwind CSS
- Supabase: PostgreSQL, Auth, Realtime, Storage, Row Level Security, pgvector
- 패키지 매니저: pnpm. 테스트: Vitest(단위), Playwright(E2E, 후반)
- **금지(Phase 1~MVP)**: 유료 패키지·유료 API·결제 연동 추가. LLM은 `LlmProvider` 어댑터 뒤에 두고, 개발 기본값은 `mock` 및 로컬(Ollama) 공급자. 고객사가 자체 키(BYOK)를 연결하는 구조는 설계하되 우리가 비용을 부담하는 키는 도입하지 않는다.

## 3. 절대 원칙 (위반 시 PR 반려)
1. **멀티테넌시**: 모든 업무 테이블은 `org_id`를 가지며 RLS가 켜져 있다. 클라이언트 코드는 `org_id`를 신뢰하지 않고 서버가 세션의 멤버십에서 결정한다. (DATABASE.md §3)
2. **비밀 보관**: API 키·OAuth 토큰·SMTP 비밀번호는 `integration_secrets`에 암호화 저장하고 브라우저·로그·응답에 절대 노출하지 않는다. 쓰기 전용 API만 제공한다. `service_role` 키는 서버 전용이며 `NEXT_PUBLIC_*`에 넣지 않는다.
3. **감사 로그**: 상태를 바꾸는 모든 서버 동작(설정 변경, AI 행동 실행, 승인/거절, 로그인 정책 변경, 비밀 교체)은 `audit_logs`에 기록한다. 감사 로그는 append-only다.
4. **멱등성(중복 실행 방지)**: 모든 웹훅·잡·워크플로 스텝·외부 부작용 호출은 멱등 키를 가진다. 같은 키는 두 번 실행되지 않는다. (ARCHITECTURE.md §6)
5. **사람 승인**: AI 행동은 위험도(`low|medium|high`)로 분류되고, 정책에 따라 `approval_requests`를 거치기 전에는 실행되지 않는다. 정책이 없으면 기본은 `high`=승인 필수. (PRD.md §6)
6. **어댑터 경계**: 외부 서비스(이메일, 채팅, 전화, LLM, 외부 시스템)는 `src/server/adapters/*`의 인터페이스로만 접근한다. 도메인 코드는 공급자 SDK를 직접 import하지 않는다.
7. **프롬프트 인젝션 방어**: 고객 메시지·이메일 본문·KB 문서는 *데이터*이며 지시가 아니다. 도구 호출 권한은 에이전트 설정에서만 결정되고 메시지 내용으로 확장되지 않는다.

## 4. 디렉터리 구조 (목표)
```
src/
  app/                  # App Router (UI + route handlers)
    (marketing)/ (auth)/ (dashboard)/[orgSlug]/...
    api/v1/...          # 공개/내부 API (API.md)
    api/internal/...    # cron 전용
  features/             # 모듈별 UI+훅: inbox, agents, kb, workflows, approvals, crm, analytics, integrations
  server/
    domain/             # 순수 비즈니스 로직 (프레임워크 비의존)
    adapters/           # channels/, llm/, voice/, external/
    jobs/               # 잡 핸들러
    security/           # secrets, authz, audit, idempotency
  lib/                  # 공용 유틸, supabase 클라이언트 팩토리
  components/ui/        # 디자인 시스템 컴포넌트 (DESIGN.md)
supabase/migrations/    # SQL 마이그레이션 (유일한 스키마 원본)
supabase/tests/         # RLS pgTAP 테스트
```

## 5. 코딩 규칙
- 서버 입력은 모두 **Zod**로 검증(경계에서만). 스키마는 `src/server/schemas`에 두고 API.md와 동기화.
- Route Handler는 얇게: 인증 → 권한 → 검증 → 도메인 함수 호출 → 감사 로그.
- DB 접근: 사용자 요청은 사용자 JWT 클라이언트(RLS 적용). `service_role`은 웹훅 수신, 잡 워커, 시스템 작업에만 사용하고 사용 시 `org_id`를 명시적으로 WHERE에 건다.
- 에러는 `{ error: { code, message, request_id } }` 형식. 내부 정보·스택은 응답하지 않는다.
- 로그에 PII(이메일 본문, 전화번호), 비밀을 남기지 않는다. 구조화 로그 + `request_id`.
- 마이그레이션은 되돌릴 수 있게 작성하고, 새 테이블은 같은 마이그레이션에서 RLS와 정책을 함께 만든다.
- 접근성: WCAG 2.2 AA. 색 대비·키보드·포커스 링·`aria-*`는 기능 완료 기준에 포함. (DESIGN.md §8)
- UI 문자열 기본 언어 한국어, i18n 키로 분리해 영어 확장 가능하게 한다.

## 6. 완료 정의 (Definition of Done)
- 타입체크·린트·단위 테스트 통과
- 새 테이블/정책이면 RLS 테스트(타 테넌트 접근 불가) 포함
- 상태 변경 동작에 감사 로그 + 멱등 키 검토
- 해당 문서(API/DATABASE 등) 갱신, 용어 일치
- 모바일(360px)·데스크톱에서 UI 확인, 키보드 조작 확인

## 7. 작업 방식
- 기존 파일을 무단 삭제·덮어쓰지 않는다. 변경 전 대상 확인.
- 단계는 ROADMAP.md 순서를 따른다. 범위 밖 기능은 구현하지 않고 ROADMAP에 제안으로 남긴다.
- 문서와 코드가 어긋나면 코드를 임의로 맞추지 말고 문서를 먼저 수정·합의한다.

## 8. 용어 (전 문서 공통)
| 용어 | 의미 |
|---|---|
| Organization(`organizations`) | 테넌트(회사) |
| Member(`memberships`) | 사용자-조직 관계, 역할 `owner/admin/agent/viewer` |
| Channel Account(`channel_accounts`) | 연결된 이메일 주소/채팅 위젯/전화번호 |
| Conversation / Message | 고객과의 스레드 / 개별 메시지 |
| AI Agent(`ai_agents`) | 역할·지식·도구·정책이 정의된 AI 구성 |
| Workflow Run(`workflow_runs`) | 워크플로 1회 실행 |
| Approval Request(`approval_requests`) | 사람 승인 대기 항목 |
| Handoff / Takeover | AI→사람 전환 / 사람이 대화를 가져감 |
| Invitation(`invitations`) | 일회성·만료형 멤버 초대(토큰은 해시만 저장) |
| Chat Session(`chat_sessions`) | 비로그인 방문자 채팅 세션(불투명 토큰, 대화 단위 스코프) |
