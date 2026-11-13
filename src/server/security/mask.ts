// Redaction for logs/audit metadata. Defense in depth: callers must still avoid passing secrets.
const SENSITIVE_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|ciphertext|wrapped|private[_-]?key|service[_-]?role)/i;
const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[JWT]'],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[API_KEY]'],
];

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return PATTERNS.reduce((s, [re, to]) => s.replace(re, to), value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[TRUNCATED]';
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
  );
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

export const last4 = (v: string): string => (v.length >= 8 ? v.slice(-4) : '');
