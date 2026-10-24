import {
  conditionLabel,
  dentalProfileFor,
  FDI_ADULT,
  FDI_CHILD,
  isValidTooth,
  surfaceLabel,
  surfacesForTooth,
  TREATMENT_KINDS,
  TREATMENT_PHASE_LABELS,
  TREATMENT_PHASES,
  type TreatmentPhase,
  variantLabel,
} from "@odentia/dental"
import { FindingChoices } from "../../components/dental/dictation-finding-choices"
import { LeavesFindingField, leavesFindingBody } from "../../components/dental/leaves-finding-field"
import { SignedOdontogramFact } from "../../components/dental/odontogram-assessments"
import { useSignedOdontogramPapers } from "../../components/dental/signed-odontogram-papers"
import { OdontogramaTab } from "../../components/dental/odontograma-tab"
import { PeriodontogramaTab } from "../../components/dental/periodontal/periodontograma-tab"
import { ToothSelector } from "../../components/dental/tooth-selector"
import { ToothSiteSelector } from "../../components/dental/tooth-site-selector"
import { useActiveFindings } from "../../lib/dental/use-odontogram"
import type { ProductSiteUi, ProductUi } from "@odentia/clinic-app/product/product-ui"
import { dentalEncounter } from "./encounter"
import { dentalHealth } from "./health"

/** El «dónde» de odentIA: la pieza en FDI (ISO 3950) y sus caras. */
const dentalSite: ProductSiteUi = {
  placeLabel: "Pieza",
  placesLabel: "Piezas",
  allPlacesLabel: "Todas las piezas",
  placeGroups: [
    { label: "Permanentes", places: FDI_ADULT },
    { label: "Temporales", places: FDI_CHILD },
  ],
  isPlace: (value) => FDI_ADULT.includes(value) || FDI_CHILD.includes(value),
  placeName: (place) => `Pieza ${place}`,
  PlacesPicker: (props) => <ToothSelector {...props} />,
  SitePicker: (props) => <ToothSiteSelector {...props} />,
  partsOf: (place) => (isValidTooth(place) ? surfacesForTooth(place) : []),
  partName: surfaceLabel,
  findingName: conditionLabel,
}

/** Para qué es cada fase del plan dental. */
const PHASE_HINTS: Record<TreatmentPhase, string> = {
  urgencia: "Dolor, infección, trauma",
  basica: "Control de caries y periodonto",
  quirurgica: "Exodoncias, cirugía e implantes",
  rehabilitadora: "Prótesis, coronas, ortodoncia",
  mantenimiento: "Controles periódicos",
}

/**
 * odentIA: lo que el producto dental agrega a las pantallas comunes (ADR
 * 0079). La app lo declara al arrancar (`router.tsx`).
 */
export const dentalUi: ProductUi = {
  product: "dental",
  record: {
    sections: [
      {
        id: "odontograma",
        label: "Odontograma",
        needsRecord: true,
        render: ({ patientId, record, place, openSection }) => (
          <OdontogramaTab
            patientId={patientId}
            initialTooth={place}
            birthDate={record?.patient.birthDate}
            onOpenItem={(itemId) => openSection("plan", { itemId })}
            onOpenPlans={() => openSection("plan")}
          />
        ),
      },
      {
        // Debajo de Odontograma (issue 49, decisión 1): las encías están junto a los dientes.
        id: "periodontograma",
        label: "Periodontograma",
        parent: "odontograma",
        render: ({ patientId, opened, openSection }) => (
          <PeriodontogramaTab
            patientId={patientId}
            initialChartId={opened}
            onToothHistory={(tooth) => openSection("historia", { place: tooth })}
          />
        ),
      },
    ],
  },
  site: dentalSite,
  useFindings: useActiveFindings,
  dictation: {
    // Un hallazgo dictado al que le falta lo que pide la norma (issue 109).
    SuggestionChoices: (props) =>
      props.item.kind === "odontograma" ? <FindingChoices {...props} /> : null,
  },
  // Lo dental del país: `dentalProfileFor` (ADR 0036 y 0079).
  country: {
    specialtiesNorm: (country) => {
      const source = dentalProfileFor(country).specialties.source
      return source ? `Las de su norma (${source})` : "Lista general de odentIA"
    },
    normRows: (country) => [
      ["Odontograma", dentalProfileFor(country).odontogram?.standard ?? "Numeración FDI"],
    ],
    professional: (country) => dentalProfileFor(country).professional,
  },
  plan: {
    phases: TREATMENT_PHASES.map((key) => ({
      key,
      label: TREATMENT_PHASE_LABELS[key],
      hint: PHASE_HINTS[key],
    })),
    defaultPhase: "basica",
  },
  services: {
    kinds: TREATMENT_KINDS.map((kind) => ({ key: kind.key, name: kind.name })),
    // Lo tratado queda dibujado (fase 3, paso 5): lo que un servicio deja en la pieza al completarse.
    leaves: {
      label: "Deja en la pieza",
      Field: (props) => <LeavesFindingField {...props} />,
      body: leavesFindingBody,
      words: ({ condition, variant }) =>
        [conditionLabel(condition), variantLabel(condition, variant)].filter(Boolean).join(" · "),
    },
  },
  // El odontograma firmado (solo en Perú; ADR 0036): un hecho de la historia y de la atención que lo firmó.
  history: {
    owns: (type) => type === "odontogram_signed",
    Item: ({ item, patientId }) => (
      <div className="flex flex-col gap-2 elevated rounded-xl border bg-card p-6">
        <SignedOdontogramFact patientId={patientId} assessmentId={item.refId} />
      </div>
    ),
    EncounterSigned: ({ patientId, encounterId }) => (
      <SignedOdontogramFact patientId={patientId} encounterId={encounterId} />
    ),
  },
  documents: {
    kind: { filter: "odontogramas", label: "Odontogramas", nouns: ["odontograma", "odontogramas"] },
    usePapers: useSignedOdontogramPapers,
  },
  encounter: dentalEncounter,
  health: dentalHealth,
  summary: { ClinicalCards: () => null },
}
