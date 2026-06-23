-- ============================================================
-- 025_account_approval.sql — Gate de aprovação de contas
--
-- Toda conta nova nasce 'pending' e não acessa nada do CRM até um
-- admin de plataforma aprovar. O bloqueio vive na RLS: redefinimos
-- is_account_member() pra exigir accounts.status='active', o que
-- fecha TODAS as tabelas de dados de uma vez (elas já usam o helper).
--
-- Exceção cirúrgica: a leitura da PRÓPRIA accounts continua liberada
-- (helper status-agnóstico) — senão a conta pending nem conseguiria
-- ler o próprio status pra renderizar a tela "/pending".
--
-- Idempotente — seguro rodar múltiplas vezes.
-- Banco alvo: Supabase dedicado do CRM (mgmokvpjswtjxhqhnyps).
-- ============================================================

-- 1) Enum de status da conta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('pending', 'active', 'suspended', 'rejected');
  END IF;
END$$;

-- 2) Colunas novas em accounts.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS account_type TEXT
    CHECK (account_type IS NULL OR account_type IN ('ia_client', 'self_serve', 'internal')),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- 3) GRANDFATHER — tudo que já existe vira 'active'/'internal' ANTES
--    de qualquer enforcement, senão o Iago e as contas atuais ficam
--    trancados pra fora. Só toca quem ainda está no default.
UPDATE accounts
   SET status = 'active',
       account_type = COALESCE(account_type, 'internal'),
       approved_at = COALESCE(approved_at, NOW())
 WHERE status = 'pending';

-- 4) Índice quente: listar pendentes no painel /admin.
CREATE INDEX IF NOT EXISTS idx_accounts_status_pending
  ON accounts(status)
  WHERE status = 'pending';

-- 5) Helper status-agnóstico — membership SEM checar status.
--    Usado só onde a leitura precisa funcionar enquanto pending
--    (a própria accounts). SECURITY DEFINER pra evitar RLS recursiva.
CREATE OR REPLACE FUNCTION is_account_member_any_status(
  target_account_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
  );
$$;
ALTER FUNCTION is_account_member_any_status(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_any_status(UUID) TO authenticated, service_role;

-- 6) Redefine is_account_member pra exigir status='active'.
--    Como TODAS as policies de dados já chamam este helper, o gate
--    entra em vigor em todas elas de uma vez. SECURITY DEFINER lê
--    accounts/profiles sem RLS (sem recursão).
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND a.status = 'active'
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;
ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- 7) accounts_select volta a ser status-agnóstica — o membro lê a
--    própria conta mesmo pending (pra renderizar o muro). As demais
--    policies de accounts (update) seguem gated por is_account_member
--    (active), porque conta pending não deve editar nada.
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member_any_status(id));
