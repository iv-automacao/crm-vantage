// Muro mostrado a contas ainda não aprovadas. Server component: lê o
// próprio status (accounts_select é status-agnóstica) e decide. Conta
// já ativa cai pro dashboard; sem sessão, pro login.
import { redirect } from "next/navigation";

import { getCurrentAccount, UnauthorizedError } from "@/lib/auth/account";

export const metadata = {
  robots: { index: false, follow: false },
};

export default async function PendingPage() {
  let status: string;
  try {
    const ctx = await getCurrentAccount();
    status = ctx.account.status;
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    // Profile sem conta / erro de contexto: manda pro login pra refazer.
    redirect("/login");
  }

  if (status === "active") redirect("/dashboard");

  const isRejected = status === "rejected";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">
          {isRejected ? "Conta não aprovada" : "Sua conta está em análise"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {isRejected
            ? "O acesso a esta conta não foi liberado. Se acha que é um engano, fale com a equipe VANTAGE."
            : "Recebemos seu cadastro. A equipe VANTAGE precisa aprovar o acesso antes de você entrar no CRM — você será avisado por e-mail assim que for liberado."}
        </p>
        <a
          href="/login"
          className="mt-6 inline-block text-sm text-primary hover:underline"
        >
          Voltar ao login
        </a>
      </div>
    </main>
  );
}
