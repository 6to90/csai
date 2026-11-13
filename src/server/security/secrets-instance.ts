import 'server-only';
import { createSecrets, masterKeysFromEnv } from './secrets';
import { supabaseSecretsStore } from './secrets-store-supabase';
import { systemClient } from './system-client';

/** Write-only secrets API (CLAUDE.md §3.2). `get` is for server-internal use right before the call that needs the value. */
export const secrets = () => createSecrets(supabaseSecretsStore(systemClient()), masterKeysFromEnv());
