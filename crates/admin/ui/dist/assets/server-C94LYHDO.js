var e=`// GET /notes forwards the caller's bearer token to Postgres RLS.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRestClient } from '@nelcota/client/rest';

export function createExampleServer(apiUrl) {
  if (!apiUrl) throw new Error('Set NELCOTA_URL');
  return createServer(async (request, response) => {
    const json = (status, data) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (request.method !== 'GET' || request.url !== '/notes') return json(404, { code: 'not_found' });
    const match = request.headers.authorization?.match(/^Bearer ([^\\s]+)$/i);
    if (!match) return json(401, { code: 'session_missing' });
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      const client = createRestClient(apiUrl, { accessToken: () => match[1] });
      const { data, error } = await client.from('notes').select('id,body').order('id', { ascending: false })
        .limit(20).abortSignal(controller.signal);
      if (error) return json(error.status || 502, { code: error.code, message: error.message });
      return json(200, data);
    } catch {
      return json(500, { code: 'server_error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createExampleServer(process.env.NELCOTA_URL).listen(Number(process.env.PORT ?? 5179), '127.0.0.1', () => {
    console.log('GET http://127.0.0.1:5179/notes with Authorization: Bearer <user token>');
  });
}
`;export{e as default};