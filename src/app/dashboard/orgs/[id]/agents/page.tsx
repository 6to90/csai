import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function AgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="AI 에이전트" desc="역할·지식·도구·정책을 정의한 AI가 답변 초안과 업무 처리를 맡습니다."
    planned={['에이전트 역할·톤 설정', '사용할 도구와 위험도(low/medium/high) 정책', '승인 대기 항목을 거치는 실행', 'LLM 공급자 어댑터(mock·로컬·BYOK)']}
    needs="ai_agents·approval_requests 테이블과 LlmProvider 어댑터가 아직 없습니다. 스키마·API 설계 후 개발합니다. 그 전까지 Inbox에서 사람이 직접 응대합니다."
    link={{ href: `${base}/inbox`, label: 'Inbox로 이동' }} />;
}
