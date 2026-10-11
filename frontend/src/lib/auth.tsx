import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, tokenStore } from './api';

export type Role = 'CUSTOMER' | 'THEATRE_MANAGER' | 'ADMIN';
export type AccountStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  accountStatus: AccountStatus;
  rejectionReason: string | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (kind: 'customer' | 'manager', input: { name: string; email: string; password: string; confirmPassword: string }) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null);
      return;
    }
    try {
      setUser((await api.get<{ user: User }>('/api/auth/me')).user);
    } catch {
      tokenStore.set(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      refresh,
      async login(email, password) {
        const { data } = await api.post<{ user: User; token: string }>('/api/auth/login', { email, password });
        tokenStore.set(data.token);
        setUser(data.user);
        return data.user;
      },
      async register(kind, input) {
        const path = kind === 'manager' ? '/api/auth/register-manager' : '/api/auth/register';
        const { data } = await api.post<{ user: User; token: string }>(path, input);
        tokenStore.set(data.token);
        setUser(data.user);
        return data.user;
      },
      logout() {
        tokenStore.set(null);
        setUser(null);
        qc.clear();
      },
    }),
    [user, loading, refresh, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Where a user lands after signing in. */
export function homeFor(user: User): string {
  if (user.role === 'ADMIN') return '/admin';
  if (user.role === 'THEATRE_MANAGER') return user.accountStatus === 'ACTIVE' ? '/manager' : '/manager/pending';
  return '/';
}
