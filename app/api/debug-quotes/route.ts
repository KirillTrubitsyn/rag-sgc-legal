import { NextRequest, NextResponse } from 'next/server';
import { parseAssistantResponse } from '@/lib/response-parser';

export async function POST(request: NextRequest) {
  try {
    const { content } = await request.json();

    if (!content) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const parsed = parseAssistantResponse(content);

    return NextResponse.json({
      quotesCount: parsed.quotes.length,
      quotes: parsed.quotes.map(q => ({
        text: q.text.substring(0, 50) + '...',
        source: q.source,
        downloadUrl: q.downloadUrl || 'NOT FOUND',
        hasUrl: !!q.downloadUrl
      })),
      rawSample: content.substring(0, 500)
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
