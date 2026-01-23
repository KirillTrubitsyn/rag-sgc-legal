import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.XAI_API_KEY;
  const collectionId = process.env.POA_COLLECTION_ID || process.env.COLLECTION_ID;

  const results: Record<string, unknown> = {
    config: {
      hasApiKey: !!apiKey,
      collectionId: collectionId || 'NOT SET',
    },
  };

  if (!apiKey || !collectionId) {
    return NextResponse.json({ error: 'Missing API key or collection ID', ...results });
  }

  // Test 1: List documents in collection
  try {
    const url = `https://api.x.ai/v1/collections/${collectionId}/documents?limit=3`;
    console.log('Fetching:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    results.listDocuments = {
      status: response.status,
      responseKeys: Object.keys(data),
      data: data,
    };

    // Если есть документы, покажем структуру первого
    const docs = data.data || data.documents || [];
    if (docs.length > 0) {
      const firstDoc = docs[0];
      results.firstDocumentStructure = {
        allKeys: Object.keys(firstDoc),
        file_id: firstDoc.file_id,
        id: firstDoc.id,
        document_id: firstDoc.document_id,
        name: firstDoc.name,
        filename: firstDoc.filename,
        file_name: firstDoc.file_name,
        metadata: firstDoc.metadata,
        fields: firstDoc.fields,
        fullDocument: firstDoc,
      };

      // Test 2: Try to get file info using the ID we found
      const testFileId = firstDoc.file_id || firstDoc.id || firstDoc.document_id;
      if (testFileId) {
        try {
          const fileInfoResponse = await fetch(`https://api.x.ai/v1/files/${testFileId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });
          const fileInfoData = await fileInfoResponse.json();
          results.fileInfo = {
            testedId: testFileId,
            status: fileInfoResponse.status,
            data: fileInfoData,
          };
        } catch (e) {
          results.fileInfo = { testedId: testFileId, error: String(e) };
        }

        // Test 3: Try to download file content
        try {
          const contentResponse = await fetch(`https://api.x.ai/v1/files/${testFileId}/content`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });
          const contentType = contentResponse.headers.get('content-type');
          if (contentResponse.ok) {
            if (contentType?.includes('json')) {
              results.fileContent = { testedId: testFileId, status: contentResponse.status, data: await contentResponse.json() };
            } else {
              const buf = await contentResponse.arrayBuffer();
              results.fileContent = { testedId: testFileId, status: contentResponse.status, size: buf.byteLength, type: contentType };
            }
          } else {
            results.fileContent = { testedId: testFileId, status: contentResponse.status, error: await contentResponse.text() };
          }
        } catch (e) {
          results.fileContent = { testedId: testFileId, error: String(e) };
        }
      }
    }
  } catch (e) {
    results.listDocuments = { error: String(e) };
  }

  // Test 4: Search documents to see what file_id format is returned
  try {
    const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'доверенность',
        source: { collection_ids: [collectionId] },
        retrieval_mode: { type: 'hybrid' },
        max_num_results: 3,
        top_k: 3,
      }),
    });

    const searchData = await searchResponse.json();
    results.searchDocuments = {
      status: searchResponse.status,
      responseKeys: Object.keys(searchData),
    };

    const searchResults = searchData.matches || searchData.results || [];
    if (searchResults.length > 0) {
      const firstResult = searchResults[0];
      results.firstSearchResult = {
        allKeys: Object.keys(firstResult),
        file_id: firstResult.file_id,
        id: firstResult.id,
        document_id: firstResult.document_id,
        metadata: firstResult.metadata,
        fields: firstResult.fields,
        chunk_content_preview: (firstResult.chunk_content || firstResult.content || '').substring(0, 200),
      };
    }
  } catch (e) {
    results.searchDocuments = { error: String(e) };
  }

  return NextResponse.json(results, { status: 200 });
}
