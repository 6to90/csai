import { InviteFlow } from './InviteFlow';

// Public page; the token lives only in the URL and is sent to our own API (never to third parties).
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <InviteFlow token={(await searchParams).token ?? ''} />;
}
