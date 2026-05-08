// ═══════════════════════════════════════════════════════════════
//  WEBDROP — Cloudflare Worker
//  Serve os sites publicados por subdomínio
//
//  Deploy: wrangler deploy
//
//  Variáveis (wrangler.toml → [vars] ou Cloudflare Dashboard → Workers → Settings):
//    BACKEND_URL   = https://webdrop-server.onrender.com
//    WORKER_SECRET = (chave secreta compartilhada com o server)
//
//  Rota configurada no Cloudflare:
//    *.webdrop.app/*  →  este worker
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const hostname = url.hostname;                  // ex: minhaloja.webdrop.app
    const baseDomain = env.BASE_DOMAIN || 'webdrop.app';

    // ── Ignora o domínio raiz e o www ────────────────────────
    if (hostname === baseDomain || hostname === `www.${baseDomain}`) {
      return fetch(request);
    }

    // ── Extrai o subdomínio ───────────────────────────────────
    const subdomain = hostname.replace(`.${baseDomain}`, '');
    if (!subdomain || subdomain.includes('.')) {
      return notFound();
    }

    // ── Determina o slot pelo path ────────────────────────────
    // minhaloja.webdrop.app        → slot 1
    // minhaloja.webdrop.app/2      → slot 2
    // minhaloja.webdrop.app/3      → slot 3
    const pathParts = url.pathname.replace(/^\//, '').split('/');
    let slot = 1;
    const slotCandidate = parseInt(pathParts[0], 10);
    if (!isNaN(slotCandidate) && slotCandidate >= 1 && slotCandidate <= 3) {
      slot = slotCandidate;
    }

    // ── Busca o HTML publicado no backend ─────────────────────
    const backendUrl = `${env.BACKEND_URL}/api/sites/serve/${encodeURIComponent(subdomain)}/${slot}`;

    try {
      const response = await fetch(backendUrl, {
        headers: {
          'X-Worker-Secret': env.WORKER_SECRET || '',
          'User-Agent':      'WebDrop-Worker/1.0',
        },
        cf: {
          // Cache na edge do Cloudflare por 60 segundos
          cacheTtl:            60,
          cacheEverything:     true,
          cacheKey:            `${subdomain}:${slot}`,
        },
      });

      if (!response.ok) {
        return response.status === 404 ? notFound() : serverError();
      }

      const html = await response.text();

      return new Response(html, {
        status:  200,
        headers: {
          'Content-Type':           'text/html; charset=utf-8',
          'Cache-Control':          'public, max-age=60, stale-while-revalidate=300',
          'X-Frame-Options':        'SAMEORIGIN',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy':        'strict-origin-when-cross-origin',
        },
      });
    } catch (e) {
      console.error('Worker fetch error:', e);
      return serverError();
    }
  },
};

// ── Páginas de erro ───────────────────────────────────────────
function notFound() {
  return new Response(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Site não encontrado — WebDrop</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#f9f9f7;color:#111;
         display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
    .wrap{max-width:400px;padding:40px 20px}
    h1{font-size:72px;font-weight:800;color:#0047ff;letter-spacing:-3px;line-height:1}
    p{color:#6b6b6b;margin:16px 0 28px;font-size:16px}
    a{display:inline-block;padding:12px 28px;background:#0047ff;color:#fff;
      border-radius:10px;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>404</h1>
    <p>Este site não existe ou ainda não foi publicado.</p>
    <a href="https://webdrop.app">Criar meu site →</a>
  </div>
</body>
</html>`, {
    status:  404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function serverError() {
  return new Response(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Erro — WebDrop</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#f9f9f7;color:#111;
         display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
    .wrap{max-width:400px;padding:40px 20px}
    h1{font-size:48px;font-weight:800;color:#d32f2f;letter-spacing:-2px}
    p{color:#6b6b6b;margin:16px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Erro</h1>
    <p>Ocorreu um erro temporário. Tente novamente em instantes.</p>
  </div>
</body>
</html>`, {
    status:  503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
