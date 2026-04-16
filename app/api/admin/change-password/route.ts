import { NextRequest, NextResponse } from 'next/server';
import { changeAdminPassword } from '@/lib/admin/password';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';

/**
 * POST /api/admin/change-password - Change admin password
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'Both current and new password are required' }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }

    const success = await changeAdminPassword(currentPassword, newPassword);
    if (!success) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
    }

    await auditLog('admin.change-password', {}, ip);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin change password error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
