import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@odentia/ui"
import { Check, Circle, Eye, EyeOff, LoaderCircle, X } from "lucide-react"
import { type KeyboardEvent, useState } from "react"

/** Un requisito de la contraseña a la vista: cumplido, no cumplido o aún por saber (`null`). */
export type PasswordRequirement = { label: string; met: boolean | null; checking?: boolean }

/**
 * Campo de contraseña de entrar, crear cuenta y la contraseña nueva: botón
 * «Ver», aviso de mayúsculas activadas y, si se pasan, los requisitos a la
 * vista desde el inicio (no solo al fallar). Se puede pegar, para los
 * gestores de contraseñas.
 */
export function PasswordInput({
  id,
  value,
  onChange,
  onBlur,
  autoComplete,
  invalid,
  describedBy,
  requirements,
  autoFocus,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  autoComplete: "current-password" | "new-password"
  invalid?: boolean
  describedBy?: string
  requirements?: PasswordRequirement[]
  autoFocus?: boolean
}) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const readCaps = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState?.("CapsLock") ?? false)
  const reqId = requirements ? `${id}-requisitos` : undefined
  const capsId = `${id}-mayusculas`
  const described =
    [describedBy, reqId, capsLock ? capsId : undefined].filter(Boolean).join(" ") || undefined

  return (
    <div className="flex flex-col gap-1.5">
      <InputGroup className="h-10">
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={described}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            setCapsLock(false)
            onBlur?.()
          }}
          onKeyDown={readCaps}
          onKeyUp={readCaps}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="xs"
            aria-pressed={visible}
            aria-controls={id}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {visible ? "Ocultar" : "Ver"}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {capsLock ? (
        <p id={capsId} className="text-xs font-semibold text-amber-700 dark:text-amber-300">
          Mayúsculas activadas.
        </p>
      ) : null}
      {requirements ? (
        <ul id={reqId} className="flex flex-col gap-1 text-xs" aria-live="polite">
          {requirements.map((r) => (
            <li
              key={r.label}
              className={
                r.met === true
                  ? "flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300"
                  : r.met === false
                    ? "flex items-center gap-1.5 font-semibold text-destructive"
                    : "flex items-center gap-1.5 text-muted-foreground"
              }
            >
              {r.checking ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : r.met === true ? (
                <Check className="size-3.5" aria-hidden />
              ) : r.met === false ? (
                <X className="size-3.5" aria-hidden />
              ) : (
                <Circle className="size-3" aria-hidden />
              )}
              <span>
                {r.label}
                <span className="sr-only">
                  {r.met === true ? ": cumple" : r.met === false ? ": no cumple" : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
