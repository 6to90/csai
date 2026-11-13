'use client';
import { useRouter } from 'next/navigation';
import { createBrowser } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/controls';

export function SignOut() {
  const router = useRouter();
  return (
    <Button variant="secondary" className="min-h-9 px-3" onClick={async () => { await createBrowser().auth.signOut(); router.replace('/login'); router.refresh(); }}>
      로그아웃
    </Button>
  );
}
