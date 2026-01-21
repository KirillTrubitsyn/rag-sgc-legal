import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const fileId = request.nextUrl.searchParams.get('file_id');
  const filename = request.nextUrl.searchParams.get('filename') || 'document';

  if (!fileId) {
    return NextResponse.json({ error: 'file_id is required' }, { status: 400 });
  }

  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
  }

  try {
    // Скачиваем файл через GET /v1/files/{file_id}/content
    const response = await fetch(`https://api.x.ai/v1/files/${fileId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      return NextResponse.json({
        error: 'Failed to download file',
        status: response.status,
        details: errorData
      }, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const fileBuffer = await response.arrayBuffer();

    // Определяем расширение файла
    let ext = '';
    if (contentType.includes('wordprocessingml')) ext = '.docx';
    else if (contentType.includes('pdf')) ext = '.pdf';
    else if (contentType.includes('spreadsheetml')) ext = '.xlsx';

    const finalFilename = filename.includes('.') ? filename : `${filename}${ext}`;

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(finalFilename)}"`,
        'Content-Length': String(fileBuffer.byteLength),
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to download file',
      details: String(error)
    }, { status: 500 });
  }
}
