import { Button } from "@odentia/ui"
import {
  type AccountGrant,
  AccountSupportPage,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { AccountSupportPageSkeleton } from "../../components/skeletons/support"
import { PanelAccount } from "../../lib/account"
import { accountOrganizationsQuery } from "../../lib/account-organizations"
import { apiFetch } from "../../lib/api"

export const Route = createFileRoute("/_app/support")({
  // `?caso=<id>`: el enlace del aviso por correo abre ese caso.
  validateSearch: (search: Record<string, unknown>): { caso?: string } =>
    typeof search.caso === "string" && search.caso ? { caso: search.caso } : {},
  pendingComponent: AccountSupportPageSkeleton,
  component: SupportPage,
})

// Los mismos límites que `grantInput` de la API.
const DURATIONS = [
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "60", label: "1 hora" },
]
const grantSchema = z.object({
  minutes: z.enum(["15", "30", "60"], { error: "Elige cuánto dura el acceso." }),
})

/** Soporte de la cuenta: la pantalla común (ADR 0216) con el acceso diagnóstico a una clínica. */
function SupportPage() {
  const linkedCase = Route.useSearch().caso ?? null
  return (
    <PanelAccount>
      <AccountSupportPage
        linkedCase={linkedCase}
        intro={{
          title: "¿No puedes entrar a una clínica?",
          description:
            "Cuéntalo aquí aunque no tengas organización abierta. Solo te pedimos lo necesario para ayudarte.",
          questionPlaceholder: "Describe tu problema para entrar…",
          detailPlaceholder: "Código de error, correo, clínica…",
        }}
        caseExtra={(kase) =>
          kase.organizationId ? (
            <AccountGrantBox
              caseId={kase.id}
              organizationId={kase.organizationId}
              organizationName={kase.organizationName}
              grants={kase.grants}
            />
          ) : null
        }
      />
    </PanelAccount>
  )
}

/**
 * Consentimiento de acceso diagnóstico con la organización ya acotada por
 * narrowing en el llamador: aquí `organizationId` es siempre un string.
 */
function AccountGrantBox({
  caseId,
  organizationId,
  organizationName,
  grants,
}: {
  caseId: string
  organizationId: string
  organizationName: string | null
  grants: AccountGrant[]
}) {
  const queryClient = useQueryClient()
  const organizations = useQuery(accountOrganizationsQuery)
  const role = organizations.data?.find((item) => item.organizationId === organizationId)?.role
  const activeGrant = grants.find((item) => item.active) ?? null

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["account-support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["account-support-case", caseId] })
  }

  const grant = useMutation({
    mutationFn: (minutes: number) =>
      apiFetch(`/api/account/support/cases/${caseId}/grants`, {
        method: "POST",
        body: JSON.stringify({ organizationId, minutes }),
      }),
    onSuccess: invalidate,
  })
  const grantForm = useAppForm({
    defaultValues: { minutes: "30" },
    validators: { onSubmit: grantSchema },
    onSubmit: async ({ value }) => {
      await grant.mutateAsync(Number(value.minutes))
    },
  })
  const onGrant = useFormSubmit(grantForm)
  const grantError = useFormSubmitError(grantForm)
  const granting = useStore(grantForm.store, (state) => state.isSubmitting)
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      apiFetch(`/api/account/support/cases/${caseId}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId }),
      }),
    onSuccess: invalidate,
  })
  if (role !== "owner" && role !== "admin")
    return (
      <p className="text-sm text-muted-foreground">
        Solo quien administra la clínica puede autorizar acceso diagnóstico a soporte.
      </p>
    )

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
      <p className="font-bold">Acceso diagnóstico de soporte</p>
      {activeGrant ? (
        <>
          <p>
            Soporte puede ver el diagnóstico de {organizationName ?? "tu clínica"} hasta el{" "}
            {new Date(activeGrant.expiresAt).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })}
            .
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 self-start sm:min-h-9"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(activeGrant.id)}
          >
            Quitar acceso
          </Button>
          {revoke.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(revoke.error)}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Solo quien es propietario o administra la clínica puede autorizarlo, máximo 1 hora.
          </p>
          <form noValidate onSubmit={onGrant} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <grantForm.AppField name="minutes">
                {(field) => (
                  <field.SelectField
                    id="cuenta-minutos"
                    label="Duración"
                    options={DURATIONS}
                    className="w-44"
                  />
                )}
              </grantForm.AppField>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={granting}
              >
                Autorizar acceso
              </Button>
            </div>
            {grantError ? (
              <p role="alert" className="text-sm text-destructive">
                {grantError}
              </p>
            ) : null}
          </form>
        </>
      )}
    </div>
  )
}
