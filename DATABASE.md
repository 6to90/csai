# DATABASE — Supabase PostgreSQL 스키마·RLS·멀티테넌시

참조: [CLAUDE.md](CLAUDE.md) §3 · [ARCHITECTURE.md](ARCHITECTURE.md) §6 · [API.md](API.md)
스키마 원본은 `supabase/migrations/*.sql`. 이 문서는 설계 기준이며 충돌 시 이 문서를 먼저 수정한다.

## 1. 공통 규칙
- PK: `id uuid default gen_random_uuid()`. 시각: `created_at/updated_at timestamptz default now()`(`updated_at`은 트리거).
- 모든 업무 테이블에 `org_id uuid not null references organizations(id) on delete cascade` + 인덱스 `(org_id, …)`.
- 열거형은 `text` + `check` 제약(마이그레이션 용이). 소프트 삭제는 필요한 테이블만 `deleted_at`.
- 확장: `pgcrypto`, `vector`(pgvector), `pg_trgm`(검색).
- 외래 키는 가능하면 `(org_id, id)` 복합 참조로 **교차 테넌트 참조를 DB가 차단**: 각 부모 테이블에 `unique (org_id, id)`를 두고 자식이 `foreign key (org_id, parent_id)`로 참조.

## 2. 테이블

### 2.1 테넌트·사용자
| 테이블 | 핵심 컬럼 |
|---|---|
| `organizations` | id, name, slug(unique), kill_switch bool(default false), data_retention_days int(default 365), settings jsonb |
| `profiles` | id(=auth.users.id), display_name, avatar_url |
| `memberships` | id, org_id, user_id, role check in (`owner`,`admin`,`agent`,`viewer`), unique(org_id,user_id) |
| `invitations` | id, org_id, email(소문자 정규화), role check in (`admin`,`agent`,`viewer`) — **`owner`는 초대 불가**, token_hash bytea **unique**(SHA-256, 평문 미저장), status check in (`pending`,`accepted`,`revoked`,`expired`), invited_by, expires_at(기본 now()+7일, 최대 14일), accepted_by?, accepted_at?, revoked_at?, created_at. **부분 유니크** `(org_id, email) where status='pending'`. 토큰은 32바이트 CSPRNG 난수(base64url)이며 생성 응답/메일 링크에서만 1회 노출 |

### 2.2 채널·대화
| 테이블 | 핵심 컬럼 |
|---|---|
| `channel_accounts` | id, org_id, kind check in (`email`,`web_chat`,`voice`), name, address(이메일/번호/도메인), public_key(위젯용, unique), config jsonb(비밀 제외), status(`active`,`paused`,`error`), integration_id? |
| `customers` | id, org_id, display_name, email?, phone?, tags text[], custom_fields jsonb, merged_into? |
| `customer_identities` | id, org_id, customer_id, kind(`email`,`phone`,`chat_visitor`), value, unique(org_id,kind,value) |
| `conversations` | id, org_id, channel_account_id, customer_id, status check in (`open`,`pending_approval`,`waiting_customer`,`resolved`,`closed`), assignee_id?, ai_agent_id?, ai_enabled bool, subject, last_message_at, first_response_at?, resolved_at?, handoff_reason?, external_thread_id?, unique(org_id, channel_account_id, external_thread_id) |
| `messages` | id, org_id, **channel_account_id**, conversation_id, direction(`inbound`,`outbound`,`internal`), sender_type(`customer`,`agent`,`ai`,`system`), sender_id?, content_type(`text`,`html`,`transcript`), body text, ai_agent_id?, sources jsonb(KB 인용), status(`received`,`draft`,`queued`,`sending`,`sent`,`failed`), external_id?(이메일은 정규화 Message-ID), **unique(org_id, channel_account_id, direction, external_id) where external_id not null** — 기존 `(org_id, conversation_id, external_id)`는 대화 생성 전 중복을 막지 못해 교체 |
| `chat_sessions` | id, org_id, channel_account_id, conversation_id, visitor_id(위젯이 발급한 임의 ID, **미검증 식별자**), token_hash bytea **unique**(SHA-256, 평문 미저장), expires_at(절대 24h), last_seen_at(유휴 30분 초과 시 만료), revoked_at?, ip_hash, origin, created_at — 비로그인 방문자용(service_role 전용) |
| `attachments` | id, org_id, message_id, storage_path(비공개 버킷 `org/{org_id}/…`), mime, size, scan_status |

### 2.3 AI·지식
| 테이블 | 핵심 컬럼 |
|---|---|
| `ai_agents` | id, org_id, name, mode check in (`draft`,`assist`,`auto`), active_version_id?, channel_kinds text[], enabled |
| `agent_versions` | id, org_id, agent_id, version int, system_prompt, tone, allowed_tools text[](앱 계층에서 도구 레지스트리와 대조 검증), params jsonb, created_by, unique(agent_id,version), unique(org_id,id) — **불변**. KB 연결은 컬럼이 아니라 `agent_version_kb_sources`로 표현(기존 `kb_source_ids uuid[]` 제거: 배열은 FK 불가·교차 테넌트 참조 가능) |
| `agent_version_kb_sources` | org_id, agent_version_id, kb_source_id, **PK(agent_version_id, kb_source_id)**, **FK (org_id, agent_version_id)→agent_versions(org_id,id)**, **FK (org_id, kb_source_id)→kb_sources(org_id,id) ON DELETE RESTRICT** — 불변 이력이므로 insert 전용(UPDATE/DELETE 방지 트리거), 조직 삭제 시에만 cascade |
| `kb_sources` | id, org_id, kind(`text`,`url`,`file`), title, status(`pending`,`indexed`,`error`), enabled, deleted_at?(**어떤 에이전트 버전이 참조 중인 소스는 하드 삭제 불가(FK RESTRICT) → 소프트 삭제**, 검색에서는 제외), unique(org_id,id) |
| `kb_documents` | id, org_id, source_id, content_hash, text, unique(org_id, source_id, content_hash) |
| `kb_chunks` | id, org_id, document_id, ordinal, content, embedding vector(384), HNSW 인덱스(`vector_cosine_ops`) |

### 2.4 워크플로·승인
| 테이블 | 핵심 컬럼 |
|---|---|
| `workflows` | id, org_id, name, trigger_type, enabled, active_version_id? |
| `workflow_versions` | id, org_id, workflow_id, version, definition jsonb(트리거·조건·스텝), 불변 |
| `workflow_runs` | id, org_id, workflow_id, version_id, trigger_key, status(`queued`,`running`,`waiting_approval`,`succeeded`,`failed`,`cancelled`), conversation_id?, started_at, finished_at, unique(workflow_id, trigger_key) |
| `workflow_run_steps` | id, org_id, run_id, step_key, status, attempt int, input_hash, output jsonb(기본 null — 스텝이 `store_output: true`를 선언하고 도구의 `piiFields`를 제외한 값만 저장, ID·상태 위주), error, unique(run_id, step_key) |
| `approval_policies` | id, org_id, agent_id?(null=조직 전체), tool_name, risk check in (`low`,`medium`,`high`), decision check in (`allow`,`require_approval`,`deny`), approver_roles text[], expires_in_minutes, **check(risk<>'high' or decision<>'allow')** |
| `approval_requests` | id, org_id, conversation_id?, run_id?, requested_by_agent_id, tool_name, **summary text**(PII 최소화된 사람용 요약, 목록·알림·분석에 사용), args jsonb(승인자 확인용 원본, **`args_purged_at` 이후 null**), payload_hash(args 삭제 후에도 보존), args_purged_at?, risk, status(`pending`,`approved`,`rejected`,`expired`,`executed`,`failed`), decided_by?, decided_at?, decision_note?, expires_at, executed_at?, check(status in ('pending','expired') or decided_by is not null) |

### 2.5 통합·보안·운영
| 테이블 | 핵심 컬럼 |
|---|---|
| `integrations` | id, org_id, kind(`email_smtp`,`email_inbound`,`http_connector`,`llm_byok`,`voice`), name, config jsonb(비밀 제외, allowed_hosts 포함), status |
| `org_keys` | org_id(pk), wrapped_key bytea, key_version int — 조직 데이터 키(마스터 키로 래핑), service_role 전용 |
| `integration_secrets` | id, org_id, integration_id, name, ciphertext bytea, key_version int, last4 text, rotated_at, unique(integration_id,name) |
| `webhook_events` | id, **org_id not null**, channel_account_id not null, provider, external_event_id(이메일은 정규화된 Message-ID), payload jsonb(처리 완료 7일 후 null 처리, §8), status(`received`,`processed`,`failed`), received_at, **unique(org_id, channel_account_id, external_event_id)** — **서명 검증을 통과한 이벤트만 저장**한다(검증 실패 요청은 저장하지 않음). 기존 `signature_valid`·전역 unique(provider, external_event_id)는 제거(서로 다른 조직이 같은 Message-ID 메일을 받으면 충돌하므로) |
| `idempotency_keys` | id, org_id, scope, key, request_hash, response jsonb, status, expires_at, unique(org_id,scope,key) |
| `jobs` | id, org_id, type, payload jsonb, dedupe_key text not null, status(`queued`,`running`,`done`,`failed`,`dead`), attempts int default 0, max_attempts int default 5, run_at timestamptz, locked_by text?(워커 ID), locked_until timestamptz?(리스 만료), last_error text?, finished_at?, unique(org_id,type,dedupe_key). 의미: `failed`=백오프 후 재시도 대기(`run_at` 미래), `dead`=재시도 소진 또는 비재시도 오류 |
| `audit_logs` | id bigint identity(단조 증가), org_id, actor_type(`user`,`ai_agent`,`system`), actor_id, action, target_type, target_id, metadata jsonb(**액션별 허용 키·값 형식만**, §5), ip inet, request_id, created_at. **MVP는 해시 체인을 두지 않는다**(§5). 기존 `prev_hash`/`hash` 컬럼은 후속 옵션으로 보류 |
| `usage_events` | id, org_id, kind(`llm_call`,`embedding`,`message`), quantity, meta jsonb, created_at — 비용 가시화용(과금 아님) |
| `rate_limits` | key text, window_start timestamptz, count int, **PK(key, window_start)**, **UNLOGGED**(재시작 시 초기화 허용), service_role 전용 — 고정 윈도 카운터. RPC `rate_limit_hit(key, limit, window_seconds)` = `insert … on conflict (key, window_start) do update set count = rate_limits.count + 1 returning count`(원자적), 반환값 > limit이면 `429`. 키: `user:{id}:{scope}`, `org:{id}:{scope}`, `ip:{daily_salt_hash}:{scope}`, `chat:{session_id}` |

### 2.6 분석 뷰
`v_conversation_metrics`(security_invoker=true, RLS 상속): 대화별 채널, 첫 응답 시간, 해결 시간, AI 단독 해결 여부, handoff_reason. 집계 엔드포인트는 이 뷰만 조회.

### 2.7 참조 무결성 메모 (배열·JSONB 참조)
FK로 보장 불가능한 참조는 **쓰기 시점 서버 검증 + 실행 시점 재검증(`org_id` 일치)** 으로 보완한다: `workflow_versions.definition` 내 에이전트·KB·도구 참조, `ai_agents.channel_kinds`, `agent_versions.allowed_tools`. 새 버전 생성 시 `agent_version_kb_sources`는 같은 트랜잭션에서 insert하며, 버전 변경=새 버전 + 새 연결 행(기존 연결 불변). KB 소스를 삭제하려면 먼저 해당 소스를 쓰는 활성 버전을 교체해야 하고, 이력 버전이 참조 중이면 소프트 삭제만 가능하다.

## 3. RLS 설계
모든 업무 테이블 `alter table … enable row level security; force row level security`.

```sql
create function is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()) $$;

create function has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.role = any(p_roles)) $$;
```
### 정책 매트릭스
| 테이블 그룹 | SELECT | INSERT/UPDATE | DELETE |
|---|---|---|---|
| conversations, messages, customers, attachments | 멤버 | owner/admin/agent | owner/admin |
| ai_agents, agent_versions, kb_*, workflows, workflow_versions, approval_policies | 멤버 | owner/admin | owner/admin |
| approval_requests | 멤버(단 `viewer`는 `args` 제외 뷰 `v_approval_requests`로만 — `summary`·상태 열람) | 결정 컬럼만 `approver_roles`에 속한 멤버(RPC `decide_approval`) | 불가 |
| channel_accounts, integrations | owner/admin | owner/admin | owner/admin |
| **integration_secrets** | **정책 없음(전면 차단)** — service_role만 | service_role | service_role |
| webhook_events, jobs, idempotency_keys, org_keys, chat_sessions, rate_limits | 정책 없음(service_role 전용) | service_role | service_role |
| **invitations** | owner/admin (`token_hash`는 컬럼 권한으로 SELECT 제외) | **직접 INSERT/UPDATE 불가** — RPC `create_invitation`/`revoke_invitation`/`accept_invitation`(security definer)만 | 불가 |
| **audit_logs** | owner/admin | **INSERT 불가(서버 헬퍼가 service_role로)**, UPDATE/DELETE 정책·권한 없음, `revoke update, delete` + 방지 트리거 | 불가 |
| memberships | 본인 행 + owner/admin은 조직 전체 | INSERT는 RPC(`accept_invitation`, 조직 생성)만 / UPDATE(role)는 owner(admin은 agent/viewer만, 마지막 owner 보호) | owner(admin은 agent/viewer만) |
| organizations | 멤버 | owner/admin(`kill_switch`는 owner/admin) | owner |
- `viewer`는 모든 테이블에서 SELECT만.
- **MFA(aal2) 규칙(Phase 2C, 마이그레이션 `…0003_mfa.sql`)**: `owner`/`admin` 역할은 **JWT의 `aal='aal2'` 세션에서만** 행사할 수 있다. ① `has_role()`이 owner/admin 멤버십을 aal2일 때만 인정(감사 로그·초대 목록·전체 멤버 조회 등 RLS 관리자 읽기 차단) ② 관리자 RPC(`create_invitation`, `revoke_invitation`, `resend_invitation`, `set_member_role`, `remove_member`, `update_organization`)는 `assert_aal2_if_privileged(org)`로 `mfa_required`(42501) 거부 ③ `aal` 클레임이 없으면 aal1로 간주(fail closed). `agent`/`viewer`, 로그인, 조직 생성, 초대 수락은 MFA 불필요. 클레임은 PostgREST가 검증한 JWT에서만 오므로 클라이언트가 위조할 수 없다(서명 검증, 테스트로 확인).
- **초대 RPC 규칙**(모두 감사 로그 기록):
  - `create_invitation(email, role)`: 호출자가 `owner`면 `admin/agent/viewer`, `admin`이면 `agent/viewer`만 허용. 이미 멤버이거나 같은 이메일의 `pending` 초대가 있으면 거부(부분 유니크). 토큰 평문은 반환값으로만 1회 전달.
  - `accept_invitation(token)`: 로그인 사용자 필수. 한 트랜잭션에서 `update invitations set status='accepted', accepted_by=auth.uid(), accepted_at=now() where token_hash=sha256($token) and status='pending' and expires_at>now() and lower(email)=lower(<auth.users.email, 이메일 인증 완료된 경우만>) returning *` → 0행이면 실패, 1행이면 `memberships` insert. **원자적 조건부 UPDATE로 일회성 보장**(동시 수락 시 1건만 성공). 이미 멤버면 역할을 올리지 않고 실패 처리.
  - `revoke_invitation(id)`: `pending`만 `revoked`로. 만료는 수락 시 `expires_at`으로도 검사하고, 시스템 유지보수 함수 `expire_invitations`가 `pending`→`expired`로 정리(§6.1).
  - 초대 토큰 비교는 해시 일치(상수시간)로만 수행. 로그·감사 로그에 토큰·해시를 남기지 않는다.
- `approval_requests`는 직접 UPDATE 금지, 보안 정의자 RPC `decide_approval(id, decision, note)`가 ① 요청자≠결정자 ② 역할 ③ 만료 ④ 상태 `pending`을 검증하고 감사 로그를 남긴다.
- Storage: 버킷 `attachments`·`kb-files`는 비공개, 경로 첫 세그먼트 `org_id`와 `is_member` 기준 정책.
- 공개 위젯은 DB·Realtime 직접 접근 없음. Route Handler가 방문자 세션 토큰(`chat_sessions.token_hash` 대조, 만료·폐기 확인) 검증 후 service_role로 해당 대화만 처리(`org_id`, `conversation_id` 강제). 방문자에게 노출되는 메시지는 `direction='outbound'`, `sender_type in ('agent','ai','system')`, `status='sent'`만이며 내부 메모·초안은 절대 포함하지 않는다.

## 4. 멀티테넌시 보장 체크
1. 모든 테이블 RLS 활성(마이그레이션 린트로 검증: `pg_tables` 중 RLS 꺼진 public 테이블 = 실패).
2. 복합 FK로 교차 테넌트 참조 불가.
3. pgTAP 테스트: 사용자 A(org1)가 org2의 모든 테이블 SELECT/INSERT/UPDATE/DELETE 시 0행/거부.
4. `kb_chunks` 벡터 검색 함수 `match_kb_chunks(p_org, embedding, k)`는 `p_org`를 필수 인자로 하며 `security invoker`.

## 5. 감사 로그 무결성 (append-only)
**MVP 방침: append-only 강제 + 원자적 기록. 해시 체인은 보류.**
- **강제**: `revoke update, delete, truncate`, UPDATE/DELETE 방지 트리거, INSERT는 보안 정의자 함수 `append_audit(...)`와 service_role 헬퍼만. 일반 사용자 INSERT 정책 없음.
- **원자성**: 보안상 중요한 변경(비밀 생성·교체, 역할·멤버·초대, 승인 결정·실행, Kill switch, 에이전트 버전 활성화)은 **변경과 같은 DB 트랜잭션**(RPC 내부)에서 `append_audit`을 호출한다. 그 외 변경은 도메인 함수가 기록하고 실패 시 `audit_retry` 잡으로 재시도(유실 시 경고 로그).
- **메타데이터는 허용 목록(allowlist)만 기록**: `append_audit`는 `audit_meta_ok(action, metadata)`를 통과해야 한다. ① **등록된 액션만**(미등록 액션은 거부 — 새 액션은 마이그레이션으로 키를 등록) ② 액션별로 **등록된 키만**(예: `invitation.create`→`role`, `member.role_change`→`from,to`, `org.update`→`fields`, `job.dead`→`type,reason,retryable`) ③ 값은 **짧은 식별자 형식만**(문자열 ≤64자 `[A-Za-z0-9_.,:-]`, 숫자, 불리언) — 중첩 객체·배열·null·공백이 있는 자유 텍스트·이메일은 거부. 이전의 "금지 키 정규식"은 키 이름을 바꾸면 우회되므로 폐기했다. 애플리케이션 계층의 `redact`는 로그용 2차 방어일 뿐 감사 로그의 신뢰 근거가 아니다.
- **설정 변경은 감사 RPC로만**: `organizations`의 직접 UPDATE/DELETE, `integrations`·`channel_accounts`의 직접 INSERT/UPDATE/DELETE 권한을 사용자 역할에서 회수했다(감사 누락 방지). 해당 변경은 `update_organization` 등 RPC(같은 트랜잭션에서 `append_audit`)로만 가능하며 integrations/channel_accounts RPC는 Phase 3에서 추가한다. 조직 삭제는 `audit_logs`가 append-only이고 FK `on delete cascade`와 충돌하므로 Phase 2에서 비활성(정책 미정).
- **체인 보류 이유**: 조직별 직렬화(advisory lock)가 없으면 동시 기록 시 `prev_hash`가 갈라지고, 락을 걸면 모든 상태 변경이 조직 단위로 직렬화된다. 또한 DB·service_role 권한을 가진 공격자는 체인을 재계산할 수 있어 **외부 앵커 없이는 변조 방지 효과가 제한적**이다.
- **후속 옵션**(규제·엔터프라이즈 요구 시): 조직별 일 1회 배치 잡이 그날 로그의 해시 요약(`sha256` 순차 누적)을 계산해 `audit_anchors`에 저장하고 외부 저장소에 내보낸다 — 쓰기 경로에 락이 없다.
- 필수 기록 이벤트: 로그인 외 모든 설정 변경, 멤버·역할 변경, 비밀 생성/교체/삭제(값 제외), 에이전트 버전 활성화, 승인 요청·결정·실행, AI 도구 실행, Kill switch, 데이터 내보내기/삭제, `job.dead`.

## 6. 멱등성·작업 큐 구현 요약
유니크 제약이 1차 방어(ARCHITECTURE §6.3). 아래 SQL은 **설계 예시이며 실행 검증 전**이다(Phase 2에서 로컬 Supabase로 검증).

**원자적 claim** — 조건부 UPDATE + `FOR UPDATE SKIP LOCKED`. 동시 워커는 서로 다른 행을 가져가거나 0행을 받는다. 정상 대기 작업과 **리스가 만료된 `running` 작업**을 함께 수집한다:
```sql
update jobs j set status='running', locked_by=$worker_id,
       locked_until=now()+interval '2 minutes', attempts=j.attempts+1
where j.id in (
  select id from jobs
  where attempts < max_attempts
    and ( (status in ('queued','failed') and run_at <= now())
       or (status = 'running' and locked_until < now()) )   -- 워커 중단 복구
  order by run_at limit $n for update skip locked)
returning *;
```
**Reaper**(claim 직전 실행): 재시도 소진 작업 정리.
```sql
update jobs set status='dead', last_error='lease expired; max_attempts reached', finished_at=now()
where status='running' and locked_until < now() and attempts >= max_attempts;
```
**완료/실패 기록(펜싱)**: `where id=$id and locked_by=$worker_id and status='running'` 조건으로만 갱신한다. 0행이면 리스를 잃은 것이므로 결과를 버리고 부작용을 추가로 만들지 않는다.
- 성공: `status='done', finished_at=now()`
- 재시도 가능 실패: `status='failed', last_error=…, run_at = now() + backoff(attempts)`
- 비재시도 오류(검증 실패, 4xx, 권한 없음): 즉시 `status='dead'`

**재시도·backoff 정책**: 최대 5회(`max_attempts`, 작업 유형별 하향 가능·상향 금지). `backoff(n) = min(30s × 2^(n-1), 30min) × (0.8~1.2 무작위)` → 약 30초, 1분, 2분, 4분, 8분. 소진 시 `dead` + `audit_logs`(`job.dead`) 기록 + 관리자 화면 표시. 리스 2분, 핸들러 제한 시간 90초, 장시간 작업은 30초마다 `locked_until` 연장(같은 펜싱 조건).

**작업별 idempotency key(`dedupe_key`)** — 등록은 `insert … on conflict (org_id,type,dedupe_key) do nothing`:
| type | dedupe_key |
|---|---|
| `process_inbound` | `webhook_events.id` |
| `ai_respond` | 인바운드 `message_id` |
| `send_message` | 아웃바운드 `message_id` |
| `execute_approval` | `approval_requests.id` |
| `workflow_step` | `{run_id}:{step_key}` |
| `index_kb` | `{document_id}:{content_hash}` |
| (없음) 시스템 유지보수 | `jobs` 테이블을 사용하지 않음 — §6.1 |
`done` 작업의 키는 보존 기간(30일) 동안 유지해 재등록을 막는다.

### 6.1 조직별 작업과 시스템 유지보수의 구분
| 구분 | 조직별 작업 | 시스템 유지보수 |
|---|---|---|
| 저장 | `jobs`(`org_id NOT NULL`, service_role 전용) | 테이블 없음 — **org 없는 멱등 SQL 함수** |
| 예 | `process_inbound`, `ai_respond`, `send_message` … | `expire_invitations`, `purge_rate_limits`, `purge_pii` |
| 실행 | `claim_jobs` → 핸들러 → `complete_job/fail_job`(펜싱) | `/api/internal/jobs/run`(CRON_SECRET)이 매 호출마다 직접 실행 |
| 격리 | 핸들러는 `job.org_id`로만 데이터 접근 | 조직 간 데이터를 **반환하지 않고** 만료·삭제만 수행(내용 열람 불가). 사용자·anon 실행 권한 없음(함수 권한 린트 테스트) |
- 이전 문서의 "`expire_invitations` 등을 `dedupe_key=YYYYMMDDHH` 잡으로 등록"은 `jobs.org_id NOT NULL`과 충돌하여 폐기. 유지보수 함수는 재실행해도 안전(멱등)하므로 중복 방지 키가 필요 없다.
- `purge_pii`는 현재 `webhook_events.payload`(처리 7일/기타 30일)·완료 `jobs`(30일)·만료 멱등 키만 처리한다. 조직별 `data_retention_days` 반영(대화·메시지 보존)은 해당 테이블이 생기는 Phase 3에서 추가하며 그전까지 이 값은 저장만 된다.

## 7. 비밀 저장
- `ciphertext` = AES-256-GCM(nonce‖암호문‖tag), 조직 데이터 키는 `SECRETS_MASTER_KEY`로 래핑해 `org_keys`(service_role 전용)에 보관.
- API 응답에는 `last4`만. 값 조회 엔드포인트 없음(쓰기·교체·삭제만).

## 8. 보존·삭제
`data_retention_days` 초과 대화·메시지는 야간 잡으로 익명화/삭제. 고객 삭제 요청은 `customers`·관련 `messages` 익명화 + 감사 로그(대상 ID만) 기록. `audit_logs`는 보존 대상 제외(최소 1년).
**개인정보(PII) 저장 분류와 정리** (K):
| 저장 위치 | 포함 가능한 PII | 정책 |
|---|---|---|
| `webhook_events.payload` | 원본 이메일 전체 | 처리 성공 7일 후 `payload=null`(메시지는 `messages`에 별도 보관), 실패 건은 30일 |
| `approval_requests.args` | 고객 식별자·금액 등 | 최종 상태(`executed/rejected/expired/failed`) 30일 후 `args=null`, `args_purged_at` 기록. 승인 대기 중에는 보관 |
| `workflow_run_steps.output` | 단계 결과 | 기본 저장 안 함, 저장 시 `piiFields` 제외, 90일 후 삭제 |
| `audit_logs.metadata` | 없어야 함 | 값·본문·인자 원문 금지(ID·해시만), 린트·테스트로 검증 |
| `jobs.payload` | ID 참조 위주 | 본문 복사 금지(ID만 담기), `done` 30일 후 삭제 |
- 고객 삭제·익명화 요청 시 해당 고객의 대화(`conversation_id`)에 연결된 `approval_requests.args`, `workflow_run_steps.output`, `webhook_events.payload`도 같은 잡에서 null 처리한다.
- 조직 설정 `data_retention_days`가 위 기본값보다 짧으면 짧은 쪽을 따른다. 정리: `purge_pii`(시스템 유지보수 함수, §6.1).

## 9. 인덱스 메모
`conversations(org_id,status,last_message_at desc)`, `messages(org_id,conversation_id,created_at)`, `customer_identities(org_id,kind,value)`, `jobs(status,run_at)`, `jobs(status,locked_until)`, `invitations(org_id,status)`, `chat_sessions(token_hash)`, `audit_logs(org_id,created_at desc)`, `kb_chunks` HNSW, `customers` trgm(이름/이메일).

## 10. 이메일 Message-ID 정규화·중복 방지
- **정규화**: 앞뒤 공백 제거 → 꺾쇠 `<>` 제거 → 소문자화 → 최대 998자. 헤더가 없거나 비어 있으면 `synthetic:` + sha256(from ‖ date ‖ subject ‖ 본문 해시). 여러 Message-ID 헤더가 있으면 첫 값.
- **중복 범위**: `(org_id, channel_account_id)`. 같은 메일이 다른 조직·다른 연동 계정으로 오는 것은 별개 메시지.
- **2중 방어**: ① `webhook_events` 유니크(재전송 차단) ② `messages` 유니크(웹훅 이벤트가 달라도 같은 메일이 오는 경우, 예: 공급자 재처리·IMAP 후속). 둘 다 `on conflict do nothing`이며 `process_inbound`는 **한 트랜잭션**에서 고객 식별 → 대화 upsert → 메시지 insert를 수행하고, 메시지 insert가 충돌하면 트랜잭션 전체를 롤백해 **고아 대화·중복 티켓이 생기지 않게** 한다.
- **스레딩**: `In-Reply-To`/`References`의 Message-ID를 같은 `(org_id, channel_account_id)`의 `messages.external_id`와 대조 → 일치하면 해당 대화, 없으면 새 대화(`external_thread_id`=`References` 첫 값 또는 자기 Message-ID, 기존 `unique(org_id, channel_account_id, external_thread_id)` 사용).
- **루프 방지**: `Auto-Submitted`≠`no`, `Precedence: bulk/junk/list`, 자기 주소 발신 메일은 대화에 기록하되 AI 자동 응답 대상에서 제외.

## 12. Phase 3B 구현 메모 (`20261112000005_inbox.sql`)
- 구현된 테이블: `customer_identities`, `messages`(+`in_reply_to`, `send_attempt`, `error_code`, `sent_at`), `attachments`(메타데이터 전용, `storage_path` null) — 모두 RLS **enable+force**, 멤버 SELECT만, **직접 쓰기 권한 없음**(RPC·service_role만). `conversations`에 `priority`, `unread_count`, `last_message_preview` 추가. `conversations`·`messages`는 `supabase_realtime` 발행에 포함(RLS 적용).
- RPC(모두 security definer, 기본 거부 후 명시 grant): 사용자 — `create_channel_account`·`set_channel_status`(owner/admin+aal2, 감사), `send_reply`·`retry_message`·`update_conversation`(agent+, 감사 `conversation.update`), `mark_conversation_read`; 서비스 전용 — `receive_webhook`(이벤트 INSERT+잡 enqueue 한 트랜잭션), `process_inbound`(고객 식별→스레딩→대화→메시지, 중복이면 아무것도 만들지 않고 반환; 어드바이저리 락으로 동시 복사본 직렬화), `chat_start`.
- 이메일 채널의 서명 비밀·SMTP URL은 `integrations(kind='email_inbound')`의 `integration_secrets`(`webhook_secret`, `smtp_url`)에 암호화 저장.
- 감사 허용 목록에 `channel.create`(kind), `channel.update`(status), `conversation.update`(fields) 추가.

## 13. Phase 3C-A 구현 메모 (`20261112000006_email_prod.sql`)
- `messages.refs text[]`(정규화된 References+In-Reply-To, GIN 부분 인덱스)·`delivery_ref`(SMTP 응답 참조 ≤64) 추가(널 허용, 기존 행 변경 없음).
- `process_inbound` 교체: 스레딩 3단계(알려진 부모 → 먼저 도착한 자식 → 스레드 키), **모든 단계에서 같은 고객만**, 스레드 키가 다른 고객 대화와 충돌하면 `{message-id}:{customer}` 키로 분리, 이메일 채널은 `email.receive` 감사.
- `record_send_result(org, msg, 'sent'|'failed', code, ref)`(service_role): queued/sending 아웃바운드만 전이, `email.send` 감사(`status`,`code`)를 같은 트랜잭션에. `create_channel_account`는 이메일 `from_name` 저장. 감사 허용 목록에 `email.receive`·`email.send` 추가.

## 14. Phase 3C-B 구현 메모 (`20261112000007_widget.sql`)
- `integrations.kind`에 `web_chat` 추가(ID 검증 비밀 보관), `chat_sessions.verified_email`(HMAC 검증된 이메일 세션). `widget_config_ok()`(origin/제목/인사말/색 검증; 실행 권한 없음, 정의자 함수 내부용).
- RPC: `create_channel_account`(web_chat 설정·integration 생성), `update_widget`(admin+aal2, 감사 `channel.update` `fields=widget`), `prepare_widget_secret`(감사 `channel.secret`), `chat_start(…, p_email)`(검증 이메일이면 이메일 고객으로 연결, 서비스 전용), `end_chat`(agent+, 세션 폐기+대화 `closed`, 감사 `chat.revoke`).
