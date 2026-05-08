# WebDrop — Guia de Deploy

Plataforma para empreendedores publicarem sites HTML em segundos.  
**Stack:** Supabase · Render · Cloudflare Worker · NowPayments (TON)

---

## Estrutura do projeto

```
webdrop/
├── supabase/
│   └── schema.sql          ← Execute no Supabase SQL Editor
├── server/
│   ├── index.js            ← Backend Node.js (deploy no Render)
│   └── package.json
├── worker/
│   ├── worker.js           ← Cloudflare Worker (serve os sites)
│   └── wrangler.toml
└── frontend/
    └── index.html          ← Frontend SPA (hospede no Cloudflare Pages ou GitHub Pages)
```

---

## 1. Supabase

1. Acesse [supabase.com](https://supabase.com) → New project
2. Vá em **SQL Editor** → cole e execute o conteúdo de `supabase/schema.sql`
3. Anote as variáveis em **Settings → API**:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (use a chave `service_role`, não a `anon`)

---

## 2. NowPayments

1. Crie conta em [nowpayments.io](https://nowpayments.io)
2. Em **Settings → API keys** → gere uma chave → anote como `NOWPAYMENTS_API_KEY`
3. Em **Settings → IPN** → anote a chave secreta como `NOWPAYMENTS_IPN_SECRET`
4. Configure o **IPN callback URL** para: `https://SEU-BACKEND.onrender.com/api/payments/ipn`

---

## 3. GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/SEU-USUARIO/webdrop.git
git push -u origin main
```

---

## 4. Render (Backend Node.js)

1. Acesse [render.com](https://render.com) → New → **Web Service**
2. Conecte ao seu repositório GitHub
3. Configurações:
   - **Root directory:** `server`
   - **Build command:** `npm install`
   - **Start command:** `node index.js`
   - **Runtime:** Node 18+

4. Em **Environment → Add Environment Variable**, adicione:

| Variável                  | Valor                                      |
|---------------------------|--------------------------------------------|
| `NODE_ENV`                | `production`                               |
| `SUPABASE_URL`            | URL do seu projeto Supabase                |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service_role do Supabase           |
| `JWT_SECRET`              | String aleatória longa (mín. 32 chars)     |
| `NOWPAYMENTS_API_KEY`     | Chave da API NowPayments                   |
| `NOWPAYMENTS_IPN_SECRET`  | Chave IPN NowPayments                      |
| `ADMIN_EMAIL`             | E-mail do administrador da plataforma      |
| `ADMIN_PASSWORD`          | Senha do administrador (forte)             |
| `CLIENT_URL`              | `https://webdrop.app` (ou seu domínio)     |
| `SERVER_URL`              | URL gerada pelo Render (ex: https://webdrop-server.onrender.com) |

5. Clique em **Create Web Service**. O Render fará o deploy automaticamente.

---

## 5. Cloudflare Worker

### Instale o Wrangler:
```bash
npm install -g wrangler
wrangler login
```

### Adicione o secret:
```bash
cd worker
wrangler secret put WORKER_SECRET
# Digite qualquer string secreta (a mesma que opcionalmente validar no server)
```

### Edite o `wrangler.toml`:
- Substitua `webdrop.app` pelo seu domínio real
- Substitua `BACKEND_URL` pela URL do Render

### Deploy:
```bash
wrangler deploy
```

### Configurar rotas no Cloudflare:
1. Vá em Cloudflare Dashboard → seu domínio → **Workers Routes**
2. Adicione a rota: `*.webdrop.app/*` → Worker: `webdrop-worker`

---

## 6. Frontend

### Opção A — Cloudflare Pages (recomendado):
1. Cloudflare Dashboard → Pages → New project
2. Conecte ao GitHub → selecione o repositório
3. **Build settings:**
   - Root directory: `frontend`
   - Build command: *(deixe vazio)*
   - Output directory: `.`
4. Configure o domínio: `webdrop.app` → Pages

### Opção B — GitHub Pages:
1. Vá em Settings → Pages → Source: `main` / `frontend`

### Configure a URL da API no frontend:
Abra `frontend/index.html` e edite a linha:
```js
const API = 'https://webdrop-server.onrender.com'; // ← sua URL do Render
```

---

## 7. DNS (Cloudflare)

| Tipo  | Nome  | Valor                         |
|-------|-------|-------------------------------|
| A     | @     | IP do servidor / Proxied      |
| CNAME | www   | webdrop.app                   |
| CNAME | *     | webdrop.app (wildcard)        |

O wildcard `*` é necessário para que `minhaloja.webdrop.app` funcione via Worker.

---

## Variáveis de ambiente — Resumo

### Render (server/.env em dev)
```env
NODE_ENV=production
PORT=3000
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
JWT_SECRET=uma-string-aleatoria-longa-e-segura
NOWPAYMENTS_API_KEY=xxx
NOWPAYMENTS_IPN_SECRET=xxx
ADMIN_EMAIL=admin@webdrop.app
ADMIN_PASSWORD=SenhaForte123!
CLIENT_URL=https://webdrop.app
SERVER_URL=https://webdrop-server.onrender.com
```

### Cloudflare Worker (wrangler secret)
```
WORKER_SECRET=mesma-string-secreta
BASE_DOMAIN=webdrop.app
BACKEND_URL=https://webdrop-server.onrender.com
```

---

## Fluxo do sistema

```
Usuário → frontend (webdrop.app)
        → API (Render: /api/*)
        → Supabase (dados)
        → NowPayments (cobrança TON)

Visitante → subdominio.webdrop.app
          → Cloudflare Worker
          → API Render (/api/sites/serve/:subdomain/:slot)
          → Supabase (HTML publicado)
          → Response ao visitante
```

---

## Plano e afiliados

- **Trial:** 7 dias grátis no cadastro
- **Plano:** 1 TON/mês via NowPayments
- **Sites:** até 3 por usuário
- **Afiliados:** +7 dias para quem convidou quando o indicado pagar o **1º mês**
- **Indicado:** ganha 7 dias grátis automaticamente

---

## Admin

Acesse `https://webdrop.app/admin` com as credenciais definidas em `ADMIN_EMAIL` e `ADMIN_PASSWORD`.
