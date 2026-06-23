import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentAccount, UnauthorizedError } from "@/lib/auth/account";
import { DashboardShell } from "./dashboard-shell";

// Mantém "não indexar" em todas as páginas autenticadas — defesa em profundidade
// caso uma URL vaze via link externo.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// Gate server-side: nenhuma página do dashboard renderiza pra uma conta
// que não está 'active'. Defesa em profundidade por cima da RLS — aqui
// é só UX (redireciona ao muro); a RLS é quem realmente esconde os dados.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let status: string | null = null;
  try {
    const ctx = await getCurrentAccount();
    status = ctx.account.status;
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    // Perfil sem conta vinculada — manda pro muro.
    redirect("/pending");
  }

  if (status !== "active") redirect("/pending");

  return <DashboardShell>{children}</DashboardShell>;
}
