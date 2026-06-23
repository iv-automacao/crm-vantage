// Painel de super admin (VANTAGE). Server component gated por
// requirePlatformAdmin: e-mail fora da allowlist nunca vê o conteúdo.
import { redirect } from "next/navigation";

import {
  requirePlatformAdmin,
} from "@/lib/auth/platform-admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { AdminAccountsTable } from "./admin-accounts-table";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    if (err instanceof ForbiddenError) redirect("/dashboard");
    throw err;
  }

  const { data: pending } = await supabaseAdmin()
    .from("accounts")
    .select("id, name, created_at, owner_user_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(200);

  // Enriquecer com e-mail do owner (profile com account_role='owner').
  const ownerIds = (pending ?? []).map((a) => a.owner_user_id);
  const { data: owners } = ownerIds.length
    ? await supabaseAdmin()
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", ownerIds)
    : { data: [] as { user_id: string; email: string; full_name: string | null }[] };

  const ownerById = new Map(
    (owners ?? []).map((o) => [o.user_id, o]),
  );
  const rows = (pending ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    created_at: a.created_at,
    owner_email: ownerById.get(a.owner_user_id)?.email ?? "—",
    owner_name: ownerById.get(a.owner_user_id)?.full_name ?? null,
  }));

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-foreground">
        Contas pendentes de aprovação
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Aprove para liberar o CRM (o lead recebe um e-mail) ou reprove.
      </p>
      <div className="mt-6">
        <AdminAccountsTable initialRows={rows} />
      </div>
    </main>
  );
}
