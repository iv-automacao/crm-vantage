-- ============================================================
-- 034 — Fecha dois caminhos de escrita que escaparam dos guards
--        anteriores (achados no review final da Fase 1a):
--
-- (RBAC-1) O trigger da 031 só cobre UPDATE de profiles. O INSERT
-- ficou aberto: a policy profiles_insert (017:567) só checa
-- auth.uid() = user_id, sem restrição de coluna. Um usuário SEM
-- profile (estado só alcançável se handle_new_user falhar silencioso)
-- poderia rodar via PostgREST:
--   insert into profiles (user_id, account_id, account_role)
--   values (auth.uid(), <conta_alheia>, 'owner')
-- promovendo-se a owner de uma conta existente, driblando
-- set_member_role/transfer_account_ownership. Como NENHUM código de
-- cliente insere profile (só handle_new_user, SECURITY DEFINER/postgres),
-- bloqueamos TODO INSERT de profile vindo de papel de client.
--
-- (RBAC-CONF-01) A policy ap_self_update (030:38) deixa o membro
-- escrever in_pool da própria linha direto do browser, contornando a
-- rota presence (que passou a ignorar in_pool na Fase 1a). in_pool é
-- admin-only (gerido em lead-autoassign). Guard column-scoped: só
-- admin (ou caminho de servidor) muda in_pool.
--
-- (RBAC-CONF-02) Alinha o predicado de ap_self_update ao guard da
-- rota presence (agent+), fechando a divergência is_available
-- (rota=agent, RLS=viewer).
-- ============================================================

-- ------------------------------------------------------------
-- (RBAC-1) Estende o guard de profiles pra INSERT também.
-- handle_new_user roda como postgres → passa; client é barrado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER          -- precisa enxergar o current_user REAL de quem escreve
SET search_path = public
AS $$
BEGIN
  -- No Supabase, escrita vinda do PostgREST roda sob 'authenticated'/'anon'
  -- (após SET ROLE). Caminhos de servidor (RPCs SECURITY DEFINER owned by
  -- postgres, e service_role) têm current_user fora dessa lista e passam.
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- Nenhum código de cliente insere profile; só handle_new_user (postgres).
      RAISE EXCEPTION
        'profiles só podem ser criados pelo servidor (signup); INSERT direto do cliente não é permitido'
        USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE'
          AND (NEW.account_role IS DISTINCT FROM OLD.account_role
               OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
      RAISE EXCEPTION
        'account_role/account_id só podem ser alterados por um RPC autorizado do servidor, não por update direto do cliente'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_profile_role_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_guard_profile_role_change ON public.profiles;
CREATE TRIGGER trg_guard_profile_role_change
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_role_change();

-- ------------------------------------------------------------
-- (RBAC-CONF-01) Guard de coluna em agent_presence: in_pool é
-- admin-only. Membro (não-admin) via client não muda in_pool; o
-- caminho admin (lead-autoassign, sessão de um admin) e os caminhos
-- de servidor (postgres/service_role) passam.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_agent_presence_pool()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.in_pool IS DISTINCT FROM OLD.in_pool
     AND current_user IN ('authenticated', 'anon')
     AND NOT is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION
      'in_pool é gerido pelo admin (distribuição de leads), não por atualização direta do membro'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_agent_presence_pool() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_guard_agent_presence_pool ON public.agent_presence;
CREATE TRIGGER trg_guard_agent_presence_pool
  BEFORE UPDATE ON public.agent_presence
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_agent_presence_pool();

-- ------------------------------------------------------------
-- (RBAC-CONF-02) ap_self_update passa a exigir agent+ (era viewer+),
-- alinhando com a rota presence (requireRole('agent')). Viewers não
-- têm presença (o trigger de sync só cria pra agent), então isto é
-- correção de coerência sem mudar comportamento real.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS ap_self_update ON agent_presence;
CREATE POLICY ap_self_update ON agent_presence
  FOR UPDATE
  USING (user_id = auth.uid() AND is_account_member(account_id, 'agent'))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id, 'agent'));
