import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@odentia/ui"
import { useStore } from "@tanstack/react-form"
import { useEffect, useRef } from "react"
import { useAppForm, useFormSubmit, useFormSubmitError } from "./form/app-form.js"
import { SubmitButton } from "./form/submit-button.js"
import { PASSWORD_MIN_LENGTH, usePasswordRequirements } from "./password-requirements.js"

/**
 * «Crea tu nueva contraseña»: aparece encima de la pantalla después de entrar
 * con el enlace de acceso (lienzo «Recuperar el acceso», paso 4). No se cierra
 * sin guardar (decisión 1); en el celular sube desde abajo. Quien solo entra
 * con Google puede seguir sin contraseña.
 *
 * `onSave` lanza si no se guardó: lo que el servidor señala de `password` se
 * dice bajo el campo y lo demás (el enlace venció) junto al botón.
 */
export function NewPasswordDialog({
  open,
  hasPassword,
  onSave,
  onSkip,
}: {
  open: boolean
  hasPassword: boolean
  onSave: (password: string) => Promise<void>
  onSkip?: () => Promise<void>
}) {
  // La filtración se consulta mientras se escribe; el esquema lee la última respuesta.
  const breachedRef = useRef(false)
  const form = useAppForm({
    defaultValues: { password: "" },
    onSubmit: async ({ value }) => {
      await onSave(value.password)
    },
  })
  const password = useStore(form.store, (state) => state.values.password)
  const { requirements, breached } = usePasswordRequirements(password)
  useEffect(() => {
    breachedRef.current = breached
  }, [breached])
  // Sin red no se sabe si se guardó, pero repetirlo no duplica nada: se dice que no hubo conexión.
  const onSubmit = useFormSubmit(form, {
    formMessage: (error) =>
      error instanceof TypeError ? "No pudimos guardarla. Revisa tu conexión e inténtalo de nuevo." : null,
  })
  const submitError = useFormSubmitError(form)

  return (
    // Sin cerrar con Escape, fuera ni ×: se guarda o, sin contraseña previa, se sigue con Google.
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-8"
      >
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <span aria-hidden className="mx-auto -mt-2 h-1.5 w-11 rounded-full bg-muted sm:hidden" />
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-xl font-extrabold tracking-[-0.02em]">
              {hasPassword ? "Crea tu nueva contraseña" : "Crea una contraseña"}
            </DialogTitle>
            <DialogDescription>
              Ya entraste con el enlace. Elige una contraseña para la próxima vez.
            </DialogDescription>
          </div>
          <form.AppField
            name="password"
            validators={{
              // Los mismos límites que el servidor (8 a 128) y la filtración ya consultada.
              onSubmit: ({ value }) =>
                value.length < PASSWORD_MIN_LENGTH
                  ? `Usa al menos ${PASSWORD_MIN_LENGTH} caracteres.`
                  : value.length > 128
                    ? "Usa como mucho 128 caracteres."
                    : breachedRef.current
                      ? "Esta contraseña aparece en filtraciones conocidas. Elige otra."
                      : undefined,
            }}
          >
            {(field) => (
              <field.PasswordField
                label="Nueva contraseña"
                autoComplete="new-password"
                autoFocus
                requirements={requirements}
              />
            )}
          </form.AppField>
          {submitError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {submitError}
            </p>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                Guardar y seguir
              </SubmitButton>
            )}
          </form.Subscribe>
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
