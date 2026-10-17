# 0043 · Un dato, un lugar: personas, citas y dinero

Fecha: 2026-10-16 · Estado: aceptada · Precisa [0027](0027-escribirle-y-avisar-la-cita.md), [0029](0029-una-persona-una-pagina.md), [0034](0034-un-plan-una-seccion.md) y [0037](0037-su-enlace-y-portal-en-un-paso.md)

## Problema

La revisión de la fase 4 (tablero 2b) encontró reglas y datos repetidos que ya daban respuestas distintas: Reportes sumaba todas las opciones de un presupuesto; el representante del registro se creaba con un `insert` propio y fallaba con el segundo hijo de la misma madre; la receta de quien cumplió 18 todavía podía ir a su madre; WhatsApp decía el nombre comercial y «Su enlace» el de la cuenta, que nadie podía cambiar; el enlace, el portal y el agente ofrecían otras horas y confirmaban, cambiaban y cancelaban con reglas distintas; el portal decía otros montos que Caja; el saldo no descontaba lo que la persona tenía a favor; el contacto de emergencia eran tres campos de texto junto a las personas vinculadas.

## Decisión y motivo

Cada cosa tiene una regla o un dato, y todas las vías lo leen:

- **Nombre visible**: el nombre comercial, obligatorio, en todo lo que ve la persona; la razón social solo en el comprobante y lo legal. La base lo copia en `organization.name` (disparador), así las pantallas de la cuenta, el chat web y el registro público leen lo mismo sin que nadie lo sincronice a mano.
- **A quién se le manda**: la regla de quién decide (`listDecisionRecipients`), con la edad contada con el día de la clínica.
- **Personas**: `createPerson` es la única forma de crearlas; quien ya tiene ese documento se reutiliza. Un solo buscador.
- **La cita de la persona**: una regla (`own-appointment.ts`) para el enlace y el portal; las horas que se ofrecen usan el mismo paso para enlace, portal y agente.
- **Montos**: una fórmula (`accountBalances`): «Debe · A favor · Saldo», con el saldo descontando lo que tiene a favor. Aplicarlo es el cobro de caja sin dinero nuevo, que deja su ticket.
- **Contacto de emergencia**: una marca sobre una persona vinculada, con el parentesco HL7, como `Patient.contact` de FHIR.
- **Teléfono y WhatsApp** (precisa ADR 0027): el teléfono pasa a ser su WhatsApp solo por decisión del equipo («Usarlo como su WhatsApp»); si WhatsApp lo rechaza, la identidad queda marcada («Este número no tiene WhatsApp»); un mensaje desde el teléfono de una ficha solo pregunta «¿Es ella?» y se une con «Reasignar canal» al confirmarlo alguien.

## Alternativas descartadas

- *Mantener `organization.name` y `trade_name` y elegir uno al leer*: cada lector elegiría distinto, como ya pasaba.
- *Unir al que escribe con la ficha por su teléfono*: lo prohíbe la regla raíz; un teléfono compartido no identifica a nadie.
- *Seguir mostrando «Por cobrar» sin descontar el crédito*: la persona recibe «Saldo vencido» cuando no debe nada.
- *Contacto de emergencia como texto*: otra ficha paralela de una persona que muchas veces ya está vinculada.

## Consecuencias

- Lo que ve la persona coincide en todas partes y las reglas cambian en un solo lugar.
- Sacrificio: más filas en `patient_contact` (cada contacto de emergencia declarado es una persona) y una consulta más al abrir una persona (el estado de su WhatsApp).
- Revisar si una clínica necesita mostrar la razón social a sus pacientes fuera de lo legal.

## Referencias

- `packages/services/src/responsibilities.ts`, `own-appointment.ts`, `payments.ts` (`accountBalances`), `clinic-identity.ts`, `contacts.ts` (`phoneWhatsAppState`, `phoneMatchOf`), `patients.ts` (`declareEmergencyContact`), `person-search.ts`.
- `packages/db/drizzle/0106_un_dato_un_lugar.sql`.
