import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@odentia/ui"
import { type FormEvent, useId, useState } from "react"
import { SubmitButton } from "./form/submit-button.js"
import { PasswordInput } from "./password-input.js"
import { PASSWORD_MIN_LENGTH, usePasswordRequirements } from "./password-requirements.js"

/**
 * «Crea tu nueva contraseña»: aparece encima de la pantalla después de entrar
 * con el enlace de acceso (lienzo «Recuperar el acceso», paso 4). No se cierra
 * sin guardar (decisión 1); en el celular sube desde abajo. Quien solo entra
 * con Google puede seguir sin contraseña.
 *
 * `onSave` devuelve el mensaje de error que se muestra bajo el campo, o null
 * si quedó guardada.
 */
export function NewPasswordDialog({
  open,
  hasPassword,
  onSave,
  onSkip,
}: {
  open: boolean
  hasPassword: boolean
  onSave: (password: string) => Promise<string | null>
  onSkip?: () => Promise<void>
}) {
  const id = useId()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { requirements, breached } = usePasswordRequirements(password)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Usa al menos ${PASSWORD_MIN_LENGTH} caracteres.`)
      return
    }
    if (breached) {
      setError("Esta contraseña aparece en filtraciones conocidas. Elige otra.")
      return
    }
    setSaving(true)
    setError(null)
    const message = await onSave(password)
    setSaving(false)
    if (message) setError(message)
  }

  return (
    // Sin cerrar con Escape, fuera ni ×: se guarda o, sin contraseña previa, se sigue con Google.
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-8"
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <span aria-hidden className="mx-auto -mt-2 h-1.5 w-11 rounded-full bg-muted sm:hidden" />
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-xl font-extrabold tracking-[-0.02em]">
              {hasPassword ? "Crea tu nueva contraseña" : "Crea una contraseña"}
            </DialogTitle>
            <DialogDescription>
              Ya entraste con el enlace. Elige una contraseña para la próxima vez.
            </DialogDescription>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-pw`} className="text-sm font-medium">
              Nueva contraseña
            </label>
            <PasswordInput
              id={`${id}-pw`}
              value={password}
              onChange={(v) => {
                setPassword(v)
                setError(null)
              }}
              autoComplete="new-password"
              autoFocus
              invalid={!!error}
              describedBy={error ? `${id}-error` : undefined}
              requirements={requirements}
            />
            {error ? (
              <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <SubmitButton type="submit" pending={saving} className="w-full">
            Guardar y seguir
          </SubmitButton>
          <p className="text-xs text-muted-foreground">
            Al guardar cerramos tu sesión en los otros equipos.
          </p>
          {!hasPassword && onSkip ? (
            <Button type="button" variant="ghost" onClick={() => void onSkip()}>
              Seguir entrando solo con Google
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}
