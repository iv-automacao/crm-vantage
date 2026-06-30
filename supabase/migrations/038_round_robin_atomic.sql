-- 038: Rodízio atômico — cursor condicional + janela canônica.
-- Acrescenta a assinatura de 2 args (p_account_id, p_conversation_id) da
-- pick_next_agent_round_robin. A função agora:
--   (a) recebe p_conversation_id e faz a ATRIBUIÇÃO da conversa por dentro,
--       endereçada por id (1 linha exata; conversations NÃO tem UNIQUE em
--       account_id+contact_id, então atribuir por contato varreria N linhas);
--   (b) só AVANÇA o cursor quando a atribuição COLA (não queima vendedor em corrida);
--   (c) é a FONTE CANÔNICA da janela de presença (INTERVAL '5 minutes').
--
-- COEXISTÊNCIA: NÃO dropamos a versão de 1 arg (pick_next_agent_round_robin(UUID)).
-- As duas assinaturas convivem (PostgREST resolve por nome de argumento), pra
-- não abrir janela onde o código no ar chame uma assinatura inexistente.
-- A de 1 arg fica órfã após esta release — remover numa migration futura.
-- ORDEM: aplicar esta migration ANTES/JUNTO do merge do código TS.
-- RLS/grants inalterados. SECURITY DEFINER (postgres) / EXECUTE só service_role.
-- Aplicada MANUALMENTE no SQL Editor (banco dedicado).

CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(
  p_account_id UUID,
  p_conversation_id UUID
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pool     UUID[];
  v_idx      BIGINT;
  v_agent    UUID;
  v_affected INT;
BEGIN
  -- 1) Pool elegível: no rodízio, recebendo, e online (heartbeat < janela).
  --    Janela CANÔNICA = 5 minutos (espelhada em PRESENCE_WINDOW_MS no TS).
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

  -- 2) Garante a linha de settings SEM girar o cursor.
  INSERT INTO lead_autoassign_settings (account_id, cursor)
  VALUES (p_account_id, 0)
  ON CONFLICT (account_id) DO NOTHING;

  -- 3) Trava a linha do cursor pra serializar chamadas concorrentes da conta.
  SELECT cursor INTO v_idx
  FROM lead_autoassign_settings
  WHERE account_id = p_account_id
  FOR UPDATE;
  IF v_idx IS NULL THEN
    RETURN NULL;  -- defensivo: nunca deve acontecer após o INSERT acima.
  END IF;

  -- 4) Peek do candidato com o cursor ATUAL (ainda não gira). Arrays são 1-based.
  v_agent := v_pool[(v_idx % array_length(v_pool, 1)) + 1];

  -- 5) Atribui só se a conversa (por id) ainda não tem dono. UPDATE de 1 linha
  --    exata -> GET DIAGNOSTICS confiável.
  UPDATE conversations
  SET assigned_agent_id = v_agent, autoassign_waiting = false
  WHERE id = p_conversation_id
    AND account_id = p_account_id
    AND assigned_agent_id IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- 6) Nada colou (a conversa já tinha dono) -> NÃO gira o cursor.
  IF v_affected = 0 THEN
    RETURN NULL;
  END IF;

  -- 7) Atribuição colou -> só agora avança o cursor.
  UPDATE lead_autoassign_settings
  SET cursor = cursor + 1, updated_at = NOW()
  WHERE account_id = p_account_id;

  RETURN v_agent;
END; $$;
ALTER FUNCTION public.pick_next_agent_round_robin(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pick_next_agent_round_robin(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_next_agent_round_robin(UUID, UUID) TO service_role;
