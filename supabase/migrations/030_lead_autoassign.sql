-- 030: Distribuição automática de leads (rodízio + presença).
-- Toggle de conta + pool de presença por agente + cursor de rodízio atômico.
-- RLS espelha 017/028 (is_account_member). Aplicada MANUALMENTE no SQL Editor.

-- 1) Setting de conta ----------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_autoassign_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  cursor BIGINT NOT NULL DEFAULT 0,          -- ponteiro do rodízio; só incrementa, usado mod tamanho do pool
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE lead_autoassign_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS laas_select ON lead_autoassign_settings;
CREATE POLICY laas_select ON lead_autoassign_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS laas_modify ON lead_autoassign_settings;
CREATE POLICY laas_modify ON lead_autoassign_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- 2) Presença por agente -------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_presence (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  in_pool BOOLEAN NOT NULL DEFAULT true,        -- membro do rodízio
  is_available BOOLEAN NOT NULL DEFAULT false,  -- toggle manual "Disponível"
  last_activity_at TIMESTAMPTZ,                 -- heartbeat
  -- gate de turno futuro: um "AND <turno aberto>" entra no predicado da fn abaixo; nada de turno nesta fatia.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, user_id)
);
ALTER TABLE agent_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ap_select ON agent_presence;
CREATE POLICY ap_select ON agent_presence
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ap_self_update ON agent_presence;
CREATE POLICY ap_self_update ON agent_presence
  FOR UPDATE USING (user_id = auth.uid() AND is_account_member(account_id))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
DROP POLICY IF EXISTS ap_admin_all ON agent_presence;
CREATE POLICY ap_admin_all ON agent_presence
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE INDEX IF NOT EXISTS idx_agent_presence_pool
  ON agent_presence(account_id) WHERE in_pool;

-- 3) Trigger de auto-join: todo profile 'agent' novo entra no pool -------
CREATE OR REPLACE FUNCTION public.autoassign_sync_agent_pool()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.account_role = 'agent' THEN
    INSERT INTO agent_presence (account_id, user_id, in_pool, is_available)
    VALUES (NEW.account_id, NEW.user_id, true, false)
    ON CONFLICT (account_id, user_id) DO NOTHING;  -- nunca sobrescreve opt-out
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION public.autoassign_sync_agent_pool() OWNER TO postgres;
DROP TRIGGER IF EXISTS trg_autoassign_sync_pool ON profiles;
CREATE TRIGGER trg_autoassign_sync_pool
  AFTER INSERT OR UPDATE OF account_role, account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.autoassign_sync_agent_pool();

-- 4) Seleção atômica do rodízio -----------------------------------------
-- ⚠️ SUPERSEDED pela migration 038 (assinatura de 2 args com p_conversation_id;
--    janela canônica = 5min; cursor condicional). Esta versão (1 arg, 15min)
--    fica órfã após o release do código novo — ver 038_round_robin_atomic.sql.
-- Devolve o próximo agente disponível, avançando o cursor da conta na MESMA
-- instrução, pra invocações concorrentes de webhook nunca colidirem.
CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(p_account_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pool UUID[];
  v_idx  BIGINT;
BEGIN
  SELECT array_agg(ap.user_id ORDER BY pr.created_at, ap.user_id)
  INTO v_pool
  FROM agent_presence ap
  JOIN profiles pr ON pr.user_id = ap.user_id AND pr.account_id = ap.account_id
  WHERE ap.account_id = p_account_id
    AND ap.in_pool
    AND ap.is_available
    AND ap.last_activity_at > NOW() - INTERVAL '15 minutes';
    -- gate de turno futuro: AND <turno aberto agora>

  IF v_pool IS NULL OR array_length(v_pool, 1) = 0 THEN
    RETURN NULL;  -- ninguém disponível -> caller faz o fallback do ADM
  END IF;

  INSERT INTO lead_autoassign_settings (account_id, cursor)
  VALUES (p_account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET cursor = lead_autoassign_settings.cursor + 1
  RETURNING cursor INTO v_idx;

  RETURN v_pool[(v_idx % array_length(v_pool, 1)) + 1];  -- arrays são 1-based
END; $$;
ALTER FUNCTION public.pick_next_agent_round_robin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pick_next_agent_round_robin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_next_agent_round_robin(UUID) TO service_role;

-- 5) Flag de "aguardando atribuição" (sinal pro ADM) --------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS autoassign_waiting BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_conversations_autoassign_waiting
  ON conversations(account_id, created_at) WHERE autoassign_waiting;

-- 6) Backfill: presença pros 'agent' existentes -------------------------
INSERT INTO agent_presence (account_id, user_id, in_pool, is_available)
SELECT account_id, user_id, true, false FROM profiles WHERE account_role = 'agent'
ON CONFLICT DO NOTHING;
