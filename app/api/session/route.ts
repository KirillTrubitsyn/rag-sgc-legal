/**
 * API для управления сессиями
 * GET - получить информацию о сессии
 * DELETE - очистить или удалить сессию
 */

import { getSessionStore, isValidSessionId, generateSessionId } from '@/lib/session';

export const runtime = 'edge';

// GET /api/session?sessionId=xxx - получить статистику сессии
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    // Создаём новую сессию
    const newSessionId = generateSessionId();
    return new Response(
      JSON.stringify({
        sessionId: newSessionId,
        isNew: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!isValidSessionId(sessionId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid session ID format' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const store = getSessionStore();
  const stats = await store.getSessionStats(sessionId);

  if (!stats) {
    return new Response(
      JSON.stringify({
        sessionId,
        exists: false,
        message: 'Session not found or expired',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      sessionId,
      exists: true,
      ...stats,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// DELETE /api/session?sessionId=xxx&action=clear|delete
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  const action = url.searchParams.get('action') || 'clear';

  if (!sessionId || !isValidSessionId(sessionId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing session ID' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const store = getSessionStore();

  if (action === 'delete') {
    await store.deleteSession(sessionId);
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Session deleted',
        sessionId,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // По умолчанию - очистка (сохраняет сессию, но удаляет документы)
  await store.clearSession(sessionId);
  return new Response(
    JSON.stringify({
      success: true,
      message: 'Session cleared',
      sessionId,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// POST /api/session - создать новую сессию
export async function POST() {
  const sessionId = generateSessionId();
  const store = getSessionStore();

  await store.createSession(sessionId);

  return new Response(
    JSON.stringify({
      sessionId,
      message: 'Session created',
    }),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
