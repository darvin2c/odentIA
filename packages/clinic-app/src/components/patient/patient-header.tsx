import {
  documentText,
  formatMoney,
  MEDICATION_CLASSES,
  type MedicationClass,
  type MedicineClassAnswer,
  medicationAlertWords,
  medicationClassOf,
} from "@odentia/clinical"
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import {
  ConfirmDialog,
  HeaderCompactProvider,
  MobileNavTrigger,
  PageHeaderMenu,
  PersonAvatar,
  submitErrorMessage,
  useHeaderUtilities,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageCircle, MoreHorizontal } from "lucide-react"
import { useId, useState } from "react"
import { allergyName } from "../../lib/allergies"
import { apiFetch } from "../../lib/api"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { changedHistoryOf, declaredMarkWords, noAllergiesWords, pregnancyChip, shortDay, unchangedWords } from "../../lib/declared-health"
import { useCan, usePermission } from "../../lib/crm"
import { accountHeaderWords, fetchPatientAccount3 } from "../../lib/finance-collect"
import { label } from "../../lib/glossary"
import { clinicToday } from "../../lib/inventory"
import { useOrgLocale } from "../../lib/locale"
import { sexLabel, speaksForWords } from "../../lib/patient-overview"
import {
  ageFrom,
  type DeclaredHealthGroup,
  fetchPatientHealth,
  hcLabel,
  isCurrentMedication,
  type PatientFull,
  type PatientHealth,
  type SaidHealth,
  type PatientSummary,
} from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonPage, relationshipText } from "../../lib/people"
import { personHeaderRules } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"
import type { BookingSeed } from "../agenda/booking-drawer"
import { openBookingAnywhere } from "../agenda/schedule-host"
import { useOpenRecordPanel } from "../person/record-panel"
import { PersonLink } from "../person-link"
import { WriteToPersonDialog } from "../write-to-person"
import { CollectButton } from "./collect-flow"
import { FiliacionSectionDrawer } from "./filiacion-section-drawer"
import { NewEncounterButton } from "./new-encounter-button"
import { StaleEncounterNotice } from "./stale-encounter"
import { UpcomingLine, usePersonUpcoming } from "./next-up"
import { PatientAvatar } from "./patient-avatar"
import { PersonalLinkActions } from "./send-personal-link"
import { beforeVisitKey, beforeVisitWords, fetchBeforeVisit, healthToReviewWords } from "../../lib/before-visit"
import { useOpenWide } from "./wide-section"

/** Alertas prioritarias: primero alergias severas, luego el resto. Siempre visibles, nunca tras un desplegable. */
export function clinicalAlerts(
  detail: Pick<PatientFull, "activeAllergies" | "activeConditions" | "currentMedications">,
): Array<{ id: string; label: string; tone: "destructive" | "warning" | "secondary" }> {
  // Criticidad alta (riesgo de reacción grave) o gravedad severa encabezan;
  // una alergia descartada ya no alerta.
  const allergies = detail.activeAllergies.filter((a) => a.verification !== "descartada")
  const critical = (a: (typeof allergies)[number]) =>
    a.severity === "severa" || a.criticality === "alta"
  const severe = allergies.filter(critical).map((a) => ({
    id: a.id,
    label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"} ${a.severity === "severa" ? "severa" : "de criticidad alta"}: ${allergyName(a)}`,
    tone: "destructive" as const,
  }))
  const other = allergies
    .filter((a) => !critical(a))
    .map((a) => ({
      id: a.id,
      intolerance: a.kind === "intolerancia",
      label: `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"}: ${allergyName(a)}${a.severity === "desconocida" ? "" : ` (${label("alergia", a.severity).toLowerCase()})`}`,
      // Toda alergia alerta al menos como una enfermedad (QA de la ficha del 10 nov, B1).
      tone: "warning" as const,
    }))
  const conditions = detail.activeConditions.map((c) => ({
    id: c.id,
    label: c.name,
    tone: "warning" as const,
  }))
  // Lo que toma, con su nombre: un anticoagulante cambia la anestesia y la hemostasia
  // (mesa del 9 nov). Un anticoagulante o una medicina para los huesos (grupos ATC B01A y M05B)
  // llevan su marca, «Anticoagulante: warfarina 5 mg», y van antes que lo demás (mesa del 13 nov).
  const medications = detail.currentMedications.map((m) => {
    const words = medicationAlertWords(m)
    return { id: m.id, label: drugWords(words.label), tone: words.group ? ("warning" as const) : ("secondary" as const) }
  })
  const marked = medications.filter((m) => m.tone === "warning")
  // El mismo orden que la línea fija de la atención (`alertsByRisk`): toda alergia antes que el
  // anticoagulante, y las intolerancias después (QA de diseño del 18 nov, H12: arriba iba al revés).
  const plain = ({ intolerance: _intolerance, ...alert }: (typeof other)[number]) => alert
  return [
    ...severe,
    ...other.filter((a) => !a.intolerance).map(plain),
    ...marked,
    ...other.filter((a) => a.intolerance).map(plain),
    ...conditions,
    ...medications.filter((m) => m.tone !== "warning"),
  ]
}

/**
 * El nombre del medicamento después de su marca, en minúscula como en la línea de anestesia, se
 * haya escrito como se escriba: «Anticoagulante: apixabán», «Medicina para los huesos: alendronato»,
 * «Toma losartán» (QA de diseño del 18 nov, H12). Una sigla («AAS») queda como está.
 */
export function drugWords(label: string): string {
  return label.replace(/^(Toma |[^:]+: )(\p{Lu})(?=\p{Ll})/u, (_all, head: string, first: string) =>
    `${head}${first.toLocaleLowerCase("es")}`,
  )
}

/**
 * Las alertas en una línea, por riesgo (P12, la voz clínica): la alergia grave; que no se le
 * preguntó por alergias; las demás alergias; el anticoagulante o la medicina para los huesos; las
 * intolerancias; el embarazo; las enfermedades; lo demás que toma; y al final «Niega alergias».
 * Toda alergia va antes que el anticoagulante (QA del 16 nov, Q6): en el teléfono la alergia a
 * penicilinas quedaba detrás de «+1», justo al recetar. Con pocas a la vista, nunca queda «Niega
 * alergias» con el anticoagulante escondido en «+N».
 * Son las mismas que la franja de arriba (`clinicalAlerts`): no es otra fuente. `short` es el
 * rótulo del teléfono, donde caben dos: «Alergia: penicilinas» y «Warfarina».
 */
export function alertsByRisk(
  detail: Pick<
    PatientFull,
    "activeAllergies" | "activeConditions" | "currentMedications" | "allergyReview" | "allergySaidUnknown"
  >,
  health: (Pick<PatientHealth, "pregnancy"> & Partial<Pick<PatientHealth, "said">>) | null | undefined,
  sex?: string | null,
): Array<{ id: string; label: string; short: string; tone: "destructive" | "warning" | "secondary" }> {
  const allergyOf = new Map(detail.activeAllergies.map((row) => [row.id, row]))
  const medicationOf = new Map(detail.currentMedications.map((row) => [row.id, row]))
  const alerts = clinicalAlerts(detail).map((alert) => {
    const allergy = allergyOf.get(alert.id)
    const medication = medicationOf.get(alert.id)
    const short = allergy
      ? `${allergy.kind === "intolerancia" ? "Intolerancia" : "Alergia"}: ${allergyName(allergy)}`
      : // El grupo y la dosis se leen al tocar «+N» o arriba: en el teléfono, el nombre.
        medication && alert.tone === "warning"
        ? medication.name
        : alert.label
    return { ...alert, short }
  })
  const allergyIds = new Set(detail.activeAllergies.map((row) => row.id))
  const intoleranceIds = new Set(
    detail.activeAllergies.filter((row) => row.kind === "intolerancia").map((row) => row.id),
  )
  const medicationIds = new Set(detail.currentMedications.map((row) => row.id))
  const noAllergies = !detail.activeAllergies.some((row) => row.verification !== "descartada")
  // Lo que oyó Clío y nadie confirmó, como en la franja: gana a «no se le preguntó» y a «Niega
  // alergias», que dirían otra cosa de lo mismo (QA del 22 nov, H11).
  const said = saidHealthAlerts(health?.said ?? []).map(({ key: _key, ...alert }) => ({ ...alert, short: alert.label }))
  const saidAllergies = said.some((alert) => alert.id === "dicho-allergies")
  const unasked =
    noAllergies && detail.allergyReview === "unknown" && !saidAllergies
      ? [
          {
            id: "alergias",
            // La misma frase que la franja, la ficha y la atención (revisión del 16 nov, R14).
            label: noAllergiesWords({ review: "unknown", saidUnknown: detail.allergySaidUnknown }, sex),
            tone: "warning" as const,
          },
        ].map((alert) => ({ ...alert, short: alert.label }))
      : []
  const denies =
    noAllergies && detail.allergyReview === "none" && !saidAllergies
      ? [{ id: "alergias", label: "Niega alergias", short: "Niega alergias", tone: "secondary" as const }]
      : []
  const pregnancy = health?.pregnancy
    ? [
        {
          id: "embarazo",
          label: pregnancyChip(health.pregnancy),
          short: pregnancyChip(health.pregnancy),
          tone: health.pregnancy.state === "vigente" ? ("warning" as const) : ("secondary" as const),
        },
      ]
    : []
  const mildAllergy = (alert: (typeof alerts)[number]) => allergyIds.has(alert.id) && alert.tone !== "destructive"
  return [
    ...alerts.filter((alert) => alert.tone === "destructive"),
    ...unasked,
    ...said.filter((alert) => alert.tone === "warning"),
    ...alerts.filter((alert) => mildAllergy(alert) && !intoleranceIds.has(alert.id)),
    ...alerts.filter((alert) => medicationIds.has(alert.id) && alert.tone === "warning"),
    ...alerts.filter((alert) => mildAllergy(alert) && intoleranceIds.has(alert.id)),
    ...pregnancy,
    ...alerts.filter((alert) => !allergyIds.has(alert.id) && !medicationIds.has(alert.id)),
    ...alerts.filter((alert) => medicationIds.has(alert.id) && alert.tone !== "warning"),
    ...said.filter((alert) => alert.tone !== "warning"),
    ...denies,
  ]
}

/** «No se le preguntó» no es «dijo que no»: lo que se sabe de cada clase, en la atención. */
const CLASS_ANSWER_WORDS: Record<Exclude<MedicineClassAnswer["answer"], "yes">, (said: boolean) => string> = {
  unasked: () => "no se le preguntó",
  saidYes: () => "dijo que toma, falta anotar cuál",
  took: () => "la tomó antes, hoy no",
  no: (said) => (said ? "dijo que no" : "no toma"),
  unknown: () => "no sabe",
  // Se le preguntó y no respondió («Saltar» en «Tus medicinas»): su enlace se lo vuelve a preguntar.
  skipped: () => "no respondió",
}

/** Lo declarado que llega a quien solo ve las alergias, como grupos de la franja. */
function receptionGroups(
  detail: Pick<PatientFull, "allergySaidNo" | "declaredAllergies">,
): DeclaredHealthGroup[] {
  const only = (by: DeclaredHealthGroup["by"], at: string | null, allergies: string[], saidNo: boolean) => ({
    by,
    at,
    allergies,
    conditions: [],
    medications: [],
    pregnancy: false,
    saidNo: { allergies: saidNo, conditions: false, medications: false },
  })
  if (detail.declaredAllergies)
    return detail.declaredAllergies.map((group) => only(group.by, group.at, group.allergies, group.saidNo))
  return detail.allergySaidNo ? [only(detail.allergySaidNo.by, detail.allergySaidNo.at, [], true)] : []
}

/**
 * Franja clínica reutilizable (cabecera y editor de atención): alergias,
 * enfermedades, lo que toma y el embarazo, sin botones. Sin alergias
 * registradas dice si niega o si no se le preguntó (`allergyReview`): no es lo
 * mismo. Lo que se dijo y nadie revisó va en una caja cerrada por
 * declaración, con su marca adentro («Lo dijo ella el 13 nov, sin revisar»),
 * alergias incluidas; lo confirmado queda fuera de toda caja. Lo grave va
 * primero, sea de quien sea, y el límite solo corta por la cola (QA del 14
 * nov). Quién lo dijo, cuándo y qué entra ahí lo dice el servidor
 * (`health.declared`, un grupo por declaración): con dos fechas o dos personas
 * salen dos cajas, y nada se le atribuye a quien no lo dijo.
 */
export function PatientClinicalStrip({
  detail,
  onAntecedentes,
  medicationReview,
  health,
  sex,
  medicineClasses = false,
  child = false,
}: {
  detail: Pick<
    PatientFull,
    | "activeAllergies"
    | "activeConditions"
    | "currentMedications"
    | "allergyReview"
    | "allergySaidNo"
    | "allergySaidUnknown"
    | "declaredAllergies"
  >
  onAntecedentes?: () => void
  /** Para quien lee la historia: si se le preguntó qué toma (sin medicación registrada). */
  medicationReview?: string | null
  /** La salud de quien lee la historia: de aquí salen las marcas de lo declarado y el embarazo. */
  health?: PatientHealth | null
  /** El sexo registrado del paciente, para decir «ella» o «él»; sin él no se supone. */
  sex?: string | null
  /**
   * La atención dice también lo que no se sabe de anticoagulantes y medicinas para los huesos: «No
   * se le preguntó», «dijo que no» o «no sabe» (mesa del 13 nov). La ficha muestra solo la marca.
   */
  medicineClasses?: boolean
  /** Un menor de 12: no se le preguntan anticoagulantes ni medicinas para los huesos (K7). */
  child?: boolean
}) {
  const stripId = useId()
  const noAllergies = !detail.activeAllergies.some((a) => a.verification !== "descartada")
  // Quien solo ve las alergias (recepción) recibe de lo declarado solo las alergias y su «No», con
  // quién lo dijo y cuándo: la misma caja, sin nada más de su salud (QA del 14 nov, H5 de clínica).
  const groups: DeclaredHealthGroup[] = health?.declared ?? receptionGroups(detail)
  const groupIndex = (find: (group: DeclaredHealthGroup) => boolean): number | null => {
    const index = groups.findIndex(find)
    return index === -1 ? null : index
  }
  const pregnancy = health?.pregnancy ?? null
  // Lo que dijo que cambió, por dato (revisión final del 15 nov, dev H2): lo de antes va junto a lo de
  // hoy de su misma clase, y nunca como otro chip vigente que se esconde tras «+N».
  const history = changedHistoryOf({ changed: health?.changed, medications: detail.currentMedications }, sex)
  const beforeIds = new Set([...(health?.changed?.conditions ?? []), ...(health?.changed?.medications ?? [])])
  // El «No» que marcó la persona (o quien habla por ella) no es «Niega alergias»: nadie se lo preguntó.
  const saidNoAllergies = noAllergies ? groupIndex((group) => group.saidNo.allergies) : null
  // En la atención, lo que no se sabe de cada clase; lo que toma ya va en su marca. La medicina para
  // los huesos que tomó antes va también en la ficha: el riesgo de una extracción sigue (B3).
  // A un niño no se le preguntan: «Anticoagulante: dijo que no · huesos» no le sirve a quien lo atiende (K7).
  // Lo que dijo en una consulta en curso y nadie confirmó (lo oyó Clío): avisa ya, como lo declarado,
  // sin frenar nada (mesa del 20 nov 2026). Lo que cambia la anestesia o la receta, no su boca.
  const saidNow = saidHealthAlerts(health?.said ?? [])
  const saidKeys = new Set(saidNow.map((alert) => alert.key))
  const classWords = health?.medicineClasses && !child
    ? (Object.keys(MEDICATION_CLASSES) as MedicationClass[]).flatMap((key) => {
          // Lo dicho en la consulta ya lo dice su aviso: no se contradice con «no se le preguntó».
          if (saidKeys.has(key)) return []
          const known = health.medicineClasses?.[key]
          if (!known || known.answer === "yes" || (!medicineClasses && known.answer !== "took")) return []
          // «No sabe» con medicinas sin clase: puede ser una de ellas (QA del 14 nov, C2).
          const unclassed =
            known.answer === "unknown" && detail.currentMedications.some((row) => !medicationClassOf(row.atcCode))
          return [
            {
              key,
              label: `${MEDICATION_CLASSES[key].label}: ${CLASS_ANSWER_WORDS[known.answer](known.said)}${unclassed ? " · revisa sus medicinas" : ""}`,
              warn: known.answer !== "no",
              said: known.said,
            },
          ]
        })
      : []
  const alerts = [
    ...(pregnancy
      ? [
          {
            id: "embarazo",
            label: pregnancyChip(pregnancy),
            // Pasado el término ya no es una alerta: se pide confirmarlo.
            tone: pregnancy.state === "vigente" ? ("warning" as const) : ("secondary" as const),
            group: groupIndex((group) => group.pregnancy),
            changed: false,
          },
        ]
      : []),
    ...(saidNoAllergies !== null
      ? // Su «No» no es una alerta: se dice, sin forma de aviso (revisión final del 15 nov, ux U3).
        [{ id: "alergias-no", label: "Alergias: dijo que no", tone: "secondary" as const, group: saidNoAllergies, changed: false }]
      : []),
    ...clinicalAlerts(detail)
      .filter((alert) => !beforeIds.has(alert.id))
      .map((alert) => {
        const medication = detail.currentMedications.find((row) => row.id === alert.id)
        const before = medication ? history.beforeFor("medications", medication) : history.allergyMark(alert.id)
        return {
          ...alert,
          label: before ? `${alert.label} · ${before}` : alert.label,
          changed: false,
          group: groupIndex(
            (group) =>
              group.allergies.includes(alert.id) || group.conditions.includes(alert.id) || group.medications.includes(alert.id),
          ),
        }
      }),
    // Lo de antes sin nada de hoy a su lado (ya no nombró ninguna de esa clase), con su marca (entrega 10).
    ...(
      [
        ["conditions", detail.activeConditions],
        ["medications", detail.currentMedications],
      ] as const
    ).flatMap(([topic, rows]) =>
      history.alone(topic, rows).map((piece, index) => ({
        id: `cambio-${topic}-${index}`,
        label: piece.line,
        tone: "warning" as const,
        group: null,
        changed: true,
      })),
    ),
    // Su «No sé» o su «No» a una clase de medicina, dentro de la caja de su última declaración (B9).
    ...classWords
      .filter((word) => word.said && groups.length > 0)
      .map((word) => ({
        id: `clase-${word.key}`,
        label: word.label,
        tone: word.warn ? ("warning" as const) : ("secondary" as const),
        group: groups.length - 1,
        changed: false,
      })),
    ...saidNow.map(({ key: _key, ...alert }) => ({ ...alert, group: null, changed: true })),
    // Lo de la entrevista que cambia la cita (el corazón, la anestesia, la lactancia), dentro de la
    // caja de quien lo dijo si nadie lo revisó (QA del 14 nov, causa raíz). Solo quien lee la historia.
    ...(health?.latestAnamnesis
      ? (productUi().health.alerts?.((health.latestAnamnesis.answers ?? {}) as Record<string, unknown>) ?? []).map((alert) => ({
          id: `entrevista-${alert.keys[0]}`,
          label: alert.label,
          tone: "warning" as const,
          group: groupIndex((group) => alert.keys.some((key) => group.interview?.includes(key))),
          changed: false,
        }))
      : []),
  ]
  // Lo grave primero, sea de quien sea (QA del 14 nov, H1): las alergias severas que confirmó el
  // equipo; después cada declaración sin revisar, con su severa delante; después lo demás.
  const severe = (alert: (typeof alerts)[number]) => alert.tone === "destructive"
  const confirmed = alerts.filter((alert) => alert.group === null && !alert.changed)
  // Lo que dijo que cambió, con su marca, después de lo que nadie revisó (entrega 10).
  const saidChanged = alerts.filter((alert) => alert.group === null && alert.changed)
  const ordered = [
    ...confirmed.filter(severe),
    ...groups.flatMap((_group, index) =>
      alerts.filter((alert) => alert.group === index).sort((a, b) => Number(severe(b)) - Number(severe(a))),
    ),
    ...saidChanged,
    ...confirmed.filter((alert) => !severe(alert)),
  ]
  // El límite corta solo por la cola: una alergia severa nunca se va a «+N».
  const shownIds = new Set(
    ordered.filter((alert, index) => index < STRIP_LIMIT || severe(alert)).map((alert) => alert.id),
  )
  const isShown = (alert: (typeof alerts)[number]) => shownIds.has(alert.id)
  const hidden = ordered.length - shownIds.size
  const unchanged = health?.unchanged ?? null
  // La misma frase en la franja, la ficha, la atención y lo que ve recepción (estudio de la atención del
  // 16 nov, E10a). Su «No sé» no es «no se le preguntó» (QA del 15 nov, K16); su «No» va en su caja.
  const allergyWord =
    !saidKeys.has("allergies") &&
    saidNoAllergies === null && noAllergies && (detail.allergyReview === "none" || detail.allergyReview === "unknown")
      ? noAllergiesWords({ review: detail.allergyReview, saidUnknown: detail.allergySaidUnknown }, sex)
      : null
  // Antes de recetar importa saber si se le preguntó qué toma (segunda mesa, latidIA).
  const medicationWord =
    detail.currentMedications.length === 0 && medicationReview === "unknown" && !saidKeys.has("medications") ? "Medicación: no preguntado" : null
  if (alerts.length === 0 && !allergyWord && !medicationWord && classWords.length === 0 && !unchanged) return null
  const moreLabel = `+${hidden} ${hidden === 1 ? "alerta" : "alertas"}`
  const chip = (alert: (typeof alerts)[number]) => (
    <Badge
      key={alert.id}
      variant={alert.tone === "destructive" ? "destructive" : alert.tone === "warning" ? "outline" : "secondary"}
      // Una alergia o enfermedad larga corta línea en vez de ensanchar la página en el teléfono.
      className={cn(
        "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
        alert.tone === "warning" && "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      {alert.label}
    </Badge>
  )
  const more = onAntecedentes ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-auto min-h-11 max-w-full shrink py-1 text-left whitespace-normal sm:min-h-8"
      onClick={onAntecedentes}
    >
      {moreLabel} · ver antecedentes
    </Button>
  ) : (
    <Badge variant="outline" className="h-auto min-h-5 max-w-full py-px text-left whitespace-normal">
      {moreLabel}
    </Badge>
  )
  const item = (alert: (typeof alerts)[number]) => (
    <li key={alert.id} className="flex min-w-0 max-w-full">
      {chip(alert)}
    </li>
  )
  return (
    // Una lista y no un texto suelto: el lector de pantalla dice cuántas alertas hay y qué cae dentro
    // de cada declaración, y lo que viene después de una caja queda fuera de ella.
    <section aria-label="Alertas clínicas" className="min-w-0">
      <ul className="flex flex-wrap items-center gap-2">
        {confirmed.filter((alert) => severe(alert) && isShown(alert)).map(item)}
        {groups.map((group, index) => {
          const said = ordered.filter((alert) => alert.group === index && isShown(alert))
          if (said.length === 0) return null
          const markId = `${stripId}-${index}`
          return (
            // Cada declaración en su caja cerrada, con su marca adentro: lo de otra persona o lo ya
            // revisado nunca queda «detrás» de ella. A lo ancho del teléfono la caja ocupa la línea.
            <li
              key={`${group.by.kind}-${group.by.name ?? ""}-${group.at ?? index}`}
              className="flex w-full min-w-0 max-w-full flex-col gap-1.5 rounded-md border border-dashed border-warning/40 bg-warning-soft/40 px-2 py-1 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center"
            >
              <span id={markId} className="text-xs font-medium">
                {declaredMarkWords(group.by, group.at, sex)}
              </span>
              <ul aria-labelledby={markId} className="flex min-w-0 flex-wrap items-center gap-2">
                {said.map(item)}
              </ul>
            </li>
          )
        })}
        {/* Lo de antes no se borra: queda con su marca hasta que lo revise quien la atiende (entrega 10). */}
        {saidChanged.filter(isShown).map(item)}
        {unchanged ? (
          <li className="flex min-w-0 max-w-full">
            <Badge variant="secondary" className="h-auto min-h-5 max-w-full py-px text-left whitespace-normal">
              {unchangedWords(unchanged.by, unchanged.at, sex)}
            </Badge>
          </li>
        ) : null}
        {confirmed.filter((alert) => !severe(alert) && isShown(alert)).map(item)}
        {allergyWord ? (
          <li className="flex min-w-0 max-w-full">
            {/* «No preguntado» es el estado peligroso: se distingue de «niega» (mesa del 9 nov). */}
            <Badge
              variant="outline"
              className={cn(
                "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
                detail.allergyReview === "unknown" && "border-warning/30 bg-warning-soft text-warning",
              )}
            >
              {allergyWord}
            </Badge>
          </li>
        ) : null}
        {medicationWord ? (
          <li className="flex min-w-0 max-w-full">
            <Badge variant="outline" className="h-auto min-h-5 max-w-full border-warning/30 bg-warning-soft py-px text-left whitespace-normal text-warning">
              {medicationWord}
            </Badge>
          </li>
        ) : null}
        {classWords.filter((word) => !(word.said && groups.length > 0)).map((word) => (
          <li key={word.key} className="flex min-w-0 max-w-full">
            <Badge
              variant="outline"
              className={cn(
                "h-auto min-h-5 max-w-full py-px text-left whitespace-normal",
                word.warn && "border-warning/30 bg-warning-soft text-warning",
              )}
            >
              {word.label}
            </Badge>
          </li>
        ))}
        {hidden > 0 ? <li className="flex min-w-0 max-w-full">{more}</li> : null}
      </ul>
    </section>
  )
}

/** Cuántas alertas caben en la franja antes de «+N»; las severas no cuentan para el corte. */
const STRIP_LIMIT = 6

/** Lo dicho en la consulta que va en la franja: lo que cambia la anestesia, la exodoncia o la receta. */
const SAID_IN_STRIP = new Set([
  "anticoagulants",
  "boneMedicines",
  "medications",
  "conditions",
  "allergies",
  "personal.embarazo",
  "medical.lactancia",
  "dental.problemaAnestesia",
  "dental.corazon",
])

/**
 * «Anticoagulante: dijo apixabán, sin confirmar», «Alergias: no sabe, sin confirmar»: lo que dijo
 * en una consulta en curso y nadie confirmó (`listSaidHealth`), una vez por dato. Lo que nombró
 * avisa en ámbar; su «No» o su «No sé», en gris: no es una alerta, pero tampoco es «no preguntado».
 * Lo de una atención ya firmada sigue avisándose, con el día en que lo dijo («dijo apixabán el 20
 * nov»), hasta que alguien lo revise o diga que no lo registra (revisión del 21 nov, A3). De un mismo
 * dato vale lo último que dijo.
 */
export function saidHealthAlerts(said: readonly SaidHealth[]): Array<{ id: string; key: string; label: string; tone: "warning" | "secondary" }> {
  const seen = new Set<string>()
  const latest = [...said].sort((a, b) => b.at.localeCompare(a.at))
  return latest.flatMap((item) =>
    item.rows.flatMap((row) => {
      if (!SAID_IN_STRIP.has(row.key) || seen.has(row.key)) return []
      seen.add(row.key)
      const label = row.key in MEDICATION_CLASSES ? MEDICATION_CLASSES[row.key as MedicationClass].label : row.label
      // «Ya no la toma» no es «dijo que sí»: lo dejó, sin alarma (QA del 21 nov, H3).
      const stopped = row.value.endsWith("ya no la toma")
      // Su «No sé» no es un «No»: se sabe tan poco como de lo que no se preguntó, y avisa igual (QA del 22 nov, H11).
      const quiet = row.value === "dijo que no" || stopped
      const named = row.value.replace(/,? ?ya no la toma$/u, "")
      const words = stopped
        ? `dijo que dejó ${named.startsWith("sí, no dijo cuál") ? "de tomarlo" : named}`
        : quiet || row.value === "no sabe"
          ? row.value
          : row.value.startsWith("sí, no dijo cuál")
            ? "dijo que sí"
            : `dijo ${row.value}`
      // Lo que corrigió al decirlo también se ve aquí: «dijo apixabán (antes dijo warfarina)» (QA del 21 nov, C2).
      const before = row.before ? ` (antes dijo ${row.before})` : ""
      const when = item.open === false && shortDay(item.at) ? ` el ${shortDay(item.at)}` : ""
      return [{ id: `dicho-${row.key}`, key: row.key, label: `${label}: ${words}${before}${when}, sin confirmar`, tone: quiet ? ("secondary" as const) : ("warning" as const) }]
    }),
  )
}

/** La ficha con lo clínico de la salud: enfermedades activas y lo que toma hoy (la regla del Resumen). */
function withHealth(detail: PatientFull, health: PatientHealth): PatientFull {
  const today = clinicToday()
  return {
    ...detail,
    activeConditions: health.conditions.filter((condition) => condition.status === "activa"),
    currentMedications: health.medications.filter((medication) => isCurrentMedication(medication, today)),
    allergyReview: health.reviewStatus.allergies,
  }
}

/**
 * «Antes de su cita: respondió el 13 nov. Lo lee el equipo clínico.» o «por responder · su enlace
 * se le envió por WhatsApp el 12 nov, 6:10 p. m.», con «Enviarle su enlace» y «Mostrar su código»
 * ahí mismo (mesa de formularios del 13 nov, entrega 10, C10). Es estado, no contenido: lo ve quien
 * edita sus datos (`patients.write`, como «Faltan datos»), sin abrir nada. Sin nada que decir, nada.
 */
function BeforeVisitLine({ patientId, sex }: { patientId: string; sex?: string | null }) {
  const canEdit = usePermission("patients.write")
  const status = useQuery({
    queryKey: beforeVisitKey(patientId),
    queryFn: () => fetchBeforeVisit(patientId),
    enabled: canEdit,
    retry: false,
  })
  const data = status.data?.data
  // Un fallo no tapa la cabecera: la línea simplemente no sale.
  if (!canEdit || !data) return null
  const visit = data.visit
  const words = visit ? beforeVisitWords(visit) : null
  return (
    <>
      {visit && words ? (
        <div className="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:items-center">
          <p>
            <span className="text-muted-foreground">Antes de su cita: </span>
            <span className="font-medium">{words.state}</span>
            {visit.state === "respondio" ? `. ${words.detail}` : ` · ${words.detail}`}
          </p>
          {visit.state === "por_responder" ? <PersonalLinkActions patientId={patientId} missing="" /> : null}
        </div>
      ) : null}
      {data.healthToReview ? (
        // Decisión del dueño (entrega 10): una línea neutra, sin qué dijo; sale aunque no tenga cita.
        <p className="text-sm text-muted-foreground">{healthToReviewWords(data.healthToReview.at, sex)}</p>
      ) : null}
    </>
  )
}

/**
 * Lo que la persona tiene por delante, según quien mira (mesa del 9 nov): su
 * próxima cita a quien ve la agenda y lo que debe o tiene a favor a quien ve la
 * caja, en la cabecera de todas las pestañas. Cada moneda por separado, sin
 * sumarlas (ADR 0135), con las palabras y cifras de la tarjeta de Cobros
 * (`accountHeaderWords`).
 */
function HeaderStatus({
  personId,
  patientId,
  onAccount,
  sex,
}: {
  personId: string
  patientId: string | null
  onAccount: boolean
  /** Para «los revisa quien la atiende»: sin sexo registrado no se supone. */
  sex?: string | null
}) {
  const canAppointments = usePermission("appointments.read")
  const canFinance = usePermission("finance.read")
  const upcoming = usePersonUpcoming(patientId, canAppointments)
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId ?? ""),
    enabled: canFinance && Boolean(patientId),
  })
  const locale = useOrgLocale() ?? "es"
  const showMoney = canFinance && Boolean(patientId)
  const canEditPerson = usePermission("patients.write")
  if (!upcoming && !showMoney && !(canEditPerson && patientId)) return null
  return (
    <section aria-label="Lo que viene" className="flex flex-col gap-1">
      {upcoming ? <UpcomingLine {...upcoming} /> : null}
      {/* «Antes de su cita» va con su próxima cita; «Declaró datos de su salud…» sale aunque no tenga una. */}
      {patientId ? <BeforeVisitLine patientId={patientId} sex={sex} /> : null}
      {showMoney ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Cuenta: </span>
          {account.isPending
            ? "consultando…"
            : account.isError
              ? "no se pudo consultar"
              : accountHeaderWords(account.data?.data.byCurrency ?? [], (cents, currency) =>
                  formatMoney(cents, currency, locale),
                )}
          {!onAccount && !account.isPending && !account.isError ? (
            <>
              {" · "}
              <Link
                to="/people/$personId"
                params={{ personId }}
                search={{ tab: "cuenta" }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Ver Cobros
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Cabecera de la página de la persona (ADR 0029): quién es, qué es para la
 * clínica, quién habla por ella o de quién es responsable, las alergias que
 * alertan y la acción principal del rol. Es la misma antes y después de
 * registrarla: el número de historia aparece al registrarla.
 */
export function PersonHeader({
  person,
  detail,
  summary,
  onAccount,
}: {
  person: PersonPage
  /** Ficha administrativa del paciente, si lo es (alergias, foto, edad). */
  detail?: PatientFull
  /** Resumen clínico ya cargado por la pestaña Clínica (no se pide aquí). */
  summary?: PatientSummary
  /** Ya está en Cobros: el botón de cobrar es el de esa pantalla, no se repite. */
  onAccount: boolean
}) {
  // La página no usa PageHeader; las utilidades globales (avisos) van aquí.
  const utilities = useHeaderUtilities()
  // El disparador del menú lateral en el teléfono, como en el encabezado de página.
  const sidebar = useSidebarOptional()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const canRead = usePermission("patients.read")
  const can = useCan()
  // «Habla por ella» no incluye a quien solo es su contacto de emergencia.
  const speaksFor = person.spokenForBy.filter((other) => !other.emergencyOnly)
  const canMessage = usePermission("conversations.write")
  const canReadChats = usePermission("conversations.read")
  const canCrm = usePermission("crm.read")
  const canRegisterResponsible = usePermission("patients.write")
  // El portal lo dan recepción y quien ve la historia, todos igual (ADR 0156).
  const canPortal = usePermission("clinical.read") || canRegisterResponsible
  // La copia de su historia la descarga quien lee la historia (mesa del 18 nov).
  const canCopy = usePermission("clinical.read")
  const openWide = useOpenWide()
  const openPanel = useOpenRecordPanel()
  const patient = person.patient
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [writeOpen, setWriteOpen] = useState(false)
  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) =>
      apiFetch(`/api/people/${person.id}/archived`, {
        method: "PUT",
        body: JSON.stringify({ archived }),
      }),
    onSuccess: () => {
      setArchiveError(null)
      setArchiveOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["person", person.id] })
      void queryClient.invalidateQueries({ queryKey: ["people"] })
      if (patient) void queryClient.invalidateQueries({ queryKey: ["patient", patient.id] })
    },
    onError: (mutationError: unknown) => setArchiveError(submitErrorMessage(mutationError)),
  })
  const responsibilities = useQuery({
    queryKey: ["responsibilities", patient?.id ?? "none"],
    queryFn: () => fetchResponsibilities(patient?.id ?? ""),
    enabled: canRead && Boolean(patient),
  })
  // Quien lee la historia ve también sus enfermedades y lo que toma, en todas las
  // pestañas (mesa del 9 nov): es la misma lectura que el Resumen, en la misma caché.
  const canClinical = can("clinical.read")
  const health = useQuery({
    queryKey: ["patient-health", patient?.id ?? null],
    queryFn: () => fetchPatientHealth(patient?.id ?? ""),
    enabled: canClinical && Boolean(patient),
  })
  const clinicalHealth = health.data?.data ?? null
  const age = ageFrom(person.birthDate)
  // Menor de edad según el servidor (el día de la clínica), no la hora de este equipo.
  const isMinor = person.isMinor
  const representatives = (responsibilities.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const { primary, book: canBook, edit: canEdit } = personHeaderRules(can, Boolean(patient))
  const docLabel = person.docNumber ? documentText(person.docType, person.docNumber) : null
  const facts = [
    patient ? hcLabel(patient.patientNumber) : null,
    docLabel,
    age ? `${age} ${Number(age) === 1 ? "año" : "años"}` : null,
    person.sex ? sexLabel(person.sex) : null,
  ].filter(Boolean)
  // «Nueva cita» al lado, sin ir a la Agenda. Para quien aún no es paciente crea
  // su ficha mínima unida a la persona.
  const bookSeed: BookingSeed | null = patient
    ? { patient: { id: patient.id, name: person.displayName }, lockedPatient: true }
    : canCrm
      ? { person: { contactId: person.id, name: person.displayName, givenNames: person.givenNames, familyName: person.familyName, phone: person.phone } }
      : null
  const writeTargets = [
    {
      contactId: person.id,
      displayName: person.displayName,
      detail: person.spokenForBy.length > 0 ? "La propia persona" : undefined,
    },
    ...person.spokenForBy.map((other) => ({
      contactId: other.personId,
      displayName: other.displayName,
      detail: relationshipText(other.relationship, other.relationshipDetail),
      isPreferred: other.isPreferred,
    })),
  ]
  const archivedWord = person.archived ? "Archivada" : null
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {sidebar ? <MobileNavTrigger /> : null}
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/people" />}>Pacientes</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{person.displayName}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {/* La miga de pan salta de línea en vez de recortarse: solo el teléfono compacta la fila. */}
        <HeaderCompactProvider value={isMobile}>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
            {utilities?.utilities}
            <PageHeaderMenu />
          </div>
        </HeaderCompactProvider>
      </div>
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            {patient ? (
              <PatientAvatar
                patientId={patient.id}
                name={person.displayName}
                givenNames={person.givenNames}
                familyName={person.familyName}
                storageKey={patient.avatarStorageKey}
              />
            ) : (
              <PersonAvatar
                name={person.displayName}
                givenNames={person.givenNames}
                familyName={person.familyName}
                className="size-20"
                fallbackClassName="text-2xl"
              />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">
                  {person.displayName}
                </h1>
                <Badge variant={person.kind === "por_registrar" ? "warning" : "secondary"}>
                  {PERSON_KIND_LABELS[person.kind]}
                </Badge>
                {patient && isMinor ? <Badge variant="warning">Menor de edad</Badge> : null}
                {archivedWord ? <Badge variant="outline">{archivedWord}</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {[
                  ...facts,
                  !patient && person.responsibleFor.length > 0
                    ? `Responsable de ${person.responsibleFor.length === 1 ? "1 paciente" : `${person.responsibleFor.length} pacientes`}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Sin datos personales todavía"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canMessage && !person.archived ? (
              <Button
                type="button"
                variant={primary === "write" ? "default" : "outline"}
                onClick={() => setWriteOpen(true)}
              >
                <MessageCircle aria-hidden className="size-4" />
                Escribirle
              </Button>
            ) : null}
            {canBook && bookSeed && !person.archived ? (
              <Button
                type="button"
                variant={primary === "book" ? "default" : "outline"}
                onClick={() => openBookingAnywhere(bookSeed)}
              >
                Reservar cita
              </Button>
            ) : null}
            {primary === "charge" && patient && !onAccount ? (
              <CollectButton patientId={patient.id} patientName={person.displayName} />
            ) : null}
            {patient && !person.archived ? (
              <NewEncounterButton
                patientId={patient.id}
                openEncounterId={summary?.openEncounterId}
                openFromSearch
              />
            ) : null}
            {canEdit || (canPortal && patient && !person.archived && openWide) || (canCopy && patient && openWide) ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="icon" aria-label="Más acciones" />}
                >
                  <MoreHorizontal aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit ? (
                  <DropdownMenuItem
                    // Sin la ficha cargada el cajón no tendría qué mostrar.
                    disabled={Boolean(patient) && !detail}
                    onClick={() => {
                      setMenuOpen(false)
                      setEditing(true)
                    }}
                  >
                    Editar datos personales
                  </DropdownMenuItem>
                  ) : null}
                  {canPortal && patient && !person.archived && openWide ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setMenuOpen(false)
                        // La misma sección de Datos, con su estado primero (ADR 0156).
                        openWide({ id: "portal" })
                      }}
                    >
                      Portal del paciente
                    </DropdownMenuItem>
                  ) : null}
                  {canCopy && patient && openWide ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setMenuOpen(false)
                        // El mismo bloque de arriba de Datos › Privacidad y pedidos.
                        openWide({ id: "copia" })
                      }}
                    >
                      Copia de su historia
                    </DropdownMenuItem>
                  ) : null}
                  {canEdit ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setMenuOpen(false)
                        setArchiveError(null)
                        setArchiveOpen(true)
                      }}
                    >
                      {person.archived ? "Recuperar" : "Archivar"}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {patient && speaksFor.length > 0 ? (
          <p className="text-sm">
            <span className="font-medium">{speaksForWords(person.sex)}: </span>
            {speaksFor.map((other, index) => (
              <span key={other.personId}>
                {index > 0 ? ", " : ""}
                <PersonLink contactId={other.personId} isPatient={other.isPatient} inText>
                  {other.displayName}
                </PersonLink>
                <span className="text-muted-foreground">
                  {" "}
                  · {relationshipText(other.relationship, other.relationshipDetail)}
                </span>
                {canReadChats && other.conversationId ? (
                  <>
                    {" · "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => {
                        if (other.conversationId) openPanel?.({ conversationId: other.conversationId, name: other.displayName })
                      }}
                    >
                      Ver su conversación
                    </Button>
                  </>
                ) : null}
              </span>
            ))}
          </p>
        ) : null}
        {patient && (isMinor || representatives.length > 0) ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm">
            {representatives.length > 0 ? (
              <>
                <span className="font-medium">Representante legal:</span>{" "}
                {representatives.map((row) => row.contact.displayName).join(", ")}. Decide
                presupuestos y firma consentimientos por el paciente.
              </>
            ) : responsibilities.isSuccess ? (
              <>
                <span className="font-medium">Sin representante legal registrado.</span> Un menor no
                decide presupuestos ni firma consentimientos por sí mismo.{" "}
                {canRegisterResponsible && !person.archived ? (
                  <button
                    type="button"
                    className="font-medium underline underline-offset-4"
                    onClick={() => openWide?.({ id: "responsables", grant: true })}
                  >
                    Registrar responsable
                  </button>
                ) : null}
              </>
            ) : responsibilities.isError ? (
              "No se pudo consultar quién representa al paciente."
            ) : (
              "Consultando responsables…"
            )}
          </p>
        ) : null}
        <HeaderStatus personId={person.id} patientId={patient?.id ?? null} onAccount={onAccount} sex={person.sex} />
        {detail ? (
          <PatientClinicalStrip
            detail={clinicalHealth ? withHealth(detail, clinicalHealth) : detail}
            medicationReview={clinicalHealth?.reviewStatus.medications ?? null}
            health={clinicalHealth}
            sex={person.sex}
            onAntecedentes={canClinical && openWide ? () => openWide({ id: "antecedentes" }) : undefined}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => {
          if (!archiveMutation.isPending) {
            setArchiveOpen(false)
            setArchiveError(null)
          }
        }}
        title={
          person.archived ? `Recuperar a ${person.displayName}` : `Archivar a ${person.displayName}`
        }
        description={
          person.archived
            ? "Vuelve entera: su página, su ficha y sus conversaciones quedan como estaban. Los enlaces de registro que se anularon al archivar no vuelven."
            : "Se archiva entera: su ficha y sus conversaciones se conservan, pero deja de aparecer en las listas y no admite conversaciones, vínculos ni enlaces de registro nuevos. Se recupera desde esta misma página."
        }
        error={archiveError}
        confirmLabel={person.archived ? "Recuperar" : "Archivar"}
        variant={person.archived ? "default" : "destructive"}
        pending={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate(!person.archived)}
      />
      {editing ? (
        detail ? (
          <FiliacionSectionDrawer
            patient={detail.patient}
            section="identidad"
            open
            onClose={() => setEditing(false)}
          />
        ) : !patient ? (
          <FiliacionSectionDrawer
            person={person}
            section="identidad"
            open
            onClose={() => setEditing(false)}
          />
        ) : null
      ) : null}
      <WriteToPersonDialog
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        people={writeTargets}
        onOpened={(conversationId, target) => openPanel?.({ conversationId, name: target.displayName })}
      />
      {/* La atención que quedó abierta de otro día: qué hacer con ella, sin frenar (10 nov). */}
      {patient && !person.archived ? <StaleEncounterNotice patientId={patient.id} /> : null}
    </header>
  )
}
