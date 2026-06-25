-- 028: configuração do CAPI por conta (Dataset ID + Access Token + evento).
-- Token guardado em texto (usado pra chamar a Graph API), protegido por
-- RLS admin-only — mesma postura do `webhook_endpoints.secret`.
CREATE TABLE IF NOT EXISTS capi_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  dataset_id TEXT,
  access_token TEXT,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE capi_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capi_settings_select ON capi_settings;
CREATE POLICY capi_settings_select ON capi_settings
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS capi_settings_modify ON capi_settings;
CREATE POLICY capi_settings_modify ON capi_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
