# AI-MODULES-PLAN — AI 에이전트 · 지식 베이스 · 워크플로 구현 계획 (초안)

> 상태: **제안(미합의)**. CLAUDE.md §7에 따라 구현 전에 이 문서를 검토·합의한다. 스키마·API 원본은 [DATABASE.md](DATABASE.md) §2.3–2.4·§3 및 [API.md](API.md) §4–7이며, 이 문서는 *현재 코드 기준의 현황*과 *구현 순서*만 다룬다. 충돌 시 DATABASE/API 문서가 우선한다.
> 작성일: 2026-11-12. 대시보드의 해당 메뉴(`agents`/`knowledge`/`workflows`)는 현재 "개발 중" 안내 화면이며 기능은 없다.

## 1. 현황 구분

| 영역 | 구현됨 (코드·마이그레이션 존재) | 미구현 |
|---|---|---|
| 대화 기반 | `conversations`(`ai_enabled`, `handoff_reason`, 상태 `pending_approval`), `messages`(`sender_type` `ai`, `status` `draft`), `send_reply` RPC, 내부 메모, Realtime | AI가 메시지를 만드는 경로 |
| 비동기 실행 | `jobs` 큐(원자적 claim·리스·재시도·dead), `worker.ts` 핸들러 레지스트리, `/api/internal/jobs/run` | AI/워크플로 잡 핸들러 |
| 안전장치 | `audit_logs`(append-only, `actor_type='ai_agent'` 허용), 멱등 키, 레이트 리밋, 비밀 저장(`integration_secrets`), `organizations.kill_switch` 컬럼 | `approval_requests`, PolicyGate, kill switch 제어 API/UI |
| 어댑터 | `adapters/mail`(패턴 참고) | `adapters/llm`(`LlmProvider`), 도구 레지스트리 |
| AI·지식 | — (테이블 없음) | `ai_agents`, `agent_versions`, `kb_*`, 임베딩 |
| 워크플로 | — (테이블 없음) | `workflows*`, `workflow_runs*`, 실행 엔진 |

핵심 관찰: **대화·메시지 스키마와 잡 큐, 감사, 멱등성은 이미 AI를 받을 준비가 되어 있다.** 새로 필요한 것은 (a) 에이전트/지식/워크플로 테이블, (b) `LlmProvider` 어댑터, (c) 승인 게이트이다. 기존 테이블 변경은 최소(필요 시 추가 컬럼만)이다.

## 2. 우선순위

가치 대비 위험·의존성 순서. 각 단계는 단독으로 사용 가능해야 하며, 앞 단계가 끝나기 전에 다음으로 넘어가지 않는다.

### P1. AI 에이전트 — **초안(draft) 모드 먼저** (가장 높은 가치, 위험 낮음)
- 이유: 사람이 전송 버튼을 누르므로 승인 게이트·도구 없이도 즉시 쓸모가 있고, 위험한 부작용이 없다.
- 범위
  - `LlmProvider` 인터페이스(`complete({system, messages, params}) → {text, usage}`) + `mock`(결정적 응답) + `ollama` 구현. 도메인 코드는 SDK를 import하지 않는다(CLAUDE §3-6).
  - 마이그레이션: `ai_agents`, `agent_versions`(불변), RLS(멤버 조회·owner/admin 변경, DATABASE §3 매트릭스). 지식 연결 테이블(`agent_version_kb_sources`)은 P2에서 추가.
  - 잡 `ai_draft`(멱등 키 `ai_draft:{conversation_id}:{last_inbound_message_id}`): 새 인바운드 메시지 → (`ai_enabled` && 에이전트 활성 && `kill_switch=false`) → 드래프트 `messages` 생성(`sender_type='ai'`, `status='draft'`). 고객에게 **전송하지 않음**.
  - Inbox: 드래프트를 구분 표시("AI 초안")하고 [편집 후 전송] / [폐기]. 전송은 기존 `send_reply` 경로 재사용.
  - 대시보드 `AI 에이전트`: 에이전트 목록, 버전 편집(시스템 프롬프트·톤), 활성화/롤백, **테스트(드라이런)**.
  - Takeover/Handback API(API.md §3) — `ai_enabled` 토글, 감사 기록.
  - 프롬프트 인젝션 방어: 고객 메시지는 구분된 *데이터* 블록으로만 전달, 도구 권한은 에이전트 버전 설정에서만 결정(CLAUDE §3-7).
- 완료 기준(ROADMAP Phase 4 게이트 일부): Takeover 즉시 AI 중지, `kill_switch` 시 잡이 아무 것도 만들지 않음, 동일 인바운드에 드래프트 1건(동시 실행 테스트), 타 조직 에이전트 접근 불가(RLS 테스트), 인젝션 샘플로 권한 확대 불가.
- 규모: 큼(마이그레이션 1, 어댑터, 잡 1, API 6~8, UI 3화면).

### P2. 지식 베이스 (P1의 답변 품질을 높임)
- 범위: `kb_sources`, `kb_documents`, `kb_chunks`, `agent_version_kb_sources`(불변·교차 테넌트 FK 방지).
- **1차는 `text` 소스만**, 검색은 Postgres 전문 검색/`pg_trgm`으로 시작(추가 의존성 없음). 벡터 검색(`pgvector`, 384차원)은 로컬 임베딩 공급자(Ollama)가 준비된 뒤 `match_kb_chunks(p_org, …)`로 추가(DATABASE §4, `security invoker`).
- `url`/`file` 소스는 Storage·스캔·SSRF 방어가 필요하므로 후순위.
- AI 답변에 **출처(chunk) 표시** 필수. 지식 문서는 데이터이며 지시가 아님.
- 대시보드 `지식 베이스`: 소스 CRUD(텍스트 붙여넣기), 색인 상태, 검색 테스트.
- 주의: 로컬 Postgres 스텁 환경에는 `pgvector`가 없으므로 벡터 부분은 실제 Supabase(Docker)에서만 테스트 가능.

### P3. 승인(Human Control) + 도구 — 쓰기 동작의 전제
- 범위: `approval_requests`, `approval_policies`, RPC `decide_approval`(요청자≠결정자·역할·만료·상태 검증+감사), 도구 레지스트리(도구별 `risk`, `piiFields`), PolicyGate(정책 없으면 `high`=승인 필수, CLAUDE §3-5).
- 첫 도구는 **읽기 전용·`low`**(예: 주문/고객 조회 mock 어댑터)로 시작. `high` 도구(환불 등)는 승인 UI·무결성 테스트(승인 1건=실행 1회, 승인 후 args 변조 거부)가 통과한 뒤에만 연결.
- 대시보드: 승인 대기열(요약·위험도·승인/거절), 개요에 "승인 대기" 카드 연결(현재 "대기 중" 카드는 `pending_approval` 상태를 이미 집계함).
- P1의 `auto`/`assist` 모드는 이 단계 이후에만 허용.

### P4. 워크플로 자동화 (가장 마지막)
- 범위: `workflows`, `workflow_versions`(불변), `workflow_runs`, `workflow_run_steps`. 실행 엔진은 **기존 `jobs` 큐 위에** `workflow_step` 잡(`{run_id}:{step_key}` 멱등 키)으로 구현 — 별도 큐를 만들지 않는다.
- 스텝 1차: `assign`, `label`, `ai_reply`(P1), `request_approval`(P3). `http_call`·`update_customer`는 SSRF/PII 검토 후.
- 게이트: 재시도 시 완료 스텝 재실행 0회(ROADMAP Phase 5).
- 대시보드: 정의 목록, 버전 편집(처음엔 JSON/폼, 시각 편집기는 후순위), 실행 이력.

## 3. 대시보드 연결 지점 (현재 코드 기준)

| 화면 | 지금 | 연결 시점 |
|---|---|---|
| 개요 "대기 중" | `conversations.status` 집계 | P3에서 `approval_requests` 대기 수 추가 |
| Inbox | 메시지 `status`/`sender_type` 표시 로직 존재 | P1에서 `draft`+`ai` 표시·전송/폐기 버튼 |
| 설정 > 보안 "AI 긴급 중지" | `kill_switch` 값 읽기 전용 표시 | P1에서 `POST /org/kill-switch`(owner/admin, 감사) |
| 분석 | 대화 수·해결률·첫 응답 시간 | P1 이후 AI 초안 채택률, P3 이후 승인 처리 시간 |
| 사이드바 "개발 중" 배지 | `layout.tsx`의 `soon: true` | 각 단계 완료(게이트 통과) 시에만 제거 |

## 4. 합의가 필요한 결정

1. **LLM 로컬 공급자**: 개발 기본값을 `mock`로 하되 Ollama를 실제 응답 품질 확인용으로 쓸지(모델·메모리 부담). BYOK는 설계만, 구현은 MVP 이후(CLAUDE §2).
2. **지식 검색 1차 방식**: 전문 검색으로 시작(제안)하고 pgvector는 후속으로 미뤄도 되는지.
3. **에이전트 모드 노출**: P1에서는 `draft`만 제공(제안). `assist`/`auto`는 P3 게이트 통과 후.
4. **드래프트 자동 생성 대상 채널**: 이메일+웹 채팅 모두 vs 웹 채팅 먼저(응답 속도 기대가 다름).
5. **DB 테스트 환경**: pgvector·Realtime 검증은 Docker(`supabase start`)가 필요 — 이 단계 착수 전에 로컬 Docker 사용 가능 여부 확인.

## 5. 하지 않는 것
유료 LLM API 키 도입(우리가 비용 부담), 결제 연동, 전화 어댑터, 시각적 워크플로 에디터, 파일/URL 지식 소스(P2 1차 범위 밖).
