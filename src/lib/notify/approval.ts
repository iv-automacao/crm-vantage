// ============================================================
// Aviso de aprovação de conta — best-effort via webhook n8n.
//
// O n8n recebe o evento e monta/envia o e-mail "sua conta foi
// liberada". Se o webhook falhar ou a env var estiver ausente,
// apenas logamos — NUNCA lançamos erro (não pode derrubar a
// aprovação em si).
// ============================================================

interface ApprovalNotifyInput {
  accountId: string;
  email: string;
  name: string;
}

export async function notifyAccountApproved(
  input: ApprovalNotifyInput,
): Promise<void> {
  const url = process.env.APPROVAL_NOTIFY_WEBHOOK_URL;
  if (!url) {
    console.warn(
      "[notify/approval] APPROVAL_NOTIFY_WEBHOOK_URL ausente — pulando aviso",
    );
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "account_approved",
        account_id: input.accountId,
        owner_email: input.email,
        owner_name: input.name,
      }),
    });
    if (!res.ok) {
      console.error(`[notify/approval] webhook respondeu ${res.status}`);
    }
  } catch (err) {
    console.error("[notify/approval] falha ao chamar webhook:", err);
  }
}
