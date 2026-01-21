import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.XAI_API_KEY;
  const collectionId = process.env.COLLECTION_ID;

  const results: Record<string, unknown> = {
    config: {
      hasApiKey: !!apiKey,
      hasCollectionId: !!collectionId,
      collectionId: collectionId || 'NOT SET',
    },
    tests: {},
  };

  // Test 1: Search documents
  try {
    const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'ГОСТ',
        source: {
          collection_ids: [collectionId],
        },
        top_k: 3,
      }),
    });

    const searchData = await searchResponse.json();
    results.tests = {
      ...results.tests as object,
      search: {
        status: searchResponse.status,
        ok: searchResponse.ok,
        data: searchData,
      },
    };
  } catch (error) {
    results.tests = {
      ...results.tests as object,
      search: { error: String(error) },
    };
  }

  // Test 2: List files (if search worked, try to get file info)
  try {
    const filesResponse = await fetch('https://api.x.ai/v1/files', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const filesData = await filesResponse.json();
    results.tests = {
      ...results.tests as object,
      files: {
        status: filesResponse.status,
        ok: filesResponse.ok,
        data: filesData,
      },
    };
  } catch (error) {
    results.tests = {
      ...results.tests as object,
      files: { error: String(error) },
    };
  }

  return NextResponse.json(results, { status: 200 });
}
