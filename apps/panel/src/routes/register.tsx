import { AGENTS, type DayEvent } from "@odentia/brand-scene"
import { Checkbox, Field, FieldError, FieldGroup, FieldLabel, Input, Separator } from "@odentia/ui"
import {
  AuthAside,
  AuthSplit,
  fieldErrorMessages,
  PasswordInput,
  SubmitButton,
  usePasswordRequirements,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { API_URL, authClient } from "../lib/auth-client"
import { AuthAlert, AuthLegal } from "../lib/auth-screens"
import { creditText } from "../lib/credit"
import { invitationQuery, moneyText, rememberInvitation } from "../lib/founders"
import { GoogleAuthButton } from "../lib/google-auth"
import { webUrl } from "../lib/host"

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.email === "string" ? { email: search.email } : {}),
    ...(typeof search.invitationId === "string" ? { invitationId: search.invitationId } : {}),
    // Invitación Fundadores (issue 165): el enlace del correo de la lista de espera.
    ...(typeof search.invitacion === "string" && search.invitacion ? { invitacion: search.invitacion } : {}),
  }),
  component: RegisterPage,
})

const signUpInfoSchema = z.object({
  offer: z.object({ currency: z.string(), creditCents: z.number(), days: z.number() }).nullable(),
  legalVersion: z.string(),
  agreementVersion: z.string(),
  signupMode: z.enum(["invitacion", "abierta"]).default("abierta"),
})

/** Crédito de prueba y versión de los documentos: los dice el servidor, no la pantalla. */
const signUpInfoQuery = {
  queryKey: ["public", "sign-up"],
  queryFn: async () => {
    const res = await fetch(`${API_URL}/api/public/sign-up`)
    if (!res.ok) throw new Error(`Error ${res.status}`)
    return signUpInfoSchema.parse(await res.json())
  },
  staleTime: 5 * 60_000,
}

const registration = z.object({
  firstName: z.string().trim().min(1, "Escribe tu nombre"),
  lastName: z.string().trim().min(1, "Escribe tus apellidos"),
  email: z.string().email("Escribe un correo válido, como nombre@clinica.com"),
  password: z.string().min(8, "Usa al menos 8 caracteres"),
  terms: z.literal(true, { error: "Acepta los documentos para crear tu cuenta" }),
})

/**
 * Crear cuenta (lienzo «Crear cuenta odentIA», aprobado el 2026-10-17): vende
 * sin abrumar. A la izquierda el titular con el crédito, tres frases de
 * confianza, las piezas de la web y una sola acción de un agente a la vez; a
 * la derecha el formulario, con el mismo botón que la web.
 */
function RegisterPage() {
  const navigate = useNavigate()
  const { email: initialEmail, invitationId, invitacion } = useSearch({ from: "/register" })
  const info = useQuery(signUpInfoQuery)
  const founderToken = invitacion ?? null
  useEffect(() => {
    if (founderToken) rememberInvitation(founderToken)
  }, [founderToken])
  const founderQuery = useQuery(invitationQuery(founderToken))
  const founder = founderQuery.data ?? null
  // Fundadores: sin invitación propia, la cuenta se crea igual pero la clínica no se abre (decisión 1).
  const invitationOnly = info.data?.signupMode === "invitacion" && !founder && !invitationId
  const offer = info.data?.offer ?? null
  const credit = founder
    ? founder.offer.trialCreditCents > 0
      ? moneyText(founder.offer.currency, founder.offer.trialCreditCents)
      : null
    : offer && offer.creditCents > 0
      ? creditText(offer.currency, offer.creditCents)
      : null
  // Quien entra invitado a un equipo no abre una clínica: no recibe el crédito.
  const cta = credit && !invitationId && !founder && !invitationOnly ? `Obtén ${credit} de crédito` : "Crear mi cuenta"
  // Tras verificar el correo (o con Google), quien trae invitación Fundadores sigue a abrir su clínica.
  const nextPath = invitationId
    ? `/accept-invitation/${encodeURIComponent(invitationId)}`
    : founderToken
      ? `/onboarding?invitacion=${encodeURIComponent(founderToken)}`
      : "/"
  const [work, setWork] = useState<DayEvent | null>(null)
  const [problem, setProblem] = useState<{
    field: "email" | "password" | "form"
    text: string
    reload?: boolean
  } | null>(null)

  const form = useForm({
    defaultValues: {
      firstName: "",
      lastName: "",
      email: initialEmail ?? "",
      password: "",
      terms: false as boolean,
    },
    validators: { onSubmit: registration },
    onSubmit: async ({ value }) => {
      setProblem(null)
      if (!info.data) {
        setProblem({
          field: "form",
          text: "No pudimos cargar los documentos. Recarga la página.",
          reload: true,
        })
        return
      }
      const { error } = await authClient.signUp.email({
        name: `${value.firstName.trim()} ${value.lastName.trim()}`.trim(),
        firstName: value.firstName.trim(),
        lastName: value.lastName.trim(),
        email: value.email,
        password: value.password,
        termsVersion: info.data.legalVersion,
        // El contrato de encargo lo acepta quien abre la clínica; quien entra invitado, no (decisión 2).
        ...(invitationId ? {} : { processingAgreementVersion: info.data.agreementVersion }),
        callbackURL: `${window.location.origin}${nextPath}`,
      })
      if (error) {
        const code = error.code ?? ""
        if (code.startsWith("USER_ALREADY_EXISTS")) setProblem({ field: "email", text: "exists" })
        else if (code === "PASSWORD_COMPROMISED" || code === "PASSWORD_TOO_SHORT")
          setProblem({ field: "password", text: error.message ?? "Elige otra contraseña." })
        else if (code === "TERMS_OUTDATED")
          setProblem({ field: "form", text: error.message ?? "", reload: true })
        else
          setProblem({
            field: "form",
            text: error.message ?? "No pudimos crear la cuenta. Inténtalo de nuevo.",
          })
        return
      }
      await navigate(
        invitationId
          ? { to: "/accept-invitation/$invitationId", params: { invitationId } }
          : { to: "/verify-email-sent" },
      )
    },
  })

  // La invitación trae su correo: se escribe solo y no se cambia (vale para ese correo).
  useEffect(() => {
    if (founder && !form.getFieldValue("email")) form.setFieldValue("email", founder.email)
  }, [founder, form])

  const trust = founder
    ? [
        ...(founder.offer.priceCents === 0 ? ["Sin cuota"] : []),
        ...(founder.offer.discountPercent ? [`Acciones con ${founder.offer.discountPercent} % menos`] : []),
        "Sin tarjeta",
      ]
    : invitationOnly
      ? ["Sin tarjeta", "Tu clínica entra con invitación"]
      : ["Sin tarjeta", offer ? `${offer.days} días` : "Prueba gratis", "Sin límite de usuarios"]
  const headline: React.ReactNode = founder ? (
    credit ? (
      <>
        Los primeros <span className="text-[1.2em] leading-none whitespace-nowrap text-[#f5c46b]">{credit}</span> los pagamos nosotros.
      </>
    ) : (
      "Tu lugar en odentIA está listo."
    )
  ) : invitationOnly ? (
    "Crea tu cuenta."
  ) : credit ? (
    `Obtén ${credit} de crédito.`
  ) : (
    "Prueba odentIA."
  )
  const accent = founder ? "Tus agentes empiezan hoy." : invitationOnly ? "Para abrir tu clínica, pide tu invitación." : "Tus agentes empiezan hoy."
  const tag = founder ? "Invitación Fundadores" : invitationOnly ? "Programa Fundadores" : offer ? `Prueba de ${offer.days} días` : "Prueba gratis"

  return (
    <AuthSplit
      title={
        <span className="flex items-center justify-between gap-3">
          Crea tu cuenta
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-bold text-foreground">
            1 de 4
          </span>
        </span>
      }
      aside={
        <AuthAside tag={tag} title={headline} accent={accent}>
          <TrustChips items={trust} />
        </AuthAside>
      }
      mobileAside={
        <div className="flex flex-col gap-3 text-left">
          <p className="text-2xl leading-tight font-extrabold tracking-[-0.02em] text-[#f1f5f9]">
            {headline} <span className="text-[#4fc3d7]">{accent}</span>
          </p>
          <TrustChips items={trust} />
        </div>
      }
      below={work ? <AgentWork work={work} /> : null}
      onWork={setWork}
      legal={<AuthLegal />}
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="font-medium text-foreground underline">
            Entrar
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {founderToken && founderQuery.data === null ? (
          <AuthAlert>
            Esa invitación ya no sirve: venció, se usó o se anuló. Responde el correo de la invitación y te enviamos otra.
          </AuthAlert>
        ) : null}
        <GoogleAuthButton label="Continuar con Google" callbackURL={nextPath} />
        <div className="flex items-center gap-3">
          <Separator className="flex-1" aria-hidden />
          <span className="text-xs text-muted-foreground">o con tu correo</span>
          <Separator className="flex-1" aria-hidden />
        </div>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <FieldGroup className="gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="firstName">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="firstName">Nombre</FieldLabel>
                  <Input
                    id="firstName"
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    aria-describedby={
                      field.state.meta.errors.length ? "firstName-error" : undefined
                    }
                    autoComplete="given-name"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError id="firstName-error">
                    {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                  </FieldError>
                </Field>
              )}
            </form.Field>
            <form.Field name="lastName">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="lastName">Apellidos</FieldLabel>
                  <Input
                    id="lastName"
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    aria-describedby={field.state.meta.errors.length ? "lastName-error" : undefined}
                    autoComplete="family-name"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError id="lastName-error">
                    {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                  </FieldError>
                </Field>
              )}
            </form.Field>
          </div>
          <form.Field name="email">
            {(field) => {
              const exists = problem?.field === "email"
              return (
                <Field>
                  <FieldLabel htmlFor="email">Correo</FieldLabel>
                  <Input
                    id="email"
                    aria-invalid={field.state.meta.errors.length > 0 || exists || undefined}
                    aria-describedby={
                      field.state.meta.errors.length || exists ? "email-error" : undefined
                    }
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    readOnly={Boolean(founder)}
                    value={field.state.value}
                    onChange={(event) => {
                      field.handleChange(event.target.value)
                      if (exists) setProblem(null)
                    }}
                  />
                  {founder ? <p className="text-xs text-muted-foreground">Es el correo de tu invitación.</p> : null}
                  <FieldError id="email-error">
                    {exists ? (
                      <>
                        Ya hay una cuenta con este correo.{" "}
                        <Link to="/login" className="underline">
                          Entra
                        </Link>{" "}
                        o{" "}
                        <Link
                          to="/forgot-password"
                          search={{ email: field.state.value }}
                          className="underline"
                        >
                          recupera tu contraseña
                        </Link>
                        .
                      </>
                    ) : (
                      (fieldErrorMessages(field.state.meta.errors)[0] ?? null)
                    )}
                  </FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="password">
            {(field) => (
              <NewPasswordField
                value={field.state.value}
                onChange={(v) => {
                  field.handleChange(v)
                  if (problem?.field === "password") setProblem(null)
                }}
                error={
                  problem?.field === "password"
                    ? problem.text
                    : fieldErrorMessages(field.state.meta.errors)[0]
                }
              />
            )}
          </form.Field>
          <form.Field name="terms">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <div className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Checkbox
                      id="terms"
                      className="mt-0.5"
                      checked={field.state.value}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? "terms-error" : undefined}
                      onCheckedChange={(checked) => field.handleChange(checked === true)}
                    />
                    <label htmlFor="terms">
                      Acepto los{" "}
                      <a
                        href={webUrl("/terminos")}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        Términos del servicio
                      </a>
                      {invitationId ? " y el " : ", el "}
                      <a
                        href={webUrl("/privacidad")}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        Aviso de privacidad
                      </a>
                      {invitationId ? null : (
                        <>
                          {" "}
                          y el{" "}
                          <a
                            href={webUrl("/encargo-de-tratamiento")}
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground underline"
                          >
                            Contrato de encargo de tratamiento
                          </a>
                        </>
                      )}
                      .
                    </label>
                  </div>
                  <FieldError id="terms-error">{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          {problem?.field === "form" ? (
            <AuthAlert>
              {problem.text}{" "}
              {problem.reload ? (
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() => window.location.reload()}
                >
                  Recargar
                </button>
              ) : null}
            </AuthAlert>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting} className="w-full">
                {cta}
              </SubmitButton>
            )}
          </form.Subscribe>
          <p className="text-center text-xs text-muted-foreground">
            {founder
              ? "Sin tarjeta. Después sigues a «Configura tu clínica», ya como Fundadora."
              : "Sin tarjeta. Te la pediremos solo cuando elijas tu plan."}
          </p>
          {invitationOnly ? (
            <p className="text-center text-sm text-muted-foreground">
              ¿Quieres usar odentIA en tu clínica?{" "}
              <a href={webUrl("/solicitar-invitacion")} className="font-medium text-foreground underline">
                Pide tu invitación
              </a>
            </p>
          ) : null}
        </FieldGroup>
      </form>
    </AuthSplit>
  )
}

function TrustChips({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((t) => (
        <li
          key={t}
          className="flex items-center gap-1.5 rounded-full border border-[#23444e] bg-[#4fc3d7]/10 px-3 py-1.5 text-sm font-bold text-[#f1f5f9]"
        >
          <Check className="size-3.5 text-[#4fc3d7]" aria-hidden />
          {t}
        </li>
      ))}
    </ul>
  )
}

/** Una sola acción a la vez, con el color del agente que la hizo; cambia con la pieza encendida. */
function AgentWork({ work }: { work: DayEvent }) {
  const agent = AGENTS[work.agent]
  return (
    <div
      key={`${work.time}-${work.text}`}
      className="flex items-center gap-3 rounded-2xl border border-[#23444e] bg-[#061318]/80 px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0"
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: agent?.color }}
      />
      <span className="shrink-0 text-sm font-extrabold text-[#f1f5f9]">{agent?.name}</span>
      <span className="min-w-0 flex-1 text-sm text-[#b9cfd5]">{work.text}</span>
      <span className="shrink-0 font-mono text-xs text-[#8fb0b8]">{work.time}</span>
    </div>
  )
}

function NewPasswordField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string | undefined
}) {
  const { requirements } = usePasswordRequirements(value)
  return (
    <Field>
      <FieldLabel htmlFor="password">Contraseña</FieldLabel>
      <PasswordInput
        id="password"
        value={value}
        onChange={onChange}
        autoComplete="new-password"
        invalid={!!error}
        describedBy={error ? "password-error" : undefined}
        requirements={requirements}
      />
      <FieldError id="password-error">{error ?? null}</FieldError>
    </Field>
  )
}
