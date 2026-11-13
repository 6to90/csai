// Launch policy: invite-only. Reopening public sign-up needs BOTH this flag and supabase `enable_signup=true` (GoTrue is the real gate).
export const SIGNUP_OPEN = process.env.NEXT_PUBLIC_SIGNUP_MODE === 'open';
