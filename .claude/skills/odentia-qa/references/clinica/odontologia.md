# Procesos clínicos de odentIA

El catálogo que supervisa la voz clínica en odentIA. Cada proceso trae dónde vive, qué se comprueba, lo que ya falló (para ver que no vuelva), los huecos conocidos y sus fuentes. Al final están los casos para recorrerlos.

**Cómo se usa:**

- **Comprobaciones:** cada una se marca como cumple, no cumple o no se pudo ver.
- **Ya falló:** errores que encontraron rondas anteriores y se corrigieron; si vuelven, es una regresión y va como alta.
- **Huecos conocidos:** lo que faltaba la última vez que se leyó el código. La voz mira si sigue faltando y cuánto le cuesta al odontólogo o al paciente; un hueco no es un hallazgo solo por estar en esta lista.
- **Rutas abreviadas:** `S` = `packages/services/src/`, `CA` = `packages/clinic-app/src/components/patient/`, `DA` = `apps/dental-clinic/src/`, `D` = `packages/dental/src/`, `C` = `packages/clinical/src/`, `DB` = `packages/db/src/schema/`.
- **La lista crece:** se suma lo que la ronda encuentre y no esté aquí («Para el catálogo» en `voces.md`). Los números de línea cambian, así que se buscan por el nombre.

La atención, la ficha y los documentos son comunes con latidIA (ADR 0079). Lo que cambia en odentIA vive en `DA/product/dental/`, `D/` y `S/dental/`.

**El hilo de la consulta.** Hallazgo → diagnóstico → plan → presupuesto → consentimiento → lo que se hizo → cierre → historia. Un mismo dato (la pieza, el diagnóstico, el tratamiento, la sesión, el precio) tiene que decir lo mismo en cada eslabón y en cada lugar donde se muestra: la atención, la Historia, la pestaña Plan, el odontograma de la ficha, el PDF, el consentimiento, el presupuesto, lo que dice Clío o Sofi y la Ayuda. Se sigue en todos los casos.

---

## El recorrido del paciente en el tiempo

Los procesos de abajo se revisan uno por uno. Este apartado los junta como los vive un paciente a lo largo de meses: primero se le diagnostica todo, después se le arma un plan, el plan se ejecuta sesión por sesión y fase por fase, se termina y pasa a mantenimiento, y años después vuelve. Lo que se pierde entre una etapa y la siguiente no lo ve ninguna revisión por proceso, y por eso este recorrido se hace en cada ronda que toque la atención, el plan o la ficha (caso R1).

En el código, cada tratamiento del plan pasa por los estados `pendiente → programado → en_curso → realizado`, con `suspendido`, `cancelado` y `reemplazado` (`DB/clinical.ts`, `treatment_plan_item`). La decisión del paciente pasa por `pendiente`, `aceptado`, `pospuesto` y `no_elegida`, y la «siguiente acción» de cada tratamiento (definir, presupuestar, decidir, iniciar, reanudar, continuar, completar o controlar) la calcula `deriveNextAction` (`S/treatment-journey.ts`), que se ve en Recorrido (`CA/recorrido-tab.tsx`). En el Perú, el odontograma se firma al inicio del plan, ante nuevos hallazgos, al culminar y al reingresar (NTS 188).

### Etapa 1 · La primera consulta: diagnosticar todo

- [ ] El odontograma inicial queda **completo**, con todas las piezas y no solo la que duele, y se firma como inicio.
- [ ] Hay una revisión periodontal básica (o el periodontograma, si hace falta) y se piden las radiografías que corresponden.
- [ ] Antecedentes, alergias, medicación y ASA quedan revisados antes de indicar nada (P-ODO-02).
- [ ] Si viene por dolor, primero se resuelve la urgencia y el resto del diagnóstico puede seguir en otra cita sin perder lo hecho.
- [ ] Cada hallazgo tiene su diagnóstico y cada diagnóstico su tratamiento indicado, o queda dicho que no se trata.

### Etapa 2 · El plan integral y su decisión

- [ ] El plan junta todo lo indicado y lo ordena en fases (urgencia, básica, quirúrgica, rehabilitadora y mantenimiento) en el orden clínico: primero el dolor y la infección, después las caries y la periodoncia, después la cirugía y al final la rehabilitación.
- [ ] Cada tratamiento dice su pieza, su diagnóstico, sus sesiones y su precio, y el total del plan se entiende.
- [ ] Lo que tiene alternativas va como caminos (P-ODO-08), y el paciente puede aceptar por partes: «hoy la urgencia y la endodoncia; la corona después».
- [ ] Lo aceptado, lo pospuesto y lo rechazado se distinguen en el Plan, la Historia, la caja y lo que dice Sofi.
- [ ] Lo que el paciente pospone no se pierde: queda visible y alguien sabe cuándo volver a ofrecerlo.
- [ ] El consentimiento se pide de lo que se va a hacer, cuando se va a hacer (P-ODO-09).

### Etapa 3 · Ejecutar el plan, sesión por sesión

- [ ] Cada cita sabe qué tratamiento y qué sesión toca, y la atención lo propone (P-ODO-03 y P-COM-03).
- [ ] Al terminar una sesión, la siguiente se reserva con quien atiende y con el plazo clínico correcto.
- [ ] El orden se respeta: no se ofrece la fase rehabilitadora de una pieza con su endodoncia a medias, ni una cirugía sin el raspado previo si el plan lo pide.
- [ ] Un hallazgo nuevo a mitad del plan (una caries que apareció) se suma al plan existente, con su presupuesto y decisión, sin abrir un plan paralelo, y el odontograma se firma como «nuevos hallazgos».
- [ ] Cambiar de opinión a mitad (endodoncia que termina en exodoncia) reemplaza el tratamiento con rastro y ajusta el presupuesto y lo cobrado.
- [ ] Varios profesionales en el mismo plan (el endodoncista hace la endodoncia y el general la corona) ven lo mismo y cada uno firma lo suyo.
- [ ] Lo que se cobra por sesión se cobra cuando se hace (ADR 0159), y el saldo del plan cuadra en todo momento.
- [ ] Si el paciente deja de venir, el tratamiento a medias se nota pronto y se le avisa (P-COM-14).

### Etapa 4 · Terminar el plan

- [ ] Cuando se hace lo último, la app dice que el plan terminó: el odontograma se firma como culminación y el paciente pasa a mantenimiento. **Hoy no hay un cierre del plan**: cada tratamiento termina por su cuenta.
- [ ] Lo que quedó sin hacer (lo pospuesto o rechazado) queda a la vista al cerrar, y no se confunde con terminado.
- [ ] El odontograma final muestra todo lo tratado en azul y ninguna lesión vigente que ya se trató.
- [ ] El saldo queda en cero, o con lo que debe dicho.

### Etapa 5 · Seguimiento y mantenimiento

- [ ] Quedan los controles que tocan (de la endodoncia, del periodonto, de la ortodoncia o de la limpieza), con su frecuencia, y no se duplican.
- [ ] El recordatorio sale a tiempo y lleva a reservar. El control vencido aparece en Inicio y en la ficha (P-ODO-18).
- [ ] En el control se compara con lo de antes: la radiografía de la endodoncia, el sondaje periodontal o el odontograma.

### Etapa 6 · Vuelve tiempo después

- [ ] La ficha cuenta su historia de un vistazo: qué se le hizo, cuándo y qué quedó pendiente.
- [ ] El odontograma parte del último estado, no de cero, y se firma como reingreso si corresponde.
- [ ] Lo pendiente del plan anterior se ofrece y no queda olvidado en un plan viejo.
- [ ] Si la historia estaba bloqueada por inactividad, «Vuelve a atenderse» la abre (P-COM-06).

### Cómo recorrerlo en una ronda

El tiempo no se puede adelantar en la demo. El recorrido se arma así:

1. Una persona nueva, con el prefijo `QA`, hace las etapas 1 a 3 el mismo día, con atenciones seguidas cuando la regla lo permita. Se anota lo que la regla impide hacer el mismo día.
2. Las etapas 3 a 6 se recorren con pacientes de la demo que ya están en cada una: con un plan a medias, con un control vencido, en mantenimiento o sin venir hace años. Si la demo no tiene a alguien en una etapa, es un error de la demo (se informa con su causa en `seed-demo.ts`).
3. En cada etapa se mira la ficha, el Plan, Recorrido, la Historia, Inicio, la caja y lo que diría Sofi: el mismo tratamiento tiene que decir lo mismo en todos.

---

## P-ODO-01 Registro del paciente y su responsable

**Dónde:** `/people` › «Nuevo paciente» (`CA/new-patient-drawer.tsx`), el registro por enlace (`S/patient-registration.ts`) y Datos › Familia y responsables (`CA/responsables-tab.tsx`).

- [ ] Nombres y apellidos en dos campos, nacimiento y un teléfono o correo. Lo demás no traba el registro.
- [ ] Un menor queda con su representante legal, y la representación termina a los 18. Paciente ≠ interlocutor ≠ responsable: el teléfono de la mamá no identifica al niño.
- [ ] Un documento repetido no se une solo: queda retenido para que alguien lo revise (ADR 0001).
- [ ] El celular extranjero (+44) se guarda con su país y se sigue viendo bien después.
- [ ] «¿Es alguna de estas personas?» no cambia el formulario sin que la persona lo elija.
- [ ] El representante legal declarado por el chat («es mi hijo», ADR 0101) no se vuelve representante pleno sin comprobarlo: una tía o una abuela no debería firmar consentimientos ni recibir los papeles de salud. Hoy el documento de prueba existe pero no se exige.
- [ ] Lo que el paciente declara en el enlace queda pendiente de revisión, no como confirmado.
- [ ] Tabaco y alcohol se preguntan. Importan en periodoncia, cirugía e implantes, y hoy solo los pregunta latidIA.
- [ ] El documento del representante escrito al firmar se guarda en su ficha (sin pisar otro distinto) y, mientras falte, entra en «Faltan datos» del menor.
- [ ] Registrar a un menor cuyo responsable no tiene teléfono deja escribirlo ahí mismo, sin salir del registro.

**Ya falló:** el +44 se abría como Perú; «Es esta persona» se movía bajo el cursor y cambiaba el formulario (8 nov, PR 550); al menor le faltaba el DNI del responsable.
**Fuentes:** NTS 139-MINSA; Ley 29414; ADR 0001, 0029, 0044, 0058 y 0109.

## P-ODO-02 Antecedentes, alergias, medicación y ASA

**Dónde:** Clínica › Antecedentes (`CA/antecedentes-tab.tsx`), alergias (`CA/allergies-card.tsx`), la franja de la cabecera (`CA/patient-header.tsx`) y, en la atención, «Pregúntale a…» (`CA/health-review-notice.tsx`).

- [ ] Las alergias severas se ven arriba, en la ficha y en la atención, sin abrir nada.
- [ ] Cada alergia tiene sustancia, reacción y severidad. «No tiene alergias» se distingue de «no se preguntó», y «Niega» no se puede marcar si hay una alergia vigente.
- [ ] La medicación con dosis y frecuencia. Lo que cambia la conducta dental se nota: anticoagulantes y antiagregantes (B01), bifosfonatos y denosumab (M05BA, M05BX), corticoides e inmunosupresores.
- [ ] Las enfermedades que cambian la conducta se ven al decidir: cardiopatía con riesgo de endocarditis, diabetes, hipertensión, embarazo con sus semanas, coagulopatía y radioterapia de cabeza y cuello.
- [ ] La ASA (I a VI) se registra. Si se sugiere a partir de las enfermedades, la decide el odontólogo.
- [ ] «Pregúntale a…» sale solo con lo que de verdad falta, nunca bloquea y desaparece al contestar (ADR 0163). Lo declarado por el paciente no se presenta como confirmado.
- [ ] Quitar una alergia pide motivo y no la borra. La revisión cada 6 meses se pide.
- [ ] El látex como alergia avisa también en los materiales que lo llevan, no solo en la receta.
- [ ] El embarazo declarado (en el registro, en el enlace o en un formulario propio) se ve con sus semanas en la franja de la ficha y al abrir la atención, no solo dentro de la entrevista de salud. Caso: C18, gestante de 30 semanas que se registra sola.
- [ ] El embarazo declarado dice la semana de hoy y deja de mostrarse como vigente pasada la fecha probable de parto.
- [ ] Un «No» a las alergias que dio la persona o su apoderado en línea se lee como «declaró que no tiene», no como «Niega alergias» ni «se le preguntó», hasta que alguien lo revisa con ella.
- [ ] «Ver declaración original» muestra lo que la persona declaró desde su enlace («Tus datos y tu salud»), con su fecha, y no solo el alta que hizo recepción.
- [ ] La misma medicina no queda dos veces ni contradicha cuando se pregunta en general y por su clase (anticoagulante, huesos); la clase se reconoce también por el nombre.
- [ ] A quien nunca se le preguntó por anticoagulantes o medicinas para los huesos, la atención lo dice («no se le preguntó»).

**Ya falló:** se anestesiaba sin antecedentes ni ASA (8 nov, PR 528); un aviso falso de antecedentes «declarados por el paciente» (PR 550).
**Huecos conocidos:** nada cruza un anticoagulante o un bifosfonato con exodoncia, cirugía o implante; no hay aviso de profilaxis antibiótica; la ASA no se sugiere; el látex no avisa en los materiales.
**Fuentes:** clasificación ASA (American Society of Anesthesiologists); profilaxis de endocarditis de la AHA (declaración de 2021); osteonecrosis por medicamentos de la AAOMS (posición de 2022); ADR 0035, 0072 y 0163.

## P-ODO-03 Abrir la atención: «Hoy viene a…», motivo y relato

**Dónde:** «Atender» (`CA/new-encounter-button.tsx`), la atención (`CA/encounter-editor.tsx`) y «Hoy viene a…» (`CA/encounter-visit.tsx`, `S/encounter-visit.ts`).

- [ ] Con o sin cita, la atención sabe a qué viene la persona: la cita de hoy, la sesión que sigue de un tratamiento en curso («sesión 2 de 2»), el control vencido o una urgencia.
- [ ] Un toque en «Continuar hoy» o «Viene a su control» llena el motivo, propone el diagnóstico activo y vincula el tratamiento. **Por la cita y por la ficha hace lo mismo.**
- [ ] Si ya tiene cita para esa sesión otro día, lo dice.
- [ ] Lo que va después de otro tratamiento de la misma pieza (la corona tras la endodoncia en curso) dice «va después de terminar…» y su «Hacerla hoy» queda como segunda opción; es la misma regla de «Qué sigue», Inicio, el enlace y Argos.
- [ ] Continuar un tratamiento no trae un diagnóstico ya resuelto: la corona después de la endodoncia no propone la pulpitis que esa endodoncia resolvió.
- [ ] Motivo, tiempo y relato son campos de la página, sin cajón. Se guardan mientras se escribe.
- [ ] Hay un solo borrador por paciente. Si otro profesional lo toma, queda registrado (`takeOverEncounter`).
- [ ] Se atiende sin cita (ADR 0098) y en domingo o fuera de horario, si la clínica lo permite.
- [ ] Si viene por la cita de un control, «Hoy viene a…» lo sigue diciendo después de usar la cita como motivo, y el cierre nombra el control que se cumple y quién lo indicó.
- [ ] Si la persona escribió su motivo antes de venir (en el cuestionario o en la cita), «Hoy viene a…» lo ofrece con «Usar como motivo»; no hay que copiarlo a mano.

**Ya falló:** la atención sin cita salía en blanco (8 nov, PR 549); por la cita no proponía el diagnóstico, y por la ficha sí (9 nov); «Hoy viene a…» ofrecía «Corona · Hacerla hoy» con la endodoncia en curso (9 nov, tarde).
**Fuentes:** NTS 139-MINSA (motivo, tiempo de enfermedad y relato); ADR 0002, 0003, 0098, 0128, 0139 y 0165.

## P-ODO-04 Examen clínico

**Dónde:** el bloque «Examen clínico» (`DA/product/dental/examination.tsx`, `D/examination.ts`).

- [ ] Signos vitales con su unidad. Una presión alta antes de anestesiar o de una exodoncia se nota: con 180/110 o más, lo electivo se difiere. Hoy no hay aviso.
- [ ] Examen extraoral (ATM, ganglios, labios) e intraoral (encías, lengua, paladar, piso de boca, carrillos y orofaringe), e higiene.
- [ ] Lo que la consulta mira siempre, con un lugar donde anotarlo: apertura bucal, oclusión (clase de Angle), pruebas de vitalidad y percusión antes de una endodoncia, y lesiones de mucosa sospechosas. Hoy todo es texto libre.
- [ ] Un índice de caries (CPOD o ceod) y el riesgo de caries, donde la clínica los use.
- [ ] Es opcional para cerrar y no traba.
- [ ] La ficha odontoestomatológica de la norma tiene dónde anotarse: índice de caries (CPOD o ceod), índice de higiene oral simplificado (placa blanda y calcificada en 16, 11, 26, 36, 31 y 46), riesgo estomatológico (bajo, moderado o alto) y el alta básica con su fecha. Hoy solo caben en un formulario propio.

**Huecos conocidos:** sin oclusión, apertura, vitalidad ni percusión estructuradas; sin tamizaje de cáncer oral; sin índices ni riesgo de caries; sin aviso de presión alta.
**Fuentes:** LOINC y UCUM; ICDAS; CPOD y ceod (OMS, *Oral Health Surveys: Basic Methods*); NTS 139-MINSA/2018/DGAIN, numeral 5.2.2 12) Fichas odonto-estomatológicas, y su «Ficha de evaluación odontológica»; Greene y Vermillion, JADA 1964;68:7-13.

## P-ODO-05 Odontograma

**Dónde:** en la atención, `OdontogramStudio` y `ToothDrawer` (`DA/components/dental/`); en la ficha, Clínica › Odontograma (`odontograma-tab.tsx`), con «Evolución», «Ver estado al» y el historial por pieza (`S/dental/tooth-history.ts`). El registro es `registerToothFinding` (`S/dental/tooth-panel.ts`) y las reglas, `findingIssues` (`D/findings.ts`).

- [ ] Numeración FDI de dos dígitos: 11 a 48 en permanentes (las terceras molares 18, 28, 38 y 48 se pueden elegir) y 51 a 85 en temporales. La dentición mixta de un niño muestra las dos.
- [ ] Las piezas se aciertan con el dedo o el mouse, también a 390 px y en tablet. Las vecinas (46 y 47, 18 y 48) no se confunden.
- [ ] El odontograma inicial está siempre a la vista en la primera consulta, no escondido en «Agregar si ocurrió».
- [ ] **Una lesión con varias caras es un solo hallazgo** en el panel, la lista, la Historia, el «hallazgo que motiva» y el PDF.
- [ ] Las caras corresponden a la pieza: oclusal en posteriores e incisal en anteriores; palatina arriba y lingual abajo.
- [ ] Hallazgo ≠ diagnóstico: la caries es un hallazgo y la pulpitis un diagnóstico. La línea no los mezcla.
- [ ] La lista de profundidades se lee entera; no salen tres opciones que dicen lo mismo cortado.
- [ ] Lo tratado se dibuja solo con la convención de colores (rojo lo que hay que tratar, azul lo que está bien o tratado), y se deshace si se anula el procedimiento.
- [ ] **Al terminar el tratamiento, la lesión que lo motivó queda resuelta**: no queda una caries «vigente» en rojo debajo de una endodoncia terminada.
- [ ] Una pieza ausente o extraída no admite procedimientos de esa pieza, salvo los que la reponen (implante, prótesis).
- [ ] En el Perú, el odontograma se firma en sus momentos (inicio del plan, nuevos hallazgos y culminación; NTS 188), y lo firmado coincide con lo que se ve.
- [ ] Las palabras van en español (no «occlusal»).

- [ ] Cada hallazgo guarda su propio código y no el del diagnóstico elegido junto. Una caries profunda (CDP) no se convierte en pulpitis: el diagnóstico pulpar se sugiere sin marcar y pide evaluar la vitalidad (AAE).

**Ya falló:** la caries quedaba rotulada con el código de la pulpitis elegida en el mismo panel (9 nov); una caries de dos caras contaba como dos hallazgos y quedaba una vigente tras la endodoncia (PR 553); la 38 no se podía elegir (PR 481); las piezas a 390 px medían 20 px; «Evolución» salía vacío sobre la lista.
**Huecos conocidos:** no hay cara cervical (la clase V va como vestibular, palatina o lingual).
**Fuentes:** ISO 3950 (notación FDI); NTS N.° 188-MINSA/DGIESP-2022 (odontograma), aprobada por la RM N.° 559-2022/MINSA (deroga la RM 272-2019/MINSA y la NTS 150), numerales 5.2 a 5.13; ADR 0036 y 0079.

## P-ODO-06 Diagnóstico

**Dónde:** el bloque «Diagnóstico» (`CA/encounter-diagnoses.tsx`) y sus propuestas; las listas en `C/diagnoses.ts` y `S/diagnosis-codes.ts`.

- [ ] El código sale de la lista de la clínica (CIE-10 del MINSA en el Perú, o CIE-11) y no se convierte entre listas.
- [ ] Presuntivo o definitivo, con la pieza y las caras.
- [ ] El buscador encuentra lo que el odontólogo escribe («caries», «pulpitis», «absceso», «periodontitis», «fractura») y por prefijo («extrac»).
- [ ] El diagnóstico se muestra con su nombre, no solo con el código, en la atención, el Plan, la Historia y el PDF.
- [ ] La terminología pulpar y periapical permite decir lo que decide el tratamiento: pulpitis reversible o irreversible, necrosis, periodontitis apical y absceso.
- [ ] Un diagnóstico no salta a otra pieza al indicar en una pieza distinta.
- [ ] «Ya diagnosticado antes» y activo o resuelto. Lo resuelto deja de proponerse.
- [ ] Se anula con motivo, nunca se borra.

**Ya falló:** el diagnóstico pasaba a la pieza anterior al indicar en otra (9 nov); solo con el código en el Plan.
**Fuentes:** CIE-10 (MINSA) y CIE-11 (OMS); terminología diagnóstica de la AAE; ADR 0041, 0053 y 0103.

## P-ODO-07 Plan de tratamiento, caminos y sesiones

**Dónde:** «Plan y controles» de la atención (`CA/encounter-plan-panel.tsx`), la pestaña Plan (`CA/plan-tab.tsx`, `plan-fases.tsx`) y el servicio `S/plan.ts`.

- [ ] Al indicar, la pieza y el diagnóstico vienen del último hallazgo, sin escribirlos de nuevo.
- [ ] El servicio corresponde a la pieza: una endodoncia de molar no se ofrece como «anterior», y el tarifario tiene la de anterior, premolar y molar.
- [ ] El servicio coincide con el grupo de la pieza (anterior, premolar o molar) y la dentición (permanente o temporal); si no, avisa sin frenar y ofrece el mismo servicio del grupo correcto. Sin él en el tarifario, no ofrece otro grupo (la bicúspide no sirve en un molar). Fuentes: CPMS (RM 550-2023-MINSA) y CDT D3310–D3348.
- [ ] El diagnóstico pulpar y la endodoncia coinciden: con necrosis o periodontitis apical, la «no vital»; si no, se avisa antes del consentimiento (AAE). Una endodoncia de permanente en una pieza temporal avisa y ofrece la pulpectomía o pulpotomía de temporales si está activa (AAPD).
- [ ] Caminos alternativos para la misma pieza (endodoncia más corona, o exodoncia) se ven como opciones que no se suman.
- [ ] Las fases (urgencia, básica, quirúrgica, rehabilitadora y mantenimiento) siguen el orden clínico: **la corona no se propone ni se hace antes de terminar la endodoncia de esa pieza**, y lo urgente va primero.
- [ ] Cada tratamiento dice sus sesiones previstas (las habituales del servicio, ADR 0164) y pregunta las sesiones por cualquier camino, también si se indica desde el odontograma.
- [ ] «Sesión N de M» cuenta la de hoy y es igual en la atención, el cierre, la cita y la ficha.
- [ ] Cada renglón indicado hoy tiene «Cambiar» y «Quitar», y «Cambiar» conserva el precio acordado.
- [ ] Avisa si ya se hizo antes en esa pieza.
- [ ] Lo anulado no ensucia el plan con renglones tachados.
- [ ] «Cambiar» un tratamiento por otro de distinto tipo recalcula la fase y las sesiones, y deja verlas y editarlas. Caso: urgencia con exodoncia indicada que se cambia a endodoncia; el cierre no debe traer «Sí, terminar».

**Ya falló:** «Endodoncia anterior vital» se ofrecía para un molar (demo) y el consentimiento firmado decía «anterior · pieza 46» (9 nov); la endodoncia indicada desde el odontograma no preguntaba sesiones y venía «Sí, terminar» marcado (9 nov); la corona antes de terminar la endodoncia del mismo diente (9 nov); «sesión 2» que contaba una cita pasada (PR 550).
**Fuentes:** ADR 0034, 0099, 0153, 0161 y 0164.

## P-ODO-08 Presupuesto del plan

**Dónde:** `CA/plan/plan-budgets.tsx`, `budget-review.tsx`, `budget-response.tsx` y `budget-signing.tsx`; el servicio `S/budgets.ts`.

- [ ] Se arma solo con lo indicado, en una línea honesta: «Opción A S/ … · Opción B S/ … · falta que elija», con un botón principal.
- [ ] Lo que eligió se dice igual en todas partes: «Eligió la opción A», nunca «Aceptó todo» si rechazó una opción.
- [ ] «Preparar presupuesto con lo pendiente» no incluye la opción no elegida.
- [ ] El precio acordado se conserva al cambiar, en la atención, el Plan, la Historia y la caja.
- [ ] Decide la persona o su representante, y la respuesta se puede anotar en el sillón sin imprimir ni enviar.
- [ ] Una revisión pregunta solo lo que cambió.
- [ ] Las dos monedas: lo que está en dólares se debe en dólares hasta que se paga.
- [ ] El odontograma de «Lo que encontramos» muestra la dentición del paciente (temporal o mixta en un niño) y la pieza tratada está en el gráfico.

**Ya falló:** «Aceptó todo» cuando eligió la opción A; la franja con un conteo y un monto que no cuadraban (8 nov); la opción no elegida dentro de lo pendiente (9 nov).
**Fuentes:** ADR 0144, 0145, 0153 y 0159.

## P-ODO-09 Consentimiento informado

**Dónde:** el bloque Documentos de la atención (`CA/encounter-documents.tsx`), la firma (`CA/consent-signing.tsx`) y las plantillas en `/settings/forms` (`C/consent.ts`).

- [ ] Se pide **solo por lo que se hace hoy o por la opción elegida**, no por lo indicado para dentro de semanas.
- [ ] «Firmar ahora» abre el documento que se pulsó.
- [ ] «Firmado en papel» pregunta cuándo se firmó; el consentimiento, su PDF y la Historia dicen esa fecha y, aparte, cuándo se registró (hoy dice la del registro). Caso: CC17.
- [ ] El texto corresponde al procedimiento, la pieza y el diagnóstico de hoy: la corona no dice «reponer piezas ausentes» ni lleva «Pulpitis» como motivo.
- [ ] Tiene procedimiento, beneficios, riesgos, alternativas y consecuencias de no hacerlo.
- [ ] La tablet, el enlace, el papel y el PDF muestran lo mismo, con la misma declaración.
- [ ] Un menor firma por su representante.
- [ ] Toda terapia pulpar (pulpotomía y pulpectomía) pide su consentimiento, y en un menor lo firma su representante. Caso: pulpectomía de una molar temporal en un niño de 7 años.
- [ ] Cerrar sin consentimiento pide escribir por qué, y no traba la atención.
- [ ] Lo firmado por enlace queda pendiente hasta que el profesional lo confirma. Lo firmado se revoca, no se borra.
- [ ] Hay plantilla para lo que se hace a menudo: anestesia local, exodoncia, endodoncia, periodoncia, implante, ortodoncia, blanqueamiento, prótesis, odontopediatría y radiografías.
- [ ] Un consentimiento ya firmado desde Documentos para el mismo procedimiento y la misma pieza cuenta para el tratamiento indicado después; no pide otro.

**Ya falló:** se pedía el consentimiento del camino no elegido (PR 539); «Firmar ahora» de la endodoncia abría la prótesis (8 nov); la declaración no se veía en el enlace (PR 479).
**Fuentes:** Ley 29414 y su reglamento; Ley 26842 (Ley General de Salud); ADR 0033, 0117, 0131 y 0148.

## P-ODO-10 Anestesia local

**Dónde:** «Riesgo anestésico (ASA)» en Antecedentes y la línea del cierre `AnesthesiaHealthLine` (`CA/encounter-closing.tsx`). El anestésico se detecta por el nombre del material (`isLocalAnestheticName`, `C/medications.ts`).

- [ ] Antes de anestesiar se ven las alergias, la ASA, la presión y la medicación, en el momento de decidir y no recién al cerrar.
- [ ] Se puede anotar qué anestésico, con o sin vasoconstrictor, cuántos cartuchos y la técnica (infiltrativa o troncular).
- [ ] La dosis máxima por peso se avisa, sobre todo en niños y en cardiópatas con vasoconstrictor.
- [ ] El aviso no bloquea: el odontólogo decide (ADR 0163).

**Ya falló:** se anestesiaba sin antecedentes ni ASA (PR 528).
**Huecos conocidos:** no hay registro propio de la anestesia (técnica, cartuchos, vasoconstrictor) ni dosis máxima por peso.
**Fuentes:** Malamed, *Handbook of Local Anesthesia*, para dosis máximas por peso y por cartucho; ADR 0106 y 0163.

## P-ODO-11 Procedimientos de hoy

**Dónde:** «Realizado hoy» (`CA/encounter-procedures.tsx`), el servicio de procedimientos en `S/encounters.ts` y los materiales (`CA/encounter-materials.tsx`).

- [ ] «Registrar lo de hoy» ofrece primero lo aceptado y en curso, y el tratamiento aceptado no es el último campo.
- [ ] Se registra la pieza, las caras y una nota de lo que se hizo en la sesión.
- [ ] El código oficial queda congelado (CPMS en el Perú) y el precio es el acordado.
- [ ] No sale el mismo tratamiento dos veces en la lista.
- [ ] Hay atajos para lo de todos los días (profilaxis, «limpieza hecha»).
- [ ] Cada especialidad deja lo que necesita registrar:
  - **Endodoncia:** conductos, longitud de trabajo (conductometría), lima apical, técnica de obturación y radiografías inicial, de conductometría y final.
  - **Exodoncia:** técnica (simple o quirúrgica), sutura, hemostasia e indicaciones.
  - **Implante:** marca, diámetro, largo, lote y torque, para la trazabilidad.
  - **Ortodoncia:** aparatología, arcos y activaciones.
  - **Restauración:** material, clase y caras.
  Hoy ningún procedimiento tiene datos propios.
- [ ] Anular un procedimiento pide motivo y deshace lo dibujado.
- [ ] Tras la medicación intraconducto, la sesión siguiente se propone a 7 días o más (Sjögren y col., Int Endod J 1991;24:119-125; la AAE y la ESE no fijan plazo: confirmar con una clínica real).

**Ya falló:** el procedimiento sin nota de la sesión y el tratamiento duplicado en la lista (8 nov).
**Huecos conocidos:** ningún procedimiento tiene datos propios de su especialidad.
**Fuentes:** CPMS (MINSA); guías clínicas de la AAE (endodoncia).

## P-ODO-12 Periodontograma

**Dónde:** el bloque en la atención (`DA/components/dental/periodontal/`), la pestaña de la ficha (`periodontograma-tab.tsx`) y las reglas en `D/periodontal.ts`.

- [ ] Seis sitios por pieza: profundidad, recesión, pérdida de inserción calculada, sangrado y supuración. Furca de Hamp, movilidad de Miller y placa de O'Leary.
- [ ] Se puede cargar rápido con el teclado, sitio por sitio, sin tocar el mouse.
- [ ] La clasificación AAP/EFP 2017 (estadio, grado y extensión) se propone y la confirma el odontólogo, y deja su código en la atención.
- [ ] La reevaluación se compara con el sondaje inicial y no baja el estadio.
- [ ] El plan periodontal tiene fase I (raspado por cuadrantes), reevaluación y mantenimiento.
- [ ] Lo incompleto se firma como parcial.

**Huecos conocidos:** solo dentición permanente; sin encía queratinizada ni datos mucogingivales.
**Fuentes:** clasificación AAP/EFP 2017 (Papapanou y colaboradores, Tonetti y colaboradores); ADR 0054 y 0142.

## P-ODO-13 Receta

**Dónde:** Documentos › Nuevo › Receta (`S/prescriptions.ts`, `CA/prescription-alerts.tsx`). Los medicamentos dentales en `C/medications.ts`.

- [ ] Cada ítem tiene DCI, concentración, forma, vía, dosis, frecuencia, duración y cantidad, y la cantidad cuadra.
- [ ] La alergia y la reactividad cruzada (penicilina y cefalosporinas; AINE) se avisan, y lo que se vio queda en la receta.
- [ ] **El embarazo y la lactancia avisan** (AINE en el tercer trimestre, tetraciclinas). Hoy odentIA no tiene ningún aviso de embarazo: `S/product-hooks.ts` deja la revisión vacía.
- [ ] Las interacciones que cambian la conducta dental se avisan: anticoagulante con AINE, y metronidazol con alcohol o warfarina.
- [ ] En un niño, la dosis por peso.
- [ ] La profilaxis antibiótica, cuando corresponde, se puede recetar con su dosis y momento (antes del procedimiento).
- [ ] Lo emitido no cambia: se anula y se emite otra. El PDF es legible para la farmacia.
- [ ] Los medicamentos salen en el orden en que se escribieron (el principal primero), en la pantalla y en el PDF.
- [ ] Un colutorio o un gel se receta con su vía (bucal o tópica), no «vía oral».

**Ya falló:** la receta imprimía los ítems en un orden al azar (QA del 11 nov).

**Huecos conocidos:** sin aviso de embarazo ni interacciones en odentIA (latidIA sí avisa del embarazo).
**Fuentes:** Manual de Buenas Prácticas de Prescripción (DIGEMID-MINSA); profilaxis de endocarditis de la AHA (2021); ADR 0132 y 0143.

## P-ODO-14 Imágenes, radiografías y tomografía

**Dónde:** órdenes (`CA/ordenes-tab.tsx`), Documentos (`CA/documentos-panel.tsx`), el visor 2D (`CA/image-viewer.tsx`) y el de tomografía (`CA/tomography-viewer.tsx`).

- [ ] Cada imagen dice su tipo (periapical, bitewing, oclusal, panorámica, cefalométrica o CBCT), su fecha y sus piezas.
- [ ] Se compara la periapical de antes con la de después, lado a lado.
- [ ] La tomografía se ve en panorámica, cortes y 3D; «ir a la pieza» lleva a la correcta y se puede guardar la vista en la atención de hoy.
- [ ] Se mide solo con escala y la medida dice que es orientativa. El visor 2D no mide sin calibrar.
- [ ] El informe queda pendiente, informado o «no requiere», y ligado a su orden.
- [ ] Recepción puede subir una tomografía sin verla.
- [ ] Las órdenes de laboratorio también existen en odentIA: el INR antes de una exodoncia, la glucemia de un diabético y la biopsia vuelven con su resultado a su orden.
- [ ] Una radiografía o un INR subidos días después dicen su fecha de toma o de examen, y la Historia los pone ese día (P-COM-24).
- [ ] En la Historia, la imagen dice su tipo (panorámica, periapical…), no solo «Radiografía».

**Ya falló:** terceras molares, la arcada de la medida y guardar la vista en otro borrador (PR 481).
**Fuentes:** DICOM; ADR 0055, 0056, 0057, 0147 y 0148.

## P-ODO-15 Evolución, cierre y lo que sigue

**Dónde:** el cierre (`CA/encounter-closing.tsx`) y el servicio en `S/encounters.ts`.

- [ ] Para cerrar se piden motivo, diagnóstico con tipo, evolución y colegiatura. Nada más se vuelve obligatorio.
- [ ] «¿Terminaste?» viene marcado solo si llegó a sus sesiones previstas (ADR 0161).
- [ ] El control vencido al que vino viene marcado como cumplido, aunque lo haya indicado otro odontólogo.
- [ ] «¿Cuándo vuelve?» ofrece lo aceptado que sigue (la corona), no solo un control.
- [ ] «Reservar la sesión 2» propone otro día, con quien atendió, y muestra qué odontólogo tiene hueco.
- [ ] Lo que queda por cobrar se dice, y caja lo ve.
- [ ] La firma guarda nombre, título y colegiatura (COP) de quien firma. Después solo se agregan adendas.
- [ ] «Qué sigue» es una sola lista, igual en la ficha, Inicio y la atención.

- [ ] Si una sesión termina en «Falta otra sesión» y lo que va después ya tiene cita, el cierre lo avisa para revisar esa cita.
- [ ] El cierre dice lo que se cargó hoy y una sola cifra de lo que debe, que sigue siendo cierta después de cobrar ahí mismo.
- [ ] Un tratamiento cuyo cobro se devolvió entero no se carga otra vez al firmar la sesión siguiente: el cierre lo dice y por qué, sin pedirle a quien atiende que cobre (ADR 0068).
- [ ] La periodontitis apical o el absceso periapical no se proponen resueltos al terminar la endodoncia: sanan en su control con radiografía. La pulpitis sí.
- [ ] El consentimiento de una corona sobre la propia pieza es el de la corona, no el de prótesis para reponer piezas ausentes.

**Ya falló:** tras un pago parcial, el cierre decía a la vez «Quedó por cobrar S/ 450» y «Debe S/ 200», y en la sesión 2 «ya estaba incluido en lo cobrado» debiendo 200 (9 nov); «Sí, terminar» venía marcado aunque faltaba una sesión; la sesión 2 se proponía el mismo día; el control de otro odontólogo venía desmarcado (8 y 9 nov; PR 524, 533, 535 y 537).
**Fuentes:** NTS 139-MINSA; ADR 0003, 0152 y 0161.

## P-ODO-16 Anular y corregir

**Dónde:** `CA/encounter-void-dialog.tsx`, `S/encounters.ts` (anular), `S/encounter-void-budgets.ts` y la adenda (`CA/encounter-addendum-drawer.tsx`).

- [ ] Un borrador se anula con motivo en pocos clics, también si tiene presupuesto: lo no entregado se anula con él (PR 546).
- [ ] Solo frena lo que de verdad no se puede deshacer (un cobro vigente, una firma de quien decide o algo hecho en otra atención), y lo dice con la salida.
- [ ] Lo anulado deja rastro (quién, cuándo y por qué) y no ensucia el Plan.
- [ ] Una atención firmada se corrige con una adenda, no editándola.
- [ ] Una atención anulada dice qué pasó con su presupuesto.

**Ya falló:** un borrador con dos opciones no se podía anular y no tenía salida (8 nov, PR 546).
**Fuentes:** NTS 139-MINSA (la historia no se borra); ADR 0002 y 0068.

## P-ODO-17 Historia clínica y papeles

**Dónde:** la Historia (`CA/historia-tab.tsx`, `encounter-history-card.tsx`; `S/patient-history.ts`), la hoja para el seguro (`S/attention-sheet.ts`) y el odontograma impreso.

- [ ] Una tarjeta por atención, con lo que se hizo, los hallazgos bajo el odontograma, el precio acordado y quién firmó.
- [ ] «Piezas tratadas» cuenta solo lo hecho o hallado hoy, no las piezas de una imagen adjunta.
- [ ] Se lee sin abrir cada cosa: el diagnóstico con su nombre, la sesión y el estado.
- [ ] Una atención en curso no queda suelta ni se confunde con una firmada.
- [ ] El PDF, el odontograma impreso y la hoja del seguro dicen lo mismo que la pantalla.
- [ ] La copia de la historia y la exportación FHIR traen todo (ADR 0080).
- [ ] La copia marca como anulado lo que viene de una atención anulada, también sus fichas, y el FHIR lo dice en el recurso (`entered-in-error`), no solo en el `Encounter`.
- [ ] Una medicina suspendida sale en la copia con hasta cuándo la tomó, no como vigente.
- [ ] La copia dice el tipo de diagnóstico (presuntivo o definitivo) y quién firmó cada atención, con su título, colegiatura y hora, como la pantalla.
- [ ] La tarjeta plegada dice la sesión y el estado (sesión 2 de 2 · tratamiento terminado; pulpitis resuelta). Lo quitado figura igual plegado y abierto, y una receta cuenta como indicación registrada.

**Ya falló:** la Historia ilegible por evento suelto (PR 551); «¿Vino?» abría «Por confirmar»; la copia daba por vigentes la ficha de una atención anulada y una medicina suspendida (QA de la entrega 2, 14 nov).
**Fuentes:** NTS 139-MINSA; HL7 FHIR R4; ADR 0080, 0115 y 0133.

## P-ODO-18 Controles y seguimiento

**Dónde:** `S/follow-ups.ts`, Inicio («controles vencidos») y la ficha.

- [ ] El control se pide al firmar y se cumple al volver (ADR 0152). Un control y una cita no son dos cosas para el odontólogo.
- [ ] Los controles que se repiten (mantenimiento periodontal, ortodoncia mensual) se generan con su frecuencia.
- [ ] La lista de vencidos de Inicio tiene un número real y lleva a atenderlos.
- [ ] La endodoncia deja un control corto (a 30 días o menos, que puede ir en la cita de la corona) y uno radiográfico de cicatrización (ESE 2006: al menos al año), que no se da por cumplido con el corto.
- [ ] El recordatorio que sale al paciente coincide con el control.
- [ ] Al terminar una endodoncia queda su control clínico y radiográfico al año, además del corto (ESE, Quality guidelines 2006, Int Endod J 39:921-930).

**Ya falló:** «Indica el próximo control» sin botón; el control y la cita separados (6 nov).
**Fuentes:** ADR 0152.

## P-ODO-19 Clío: el dictado

**Dónde:** `CA/dictation-panel.tsx`, `S/encounter-dictation.ts`, `S/dictation-forms.ts`, `CA/formularios-tab.tsx` y `S/dental/dictation.ts`.

- [ ] Lo dictado entra como propuesta y el odontólogo lo confirma. Nada se guarda solo.
- [ ] Lo dictado se suma al texto y no lo borra. Deshacer una corrección por voz no borra un aviso de alergia ya dictado.
- [ ] La receta dictada pasa por las mismas reglas que la escrita, con su cantidad bien calculada.
- [ ] El odontograma dictado pone la pieza y las caras correctas. No dicta movilidad, rotación ni hallazgos que exigen evidencia.
- [ ] Reconoce el motivo y la pulpitis cuando se dicen.
- [ ] Lo que no puede hacer (examen, signos vitales) lo dice.
- [ ] Al reservar y armar el presupuesto (ADR 0102) distingue «cítalo el jueves» (una cita) de «control en 6 meses» (un control); la hora sale de la agenda, no del modelo, y «envíaselo» dicho por voz no envía nada sin confirmar.

- [ ] Con una ficha empezada, lo dictado para ella aparece en su pregunta («Clío: 6 mm · dijiste…»), con su frase y sin repetirse en la consulta; sin ficha empezada no aparece nada. Se confirma en la ficha («Confirmar», «Confirmar las N») y queda «Clío · confirmó…» en la ficha, la Historia y la copia; la barra del dictado no confirma lo de la ficha.
- [ ] En la ficha, el silencio no es «No»; el número o la pieza tienen que estar en la frase; la clase de Angle sin división o sin lado no se llena y lo dice; lo escrito a mano no se cambia.
- [ ] «Dictar» con la ficha abierta no la tapa; al firmar, lo propuesto para la ficha viene marcado y la ficha sigue a medias.

**Ya falló:** la nota dictada borraba lo escrito (PR 418); la cantidad de la receta dictada (PR 416); Clío sin pulpitis (8 nov); lo dictado para la ficha abierta no iba a ningún lado y «Lo dictado» lo resaltaba como usado (mesa del 14 nov, entrega 11).
**Fuentes:** ADR 0012, 0099, 0100, 0102 y 0187.

## P-ODO-20 Quién ve lo clínico

**Dónde:** `packages/auth/src/permissions.ts` y `S/clinical-access.ts`.

- [ ] Recepción y caja nunca ven lo clínico; recepción solo ve las alergias activas.
- [ ] Solo quien lleva la atención la edita; otro profesional la toma con registro.
- [ ] Toda lectura de la historia queda registrada, y la historia bloqueada no se abre.
- [ ] El servidor lo rechaza, no basta con que falte el botón.

**Ya falló:** lo de permisos y datos no se escribe aquí, porque el repositorio es público: está en los informes privados de `~/odentia-qa/`.
**Fuentes:** ADR 0035 y 0128.

## P-ODO-21 Especialidades con tratamiento largo

No tienen pantalla propia: viven en el plan, las sesiones, los controles y los procedimientos. Se revisan como proceso porque ahí se ve si el plan aguanta un tratamiento de meses.

- [ ] **Ortodoncia:** el plan de 18 a 24 meses con controles mensuales, la aparatología, las fotos y la cefalometría de inicio y de fin, y el cobro en cuotas sin perder la cuenta.
- [ ] **Prótesis y corona:** preparación, impresión, prueba y cementación como sesiones, con el provisional y el trabajo del laboratorio.
- [ ] **Implante:** cirugía, oseointegración, segunda fase y corona, con la trazabilidad del implante.
- [ ] **Odontopediatría:** dentición temporal y mixta, sellantes, flúor barniz, pulpotomía, conducta del niño, anestesia por peso y consentimiento del representante.
- [ ] **Ortodoncia:** la ficha de inicio (clase molar y canina, overjet, overbite, línea media, apiñamiento, mordidas cruzadas, hábitos) tiene un lugar, y en cada control se ve la de inicio para comparar.
- [ ] **Odontopediatría:** lo que cuenta el apoderado (biberón, chupón, dulces entre comidas, flúor, quién le cepilla) y lo que anota el odontólogo (ceod, riesgo de caries, conducta de Frankl) quedan en la historia del niño y se ven en la visita siguiente.

**Fuentes:** las guías de cada especialidad; para odontopediatría, las guías de la AAPD.

---

## Lo que hace una consulta y la app todavía no tiene

Flujos que un odontólogo hace a menudo y que no tienen un camino propio en el código (se buscaron por rutas, tablas y servicios). La voz los recorre con lo que hay hoy y dice cuánto cuesta hacerlos, si se pueden hacer y si se pierde algo. Antes de proponer construir uno, aplica la pregunta del `AGENTS.md` raíz: no se agrega algo solo porque otros programas lo tienen.

### P-ODO-22 Trauma dental

- [ ] Fractura, luxación o avulsión se registran con la pieza, el tipo y la hora del golpe.
- [ ] Una avulsión se trata como urgencia desde el primer mensaje (Sofi) hasta la atención.
- [ ] Los controles del trauma se generan con sus plazos (2 semanas, 4 semanas, 6 a 8 semanas, 6 meses y 1 año), con su radiografía.
- [ ] En un niño, la pieza temporal o permanente cambia la conducta.

**Fuentes:** guías de la IADT (International Association of Dental Traumatology), 2020.

### P-ODO-23 Constancias, certificados y descanso

- [ ] El odontólogo puede dar la constancia de atención para el trabajo o el colegio y el descanso después de una cirugía (terceras molares). Hoy el descanso médico solo existe en latidIA.
- [ ] El papel va firmado, numerado y con QR, como los demás (P-COM-05).

### P-ODO-24 Orden al laboratorio dental

- [ ] Una corona, prótesis o férula lleva su orden al laboratorio: pieza, material, color (guía VITA), fecha de prueba y de entrega.
- [ ] Lo que cobra el laboratorio queda como gasto y no se pierde en la comisión.
- [ ] La sesión de prueba o cementación se reserva cuando llega el trabajo.
- [ ] La factura del laboratorio se anota desde su orden o la elige: queda con la paciente, la pieza y el trabajo, sin escribirlos en el concepto.
- [ ] La factura del laboratorio puede quedar por pagar hasta fin de mes, y la clínica ve cuánto le debe a cada laboratorio.
- [ ] El costo del laboratorio se ve junto a lo cobrado de ese tratamiento.

### P-ODO-25 Cirugía oral

- [ ] Exodoncia de terceras molares, con su radiografía, la interconsulta médica previa si hace falta (riesgo quirúrgico, INR), la técnica, la sutura y el control para retirar los puntos a los 7 días.
- [ ] Una biopsia se registra y se deriva a patología, y el resultado vuelve a la historia.

### P-ODO-26 Bruxismo y ATM

- [ ] El diagnóstico, la férula (con su orden al laboratorio) y sus controles.

### P-ODO-27 Sedación consciente, óxido nitroso y anestesia general

La biblioteca ofrece estos servicios (`packages/db/seeds/biblioteca.csv`), pero no hay dónde registrar cómo se hicieron.

- [ ] Ayuno, monitoreo (saturación, frecuencia y presión durante el procedimiento), fármaco y dosis, y criterios de alta.
- [ ] Su consentimiento propio.
- [ ] En niños, el peso y quién lo acompaña al salir.

**Fuentes:** guía de monitoreo durante la sedación de la AAPD y la AAP (2019); guías de sedación de la ADA (2016).

### P-ODO-28 Bioseguridad y esterilización

- [ ] Evaluar primero el valor: ¿la clínica necesita registrar la trazabilidad del instrumental por paciente, o basta con lo que hace fuera del sistema? Solo se propone si una clínica real lo pide.

---

## Casos

Cada caso va de punta a punta, con datos coherentes, y dice qué procesos recorre. Se crean pacientes con el prefijo `QA` y teléfonos `+44 7700 900xxx`. Por cada caso se cuentan los clics desde «Atender» hasta firmar y se comparan con la ronda anterior (`~/odentia-qa/recorrido.md`).

| Caso | Paciente y situación | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| C1 | Adulto nuevo con dolor espontáneo en la 36: caries MO profunda, pulpitis irreversible sintomática. Dos caminos: endodoncia de molar más corona, o exodoncia. | 01, 02, 03, 05, 06, 07, 08, 09, 10, 11, 15 | Una sola lesión MO; endodoncia de molar con sus sesiones; la corona después; las dos opciones sin sumarse; «Eligió la opción A»; consentimiento solo de la endodoncia; sesión 1 de 2; la sesión 2 reservada otro día. |
| C2 | El mismo paciente vuelve a la sesión 2: una vez por su cita y otra sin cita, desde la ficha. | 03, 06, 07, 11, 15, 05 | Los dos caminos proponen el motivo y la pulpitis 36; sesión 2 de 2; «Sí, terminar»; la caries y la pulpitis quedan resueltas; «¿Cuándo vuelve?» ofrece la corona. |
| C3 | Paciente con su limpieza y control vencidos hace 6 meses, indicados por otro odontólogo. | 03, 11, 15, 18 | «Viene a su control» lo llena; profilaxis con un atajo; el control viene marcado como cumplido; el siguiente control con su frecuencia. |
| C4 | Urgencia sin cita: fractura de la 47 en un paciente con una corona aceptada sin empezar en la 46. | 03, 05, 06, 07, 11 | «Es una urgencia»; la corona pendiente a la vista; trazo y caras en la 47; resina de dos caras que conserva el precio al «Cambiar». |
| C5 | Equivocarse: un borrador con dos opciones y presupuesto, y después una nota que hay que corregir en una atención firmada. | 08, 16, 17 | Anular en pocos clics con lo no entregado; Plan limpio; adenda en la firmada; la Historia lo cuenta sin confusión. |
| C6 | Niño de 7 años, 22 kg, lo trae su mamá: caries en la 75 y la 85 con pulpitis, primeras molares permanentes sanas. | 01, 02, 05, 07, 09, 10, 21 | La mamá como representante; dentición mixta; pulpotomía en temporales y sellantes en 16, 26, 36 y 46; dosis máxima de anestesia por peso; consentimiento de odontopediatría firmado por la mamá. |
| C7 | Adulta de 68 años con apixabán y alendronato, necesita la exodoncia de la 48. | 02, 04, 06, 07, 09, 10, 11, 13 | El anticoagulante y el bifosfonato se ven al indicar la exodoncia; la receta no lleva AINE sin aviso; técnica e indicaciones registradas. |
| C8 | Adulto fumador con periodontitis generalizada. | 01, 02, 12, 07, 18 | Sondaje de 6 sitios con el teclado; estadio III grado C propuesto y confirmado; raspado por cuadrantes en sesiones; reevaluación comparada; mantenimiento cada 3 meses. |
| C9 | Adolescente de 14 años que empieza ortodoncia de 24 meses. | 01, 07, 08, 14, 18, 21 | Fotos y cefalometría de inicio; controles mensuales que se generan; cobro en cuotas; el representante decide. |
| C10 | Corona sobre la 46 ya con endodoncia, con laboratorio y provisional. | 07, 11, 15, 21 | Sesiones de preparación, prueba y cementación; el trabajo de laboratorio; el precio acordado de la opción A. |
| C10b | Llega la factura del laboratorio por la corona de la 46 (S/ 430, con el RUC del laboratorio), a pagar a fin de mes, y un motorizado cobra S/ 15 por traerla. | 24 | La factura se ata a la orden y queda por pagar; el motorizado queda sin comprobante; la comisión de la corona dice cuánto fue el laboratorio. |
| C11 | Embarazada de 30 semanas con un absceso en la 26. | 02, 06, 10, 13, 14 | El embarazo a la vista; la radiografía con su consentimiento; la receta avisa los AINE en el tercer trimestre (hoy no avisa). |
| C12 | Paciente alérgico a la penicilina a quien se le iba a recetar amoxicilina tras una exodoncia. | 02, 13 | La alergia se ve al recetar; avisa la reactividad cruzada; lo visto queda en la receta. |
| C13 | Hipertenso que llega con 185/115 para una exodoncia programada. | 02, 04, 10 | La presión se nota antes de anestesiar y el aviso no bloquea (hoy no hay aviso). |
| C14 | Tomografía para planear un implante en la 36, guardada en la atención de hoy. | 14, 21 | Ir a la 36; medir con escala; guardar la vista en la atención correcta; la orden se completa. |
| C15 | Toda la consulta C1 dictada a Clío. | 19 y los de C1 | Cada propuesta se confirma; el odontograma, el diagnóstico y la receta dictados son correctos. |
| C17 | Niño de 6 años con pulpitis en la 75 a quien se le indica «Endodoncia posterior vital». | 05, 06, 07 | Avisa que la pieza es temporal; ofrece la pulpectomía si la clínica la tiene. |
| C16 | Adulto con necrosis en la 14, a quien se le indica «Endodoncia posterior no vital». | 05, 06, 07, 09 | Avisa y ofrece la de bicúspide no vital; el consentimiento dice premolar. |
| C18 | Gestante de 30 semanas, alérgica al látex, que se registra sola en el enlace público y viene por dolor. | 01, 02, 10, 13 | El embarazo y sus semanas en la franja y al abrir la atención; el látex a la vista. |

### El recorrido largo

| Caso | Paciente | Etapas | Lo que tiene que pasar |
|---|---|---|---|
| R1 | Adulto nuevo que llega con dolor en la 36 y en el examen tiene caries en la 15 y la 24, gingivitis generalizada y le falta la 46. | 1 a 6 | **1:** urgencia resuelta (pulpitis 36) y odontograma inicial completo firmado como inicio. **2:** plan en fases: urgencia (endodoncia 36), básica (profilaxis, resinas 15 y 24), rehabilitadora (corona 36 e implante o puente en la 46, con caminos). Acepta la urgencia y la básica y pospone la rehabilitadora. **3:** las sesiones de la endodoncia, las resinas y la profilaxis, cada una reservada desde el cierre; a mitad aparece una caries en la 17, que se suma como nuevo hallazgo. **4:** termina lo aceptado; la rehabilitadora pospuesta queda a la vista; odontograma de culminación; saldo en cero. **5:** control de la endodoncia a los 6 meses con radiografía, y limpieza cada 6 meses. **6:** vuelve en 2 años; la ficha cuenta todo y le ofrece la corona y el implante pendientes. |
| R2 | Paciente de la demo con un plan a medias y sin venir hace meses. | 3, 6 | El tratamiento a medias se nota en Inicio y en la ficha; al volver, «Hoy viene a…» lo propone; reanudar no rehace lo hecho. |
| R3 | Paciente de la demo en mantenimiento periodontal. | 5 | El control con su frecuencia; el sondaje nuevo se compara con el anterior; el siguiente control se genera solo. |
