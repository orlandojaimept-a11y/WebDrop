-- ═══════════════════════════════════════════════════════════════
--  WEBDROP — Supabase Schema
--  Execute no SQL Editor do Supabase Dashboard
-- ═══════════════════════════════════════════════════════════════

-- ── Extensões ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Tabela: users ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  subdomain       TEXT UNIQUE NOT NULL,
  ref_code        TEXT UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 8),
  referred_by     TEXT,                          -- ref_code de quem convidou
  access_until    TIMESTAMPTZ NOT NULL,          -- data fim do acesso ativo
  ref_earned      INTEGER NOT NULL DEFAULT 0,   -- nº de referências convertidas
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabela: sites ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subdomain       TEXT NOT NULL,
  slot            INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  title           TEXT NOT NULL DEFAULT 'Meu Site',
  html_content    TEXT,                          -- conteúdo publicado
  draft_content   TEXT,                          -- rascunho (antes de publicar)
  file_size       BIGINT NOT NULL DEFAULT 0,
  published_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subdomain, slot)
);

-- ── Tabela: payments ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id        TEXT UNIQUE NOT NULL,
  nowpayments_id  TEXT,
  payment_id      TEXT,
  amount_ton      NUMERIC(10,4) NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting','confirming','confirmed','finished','failed','expired','refunded')),
  days_granted    INTEGER NOT NULL DEFAULT 30,
  pay_address     TEXT,
  pay_amount      NUMERIC(20,8),
  pay_currency    TEXT DEFAULT 'ton',
  invoice_url     TEXT,
  ipn_verified    BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabela: sessions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Índices ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_subdomain    ON users(subdomain);
CREATE INDEX IF NOT EXISTS idx_users_ref_code     ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_sites_subdomain    ON sites(subdomain);
CREATE INDEX IF NOT EXISTS idx_sites_user_id      ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id   ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id  ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);
CREATE INDEX IF NOT EXISTS idx_sessions_token     ON sessions(token_hash);

-- ── Função: updated_at automático ────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_users
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_sites
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_payments
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ── Função: award_referrer ────────────────────────────────────
-- Chamada quando um pagamento é confirmado pela primeira vez
CREATE OR REPLACE FUNCTION award_referrer(p_user_id UUID, p_days INTEGER DEFAULT 7)
RETURNS VOID AS $$
DECLARE
  v_ref_code   TEXT;
  v_referrer   users%ROWTYPE;
  v_paid_count INTEGER;
BEGIN
  -- Pega quem convidou este usuário
  SELECT referred_by INTO v_ref_code FROM users WHERE id = p_user_id;
  IF v_ref_code IS NULL THEN RETURN; END IF;

  -- Só bonifica se este for o PRIMEIRO pagamento do usuário indicado
  SELECT COUNT(*) INTO v_paid_count
  FROM payments
  WHERE user_id = p_user_id
    AND status IN ('confirmed','finished');
  IF v_paid_count > 1 THEN RETURN; END IF;

  -- Encontra o referenciador pelo ref_code
  SELECT * INTO v_referrer FROM users WHERE ref_code = v_ref_code;
  IF NOT FOUND THEN RETURN; END IF;

  -- Adiciona dias ao referenciador
  UPDATE users SET
    access_until = GREATEST(access_until, NOW()) + (p_days || ' days')::INTERVAL,
    ref_earned   = ref_earned + 1
  WHERE id = v_referrer.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── RLS (Row Level Security) ──────────────────────────────────
-- Desabilitado: acesso controlado pelo backend via service_role key
ALTER TABLE users    DISABLE ROW LEVEL SECURITY;
ALTER TABLE sites    DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;

-- ── Dados iniciais: 3 slots de site por usuário ───────────────
-- Gerados automaticamente no backend ao criar conta (ver server/index.js)
