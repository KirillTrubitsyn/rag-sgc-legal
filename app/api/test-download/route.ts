import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.XAI_API_KEY;
  const testFileId = 'file_6bc19288-47d1-4181-8f2e-0e31cc1f1400'; // из результатов поиска

  const results: Record<string, unknown> = {};

  // Test 1: GET /v1/files/{file_id} - информация о файле
  try {
    const response = await fetch(`https://api.x.ai/v1/files/${testFileId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    results.fileInfo = {
      status: response.status,
      data: await response.json(),
    };
  } catch (error) {
    results.fileInfo = { error: String(error) };
  }

  // Test 2: POST /v1/files:download
  try {
    const response = await fetch('https://api.x.ai/v1/files:download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_id: testFileId }),
    });

    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      results.download = {
        status: response.status,
        contentType,
        data: await response.json(),
      };
    } else {
      const buffer = await response.arrayBuffer();
      results.download = {
        status: response.status,
        contentType,
        size: buffer.byteLength,
        message: 'Binary data received - download works!',
      };
    }
  } catch (error) {
    results.download = { error: String(error) };
  }

  // Test 3: Альтернативный формат - file_ids array
  try {
    const response = await fetch('https://api.x.ai/v1/files:download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_ids: [testFileId] }),
    });

    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      results.downloadAlt = {
        status: response.status,
        data: await response.json(),
      };
    } else {
      const buffer = await response.arrayBuffer();
      results.downloadAlt = {
        status: response.status,
        size: buffer.byteLength,
        message: 'Binary data received!',
      };
    }
  } catch (error) {
    results.downloadAlt = { error: String(error) };
  }

  return NextResponse.json(results);
}
