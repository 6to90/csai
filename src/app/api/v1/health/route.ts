import { route } from '@/server/http';
export const GET = route(async () => ({ status: 'ok' })); // no auth, no version/config info
