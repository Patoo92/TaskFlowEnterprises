import { createClient } from '@supabase/supabase-js';

// ─── Configuración ─────────────────────────────────────────────────────────────
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const isCloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let _client = null;

export function getSupabaseClient() {
  if (!isCloudConfigured()) throw new Error('SUPABASE_NOT_CONFIGURED');
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _client;
}

// ─── Helpers de Resiliencia ────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ─── CloudService Object ───────────────────────────────────────────────────────
export const CloudService = {
  
  // Sincroniza el Auth (Lo que antes llamamos bridgeManualAuth)
  async syncSupabaseAuth(userCredentials) {
    const client = getSupabaseClient();
    const { email, password } = userCredentials;

    const { data: signInData, error: signInError } = 
      await client.auth.signInWithPassword({ email, password });

    if (!signInError && signInData?.user) return signInData.user.id;

    if (signInError?.message?.includes('Invalid login credentials')) {
      const { data: signUpData, error: signUpError } = 
        await client.auth.signUp({ email, password });
      if (signUpError) throw signUpError;
      return signUpData.user?.id;
    }
    throw signInError;
  },

  // Google Auth Bridge
  async bridgeGoogleAuth(idToken) {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });
    if (error) throw error;
    return data.user?.id;
  },

  // Escritura de Workspaces
  async upsertWorkspace(workspace, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('workspaces').upsert({
        idb_id: workspace.id,
        owner_id: supabaseUid,
        name: workspace.name,
        sheets: workspace.sheets,
      }, { onConflict: 'owner_id,idb_id' }));
    });
  },

  // Lectura de Workspaces
  async fetchRemoteWorkspaces(supabaseUid, since = null) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      let query = client
        .from('workspaces')
        .select('idb_id, name, sheets, updated_at')
        .eq('owner_id', supabaseUid);
      
      if (since) query = query.gt('updated_at', since);
      
      return unwrap(await query.order('updated_at', { ascending: false })) ?? [];
    });
  },

  // Perfil de usuario
  async upsertProfile(profile, supabaseUid) {
    return withRetry(async () => {
      const client = getSupabaseClient();
      return unwrap(await client.from('profiles').upsert({
        id: supabaseUid,
        display_name: profile.displayName,
        photo_url: profile.photoURL,
      }));
    });
  },

  async signOut() {
    const client = getSupabaseClient();
    await client.auth.signOut();
  }
};