import { Skeleton } from '@/components/ui/data';

export default function Loading() {
  return (
    <div role="status" aria-label="불러오는 중">
      <Skeleton className="mb-3 h-9 w-48" /><Skeleton className="mb-8 h-5 w-80 max-w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      <Skeleton className="mt-6 h-64" />
    </div>
  );
}
