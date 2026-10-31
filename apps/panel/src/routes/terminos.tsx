import { AuthAside, AuthSplit, SubmitButton, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { TerminosPageSkeleton, TerminosSkeleton } from "../components/skeletons/terminos"
import { accountInvitationsQuery } from "../lib/account-organizations"
import { API_URL, authClient } from "../lib/auth-client"
import { authError, authFailureOf, authFormMessage } from "../lib/auth-error"
import { AuthAlert, AuthLegal } from "../lib/auth-screens"
import { creditText } from "../lib/credit"
import { requireVerifiedSession } from "../lib/guards"
import { legalLinks } from "../lib/host"
import { safeNext } from "../lib/safe-next"
import { initials } from "../lib/welcome"
import { panelWords } from "../lib/brand"

export const Route = createFileRoute("/terminos")({
  ssr: false,
  beforeLoad: () => requireVerifiedSession(),
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
  }),
  pendingComponent: TerminosPageSkeleton,
  component: TermsStepPage,
})

const statusSchema = z.object({
  terms: z.object({ state: z.enum(["ok", "first", "updated"]), version: z.string() }),
  agreement: z.object({ accepted: z.boolean(), version: z.string() }),
})
const offerSchema = z.object({
  offer: z.object({ currency: z.string(), creditCents: z.number(), days: z.number() }).nullable(),
})

const acceptance = z.object({
  accepted: z.literal(true, { error: "Marca la casilla para seguir." }),
})

/** Ya trabaja en una clínica o entra invitado: no abre una (acepta términos y aviso). */
function joins(orgCount: number, invitationCount: number, next: string | undefined): boolean {
  return orgCount > 0 || invitationCount > 0 || (next ?? "").includes("accept-invitation")
}

/** Adónde vuelve: una ruta del panel o una dirección https del dominio. */
function target(next: string | undefined): { path: string } | { href: string } | null {
  if (!next) return null
  if (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/terminos"))
    return { path: next }
  const href = safeNext(next)
  return href ? { href } : null
}

/**
 * «Un paso antes de seguir» (lienzo «Términos con Google», tablero 2): la
 * primera vez que alguien entra sin haber aceptado los documentos (con Google,
 * o con una cuenta anterior). Quien va a abrir una clínica acepta los tres y
 * sigue a crearla con el crédito; quien trabaja en una clínica o entra
 * invitado acepta los términos y el aviso de privacidad (decisión 2).
 */
function TermsStepPage() {
  const navigate = useNavigate()
  const { next } = useSearch({ from: "/terminos" })
  const session = authClient.useSession().data?.user
  const status = useQuery({
    queryKey: ["legal", "status"],
    queryFn: async () => {
      const { data, error } = await authClient.$fetch("/legal/status", { method: "GET" })
      if (error) throw new Error(error.message ?? "No pudimos cargar los documentos.")
      return statusSchema.parse(data)
    },
  })
  const orgs = useQuery({
    queryKey: ["account", "orgs-for-terms"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  })
  const invitations = useQuery(accountInvitationsQuery)
  const accounts = useQuery({
    queryKey: ["account", "providers"],
    queryFn: async () => (await authClient.listAccounts()).data ?? [],
  })
  const offer = useQuery({
    queryKey: ["public", "sign-up-offer"],
    queryFn: async () =>
      offerSchema.parse(await (await fetch(`${API_URL}/api/public/sign-up`)).json()).offer,
  })
  // Los documentos cambiaron mientras tanto: el aviso ofrece recargar.
  const [outdated, setOutdated] = useState(false)
  const back = target(next)

  const form = useAppForm({
    defaultValues: { accepted: false as boolean },
    validators: { onSubmit: acceptance },
    onSubmit: async () => {
      if (!status.data) return
      setOutdated(false)
      const opens = !joins(orgs.data?.length ?? 0, invitations.data?.length ?? 0, next)
      const { error: failure } = await authClient.$fetch("/legal/accept", {
        method: "POST",
        body: {
          termsVersion: status.data.terms.version,
          ...(opens ? { processingAgreementVersion: status.data.agreement.version } : {}),
        },
      })
      if (failure) {
        if (authFailureOf(failure).code === "TERMS_OUTDATED") setOutdated(true)
        throw authError(failure)
      }
      if (back && "href" in back) {
        window.location.assign(back.href)
        return
      }
      // Quien abre su clínica sigue a crearla aunque viniera de «/» (que sin clínica no tiene nada).
      await navigate({
        to: opens && (!back || back.path === "/") ? "/onboarding" : (back?.path ?? "/"),
      })
    },
  })
  const onSubmit = useFormSubmit(form, { formMessage: authFormMessage })
  const submitError = useFormSubmitError(form)

  // Ya aceptó: no hay nada que hacer aquí.
  useEffect(() => {
    if (status.data && status.data.terms.state !== "first") {
      if (back && "href" in back) window.location.assign(back.href)
      else void navigate({ to: back?.path ?? "/" })
    }
  }, [status.data, back, navigate])

  const loading = status.isPending || orgs.isPending || invitations.isPending
  if (loading || !status.data || status.data.terms.state !== "first") {
    return (
      <AuthSplit title="Un paso antes de seguir" legal={<AuthLegal />}>
        {status.isError ? (
          <AuthAlert>No pudimos cargar los documentos. Recarga la página.</AuthAlert>
        ) : (
          <TerminosSkeleton />
        )}
      </AuthSplit>
    )
  }

  const invitation = invitations.data?.[0]
  const clinic = orgs.data?.length === 1 ? orgs.data[0]?.name : undefined
  const opens = !joins(orgs.data?.length ?? 0, invitations.data?.length ?? 0, next)
  const credit =
    opens && offer.data && offer.data.creditCents > 0
      ? creditText(offer.data.currency, offer.data.creditCents)
      : null
  const google = accounts.data?.some((a) => a.providerId === "google") ?? false
  const name = session?.name ?? ""
  const cta = opens
    ? credit
      ? `Obtén ${credit} de crédito`
      : "Seguir"
    : invitation
      ? `Entrar a ${invitation.organizationName}`
      : clinic
        ? `Entrar a ${clinic}`
        : "Seguir"

  return (
    <AuthSplit
      title={
        <span className="flex items-center justify-between gap-3">
          Un paso antes de seguir
          {opens ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-bold text-foreground">
              2 de 4
            </span>
          ) : null}
        </span>
      }
      aside={
        opens ? (
          <AuthAside
            tag="Ya casi"
            title={credit ? `Obtén ${credit} de crédito.` : "Ya casi."}
            accent="Tus agentes empiezan hoy."
          />
        ) : (
          <AuthAside
            tag={invitation ? "Te invitaron" : `Tu ${panelWords.place.one}`}
            title={invitation?.organizationName ?? clinic ?? "Tu clínica"}
            accent="te espera."
          />
        )
      }
      legal={<AuthLegal />}
      footer={
        <>
          ¿No es tu cuenta?{" "}
          <button
            type="button"
            className="font-medium text-foreground underline"
            onClick={async () => {
              await authClient.signOut()
              await navigate({ to: "/login" })
            }}
          >
            Usar otra
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2.5">
        {session?.image ? (
          <img src={session.image} alt="" className="size-10 shrink-0 rounded-full" />
        ) : (
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-extrabold text-primary"
          >
            {initials(name)}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="truncate text-sm text-muted-foreground">{session?.email}</span>
        </span>
        {google ? (
          <span className="shrink-0 rounded-full border bg-card px-2 py-0.5 text-xs font-bold text-muted-foreground">
            Google
          </span>
        ) : null}
      </div>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <form.AppField name="accepted">
          {(field) => (
            <field.CheckboxField
              id="acepto"
              className="text-muted-foreground"
              label={
                <span className="font-normal">
                  Acepto los{" "}
                  <a
                    href={legalLinks.terms}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    Términos del servicio
                  </a>
                  {opens ? ", el " : " y el "}
                  <a
                    href={legalLinks.privacy}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    Aviso de privacidad
                  </a>
                  {opens ? (
                    <>
                      {" "}
                      y el{" "}
                      <a
                        href={legalLinks.agreement}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        Contrato de encargo de tratamiento
                      </a>
                    </>
                  ) : null}
                  .
                </span>
              }
            />
          )}
        </form.AppField>
        {submitError ? (
          <AuthAlert>
            {submitError}{" "}
            {outdated ? (
              <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
                Recargar
              </button>
            ) : null}
          </AuthAlert>
        ) : null}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <SubmitButton type="submit" pending={isSubmitting} className="w-full">
              <span className="truncate">{cta}</span>
            </SubmitButton>
          )}
        </form.Subscribe>
      </form>
    </AuthSplit>
  )
}
