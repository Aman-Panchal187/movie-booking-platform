const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const TOKEN_KEY = 'cinebook.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode): session just won't persist */
    }
  },
};

// ---- server wake-up state (free-tier hosts suspend idle services) ----
type Listener = (waking: boolean) => void;
const listeners = new Set<Listener>();
let slowRequests = 0;
export const serverStatus = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  bump(delta: number) {
    slowRequests = Math.max(0, slowRequests + delta);
    listeners.forEach((l) => l(slowRequests > 0));
  },
};

interface Options {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Only safe/idempotent reads are retried automatically. */
  retry?: boolean;
  formData?: FormData;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([502, 503, 504]);

async function once(path: string, o: Options): Promise<Response> {
  const headers: Record<string, string> = { ...o.headers };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.formData ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
}

export async function request<T>(path: string, o: Options = {}): Promise<{ data: T; meta?: PageMeta; headers: Headers }> {
  const method = o.method ?? 'GET';
  const retries = o.retry ?? method === 'GET' ? 3 : 0;
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    serverStatus.bump(1);
  }, 3000);
  try {
    for (let attempt = 0; ; attempt += 1) {
      let res: Response | undefined;
      try {
        res = await once(path, o);
      } catch (err) {
        if (attempt >= retries) throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.', err);
      }
      if (res && !(RETRYABLE.has(res.status) && attempt < retries)) {
        const json = (await res.json().catch(() => ({}))) as { data?: T; meta?: PageMeta; error?: { code: string; message: string; details?: unknown } };
        if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'ERROR', json.error?.message ?? res.statusText, json.error?.details);
        return { data: json.data as T, meta: json.meta, headers: res.headers };
      }
      await sleep(1500 * 2 ** attempt);
    }
  } finally {
    clearTimeout(timer);
    if (slow) serverStatus.bump(-1);
  }
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const api = {
  get: async <T>(path: string) => (await request<T>(path)).data,
  list: async <T>(path: string) => {
    const r = await request<T[]>(path);
    return { rows: r.data, meta: r.meta ?? { page: 1, pageSize: r.data.length, total: r.data.length, totalPages: 1 } };
  },
  post: async <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body ?? {}, headers }),
  patch: async <T>(path: string, body: unknown) => (await request<T>(path, { method: 'PATCH', body })).data,
  del: async <T>(path: string) => (await request<T>(path, { method: 'DELETE' })).data,
  upload: async <T>(path: string, form: FormData) => (await request<T>(path, { method: 'POST', formData: form })).data,
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
