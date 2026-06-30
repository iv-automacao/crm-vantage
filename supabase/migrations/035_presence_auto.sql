-- 035: Presença automática + Pausar leads.
-- is_available passa a significar "recebendo leads" (default true; pausa = false).
-- "Online agora" vira função pura do heartbeat (last_activity_at) na camada de app.
-- Agente novo nasce FORA do pool (in_pool=false; ADM libera). Janela 15min -> 5min.
-- RLS/guards (030/034) inalterados. Aplicada MANUALMENTE no SQL Editor.

-- 1) is_available agora é "recebendo leads", default true -----------------
ALTER TABLE agent_presence ALTER COLUMN is_available SET DEFAULT true;

-- Backfill: todos os agentes existentes passam a "recebendo".
-- ATENÇÃO — o bit is_available MUDOU DE SIGNIFICADO: sob a 030 era o toggle
-- manual "Disponível" (default false); aqui vira "recebendo leads" (default
-- true). Este UPDATE RE-ATIVA o recebimento de quem tinha o toggle desligado de
-- propósito. É esperado pelo novo modelo (online = recebendo), mas avise os
-- vendedores: "Pausar" agora é por SESSÃO, não um "sempre off" persistente.
-- NÃO mexe em in_pool: quem o ADM já configurou no rodízio continua.
UPDATE agent_presence SET is_available = true WHERE is_available = false;

-- 2) Trigger de presença: agente novo nasce FORA do pool, recebendo -------
-- Inverte o auto-join do PR #18 (antes entrava no pool automaticamente).
CREATE OR REPLACE FUNCTION public.autoassign_sync_agent_pool()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.account_role = 'agent' THEN
    -- Cria a linha de presença do agente FORA do rodízio; o ADM libera
    -- ligando "No rodízio". is_available=true (recebendo por padrão).
    INSERT INTO agent_presence (account_id, user_id, in_pool, is_available)
    VALUES (NEW.account_id, NEW.user_id, false, true)
    ON CONFLICT (account_id, user_id) DO NOTHING;  -- nunca sobrescreve config existente
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION public.autoassign_sync_agent_pool() OWNER TO postgres;

-- 3) Janela de presença do rodízio: 15min -> 5min -------------------------
-- ⚠️ SUPERSEDED pela migration 038 (recria a função com a assinatura de 2 args
--    p_conversation_id + cursor condicional). A janela canônica de 5min mora
--    agora na 038. Esta assinatura de 1 arg fica órfã após o release.
-- Espelha PRESENCE_WINDOW_MS em round-robin.ts. Predicado inalterado.
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
    AND ap.last_activity_at > NOW() - INTERVAL '5 minutes';
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
