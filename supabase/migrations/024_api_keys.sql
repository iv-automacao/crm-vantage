-- ============================================================
-- 024_api_keys.sql — Per-account API keys (bearer tokens)
--
-- Habilita integrações externas (ex: agente de IA no n8n) a chamar
-- o endpoint /api/external/whatsapp/send autenticando com um bearer
-- token por conta.
--
-- Segurança (espelha account_invitations da migration 017):
--   - Guardamos só `token_hash` (SHA-256 da chave), nunca o valor cru.
--     Um vazamento de snapshot do banco não rende uma chave usável —
--     o atacante precisaria do token original, devolvido uma única
--     vez na criação.
--   - Múltiplas chaves nomeadas por conta, revogáveis individualmente
--     (rotação sem downtime). Revogação = setar `revoked_at`.
--   - `scopes` já existe como array pra evoluir pra escopos granulares
--     depois sem nova migration. Default mínimo: messages:send.
--   - RLS: só admin+ da conta lê/gerencia chaves. O endpoint externo
--     usa service role (bypassa RLS) só pra resolver o token_hash e
--     carimbar last_used_at.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Rótulo amigável escolhido na criação (ex: "n8n produção").
  name TEXT NOT NULL,
  -- SHA-256 hex da chave crua. UNIQUE pra lookup O(1) no login externo.
  token_hash TEXT NOT NULL UNIQUE,
  -- Trecho exibível pra o usuário reconhecer a chave na lista
  -- (ex: "vtg_sk_a1b2…z9"). Nunca permite reconstruir o segredo.
  prefix TEXT NOT NULL,
  -- Capacidades da chave. Preparado pra granularidade futura; v1 só
  -- emite e valida 'messages:send'.
  scopes TEXT[] NOT NULL DEFAULT ARRAY['messages:send'],
  -- Quem criou (auditoria). SET NULL se o usuário sumir.
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Carimbado pelo endpoint externo a cada uso bem-sucedido.
  last_used_at TIMESTAMPTZ,
  -- NULL = ativa. Não-NULL = revogada (mantém a linha pra auditoria).
  revoked_at TIMESTAMPTZ
);

-- Lookup quente: listar chaves ativas de uma conta.
CREATE INDEX IF NOT EXISTS idx_api_keys_account_active
  ON api_keys(account_id)
  WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS — só admin+ da conta enxerga/gerencia chaves.
--
-- A criação real (com hash) e a leitura pública (sem segredo) passam
-- pelas rotas de sessão que já rodam requireRole('admin'); o RLS é a
-- segunda camada. O endpoint externo NÃO usa estas policies — ele
-- resolve o token_hash com a service role, que bypassa RLS.
-- ============================================================
DROP POLICY IF EXISTS api_keys_select ON api_keys;
DROP POLICY IF EXISTS api_keys_modify ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY api_keys_modify ON api_keys FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
