import { orgCtx } from '@/lib/org-page';
import { ComingSoon } from '@/components/ComingSoon';

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { base } = await orgCtx(params);
  return <ComingSoon title="지식 베이스" desc="FAQ와 정책 문서를 등록해 AI와 상담원이 같은 근거로 답하게 합니다."
    planned={['문서 등록·수정·게시', 'pgvector 기반 검색', '답변 근거 인용', '문서 접근 권한']}
    needs="kb 문서 테이블과 임베딩 파이프라인이 아직 없습니다. 고객 메시지·문서는 데이터로만 취급(프롬프트 인젝션 방어)하도록 설계할 예정입니다."
    link={{ href: `${base}/inbox`, label: 'Inbox로 이동' }} />;
}
