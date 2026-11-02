// Слой данных. Есть два варианта с одинаковым интерфейсом:
//   remote - Supabase: вход через Google/Apple, общие метки, код выдаёт сервер (reveal_code);
//   local  - всё в localStorage этого телефона (если сервер не настроен или не загрузился).
import { canRevealCode } from './geo.js';

const MARKERS_KEY = 'domofon.markers.v1';
const codeKey = (id) => `domofon.code.${id}`;

const fail = (code) => Object.assign(new Error(code), { code });

export function isConfigured(cfg) {
  return (
    !!cfg &&
    typeof cfg.SUPABASE_URL === 'string' &&
    cfg.SUPABASE_URL.startsWith('https://') &&
    !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    typeof cfg.SUPABASE_ANON_KEY === 'string' &&
    cfg.SUPABASE_ANON_KEY.length > 20 &&
    !cfg.SUPABASE_ANON_KEY.startsWith('PASTE')
  );
}

// ---------- Метки, сохранённые на телефоне (старая версия приложения и локальный режим) ----------
export const legacy = {
  list() {
    try {
      return JSON.parse(localStorage.getItem(MARKERS_KEY) || '[]');
    } catch {
      return [];
    }
  },
  code(id) {
    try {
      return localStorage.getItem(codeKey(id));
    } catch {
      return null;
    }
  },
  save(list) {
    localStorage.setItem(MARKERS_KEY, JSON.stringify(list));
  },
  remove(id) {
    legacy.save(legacy.list().filter((m) => m.id !== id));
    localStorage.removeItem(codeKey(id));
  },
};

export function createLocalStore(reason = 'not_configured') {
  return {
    kind: 'local',
    reason,
    get user() {
      return null;
    },
    onAuthChange() {},
    async init() {
      return null;
    },
    async signIn() {
      throw fail(reason);
    },
    async signOut() {},
    async call() {
      throw fail(reason);
    },
    async markersInBounds() {
      return legacy.list().map((m) => ({
        id: m.id,
        latitude: m.latitude,
        longitude: m.longitude,
        title: m.title || '',
        mine: true,
      }));
    },
    async addMarker({ latitude, longitude, title, code }) {
      const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const marker = { id, latitude, longitude, title: title || '', createdAt: Date.now() };
      try {
        // Сначала код, потом список: маркер без кода не появится.
        localStorage.setItem(codeKey(id), code);
        legacy.save([...legacy.list(), marker]);
      } catch {
        localStorage.removeItem(codeKey(id));
        throw fail('storage');
      }
      return id;
    },
    async revealCode(id, pos) {
      const m = legacy.list().find((x) => x.id === id);
      if (!m) throw fail('not_found');
      if (!canRevealCode(pos, m)) throw fail('too_far');
      return legacy.code(id) ?? '— не найден —';
    },
    async deleteMarker(id) {
      legacy.remove(id);
    },
  };
}

export function createRemoteStore(cfg, lib) {
  const sb = lib.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  let user = null;
  const listeners = new Set();

  const toUser = (session) => {
    const u = session?.user;
    if (!u) return null;
    const meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || '',
      name: meta.full_name || meta.name || u.email || 'Пользователь',
      avatar: meta.avatar_url || meta.picture || '',
    };
  };

  sb.auth.onAuthStateChange((_event, session) => {
    user = toUser(session);
    // Не вызываем методы Supabase прямо внутри обработчика (иначе возможна взаимная блокировка).
    setTimeout(() => listeners.forEach((f) => f(user)), 0);
  });

  return {
    kind: 'remote',
    get user() {
      return user;
    },
    onAuthChange(f) {
      listeners.add(f);
    },
    async init() {
      const { data } = await sb.auth.getSession();
      user = toUser(data?.session);
      return user;
    },
    async signIn(provider) {
      const redirectTo = location.origin + location.pathname.replace(/index\.html$/, '');
      const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo } });
      if (error) throw error;
    },
    async signOut() {
      await sb.auth.signOut();
    },
    // Вызов серверной функции (жалобы, согласия, модерация). Проверку прав всегда делает сервер.
    async call(fn, args = {}) {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw error;
      return data;
    },
    async markersInBounds({ south, north, west, east }) {
      const { data, error } = await sb
        .from('markers')
        .select('id,lat,lon,title,created_by')
        .gte('lat', south)
        .lte('lat', north)
        .gte('lon', west)
        .lte('lon', east)
        .limit(2000);
      if (error) throw error;
      return (data || []).map((r) => ({
        id: r.id,
        latitude: r.lat,
        longitude: r.lon,
        title: r.title || '',
        mine: !!user && r.created_by === user.id,
      }));
    },
    async addMarker({ latitude, longitude, title, code }) {
      const { data, error } = await sb.rpc('add_marker', {
        p_lat: latitude,
        p_lon: longitude,
        p_title: title || '',
        p_code: code,
      });
      if (error) throw error;
      return data;
    },
    async revealCode(id, pos) {
      const { data, error } = await sb.rpc('reveal_code', {
        p_id: id,
        p_lat: pos.latitude,
        p_lon: pos.longitude,
        p_acc: pos.accuracy,
      });
      if (error) throw error;
      return data;
    },
    async deleteMarker(id) {
      const { error } = await sb.from('markers').delete().eq('id', id);
      if (error) throw error;
    },
  };
}

export function createStore(cfg) {
  if (!isConfigured(cfg)) return createLocalStore('not_configured');
  if (!window.supabase?.createClient) return createLocalStore('lib_failed');
  return createRemoteStore(cfg, window.supabase);
}
