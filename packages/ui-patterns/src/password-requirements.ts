import { useEffect, useState } from "react"
import type { PasswordRequirement } from "./password-input.js"

/** Mismo mínimo que el servidor (Better Auth): 8 caracteres (NIST SP 800-63B). */
export const PASSWORD_MIN_LENGTH = 8

/**
 * true si la contraseña aparece en filtraciones conocidas (Have I Been Pwned);
 * null si no se pudo comprobar. Solo viajan los 5 primeros caracteres de su
 * SHA-1 (k-anonimato). El servidor comprueba igual al guardar: esto solo
 * adelanta el aviso mientras se escribe.
 */
export async function isPasswordBreachedOnline(
  password: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  try {
    const bytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password))
    const hash = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { "Add-Padding": "true" },
      signal,
    })
    if (!res.ok) return null
    const suffix = hash.slice(5)
    for (const line of (await res.text()).split(/\r?\n/)) {
      const [rest, count] = line.trim().split(":")
      if (rest === suffix && Number(count) > 0) return true
    }
    return false
  } catch {
    return null
  }
}

/**
 * Los dos requisitos de una contraseña nueva, a la vista mientras se escribe:
 * largo mínimo y que no aparezca en filtraciones (se consulta medio segundo
 * después de dejar de escribir). Sin conexión con el servicio queda «por
 * saber» y decide el servidor.
 */
export function usePasswordRequirements(
  password: string,
  check: (
    password: string,
    signal?: AbortSignal,
  ) => Promise<boolean | null> = isPasswordBreachedOnline,
): { requirements: PasswordRequirement[]; breached: boolean } {
  const longEnough = password.length >= PASSWORD_MIN_LENGTH
  const [breach, setBreach] = useState<{ for: string; value: boolean | null } | null>(null)

  useEffect(() => {
    if (!longEnough) return
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      void check(password, ctrl.signal).then((value) => {
        if (!ctrl.signal.aborted) setBreach({ for: password, value })
      })
    }, 500)
    return () => {
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [password, longEnough, check])

  const known = breach && breach.for === password ? breach.value : null
  const checking = longEnough && (!breach || breach.for !== password)
  return {
    breached: known === true,
    requirements: [
      { label: `Al menos ${PASSWORD_MIN_LENGTH} caracteres`, met: password ? longEnough : null },
      {
        label:
          known === true
            ? "Aparece en filtraciones conocidas: elige otra"
            : "No aparece en filtraciones conocidas",
        met: !longEnough ? null : known === null ? null : !known,
        checking,
      },
    ],
  }
}
