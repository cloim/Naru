// Keep server responses and engine data on the network. Only document navigation gets a fallback.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate' || request.destination !== 'document')
    return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/')
  )
    return;

  event.respondWith(fetch(request).catch(offlinePage));
});

function offlinePage() {
  const korean = self.navigator.language.toLowerCase().startsWith('ko');
  const title = korean ? 'Naru 서버에 연결할 수 없어요' : 'Naru server is unreachable';
  const message = korean
    ? 'Naru가 실행 중인지 확인하고 연결을 다시 시도해 주세요.'
    : 'Check that Naru is running, then try connecting again.';
  const retry = korean ? '다시 시도' : 'Try again';

  return new Response(
    `<!doctype html>
<html lang="${korean ? 'ko' : 'en'}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#163d35">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #163d35; color: #eef8e4; font: 1rem/1.5 system-ui, sans-serif; }
  main { max-width: 30rem; padding: 1.5rem; }
  h1 { margin: 0; font-size: 1.5rem; }
  p { color: #c7d6ce; }
  a { display: inline-block; padding: .625rem 1rem; border-radius: .375rem; background: #d4efae; color: #163d35; font-weight: 600; }
</style>
<main>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="">${retry}</a>
</main>
</html>`,
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
}
