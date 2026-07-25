// Server component: admin-only. Verify session + role, then render management.
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE } from '@/core/auth';
import App from '@/components/App';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sess = verifySession(token);
  if (!sess) redirect('/login');
  if (sess.role !== 'admin') redirect('/');
  return <App mode="admin" me={{ email: sess.email, role: sess.role }} />;
}
