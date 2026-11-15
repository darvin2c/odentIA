import { MEDICATION_CLASSES, type MedicationClass, medicationClassOf, saidWhenWords, specificKin } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { DetailField, DetailList, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { allergyTitle, bySeverity, sinceWords } from "../../lib/allergies"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  changedHistoryOf,
  declaredMarkWords,
  type HealthDeclarant,
  pregnancyWords,
  saidNoWords,
  shortDay,
  whoWords,
} from "../../lib/declared-health"
import { clinicToday } from "../../lib/inventory"
import {
  isCurrentMedication,
  markAllergiesReviewedApi,
  markHealthDeniedApi,
  type PatientHealth,
  reviewDeclaredHealthApi,
  unaskedHealthGroups,
} from "../../lib/patients"
import { productUi } from "../../product/product-ui"
import { AllergyFormDrawer } from "./allergies-card"
import { useOpenWide } from "./wide-section"

/** «a, b y c». */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

/** El tiempo para «Deshacer» «Lo revisé con ella», como los demás «Deshacer» de la app. */
const REVIEW_UNDO_MS = 10_000

/** «alergia, anticoagulante y 6 más». */
function summaryOf(items: string[]): string {
  if (items.length <= 3) return listWords(items)
  return `${items.slice(0, 2).join(", ")} y ${items.length - 2} más`
}

/** Con quién se revisó: «ella», «él», «su madre»; sin saberlo, «la persona». */
function reviewWho(by: HealthDeclarant | null, sex: string | null | undefined): string {
  if (by?.kind === "representative") return `su ${specificKin(by.relation) ?? "representante"}`
  return sex === "F" ? "ella" : sex === "M" ? "él" : "la persona"
}

/**
 * A quién preguntarle cuando lo dijo quien habla por la persona y todavía no figura como su
 * representante (el enlace de un niño): «su madre, Carla». Nulo si lo dijo ella o si fueron varios.
 */
function askDeclarant(groups: ReadonlyArray<{ by: HealthDeclarant }>, sex: string | null | undefined): string | null {
  const people = [...new Set(groups.filter((group) => group.by.kind === "representative").map((group) => whoWords(group.by, sex)))]
  return people.length === 1 ? people[0]! : null
}

// A quién se le pregunta cuando la persona tiene representante: la misma regla que dice quién lo dijo.
export { askWhom } from "../../lib/declared-health"

/**
 * «Antes de atenderla» en la atención (QA del 8 nov, A2): un solo aviso con lo
 * que nunca se le preguntó de su salud, una fila por tema y su respuesta a un
 * toque. Alergias: si nunca se revisaron o pasaron 6 meses (tablero 7).
 * Enfermedades y medicación: si siguen «no preguntado» y sin filas vigentes;
 * «Niega enfermedades» y «No toma medicación» lo dejan dicho con quién y
 * cuándo, y lo que sí tiene se escribe en Antecedentes, encima de la atención.
 * La ASA no va aquí: es un juicio del profesional después de saber lo demás
 * (se ve en «Antecedentes y última atención» y al firmar con anestesia).
 * Avisa, nunca frena la firma. Solo para quien escribe en la historia. «No»
 * y «sí tiene» pesan lo mismo: el aviso pide preguntar, no negar a un toque.
 * Lo que dijo la persona y nadie revisó (mesa del 13 nov) va en una fila, por
 * tema y con sus palabras: el embarazo con la semana de hoy, cada alergia con
 * lo que le pasó, sus medicinas y sus enfermedades, y su «No» como «dijo que
 * no». Se decide por declaración, no por si la salud ya tuvo una revisión, y
 * sus alergias se revisan ahí mismo: no se repiten en la fila «Alergias» ni
 * se dan por vistas con «Sin cambios» (QA del 14 nov). Un embarazo que ya
 * pasó su término pide confirmarlo.
 */
export function HealthReviewNotice({
  patientId,
  patientName,
  health,
  disabled = false,
  askTo = null,
  sex,
  child = false,
}: {
  patientId: string
  patientName: string
  health: PatientHealth
  disabled?: boolean
  /** Con representante, a quién se le pregunta (`askWhom`): «su padre (Luis Ríos)». */
  askTo?: string | null
  /** El sexo registrado del paciente, para decir «ella» o «él»; sin él no se supone. */
  sex?: string | null
  /** Un menor de 12: no se le preguntan anticoagulantes ni medicinas para los huesos (K7). */
  child?: boolean
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const openWide = useOpenWide()
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [adding, setAdding] = useState(false)
  const [showing, setShowing] = useState(false)
  const detailId = useId()
  // «Lo revisé con ella» se guarda pasados unos segundos, con «Deshacer» mientras tanto: la revisión no
  // tiene vuelta atrás en el servidor (sella quién y cuándo), así que se deshace antes de enviarla. Si
  // la pantalla se cierra antes, se guarda en ese momento: no se pierde.
  const [reviewedHere, setReviewedHere] = useState(false)
  const pendingReview = useRef<{ timer: ReturnType<typeof setTimeout>; send: () => void } | null>(null)
  useEffect(
    () => () => {
      const waiting = pendingReview.current
      if (!waiting) return
      clearTimeout(waiting.timer)
      waiting.send()
    },
    [],
  )
  const refresh = async () => {
    await Promise.all(
      [
        ["patient-health", patientId],
        ["patient", patientId],
        ["patient-summary", patientId],
        ["encounter-closing", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
    // La fila respondida se va: el foco vuelve al aviso, no se pierde.
    titleRef.current?.focus()
  }
  const reviewed = useMutation({
    mutationFn: () => markAllergiesReviewedApi(patientId),
    onSuccess: async () => {
      await refresh()
      toast.success("Alergias revisadas")
    },
  })
  const denied = useMutation({
    mutationFn: (group: "conditions" | "medications") => markHealthDeniedApi(patientId, [group]),
    onSuccess: async (_result, group) => {
      await refresh()
      toast.success(group === "conditions" ? "Anotado: niega enfermedades" : "Anotado: no toma medicación")
    },
  })
  const allergiesDue = health.allergyReviewDue === true
  const unasked = unaskedHealthGroups(health, clinicToday())
  const today = clinicToday()
  const pregnancy = health.pregnancy ?? null
  // Lo que dijo, por dato y no por declaración (revisión final del 15 nov, ux R2): cada dato una vez,
  // con lo de hoy y su historia; de quién y cuándo, en la línea si fue una sola declaración, y si no,
  // en cada dato.
  const declared = health.declared ?? []
  const lastGroup = declared.at(-1)
  const currentMedications = health.medications.filter((row) => isCurrentMedication(row, today))
  const history = changedHistoryOf({ changed: health.changed, medications: currentMedications }, sex)
  const marks = [...new Set(declared.map((group) => declaredMarkWords(group.by, group.at, sex)))]
  const oneMark = marks.length === 1 ? marks[0]! : null
  const rows: Array<{ label: string; short: string; value: string }> = []
  const saidWhen = new Map(
    declared.map((group) => [
      group,
      saidWhenWords(group.by, group.at ? shortDay(group.at) : "", sex).replace(/^./, (letter) => letter.toLocaleLowerCase("es")),
    ]),
  )
  /** Un dato, con de quién y cuándo si hay más de una declaración. `short`: su nombre en la línea. */
  const push = (label: string, value: string, groups: typeof declared, short = label.toLocaleLowerCase("es")) => {
    const own = [...new Set(groups.map((group) => saidWhen.get(group) ?? ""))]
    rows.push({ label, short, value: oneMark || own.length === 0 ? value : `${value} (${own.join("; ")})` })
  }
  const no = (group: (typeof declared)[number]) => saidNoWords(group.by, sex).toLocaleLowerCase("es")
  const pregnancyPending = declared.some((group) => group.pregnancy)
  if (pregnancy && pregnancyPending) {
    const words = pregnancyWords(pregnancy)
    push(
      "Embarazo",
      words.confirm
        ? `${words.detail}; pregúntale si sigue embarazada`
        : pregnancy.weeksToday === null
          ? words.detail
          : pregnancy.weeksSaid === pregnancy.weeksToday
            ? // Sin una semana de diferencia, el dato se dice una vez: «20 semanas (lo dijo el 14 nov)».
              `${words.title.replace("Embarazo · ", "")} (${words.detail})`
            : `${pregnancy.weeksToday} ${pregnancy.weeksToday === 1 ? "semana" : "semanas"} hoy (dijo ${words.detail})`,
      // El embarazo ya dice cuándo lo dijo.
      [],
    )
  }
  const allergyGroups = declared.filter((group) => group.allergies.length > 0)
  const saidAllergies = health.allergies.filter((row) => allergyGroups.some((group) => group.allergies.includes(row.id)))
  const saidNoAllergyGroup = declared.find((group) => group.saidNo.allergies)
  if (saidAllergies.length > 0)
    push(
      "Alergias",
      saidAllergies
        // El registro no pregunta qué le pasó: sin reacción no se dice «no dijo» (auditor, 14 nov).
        .map((row) => [allergyTitle(row), row.reaction?.trim(), history.allergyMark(row.id)].filter(Boolean).join(" · "))
        .join("; "),
      allergyGroups,
      saidAllergies.length === 1 ? "alergia" : "alergias",
    )
  else if (saidNoAllergyGroup) push("Alergias", no(saidNoAllergyGroup), [saidNoAllergyGroup])
  // Lo que toma hoy y dijo; lo de antes va junto a lo de hoy de su clase, nunca como otro vigente.
  const medicationGroups = declared.filter((group) => group.medications.length > 0)
  const saidMedications = history.current(
    "medications",
    currentMedications.filter((row) => medicationGroups.some((group) => group.medications.includes(row.id))),
  )
  const groupsOf = (ids: string[]) => medicationGroups.filter((group) => ids.some((id) => group.medications.includes(id)))
  const aloneMedications = history.alone("medications", currentMedications)
  // Lo que tiene marca (anticoagulante, huesos) va en su propia fila, como arriba de la ficha.
  for (const key of Object.keys(MEDICATION_CLASSES) as MedicationClass[]) {
    const inClass = saidMedications.filter((row) => medicationClassOf(row.atcCode) === key)
    const label = MEDICATION_CLASSES[key].label
    const alone = aloneMedications.find((piece) => piece.group === key)
    if (inClass.length > 0)
      push(
        label,
        // «Anticoagulante · Anticoagulante (no dijo cuál)» se leía dos veces (B9): sin nombre, «no dijo cuál».
        inClass
          .map((row) => {
            const name = row.name === MEDICATION_CLASSES[key].unnamed ? "no dijo cuál" : [row.name, row.dose].filter(Boolean).join(" ")
            const before = history.beforeFor("medications", row, currentMedications)
            return before ? `${name} · ${before}` : name
          })
          .join(", "),
        groupsOf(inClass.map((row) => row.id)),
      )
    else if (alone) push(label, alone.text, [])
    else if (lastGroup && !child) {
      // Su «No» o su «No sé» a la clase también se revisa con ella (B9), en su última declaración. A un
      // niño no se le pregunta (revisión final del 15 nov, K7).
      const known = health.medicineClasses?.[key]
      if (known?.said && known.answer === "unknown") push(label, "no sabe", [lastGroup])
      else if (known?.said && known.answer === "no") push(label, no(lastGroup), [lastGroup])
    }
  }
  const otherMedications = saidMedications.filter((row) => medicationClassOf(row.atcCode) === null)
  const aloneOther = aloneMedications.find((piece) => piece.group === null)
  const saidNoMedicationGroup = declared.find((group) => group.saidNo.medications)
  if (otherMedications.length > 0 || aloneOther)
    push(
      "Medicinas",
      [...otherMedications.map((row) => row.name), ...(aloneOther ? [aloneOther.text] : [])].join(", "),
      groupsOf(otherMedications.map((row) => row.id)),
    )
  else if (saidMedications.length === 0 && saidNoMedicationGroup)
    push("Medicinas", no(saidNoMedicationGroup), [saidNoMedicationGroup])
  const conditionGroups = declared.filter((group) => group.conditions.length > 0)
  const activeConditions = health.conditions.filter((row) => row.status === "activa")
  const saidConditions = history.current(
    "conditions",
    activeConditions.filter((row) => conditionGroups.some((group) => group.conditions.includes(row.id))),
  )
  const aloneConditions = history.alone("conditions", activeConditions)
  const saidNoConditionGroup = declared.find((group) => group.saidNo.conditions)
  if (saidConditions.length > 0 || aloneConditions.length > 0)
    push(
      "Enfermedades",
      [...saidConditions.map((row) => row.name), ...aloneConditions.map((piece) => piece.text)].join(", "),
      conditionGroups.filter((group) => saidConditions.some((row) => group.conditions.includes(row.id))),
    )
  else if (saidNoConditionGroup) push("Enfermedades", no(saidNoConditionGroup), [saidNoConditionGroup])
  // El corazón, la anestesia, el tabaco, la lactancia y lo de un niño en casa que dijo (QA del 14 nov),
  // una vez cada uno y solo lo que sigue como lo dijo.
  const interviewGroups = declared.filter((group) => (group.interview ?? []).length > 0)
  if (interviewGroups.length > 0)
    for (const row of productUi().health.saidRows?.((health.latestAnamnesis?.answers ?? {}) as Record<string, unknown>) ?? []) {
      const groups = interviewGroups.filter((group) => row.keys.some((key) => group.interview?.includes(key)))
      if (groups.length > 0) push(row.label, row.value, groups)
    }
  // Lo que dijo y nadie revisó se decide por declaración (`health.declared`, del servidor), no por si
  // la salud tuvo antes una revisión: un látex que llegó después de revisarla también se marca (QA del
  // 14 nov, H2 de clínica). `reviewPending` solo dice si hay algo que revisar en Antecedentes.
  const pending = health.reviewPending === true
  const declaredHere = rows.length > 0 || pending
  // Las alergias que dijo la persona (o su «No») se revisan aquí, con lo demás que dijo: no salen
  // otra vez en una fila «Alergias» aparte ni se dan por vistas con «Sin cambios».
  const declaredAllergyIds = new Set(declared.flatMap((group) => group.allergies))
  const saidNoAllergies = !!saidNoAllergyGroup
  const allergiesSaid = saidAllergies.some((row) => row.isActive) || saidNoAllergies
  // Un embarazo que ya pasó su término (o quedó sin fecha) y que ya nadie tiene por revisar: se pide confirmarlo.
  const confirmPregnancy = pregnancy?.state === "por_confirmar" && !(declaredHere && pregnancyPending)
  if (!canWrite || (!allergiesDue && unasked.length === 0 && !declaredHere && !confirmPregnancy)) return null
  const active = health.allergies.filter((allergy) => allergy.isActive).sort(bySeverity)
  // Las que ya tenía, anotadas o revisadas por el equipo: revisar las alergias también las cubre.
  const others = active.filter((allergy) => !declaredAllergyIds.has(allergy.id))
  const allergyRow = allergiesDue && !allergiesSaid
  // «Nuevas» solo si alguien de la clínica ya se las preguntó: el «No» que marcó la persona no cuenta.
  const asked = others.length > 0 || (health.reviewStatus.allergies === "none" && !saidNoAllergies)
  // Con representante (un niño), se le pregunta a él, como lo dice la ficha. Sin uno registrado
  // todavía, a quien lo declaró, no al niño (revisión final del 15 nov, K5); si no, a la persona.
  const patientFirst = patientName.trim().split(/\s+/)[0] ?? patientName
  const declarant = askTo ? null : askDeclarant(declared, sex)
  const first = askTo ?? declarant ?? patientFirst
  const talksFor = !!(askTo ?? declarant)
  const reviewer = talksFor ? (lastGroup?.by ?? null) : null
  const topics = [
    allergyRow ? (asked ? "sus alergias nuevas" : "sus alergias") : null,
    unasked.includes("conditions") ? "sus enfermedades" : null,
    unasked.includes("medications") ? "su medicación" : null,
  ].filter((topic): topic is string => topic !== null)
  const title =
    topics.length === 0
      ? declaredHere
        ? `Revisa con ${first}${first.includes(",") ? "," : ""} lo que dijo de ${talksFor ? `la salud de ${patientFirst}` : "su salud"}`
        : `Pregúntale a ${first} si sigue embarazada`
      : unasked.length === 0
        ? asked
          ? `Pregúntale a ${first} si tiene alergias nuevas`
          : `Pregúntale a ${first} si tiene alergias`
        : `Pregúntale a ${first} por ${listWords(topics)}`
  const busy = disabled || reviewed.isPending || denied.isPending
  const reviewNow = () => {
    const revision = health.revision
    const send = () => {
      pendingReview.current = null
      void reviewDeclaredHealthApi(patientId, revision)
        .then(refresh)
        .catch((error: unknown) => {
          setReviewedHere(false)
          toast.error(submitErrorMessage(error))
        })
    }
    setReviewedHere(true)
    pendingReview.current = { timer: setTimeout(send, REVIEW_UNDO_MS), send }
    toast.success(`Revisado con ${reviewWho(reviewer, sex)}: ya no dice «sin revisar»`, {
      duration: REVIEW_UNDO_MS,
      action: {
        label: "Deshacer",
        onClick: () => {
          const waiting = pendingReview.current
          if (!waiting) return
          clearTimeout(waiting.timer)
          pendingReview.current = null
          setReviewedHere(false)
          titleRef.current?.focus()
        },
      },
    })
    titleRef.current?.focus()
  }
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-sm font-medium outline-none">
          {title}
        </h2>
        {unasked.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Problemas del corazón, presión alta, diabetes, anticoagulantes o un embarazo cambian la anestesia y lo que
            se receta.
          </p>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-warning/30">
        {allergyRow ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Alergias</h3>
              <p className="text-sm text-muted-foreground">
                {health.allergiesReviewedAt
                  ? `Última revisión ${sinceWords(health.allergiesReviewedAt)}${health.allergiesReviewedBy ? `, por ${memberName(health.allergiesReviewedBy)}` : ""}.`
                  : "Nadie las revisó todavía con el paciente."}
              </p>
              {active.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {active.map((allergy) => (
                    <li key={allergy.id} className="rounded-full border bg-background px-3 py-1 text-sm">
                      {allergyTitle(allergy)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => reviewed.mutate()}>
                {reviewed.isPending ? "Guardando…" : asked ? "Sin cambios" : "No tiene alergias"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                Agregar alergia
              </Button>
            </div>
          </li>
        ) : null}
        {unasked.includes("conditions") ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Enfermedades</h3>
              <p className="text-sm text-muted-foreground">Aún no se le preguntó.</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => denied.mutate("conditions")}>
              {denied.isPending && denied.variables === "conditions" ? "Guardando…" : "Niega enfermedades"}
            </Button>
          </li>
        ) : null}
        {unasked.includes("medications") ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Medicación</h3>
              <p className="text-sm text-muted-foreground">Aún no se le preguntó.</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => denied.mutate("medications")}>
              {denied.isPending && denied.variables === "medications" ? "Guardando…" : "No toma medicación"}
            </Button>
          </li>
        ) : null}
        {declaredHere && !reviewedHere ? (
          // En una línea (revisión final del 15 nov, ux propuesta 3): qué dijo, «Ver lo que dijo» y
          // «Lo revisé con ella», que lo resuelve en un toque. Lo que la franja ya dice no se repite.
          <li className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-sm">
                <span className="font-medium">{oneMark ?? "Sin revisar"}</span>
                {rows.length > 0 ? `: ${summaryOf(rows.map((row) => row.short))}` : ": datos de su salud que nadie revisó todavía"}
              </p>
              <div className="flex flex-wrap gap-2">
                {rows.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={showing}
                    aria-controls={detailId}
                    onClick={() => setShowing((value) => !value)}
                  >
                    {showing ? "Ocultar lo que dijo" : "Ver lo que dijo"}
                  </Button>
                ) : null}
                <Button type="button" size="sm" disabled={busy} onClick={reviewNow}>
                  {`Lo revisé con ${reviewWho(reviewer, sex)}`}
                </Button>
                {openWide ? (
                  <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openWide({ id: "antecedentes", review: true })}>
                    Corregir algo
                  </Button>
                ) : null}
              </div>
            </div>
            {/* Una columna: se lee igual a 390 px y con el panel lateral abierto (sin columnas que se aplasten). */}
            <div id={detailId} hidden={!showing}>
              <DetailList columns={1}>
                {rows.map((row) => (
                  <DetailField key={row.label} label={row.label}>
                    {row.value}
                  </DetailField>
                ))}
                {saidAllergies.length > 0 && others.length > 0 ? (
                  <DetailField label="Ya tenía anotadas">{others.map((allergy) => allergyTitle(allergy)).join(", ")}</DetailField>
                ) : null}
              </DetailList>
            </div>
          </li>
        ) : null}
        {confirmPregnancy && pregnancy ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Embarazo por confirmar</h3>
              <p className="text-sm text-muted-foreground">
                {pregnancyWords(pregnancy).detail.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}. Ya pasó
                el tiempo de un embarazo o no tiene fecha: anota en sus antecedentes cómo está hoy.
              </p>
            </div>
            {openWide ? (
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openWide({ id: "antecedentes", review: true })}>
                Actualizar en antecedentes
              </Button>
            ) : null}
          </li>
        ) : null}
      </ul>
      {unasked.length > 0 && openWide ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* Lo que sí tiene se escribe en Antecedentes, encima de la atención: al cerrar se sigue aquí. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => openWide({ id: "antecedentes", review: true })}
          >
            Registrar enfermedades o medicación
          </Button>
        </div>
      ) : null}
      {reviewed.error || denied.error ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(reviewed.error ?? denied.error)}
        </p>
      ) : null}
      <AllergyFormDrawer patientId={patientId} patientName={patientName} open={adding} onClose={() => setAdding(false)} />
    </section>
  )
}
