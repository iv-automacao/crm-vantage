-- ============================================================
-- 031 — Guard de escalonamento de privilégio em profiles
--
-- Contexto: a policy profiles_update (017:564-566) é self-scoped
-- (auth.uid() = user_id) SEM restrição de coluna. Como account_role
-- mora em profiles, qualquer membro (viewer/agent) conseguia rodar
--   update profiles set account_role='owner' where user_id = <eu>
-- pelo PostgREST e virar owner da própria conta, driblando a rota
-- admin-only de membros e os RPCs SECURITY DEFINER.
--
-- Fix: trigger BEFORE UPDATE que rejeita mudança de account_role OU
-- account_id quando o current_user é um papel de client
-- (authenticated/anon). Os caminhos legítimos — set_member_role,
-- remove_account_member, transfer_account_ownership, redeem_invitation,
-- handle_new_user — são SECURITY DEFINER OWNER TO postgres, então
-- rodam com current_user = postgres e passam intactos. Writes via
-- service_role (backend admin client) também passam.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_profile_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER          -- precisa enxergar o current_user REAL de quem faz o UPDATE
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     -- No Supabase, um UPDATE vindo do PostgREST roda sob o papel
     -- 'authenticated'/'anon' (após SET ROLE). Caminhos de servidor
     -- (RPCs SECURITY DEFINER owned by postgres, e service_role) têm
     -- current_user fora dessa lista e passam.
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'account_role/account_id só podem ser alterados por um RPC autorizado do servidor, não por update direto do cliente'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_profile_role_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_guard_profile_role_change ON public.profiles;
CREATE TRIGGER trg_guard_profile_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_role_change();
