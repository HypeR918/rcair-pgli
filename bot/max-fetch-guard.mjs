const realFetch = globalThis.fetch;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

globalThis.fetch = async function maxFetchGuard(input, init = {}) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input?.url || String(input);

  if (!url.startsWith('https://platform-api2.max.ru')) {
    return realFetch(input, init);
  }

  const method = String(
    init?.method ||
    (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
  ).toUpperCase();

  // GET можно безопасно повторить.
  // POST/PUT/DELETE автоматически НЕ повторяем,
  // чтобы случайно не отправить сообщение дважды.
  const maxAttempts = method === 'GET' ? 4 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await realFetch(input, init);

      const contentType =
        response.headers.get('content-type') || '';

      if (contentType.toLowerCase().includes('application/json')) {
        return response;
      }

      const body = await response.text();

      console.error(
        `[MAX-UPSTREAM] NON-JSON ` +
        `method=${method} ` +
        `attempt=${attempt}/${maxAttempts} ` +
        `status=${response.status} ` +
        `content-type=${contentType || '-'} ` +
        `server=${response.headers.get('server') || '-'} ` +
        `url=${url}`
      );

      console.error(
        '[MAX-UPSTREAM] BODY:',
        body.slice(0, 1500).replace(/\s+/g, ' ')
      );

      if (method === 'GET' && attempt < maxAttempts) {
        await sleep(attempt * 1000);
        continue;
      }

      // SDK безусловно вызывает res.json().
      // Поэтому отдаём ему JSON вместо HTML.
      return new Response(
        JSON.stringify({
          code: 'max.upstream_non_json',
          message: 'MAX API returned non-JSON response',
          upstream_status: response.status,
          upstream_content_type: contentType,
          upstream_body: body.slice(0, 500)
        }),
        {
          status:
            response.status >= 400
              ? response.status
              : 502,
          headers: {
            'content-type': 'application/json; charset=utf-8'
          }
        }
      );
    } catch (error) {
      console.error(
        `[MAX-UPSTREAM] FETCH ERROR method=${method} attempt=${attempt}/${maxAttempts} url=${url}:`,
        error?.message || error
      );

      if (method === 'GET' && attempt < maxAttempts) {
        await sleep(attempt * 1000);
        continue;
      }

      throw error;
    }
  }
};
