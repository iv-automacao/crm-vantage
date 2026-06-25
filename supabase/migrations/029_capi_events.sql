-- 029: fila de conversões CAPI + trigger que enfileira no `deal.won`.
-- A UI marca deal como ganho client-side (via RLS), então o gancho fica
-- no banco pra pegar TODOS os caminhos (kanban, contact-detail, API).
CREATE TABLE IF NOT EXISTS capi_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  value NUMERIC(12,2),
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | skipped | failed
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  meta_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capi_events_pending
  ON capi_events(status) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_capi_events_account
  ON capi_events(account_id, created_at DESC);

ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;

-- Só leitura pra admin; escrita exclusivamente via service-role (cron/trigger).
DROP POLICY IF EXISTS capi_events_select ON capi_events;
CREATE POLICY capi_events_select ON capi_events
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- Enfileira uma conversão quando o deal entra em 'won' (e não estava antes).
CREATE OR REPLACE FUNCTION enqueue_capi_event_on_deal_won() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'won' AND (OLD.status IS DISTINCT FROM 'won') THEN
    INSERT INTO capi_events (account_id, deal_id, contact_id, value, currency)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, NEW.value, NEW.currency);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capi_event_on_deal_won ON deals;
CREATE TRIGGER trg_capi_event_on_deal_won
  AFTER UPDATE OF status ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_capi_event_on_deal_won();
