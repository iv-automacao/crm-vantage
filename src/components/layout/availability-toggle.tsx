'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { Switch } from '@/components/ui/switch'

/**
 * Toggle "Disponível / Ausente" para vendedores.
 * Visível apenas quando o usuário tem papel 'agent'.
 * Inclui heartbeat automático a cada 4min para manter a presença ativa.
 */
export function AvailabilityToggle() {
  const { profile } = useAuth()
  // Estado local: null = ainda carregando (desabilita o toggle).
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null)

  // Renderiza apenas para agentes — admin/owner têm opt-in separado (fora do escopo).
  if (profile?.account_role !== 'agent') return null

  return <AvailabilityToggleInner isAvailable={isAvailable} setIsAvailable={setIsAvailable} />
}

/**
 * Componente interno separado para evitar hooks após return condicional.
 */
function AvailabilityToggleInner({
  isAvailable,
  setIsAvailable,
}: {
  isAvailable: boolean | null
  setIsAvailable: (v: boolean | null) => void
}) {
  // Carrega o estado inicial de presença no mount.
  useEffect(() => {
    fetch('/api/account/presence')
      .then((r) => r.json())
      .then((data: { is_available?: boolean }) => {
        setIsAvailable(data.is_available ?? false)
      })
      .catch(() => {
        // Falha silenciosa: toggle fica desabilitado (null).
        setIsAvailable(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Heartbeat: registra atividade a cada 4min e ao voltar para a aba.
  useEffect(() => {
    const ping = () =>
      fetch('/api/account/presence', { method: 'POST' }).catch(() => {})

    // Ping imediato ao montar — registra sessão ativa.
    ping()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') ping()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const interval = setInterval(ping, 4 * 60_000)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = async (checked: boolean) => {
    // Atualização otimista: aplica imediatamente antes da resposta da API.
    setIsAvailable(checked)
    try {
      const res = await fetch('/api/account/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: checked }),
      })
      if (!res.ok) throw new Error('Falha ao atualizar disponibilidade')
    } catch {
      // Rollback: reverte ao estado anterior se a requisição falhar.
      setIsAvailable(!checked)
      toast.error('Não foi possível atualizar sua disponibilidade.')
    }
  }

  const loaded = isAvailable !== null

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={isAvailable ?? false}
        disabled={!loaded}
        onCheckedChange={handleChange}
        aria-label={isAvailable ? 'Disponível' : 'Ausente'}
      />
      {/* Label oculta em telas muito pequenas para caber no header de 56px. */}
      <span
        className={[
          'hidden sm:inline text-xs font-medium select-none',
          loaded && isAvailable
            ? 'text-green-600 dark:text-green-400'
            : 'text-muted-foreground',
        ].join(' ')}
      >
        {loaded && isAvailable ? 'Disponível' : 'Ausente'}
      </span>
    </div>
  )
}
