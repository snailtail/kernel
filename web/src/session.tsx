import { createContext, useContext } from 'react';
import type { Meta, User } from './api';

export interface Session {
  user: User;
  meta: Meta;
  reloadMeta: () => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionContext');
  return session;
}

export const canEdit = (user: User) => user.role !== 'viewer' && user.role !== 'integration';
export const isManager = (user: User) => user.role === 'admin' || user.role === 'problem_manager';
