-- 037: claim atômico da fila CAPI. Lock por claimed_at que expira sozinho,
-- evitando duplo-envio quando dois processos pegam a mesma linha. O claim é
-- por id (PK), então não precisa de índice novo.
ALTER TABLE capi_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
