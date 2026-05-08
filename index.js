// ═══════════════════════════════════════════════════════════════
//  WEBDROP — Server (Render + Supabase)
//  Node.js / Express — Produção
//
//  Variáveis de ambiente (Render Dashboard → Environment):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//    JWT_SECRET
//    NOWPAYMENTS_API_KEY
//    NOWPAYMENTS_IPN_SECRET
//    ADMIN_EMAIL
//    ADMIN_PASSWORD
//    CLIENT_URL          (ex: https://webdrop.app)
//    PORT                (Render define automaticamente)
// ═══════════════════════════════════════════════════════════════

'use strict';
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const multer       = require('multer');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const fetch        = require('node-fetch');

// ── Config ────────────────────────────────────────────────────
const PORT              = process.env.PORT || 3000;
const JWT_SECRET        = process.env.JWT_SECRET;
const CLIENT_URL        = process.env.CLIENT_URL || 'http://localhost:5173';
const NOWPAYMENTS_KEY   = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN   = process.env.NOWPAYMENTS_IPN_SECRET;
const ADMIN_EMAIL       = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD;
const MAX_SITES         = 3;
const TRIAL_DAYS        = 7;
const REF_DAYS          = 7;
const TON_PRICE_USD     = 1;   // 1 TON cobrado em TON nativo
const MAX_FILE_SIZE     = 10 * 1024 * 1024; // 10MB
const SUBDOMAIN_RE      = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Express setup ─────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: [CLIENT_URL, /\.webdrop\.app$/],
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Cookie'],
}));

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Rate limiting ─────────────────────────────────────────────
const limiterGeneral = rateLimit({ windowMs: 15*60*1000, max: 200 });
const limiterAuth    = rateLimit({ windowMs: 15*60*1000, max: 20,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' }
});
const limiterUpload  = rateLimit({ windowMs: 60*1000, max: 10 });

app.use('/api/auth', limiterAuth);
app.use('/api/sites/upload', limiterUpload);
app.use('/api', limiterGeneral);

// ── Multer (upload em memória) ────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.html?$/i))
      return cb(new Error('Apenas arquivos .html são aceitos.'));
    cb(null, true);
  }
});

// ── Helpers ───────────────────────────────────────────────────
function ok(res, data={}, status=200) {
  return res.status(status).json({ ok: true, ...data });
}
function fail(res, message, status=400) {
  return res.status(status).json({ ok: false, error: message });
}

// ── JWT ───────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.wd_token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : null);
  if (!token) return fail(res, 'Não autenticado.', 401);
  const payload = verifyToken(token);
  if (!payload) return fail(res, 'Sessão expirada.', 401);
  req.user = payload;
  next();
}
function requireAdmin(req, res, next) {
  const token = req.cookies?.wd_admin;
  if (!token) return fail(res, 'Acesso negado.', 403);
  const payload = verifyToken(token);
  if (!payload?.admin) return fail(res, 'Acesso negado.', 403);
  req.admin = payload;
  next();
}

// ── Cookie options ────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   7 * 24 * 60 * 60 * 1000,
  path:     '/',
};

// ── NowPayments helpers ───────────────────────────────────────
async function npCreateInvoice(orderId, description) {
  const res = await fetch('https://api.nowpayments.io/v1/invoice', {
    method:  'POST',
    headers: { 'x-api-key': NOWPAYMENTS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount:      TON_PRICE_USD,
      price_currency:    'ton',
      pay_currency:      'ton',
      order_id:          orderId,
      order_description: description,
      ipn_callback_url:  `${process.env.SERVER_URL || ''}/api/payments/ipn`,
    }),
  });
  return res.json();
}

async function npCheckPayment(paymentId) {
  const res = await fetch(`https://api.nowpayments.io/v1/payment/${paymentId}`, {
    headers: { 'x-api-key': NOWPAYMENTS_KEY },
  });
  return res.json();
}

async function verifyIPN(rawBody, sig) {
  const { createHmac } = require('crypto');
  const data   = JSON.stringify(JSON.parse(rawBody), Object.keys(JSON.parse(rawBody)).sort());
  const digest = createHmac('sha512', NOWPAYMENTS_IPN).update(data).digest('hex');
  return digest === sig;
}

// ── DB helpers ────────────────────────────────────────────────
async function getUser(email) {
  const { data } = await supabase
    .from('users').select('*').eq('email', email).single();
  return data;
}
async function getUserById(id) {
  const { data } = await supabase
    .from('users').select('*').eq('id', id).single();
  return data;
}

// ── Subscription helper ───────────────────────────────────────
function isActive(user) {
  return user?.access_until && new Date(user.access_until) > new Date();
}
function daysLeft(user) {
  if (!user?.access_until) return 0;
  const ms = new Date(user.access_until) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// ═══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, subdomain, ref } = req.body;

  if (!name || !email || !password || !subdomain)
    return fail(res, 'Todos os campos são obrigatórios.');
  if (password.length < 8)
    return fail(res, 'Senha deve ter no mínimo 8 caracteres.');
  if (!SUBDOMAIN_RE.test(subdomain))
    return fail(res, 'Subdomínio inválido. Use letras minúsculas, números e hífens (mín. 3 chars).');

  // Check email + subdomain uniqueness
  const { data: existEmail } = await supabase
    .from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
  if (existEmail) return fail(res, 'E-mail já cadastrado.');

  const { data: existSub } = await supabase
    .from('users').select('id').eq('subdomain', subdomain.toLowerCase()).maybeSingle();
  if (existSub) return fail(res, 'Subdomínio já em uso.');

  // Hash password
  const salt  = await bcrypt.genSalt(12);
  const hash  = await bcrypt.hash(password, salt);
  const refCode = uuidv4().replace(/-/g,'').slice(0,8);

  const accessUntil = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();

  const { data: user, error } = await supabase.from('users').insert({
    name:          name.trim(),
    email:         email.toLowerCase().trim(),
    password_hash: hash,
    password_salt: salt,
    subdomain:     subdomain.toLowerCase(),
    ref_code:      refCode,
    referred_by:   ref || null,
    access_until:  accessUntil,
  }).select().single();

  if (error) return fail(res, 'Erro ao criar conta. Tente novamente.', 500);

  // Create 3 site slots
  const slots = [1,2,3].map(n => ({
    user_id:   user.id,
    subdomain: user.subdomain,
    slot:      n,
    title:     `Site ${n}`,
  }));
  await supabase.from('sites').insert(slots);

  const token = signToken({ id: user.id, email: user.email, subdomain: user.subdomain });
  res.cookie('wd_token', token, COOKIE_OPTS);

  return ok(res, {
    user: { id: user.id, name: user.name, email: user.email,
            subdomain: user.subdomain, access_until: user.access_until,
            ref_code: user.ref_code },
    token,
  }, 201);
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'E-mail e senha são obrigatórios.');

  const user = await getUser(email.toLowerCase().trim());
  if (!user) return fail(res, 'E-mail ou senha incorretos.', 401);

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return fail(res, 'E-mail ou senha incorretos.', 401);

  const token = signToken({ id: user.id, email: user.email, subdomain: user.subdomain });
  res.cookie('wd_token', token, COOKIE_OPTS);

  return ok(res, {
    user: { id: user.id, name: user.name, email: user.email,
            subdomain: user.subdomain, access_until: user.access_until,
            ref_code: user.ref_code, ref_earned: user.ref_earned },
    token,
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('wd_token', { path: '/' });
  return ok(res, { message: 'Sessão encerrada.' });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return fail(res, 'Usuário não encontrado.', 404);

  const { data: sites } = await supabase
    .from('sites').select('*')
    .eq('user_id', user.id)
    .order('slot');

  return ok(res, {
    user: {
      id:           user.id,
      name:         user.name,
      email:        user.email,
      subdomain:    user.subdomain,
      access_until: user.access_until,
      ref_code:     user.ref_code,
      ref_earned:   user.ref_earned,
      referred_by:  user.referred_by,
      created_at:   user.created_at,
      active:       isActive(user),
      days_left:    daysLeft(user),
    },
    sites: (sites || []).map(s => ({
      id:           s.id,
      slot:         s.slot,
      title:        s.title,
      has_draft:    !!s.draft_content,
      is_live:      !!s.html_content,
      file_size:    s.file_size,
      published_at: s.published_at,
      updated_at:   s.updated_at,
    })),
  });
});

// PUT /api/auth/profile
app.put('/api/auth/profile', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return fail(res, 'Nome inválido.');
  await supabase.from('users').update({ name: name.trim() }).eq('id', req.user.id);
  return ok(res, { message: 'Perfil atualizado.' });
});

// PUT /api/auth/password
app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return fail(res, 'Campos obrigatórios.');
  if (new_password.length < 8) return fail(res, 'Nova senha muito curta.');

  const user = await getUserById(req.user.id);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return fail(res, 'Senha atual incorreta.', 401);

  const salt = await bcrypt.genSalt(12);
  const hash = await bcrypt.hash(new_password, salt);
  await supabase.from('users').update({ password_hash: hash, password_salt: salt }).eq('id', user.id);
  return ok(res, { message: 'Senha alterada com sucesso.' });
});

// DELETE /api/auth/account
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  await supabase.from('users').delete().eq('id', req.user.id);
  res.clearCookie('wd_token', { path: '/' });
  return ok(res, { message: 'Conta deletada.' });
});

// ═══════════════════════════════════════════════════════════════
//  SITES ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/sites/upload — upload de HTML para rascunho
app.post('/api/sites/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return fail(res, 'Arquivo não enviado.');
  const slot = parseInt(req.body.slot || '0', 10);
  if (!slot || slot < 1 || slot > MAX_SITES) return fail(res, 'Slot inválido.');

  const user = await getUserById(req.user.id);
  if (!isActive(user)) return fail(res, 'Assinatura expirada. Renove para publicar.', 403);

  const html = req.file.buffer.toString('utf8');
  if (!/<html|<!doctype/i.test(html)) return fail(res, 'Arquivo não parece ser HTML válido.');

  const { error } = await supabase.from('sites')
    .update({ draft_content: html, file_size: req.file.size, updated_at: new Date().toISOString() })
    .eq('user_id', req.user.id)
    .eq('slot', slot);

  if (error) return fail(res, 'Erro ao salvar rascunho.', 500);
  return ok(res, { message: 'Upload concluído. Faça preview antes de publicar.' });
});

// GET /api/sites/:slot/draft — retorna HTML do rascunho (para preview no iframe)
app.get('/api/sites/:slot/draft', requireAuth, async (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  const { data: site } = await supabase.from('sites')
    .select('draft_content').eq('user_id', req.user.id).eq('slot', slot).single();

  if (!site?.draft_content)
    return res.status(404).send('<h1>Nenhum rascunho disponível.</h1>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  return res.send(site.draft_content);
});

// POST /api/sites/:slot/publish — publica o rascunho
app.post('/api/sites/:slot/publish', requireAuth, async (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  const user = await getUserById(req.user.id);
  if (!isActive(user)) return fail(res, 'Assinatura expirada.', 403);

  const { data: site } = await supabase.from('sites')
    .select('draft_content').eq('user_id', req.user.id).eq('slot', slot).single();

  if (!site?.draft_content) return fail(res, 'Nenhum rascunho para publicar.');

  await supabase.from('sites')
    .update({
      html_content: site.draft_content,
      published_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq('user_id', req.user.id)
    .eq('slot', slot);

  return ok(res, { message: `Site ${slot} publicado com sucesso.` });
});

// DELETE /api/sites/:slot — apaga conteúdo do slot
app.delete('/api/sites/:slot', requireAuth, async (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  await supabase.from('sites')
    .update({ html_content: null, draft_content: null, file_size: 0, published_at: null })
    .eq('user_id', req.user.id)
    .eq('slot', slot);
  return ok(res, { message: 'Conteúdo do site apagado.' });
});

// PUT /api/sites/:slot/rename
app.put('/api/sites/:slot/rename', requireAuth, async (req, res) => {
  const slot  = parseInt(req.params.slot, 10);
  const title = (req.body.title || '').trim().slice(0, 50);
  if (!title) return fail(res, 'Título inválido.');
  await supabase.from('sites')
    .update({ title })
    .eq('user_id', req.user.id)
    .eq('slot', slot);
  return ok(res, { message: 'Nome atualizado.' });
});

// GET /api/sites/serve/:subdomain/:slot — serve o HTML publicado (usado pelo Cloudflare Worker)
app.get('/api/sites/serve/:subdomain/:slot', async (req, res) => {
  const { subdomain, slot } = req.params;
  const { data: site } = await supabase.from('sites')
    .select('html_content, published_at')
    .eq('subdomain', subdomain)
    .eq('slot', parseInt(slot, 10))
    .single();

  if (!site?.html_content)
    return res.status(404).send('<html><body><h1>Site não encontrado.</h1></body></html>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.send(site.html_content);
});

// ═══════════════════════════════════════════════════════════════
//  PAYMENTS ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/payments/create — cria invoice NowPayments
app.post('/api/payments/create', requireAuth, async (req, res) => {
  const user    = await getUserById(req.user.id);
  const orderId = `wd_${user.subdomain}_${Date.now()}`;
  const desc    = `WebDrop — ${user.subdomain} — 30 dias`;

  try {
    const inv = await npCreateInvoice(orderId, desc);
    if (!inv || inv.statusCode === 500)
      return fail(res, 'Erro ao criar invoice NowPayments.', 502);

    await supabase.from('payments').insert({
      user_id:        user.id,
      order_id:       orderId,
      nowpayments_id: inv.id,
      payment_id:     inv.payment_id,
      status:         'waiting',
      days_granted:   30,
      pay_address:    inv.pay_address,
      pay_amount:     inv.pay_amount,
      pay_currency:   inv.pay_currency || 'ton',
      invoice_url:    inv.invoice_url,
    });

    return ok(res, {
      payment_id:  inv.payment_id,
      pay_address: inv.pay_address,
      pay_amount:  inv.pay_amount,
      pay_currency: inv.pay_currency,
      invoice_url: inv.invoice_url,
    });
  } catch (e) {
    console.error('NowPayments error:', e);
    return fail(res, 'Erro ao conectar ao processador de pagamentos.', 502);
  }
});

// GET /api/payments/check?payment_id=xxx — polling de status
app.get('/api/payments/check', requireAuth, async (req, res) => {
  const { payment_id } = req.query;
  if (!payment_id) return fail(res, 'payment_id obrigatório.');

  try {
    const status = await npCheckPayment(payment_id);
    const pStatus = status.payment_status;

    if (pStatus === 'finished' || pStatus === 'confirmed') {
      // Atualiza payment no banco
      const { data: payment } = await supabase.from('payments')
        .select('*').eq('payment_id', payment_id).single();

      if (payment && payment.status !== 'finished') {
        await supabase.from('payments')
          .update({ status: pStatus, updated_at: new Date().toISOString() })
          .eq('id', payment.id);

        // Estende acesso do usuário
        const user = await getUserById(req.user.id);
        const base = isActive(user) ? new Date(user.access_until) : new Date();
        base.setDate(base.getDate() + payment.days_granted);
        await supabase.from('users')
          .update({ access_until: base.toISOString() })
          .eq('id', user.id);

        // Bonifica referenciador (apenas no 1º pagamento)
        const { count } = await supabase.from('payments')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('status', ['confirmed','finished']);
        if (count === 1 && user.referred_by) {
          await supabase.rpc('award_referrer', {
            p_user_id: user.id,
            p_days:    REF_DAYS,
          });
        }
      }
    }

    return ok(res, { status: pStatus });
  } catch (e) {
    console.error('Check payment error:', e);
    return fail(res, 'Erro ao verificar pagamento.', 502);
  }
});

// POST /api/payments/ipn — webhook NowPayments (IPN)
app.post('/api/payments/ipn', express.raw({ type: '*/*' }), async (req, res) => {
  const sig     = req.headers['x-nowpayments-sig'] || '';
  const rawBody = req.body.toString();

  const valid = await verifyIPN(rawBody, sig);
  if (!valid) {
    console.warn('IPN: assinatura inválida');
    return res.status(401).send('Invalid signature');
  }

  const data = JSON.parse(rawBody);
  const pStatus = data.payment_status;

  const { data: payment } = await supabase.from('payments')
    .select('*').eq('payment_id', String(data.payment_id)).single();

  if (!payment) return res.status(200).send('OK');

  await supabase.from('payments')
    .update({ status: pStatus, ipn_verified: true, updated_at: new Date().toISOString() })
    .eq('id', payment.id);

  if (pStatus === 'finished' || pStatus === 'confirmed') {
    const user = await getUserById(payment.user_id);
    if (user) {
      const base = isActive(user) ? new Date(user.access_until) : new Date();
      base.setDate(base.getDate() + payment.days_granted);
      await supabase.from('users')
        .update({ access_until: base.toISOString() })
        .eq('id', user.id);

      // Bonifica referenciador
      if (user.referred_by) {
        await supabase.rpc('award_referrer', {
          p_user_id: user.id,
          p_days:    REF_DAYS,
        });
      }
    }
  }

  return res.status(200).send('OK');
});

// GET /api/payments/history
app.get('/api/payments/history', requireAuth, async (req, res) => {
  const { data: payments } = await supabase.from('payments')
    .select('order_id, amount_ton, status, days_granted, pay_currency, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(20);
  return ok(res, { payments: payments || [] });
});

// ═══════════════════════════════════════════════════════════════
//  AFFILIATES ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/affiliates — dados de afiliados do usuário logado
app.get('/api/affiliates', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.id);

  // Usuários convidados por este ref_code
  const { data: referred } = await supabase.from('users')
    .select('id, name, email, created_at')
    .eq('referred_by', user.ref_code);

  // Dos convidados, quais já pagaram
  const referredIds = (referred || []).map(u => u.id);
  let paidIds = [];
  if (referredIds.length > 0) {
    const { data: paidPayments } = await supabase.from('payments')
      .select('user_id')
      .in('user_id', referredIds)
      .in('status', ['confirmed','finished']);
    paidIds = [...new Set((paidPayments || []).map(p => p.user_id))];
  }

  const list = (referred || []).map(u => ({
    name:      u.name,
    email:     u.email,
    joined_at: u.created_at,
    paid:      paidIds.includes(u.id),
  }));

  return ok(res, {
    ref_code:    user.ref_code,
    ref_earned:  user.ref_earned,
    days_earned: user.ref_earned * REF_DAYS,
    total_invited: list.length,
    total_paid:    paidIds.length,
    referrals:     list,
  });
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD)
    return fail(res, 'Credenciais inválidas.', 401);
  const token = signToken({ admin: true, email });
  res.cookie('wd_admin', token, COOKIE_OPTS);
  return ok(res, { token });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('wd_admin', { path: '/' });
  return ok(res, { message: 'Sessão admin encerrada.' });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const { count: totalUsers }  = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: activeUsers } = await supabase.from('users').select('*', { count: 'exact', head: true }).gt('access_until', new Date().toISOString());
  const { count: totalPaid }   = await supabase.from('payments').select('*', { count: 'exact', head: true }).in('status', ['confirmed','finished']);
  const { data: revenueData }  = await supabase.from('payments').select('amount_ton').in('status', ['confirmed','finished']);
  const revenue = (revenueData || []).reduce((s, p) => s + Number(p.amount_ton), 0);

  return ok(res, { totalUsers, activeUsers, totalPaid, revenue: revenue.toFixed(2) });
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = 50;
  const from  = (page - 1) * limit;

  const { data: users, count } = await supabase.from('users')
    .select('id, name, email, subdomain, access_until, ref_code, ref_earned, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);

  return ok(res, { users: users || [], total: count, page, limit });
});

// POST /api/admin/users/:id/add-days
app.post('/api/admin/users/:id/add-days', requireAdmin, async (req, res) => {
  const days = parseInt(req.body.days || '7', 10);
  const user = await getUserById(req.params.id);
  if (!user) return fail(res, 'Usuário não encontrado.', 404);
  const base = isActive(user) ? new Date(user.access_until) : new Date();
  base.setDate(base.getDate() + days);
  await supabase.from('users').update({ access_until: base.toISOString() }).eq('id', user.id);
  return ok(res, { message: `+${days} dias adicionados.`, access_until: base.toISOString() });
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  await supabase.from('users').delete().eq('id', req.params.id);
  return ok(res, { message: 'Usuário deletado.' });
});

// GET /api/admin/payments
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  const { data: payments } = await supabase.from('payments')
    .select('*, users(name, email, subdomain)')
    .order('created_at', { ascending: false })
    .limit(100);
  return ok(res, { payments: payments || [] });
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => fail(res, 'Rota não encontrada.', 404));

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 'Arquivo muito grande. Máx 10MB.');
  return fail(res, err.message || 'Erro interno do servidor.', 500);
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WebDrop Server rodando na porta ${PORT}`);
});
