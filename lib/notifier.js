/**
 * In-app notifications.
 *
 * Server-side helpers used by API routes and cron jobs to register
 * notifications that show up in the dashboard's bell icon.
 *
 * Types:  'info' | 'success' | 'warning' | 'error'
 */

import pool from '@/lib/db';
import { sendAlert } from '@/lib/alert-webhook';

/**
 * Create a new notification.
 * @param {object} opts
 * @param {string} opts.type      'info' | 'success' | 'warning' | 'error'
 * @param {string} opts.title     short headline
 * @param {string} opts.message   body text
 * @param {number} [opts.billId]  link to a utility bill (optional)
 * @param {object} [opts.metadata] arbitrary structured data (optional)
 */
export async function createNotification({ type, title, message, billId = null, metadata = null }) {
  if (!['info', 'success', 'warning', 'error'].includes(type)) {
    throw new Error(`Invalid notification type: ${type}`);
  }
  if (!title || !message) throw new Error('createNotification requires title and message');

  const r = await pool.query(
    `INSERT INTO notifications (type, title, message, bill_id, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [type, title, message, billId, metadata ? JSON.stringify(metadata) : null]
  );

  // Errors also go to Lluis's WhatsApp via the Jarvis webhook. Fire-and-forget:
  // an unreachable VPS must never break the caller — the row above is already
  // saved and visible in the dashboard bell.
  if (type === 'error') {
    await sendAlert({ title, message });
  }

  return r.rows[0];
}

/**
 * List notifications. Defaults to the most recent 50.
 */
export async function listNotifications({ limit = 50, unreadOnly = false } = {}) {
  const where = unreadOnly ? 'WHERE read_at IS NULL' : '';
  const r = await pool.query(
    `SELECT id, type, title, message, bill_id, metadata, read_at, created_at
     FROM notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

export async function getUnreadCount() {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE read_at IS NULL`);
  return r.rows[0].c;
}

export async function markRead(id) {
  await pool.query(`UPDATE notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`, [id]);
}

export async function markAllRead() {
  const r = await pool.query(`UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL`);
  return r.rowCount;
}
