-- 027: captura de atribuição CTWA no contato.
-- Quando um lead clica num anúncio Click-to-WhatsApp, a primeira mensagem
-- inbound traz um objeto `referral` com o `ctwa_clid` (click-id). Guardamos
-- pra, no fechamento do negócio, devolver a conversão pra Meta (CAPI).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_ctwa_clid
  ON contacts(ctwa_clid) WHERE ctwa_clid IS NOT NULL;
