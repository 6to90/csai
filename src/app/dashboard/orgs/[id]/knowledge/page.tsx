import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="지식 베이스" desc="FAQ와 정책 문서를 등록해 AI와 상담원이 같은 근거로 답하게 합니다."
    planned={["문서 등록·수정·게시", "문서 기반 검색", "답변 근거 표시", "문서별 접근 권한"]}
    now="아직 문서를 등록할 수 없습니다. 지금은 상담원이 Inbox에서 직접 답변을 작성합니다."
    link={{ href: `${base}/inbox`, label: "Inbox로 이동" }} />;
}
