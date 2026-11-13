import { safeNext } from '@/lib/safe-next';
import { LoginForm } from './LoginForm';

// Server component: the form (labels, aria-live) is in the initial HTML, no client-only render bailout.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <LoginForm next={safeNext((await searchParams).next)} />;
}
