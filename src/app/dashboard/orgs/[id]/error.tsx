'use client';
import { Button } from '@/components/ui/controls';

// Shown when a page's data load throws. No internal details are rendered (CLAUDE.md §5); `digest` is the server log correlation id.
export default function OrgError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="card mx-auto mt-16 flex max-w-md flex-col items-center gap-3 p-8 text-center">
      <h1 className="text-[22px] font-bold tracking-tight">화면을 불러오지 못했습니다</h1>
      <p className="text-[#615d59]">잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 아래 코드를 알려주세요.</p>
      {error.digest && <code className="text-xs text-[#757575]">{error.digest}</code>}
      <Button onClick={reset}>다시 시도</Button>
    </div>
  );
}
