-- ============================================================
-- 033 — Template é único por CONTA, não por usuário
--
-- Habilitar templates como admin+ permite vários admins na mesma
-- conta. O índice único legado é (user_id, name, language) (014:190),
-- mas o ENVIO resolve por (account_id, name, language). Dois admins
-- com o mesmo (name, language) criavam linhas distintas e quebravam o
-- disparo (PostgREST "multiple rows"). Aqui a unicidade passa a ser
-- por (account_id, name, language).
-- ============================================================

-- 1. Aborta se já houver duplicata (account_id, name, language) — limpar manual e re-rodar.
DO $$
DECLARE v_dups text;
BEGIN
  SELECT string_agg(format('%s / %s / %s (%s linhas)', account_id, name, COALESCE(language,'(null)'), c), E'\n  ')
  INTO v_dups
  FROM (
    SELECT account_id, name, language, count(*) AS c
    FROM message_templates
    GROUP BY account_id, name, language
    HAVING count(*) > 1
  ) d;
  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION E'Não dá pra criar UNIQUE(account_id, name, language) — duplicatas:\n  %\nDelete as linhas indesejadas e re-rode.', v_dups;
  END IF;
END $$;

-- 2. Troca o índice.
DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_name_language_key
  ON message_templates (account_id, name, language);
