// ============================================================
// GET /api/admin/accounts?status=pending
//
// Lista contas para o painel de super admin. Usa service role
// (supabaseAdmin) porque o admin de plataforma não é membro das
// contas — RLS bloquearia a query. Gate por requirePlatformAdmin.
//
// Abordagem de dois queries para o owner: primeiro busca as contas,
// depois busca os profiles dos owners e faz o join em JS. Evita
// dependência de FK-hint do PostgREST (que pode ser ambíguo).
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";

const VALID_STATUS = ["pending", "active", "suspended", "rejected"] as const;

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && (VALID_STATUS as readonly string[]).includes(statusParam)
        ? statusParam
        : "pending";

    const db = supabaseAdmin();

    // 1ª query: busca as contas (sem embed de owner).
    const { data: accounts, error } = await db
      .from("accounts")
      .select(
        "id, name, status, account_type, created_at, approved_at, owner_user_id",
      )
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[GET /api/admin/accounts] erro:", error);
      return NextResponse.json(
        { error: "Falha ao listar contas" },
        { status: 500 },
      );
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ accounts: [] });
    }

    // 2ª query: busca profiles dos owners para enriquecer a resposta.
    const ownerIds = [
      ...new Set(
        accounts
          .map((a) => a.owner_user_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const profilesMap: Record<
      string,
      { email: string | null; full_name: string | null }
    > = {};

    if (ownerIds.length > 0) {
      const { data: profiles } = await db
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", ownerIds);

      if (profiles) {
        for (const p of profiles) {
          profilesMap[p.user_id] = {
            email: p.email ?? null,
            full_name: p.full_name ?? null,
          };
        }
      }
    }

    // Monta resposta com dados do owner embutidos.
    const enriched = accounts.map((a) => {
      const ownerProfile = a.owner_user_id
        ? (profilesMap[a.owner_user_id] ?? null)
        : null;
      return {
        ...a,
        owner_email: ownerProfile?.email ?? null,
        owner_name: ownerProfile?.full_name ?? null,
      };
    });

    return NextResponse.json({ accounts: enriched });
  } catch (err) {
    return toErrorResponse(err);
  }
}
