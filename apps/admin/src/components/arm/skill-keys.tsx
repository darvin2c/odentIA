/**
 * Equipo › Llaves de la skill (ARM, ADR 0183; solo Administración): la llave
 * personal con que la skill de carga deja planes e informes en la ficha del
 * cliente › Alta. Solo deposita: no aprueba, no ensaya, no carga ni envía, y
 * no lee pacientes. Se muestra una sola vez al crearla (el servidor guarda
 * solo su huella), vence a los 90 días y se revoca aquí. El servidor exige
 * Administración con su sesión para todo esto.
 */
import { Badge, Button, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, KeyRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { invitationDueWords } from "../../lib/invitation-words"
import { agoWords, supportDay } from "../../lib/support-words"
import { SkillKeysSkeleton } from "../skeletons/team"

const person = z.object({ userId: z.string(), name: z.string() })
const keySchema = z.object({
  id: z.string(),
  label: z.string(),
  user: person,
  scope: z.literal("carga"),
  state: z.enum(["vigente", "vencida", "revocada"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: person.nullable(),
  lastUsedAt: z.string().nullable(),
})
type SkillKey = z.infer<typeof keySchema>
const createdSchema = z.object({ id: z.string(), token: z.string(), expiresAt: z.string() })

const skillKeysKey = ["admin", "skill-keys"] as const

const STATE_WORDS: Record<
  SkillKey["state"],
  { text: string; tone: "success" | "outline" | "secondary" }
> = {
  vigente: { text: "Vigente", tone: "success" },
  vencida: { text: "Vencida", tone: "outline" },
  revocada: { text: "Revocada", tone: "secondary" },
}

/** Dónde se guarda en la máquina que corre la skill (la lee `import:dejar`). */
const KEY_FILE = "~/odentia-cargas/.llave-administracion"

const createSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Ponle un nombre a la llave")
    .max(80, "El nombre de la llave, 80 caracteres como mucho"),
})

function keyLine(key: SkillKey): string {
  const pieces = [`de ${key.user.name}`, `creada el ${supportDay(key.createdAt)}`]
  if (key.state === "revocada" && key.revokedAt)
    pieces.push(
      `revocada el ${supportDay(key.revokedAt)}${key.revokedBy ? ` por ${key.revokedBy.name.split(" ")[0]}` : ""}`,
    )
  else pieces.push(invitationDueWords(key.expiresAt).text)
  pieces.push(key.lastUsedAt ? `último uso ${agoWords(key.lastUsedAt)}` : "nunca se usó")
  return pieces.join(" · ")
}

export function SkillKeysSection() {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<z.infer<typeof createdSchema> | null>(null)
  const [toRevoke, setToRevoke] = useState<SkillKey | null>(null)
  const shown = useRef<HTMLDivElement>(null)
  const keys = useQuery({
    queryKey: skillKeysKey,
    queryFn: async () =>
      z.array(keySchema).parse(await api<unknown>("/api/admin/clients/skill-keys")),
  })
  const revoke = useMutation({
    mutationFn: (key: SkillKey) =>
      api(`/api/admin/clients/skill-keys/${key.id}/revoke`, { method: "POST" }),
    onSuccess: (_, key) => {
      toast.success(`Llave «${key.label}» revocada: ya no deja borradores`)
      setToRevoke(null)
      void queryClient.invalidateQueries({ queryKey: skillKeysKey })
    },
  })
  // La llave recién creada se anuncia y recibe el foco: es lo único que hay que hacer ahora.
  useEffect(() => {
    if (created) shown.current?.focus()
  }, [created])

  return (
    <section aria-labelledby="llaves-skill" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="llaves-skill" className="text-lg font-semibold">
          Llaves de la skill
        </h2>
        <Button type="button" variant="outline" onClick={() => setCreating(true)}>
          <KeyRound aria-hidden />
          Crear llave
        </Button>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        La skill de carga entra con una llave personal para dejar planes e informes en la ficha del
        cliente › Alta. Solo deja borradores: aprobar, ensayar, cargar y enviar lo hace una persona
        aquí. Cada entrega queda a nombre de quien tiene la llave. Vence a los 90 días.
      </p>

      {created ? (
        <div
          ref={shown}
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <p className="font-medium">Copia la llave ahora: no se vuelve a mostrar.</p>
          <code className="block rounded-md bg-background px-3 py-2 font-mono text-xs break-all">
            {created.token}
          </code>
          <p>
            En la máquina donde corre la skill, guárdala en{" "}
            <code className="break-all">{KEY_FILE}</code> con permisos 600 (solo tú la lees), o en
            la variable <code>ODENTIA_ADMIN_KEY</code>. No la pegues en un chat, un correo ni un
            documento. Vale hasta el {supportDay(created.expiresAt)}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(created.token).then(
                  () => toast.success("Llave copiada"),
                  () => toast.error("No se pudo copiar: selecciónala y cópiala a mano"),
                )
              }
            >
              <Copy aria-hidden />
              Copiar
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Ya la guardé
            </Button>
          </div>
        </div>
      ) : null}

      {keys.isPending ? (
        <SkeletonRegion message="Cargando las llaves…">
          <SkillKeysSkeleton />
        </SkeletonRegion>
      ) : keys.isError ? (
        <ErrorState
          title="No se pudieron cargar las llaves"
          message={submitErrorMessage(keys.error)}
          onRetry={() => void keys.refetch()}
        />
      ) : keys.data.length === 0 ? (
        <EmptyState
          title="Sin llaves"
          description="Crea una para la máquina donde corres la skill de carga."
          actionLabel="Crear llave"
          onAction={() => setCreating(true)}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.data.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-medium [overflow-wrap:anywhere]">{key.label}</p>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {keyLine(key)}
                </p>
              </div>
              <Badge variant={STATE_WORDS[key.state].tone}>{STATE_WORDS[key.state].text}</Badge>
              {key.state === "vigente" ? (
                <Button type="button" variant="ghost" onClick={() => setToRevoke(key)}>
                  Revocar
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <CreateKeyDrawer
          onClose={() => setCreating(false)}
          onCreated={(next) => {
            setCreated(next)
            void queryClient.invalidateQueries({ queryKey: skillKeysKey })
          }}
        />
      ) : null}
      <ConfirmDialog
        open={toRevoke !== null}
        title={toRevoke ? `Revocar la llave «${toRevoke.label}»` : "Revocar la llave"}
        description={`${toRevoke ? `Es de ${toRevoke.user.name}. ` : ""}Desde ya, la skill que la use no puede dejar borradores. Lo que ya dejó sigue en la ficha. No se puede deshacer: si hace falta, se crea otra.`}
        confirmLabel="Revocar"
        pending={revoke.isPending}
        error={revoke.isError ? submitErrorMessage(revoke.error) : null}
        onConfirm={() => {
          if (toRevoke) revoke.mutate(toRevoke)
        }}
        onClose={() => {
          revoke.reset()
          setToRevoke(null)
        }}
      />
    </section>
  )
}

function CreateKeyDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (created: z.infer<typeof createdSchema>) => void
}) {
  const form = useAppForm({
    defaultValues: { label: "" },
    validators: { onSubmit: createSchema },
    onSubmit: async ({ value }) => {
      const created = createdSchema.parse(
        await api<unknown>("/api/admin/clients/skill-keys", {
          method: "POST",
          body: JSON.stringify({ label: value.label.trim() }),
        }),
      )
      onCreated(created)
      onClose()
    },
  })
  return (
    <FormDrawer
      {...useFormSurface(form)}
      open
      title="Crear una llave de la skill"
      description="Es tuya: cada borrador que deje la skill con ella queda a tu nombre. Se muestra una sola vez."
      submitLabel="Crear llave"
      onClose={onClose}
    >
      <form.AppField name="label">
        {(field) => (
          <field.TextField
            id="skill-key-label"
            label="Para qué es"
            description="Para reconocerla después, por ejemplo la máquina donde corre la skill."
            placeholder="Laptop de la oficina"
            maxLength={80}
            autoComplete="off"
          />
        )}
      </form.AppField>
    </FormDrawer>
  )
}
