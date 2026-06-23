// Página do painel interno VANTAGE. Server component protegido por
// requirePlatformAdmin — apenas e-mails na allowlist conseguem acessar.
import { redirect } from 'next/navigation';

import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { AdminPanel } from './admin-panel';

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login');
    if (err instanceof ForbiddenError) redirect('/dashboard');
    throw err;
  }

  return <AdminPanel />;
}
