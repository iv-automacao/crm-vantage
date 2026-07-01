-- ============================================================
-- 039_conversation_unread_increment.sql
--
-- Incremento ATÔMICO de conversations.unread_count no inbound + refresh de
-- last_message_text / last_message_at / updated_at. Chamada via RPC PostgREST
-- pelo webhook (service-role).
--
-- Antes disto, o webhook fazia read-modify-write em memória:
--   UPDATE conversations SET unread_count = <cache + 1> WHERE id = ...
-- então 2 entregas de mensagens DISTINTAS concorrentes liam N e escreviam
-- N+1, perdendo um incremento. (O gate 23505 do #1 só cobre a reentrega do
-- MESMO message_id.) Aqui o "+1" é resolvido pelo Postgres na própria
-- instrução — entregas concorrentes contam ambas.
--
-- Idempotente — seguro re-rodar. Aplicada MANUALMENTE no SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_conversation_unread(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET
    unread_count = unread_count + 1,
    last_message_text = p_last_message_text,
    last_message_at = NOW(),
    updated_at = NOW()
  WHERE id = p_conversation_id;
$$;

-- Só o service role chama (o webhook usa o client service-role). Bloqueia
-- anon / authenticated explicitamente pra um usuário não turbinar contador
-- alheio via RPC.
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_conversation_unread(UUID, TEXT) TO service_role;
