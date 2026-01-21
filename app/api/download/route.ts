import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const fileId = request.nextUrl.searchParams.get('file_id');

  if (!fileId) {
    return NextResponse.json({ error: 'file_id is required' }, { status: 400 });
  }

  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
  }

  try {
    // Попробуем endpoint POST /v1/files:download
    const downloadResponse = await fetch('https://api.x.ai/v1/files:download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_id: fileId }),
    });

    if (!downloadResponse.ok) {
      const errorData = await downloadResponse.json().catch(() => ({}));

      // Если не работает, попробуем GET /v1/files/{file_id}
      const fileInfoResponse = await fetch(`https://api.x.ai/v1/files/${fileId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      const fileInfo = await fileInfoResponse.json();

      return NextResponse.json({
        error: 'Download endpoint failed',
        downloadError: errorData,
        fileInfo: fileInfo,
        suggestion: 'Check fileInfo for download_url or content field'
      }, { status: 422 });
    }

    // Получаем содержимое файла
    const contentType = downloadResponse.headers.get('content-type') || 'application/octet-stream';
    const fileBuffer = await downloadResponse.arrayBuffer();

    // Определяем имя файла
    const contentDisposition = downloadResponse.headers.get('content-disposition');
    let filename = 'document';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^";\n]+)"?/);
      if (match) filename = match[1];
    }

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to download file',
      details: String(error)
    }, { status: 500 });
  }
}
