-- ============================================================
-- 032 — RBAC: DELETE admin+ em contacts/deals + consistência
--        de broadcasts/automations/flows (agent -> admin)
--
-- contacts/deals são escritos direto do browser (client de sessão),
-- sem rota de app — a RLS é a única defesa. A matriz põe DELETE em
-- admin+, mas a 017 deixou em agent. Aqui separamos o DELETE.
-- broadcasts/automations/flows sobem pra admin+ por consistência com
-- a matriz (guard de app é a barreira efetiva hoje, mas a RLS passa a
-- concordar — defesa em profundidade pra caminhos futuros).
-- ============================================================

-- contacts: DELETE agora exige admin (INSERT/UPDATE seguem agent)
DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- deals: idem
DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- broadcasts: write admin+ (consistência)
DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- automations: write admin+ (consistência)
DROP POLICY IF EXISTS automations_insert ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_update ON automations;
CREATE POLICY automations_update ON automations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_delete ON automations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- flows: write admin+ (consistência)
DROP POLICY IF EXISTS flows_insert ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_update ON flows;
CREATE POLICY flows_update ON flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_delete ON flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));
