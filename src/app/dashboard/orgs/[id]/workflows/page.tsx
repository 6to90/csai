import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function WorkflowsPage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="워크플로 자동화" desc="환불 조회·일정 변경 같은 반복 업무를 단계별로 자동화합니다."
    planned={['트리거 → 단계 → 승인 구성', '멱등 키 기반 단계 실행', '실행 이력(workflow_runs)', '실패 재시도와 알림']}
    needs="workflow_runs 테이블과 단계 실행 엔진이 아직 없습니다. 기존 jobs 큐(멱등 처리)를 기반으로 확장할 예정입니다."
    link={{ href: `${base}/channels`, label: '채널·연동 보기' }} />;
}
