import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function AgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="AI 에이전트" desc="역할·지식·도구·정책을 정의한 AI가 답변 초안과 업무 처리를 맡습니다."
    planned={["에이전트 역할과 말투 설정", "사용할 수 있는 도구와 위험도별 승인 정책", "답변 초안 생성과 사람의 검토", "자체 AI 키(BYOK) 연결"]}
    now="지금은 통합 Inbox에서 상담원이 직접 응대합니다. AI 초안과 승인 요청은 출시 전까지 동작하지 않습니다."
    link={{ href: `${base}/inbox`, label: "Inbox로 이동" }} />;
}
