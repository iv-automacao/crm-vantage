-- 036: Idempotência do inbound + pausa do bot por conversa.
-- Aplicada MANUALMENTE no SQL Editor (banco dedicado). Ver
-- docs/superpowers/specs/2026-06-28-webhook-agente-n8n-design.md
--
-- Contexto: a Meta entrega webhooks at-least-once e re-tenta em timeout/erro.
-- Sem UNIQUE em messages.message_id, a reentrega cria linha duplicada e
-- re-dispara todos os efeitos. Este índice faz o reinsert falhar com 23505,
-- que o handler trata como reentrega (idempotência). message_id pode ser
-- null (nota interna) -> índice PARCIAL.

-- 1) Diagnóstico — rode estes SELECTs em execução SEPARADA, ANTES de aplicar o
--    resto do arquivo (são comentários; o SQL Editor não força a ordem).
--    Esperado: 0 linhas nos dois. Se o 2º vier > 0, decida repontar as reações
--    antes de deletar (senão o CASCADE as remove junto).
-- SELECT message_id, count(*) FROM messages
-- WHERE message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 1;
-- SELECT count(*) FROM message_reactions WHERE message_id IN (
--   SELECT id FROM (
--     SELECT id, row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
--     FROM messages WHERE message_id IS NOT NULL
--   ) r WHERE rn > 1);

-- 2) Dedup defensivo: mantém a linha mais antiga por message_id.
--    FKs pra messages.id: reply_to_message_id (009) e flows.last_prompt_message_id
--    (010) são ON DELETE SET NULL (seguro). message_reactions.message_id (009) é
--    ON DELETE CASCADE NOT NULL — se uma duplicata tiver reações, elas somem
--    junto (silenciosamente). No banco dedicado o esperado é ZERO duplicatas
--    (o diagnóstico do passo 1 confirma antes de rodar).
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
  FROM messages
  WHERE message_id IS NOT NULL
)
DELETE FROM messages WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3) Índice único parcial — a partir daqui, reentrega = 23505 no insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
  ON messages (message_id) WHERE message_id IS NOT NULL;

-- 4) Pausa do bot por conversa (default false = bot ativo, modelo "bot 24/7").
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_paused boolean NOT NULL DEFAULT false;

-- ===== VERIFICAÇÃO (rodar após aplicar; espera-se tudo true) =====
SELECT
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_messages_message_id_unique'
  ) AS idx_unique_existe,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'bot_paused'
  ) AS coluna_bot_paused_existe,
  (SELECT count(*) FROM (
     SELECT message_id FROM messages
     WHERE message_id IS NOT NULL
     GROUP BY message_id HAVING count(*) > 1
   ) d) = 0 AS sem_duplicatas;
