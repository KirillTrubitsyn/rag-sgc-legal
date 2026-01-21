import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.XAI_API_KEY;
  const mgmtKey = process.env.XAI_MANAGEMENT_API_KEY;
  const testFileId = 'file_6bc19288-47d1-4181-8f2e-0e31cc1f1400';

  const results: Record<string, unknown> = {};

  // Test 1: GET /v1/files/{file_id}/content
  try {
    const response = await fetch(`https://api.x.ai/v1/files/${testFileId}/content`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('json')) {
      results.content = { status: response.status, data: await response.json() };
    } else {
      const buf = await response.arrayBuffer();
      results.content = { status: response.status, size: buf.byteLength, type: contentType };
    }
  } catch (e) { results.content = { error: String(e) }; }

  // Test 2: Management API - GET /v1/files/{file_id}
  try {
    const response = await fetch(`https://management-api.x.ai/v1/files/${testFileId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${mgmtKey}` },
    });
    results.mgmtFileInfo = { status: response.status, data: await response.json() };
  } catch (e) { results.mgmtFileInfo = { error: String(e) }; }

  // Test 3: Management API - download
  try {
    const response = await fetch(`https://management-api.x.ai/v1/files/${testFileId}/content`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${mgmtKey}` },
    });
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('json')) {
      results.mgmtContent = { status: response.status, data: await response.json() };
    } else {
      const buf = await response.arrayBuffer();
      results.mgmtContent = { status: response.status, size: buf.byteLength, type: contentType };
    }
  } catch (e) { results.mgmtContent = { error: String(e) }; }

  // Test 4: Try collections document endpoint
  const collectionId = process.env.COLLECTION_ID;
  try {
    const response = await fetch(
      `https://api.x.ai/v1/collections/${collectionId}/documents/${testFileId}`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    results.collectionDoc = { status: response.status, data: await response.json() };
  } catch (e) { results.collectionDoc = { error: String(e) }; }

  // Test 5: POST /v1/files:download с id без prefix
  try {
    const shortId = testFileId.replace('file_', '');
    const response = await fetch('https://api.x.ai/v1/files:download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: shortId }),
    });
    results.downloadShortId = { status: response.status, data: await response.json() };
  } catch (e) { results.downloadShortId = { error: String(e) }; }

  return NextResponse.json(results);
}
