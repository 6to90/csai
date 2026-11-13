import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { log } from './log';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public headers: Record<string, string> = {}) {
    super(message ?? code);
  }
}

type DbError = { code?: string; message?: string } | null | undefined;
/** Maps Postgres/PostgREST errors raised by our RPCs to HTTP errors. Never forwards raw DB messages. */
export function fromDbError(e: NonNullable<DbError>): HttpError {
  const msg = e.message ?? '';
  if (msg.includes('invitation_invalid')) return new HttpError(404, 'invitation_invalid', 'invitation is invalid');
  if (msg.includes('mfa_required')) return new HttpError(403, 'mfa_required', 'multi-factor authentication required for this role');
  if (msg.includes('email_mismatch')) return new HttpError(403, 'email_mismatch', 'signed-in email does not match the invitation');
  switch (e.code) {
    case '28000': return new HttpError(401, 'unauthorized');
    case '42501': return new HttpError(403, 'forbidden');
    case 'P0002': return new HttpError(404, 'not_found');
    case '23505': return new HttpError(409, 'conflict');
    case '22023': case '23514': case '22P02': return new HttpError(422, 'validation_failed');
    default: return new HttpError(500, 'internal');
  }
}
export function unwrapDb<T>(r: { data: T | null; error: DbError }): T {
  if (r.error) throw fromDbError(r.error);
  return r.data as T;
}

export type Ctx<P> = { requestId: string; params: P };
export function route<P = Record<string, never>>(fn: (req: Request, ctx: Ctx<P>) => Promise<unknown>) {
  return async (req: Request, extra?: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      Response.json(body, { status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store', ...headers } });
    try {
      const out = await fn(req, { requestId, params: (await extra?.params) as P });
      return out instanceof Response ? out : respond(200, { data: out });
    } catch (err) {
      let e: HttpError;
      if (err instanceof HttpError) e = err;
      else if (err instanceof ZodError) e = new HttpError(422, 'validation_failed', 'invalid request');
      else e = new HttpError(500, 'internal');
      if (e.status >= 500) log('error', 'unhandled', { requestId, err });
      return respond(e.status, { error: { code: e.code, message: e.status >= 500 ? 'internal error' : e.message, request_id: requestId } }, e.headers);
    }
  };
}
