import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function WorkflowsPage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="워크플로 자동화" desc="환불 조회·일정 변경 같은 반복 업무를 단계별로 자동화합니다."
    planned={["트리거 → 단계 → 승인 구성", "중복 실행 방지", "실행 이력 확인", "실패 시 재시도와 알림"]}
    now="아직 자동화를 만들 수 없습니다. 지금은 채널을 연결하고 Inbox에서 응대하는 기능을 사용할 수 있습니다."
    link={{ href: `${base}/channels`, label: "채널·연동 보기" }} />;
}
