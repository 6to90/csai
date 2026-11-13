// Only same-site relative paths are allowed as post-login targets (open-redirect guard).
export const safeNext = (n: string | null | undefined): string => (n && /^\/(?!\/)[\w\-./]*$/.test(n) ? n : '/dashboard');
