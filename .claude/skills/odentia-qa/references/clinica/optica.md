# Procesos clínicos de vistIA

El catálogo que supervisa la voz clínica en vistIA, el producto de las ópticas (ADR 0169). Quien atiende es el **optómetra** (en el Perú, el tecnólogo médico en optometría, con su colegiatura del CTMP), no el oftalmólogo: mide la vista, hace la receta de lentes y deriva al oftalmólogo lo que lo necesita. Después de examinar, la óptica vende, encarga los lentes al taller y avisa cuando están listos. Por eso el recorrido clínico sigue hasta que la persona se lleva sus lentes y ve bien con ellos.

**Cómo se usa:** igual que `odontologia.md` y `medicina.md`. Las comprobaciones se marcan como cumple, no cumple o no se pudo ver; los huecos conocidos se miran por lo que cuestan; la lista crece con «Para el catálogo». Lo que rodea a la atención está en `comunes.md`.

**Dónde está el código.** En `main`, como odentIA y latidIA. Rutas: `O` = `packages/optical/src/`, `SO` = `packages/services/src/optical/`, `AO` = `apps/optical-clinic/src/product/optical/`. ADR 0168 a 0173.

**La regla que más pesa:** un signo, un eje o un ojo cambiado es un lente mal hecho. Por eso Clío no dicta en vistIA (ADR 0169). La voz revisa que el dato de cada ojo (OD y OI) sea el mismo en el examen, la receta, su PDF, la copia del pedido, lo que ve el taller y el portal.

---

## Primero lo masivo: el mostrador y la medida al paso

En una óptica, la mayor parte del día no es una consulta con cita. Es gente que entra de la calle, muchas veces el sábado y varias a la vez:

- **Compra en el mostrador sin examen:** lentes de sol, lentes de lectura ya hechos, un estuche, un líquido, un ajuste o una reparación.
- **Se mide la vista al paso:** muchas ópticas lo hacen gratis o lo descuentan si compra, y la persona compra ahí mismo.
- **Trae la receta de su oftalmólogo** y elige la montura.

Por eso, en vistIA la ronda empieza por aquí y lo juzga por **volumen**: cuánto tarda cada cliente, cuántos clics, si varias personas atienden a la vez sin pisarse y si la cola avanza. La consulta con cita (el examen completo y el control anual) se revisa después. Los casos de este apartado son CO10 a CO14 y el recorrido RO2.

**Decisión a revisar:** la demo y Sofi dicen «La medida de la vista es con cita… toma unos 30 minutos» (`SO/demo-kinds.ts`) y el examen está pensado como una consulta completa. Si las ópticas reales miden al paso, eso traba lo masivo. La voz lo recorre como pasa en una óptica y dice cuánto cuesta. Que la medida sea al paso o con cita lo decide el usuario.

### P-OPT-14 La medida de la vista al paso

La persona entra sin cita y pide que le midan la vista.

- [ ] Registrarla pide lo mínimo (nombre y un teléfono, o solo el nombre) y toma menos de un minuto. Si ya es cliente, la búsqueda por nombre, teléfono o DNI la encuentra al primer intento.
- [ ] «Atender» sin cita es un clic (ADR 0098), y queda claro a quién le toca si hay varios optómetras.
- [ ] La medida rápida es la habitual en una óptica: la agudeza, el autorrefractómetro como punto de partida, la subjetiva y la distancia pupilar. No obliga a llenar la salud del ojo, que queda «no realizado». Lo que no se pide no traba.
- [ ] Del examen sale la receta con un toque, y de la receta, la venta, sin volver a escribir los números ni cambiar de pantalla más de lo necesario.
- [ ] La medida gratuita o descontada se cobra como la óptica lo hace (gratis, gratis si compra o descontada de los lentes) sin trucos en la caja.
- [ ] Se puede hacer en una tablet o un celular junto al equipo.
- [ ] Se anota el tiempo y los clics desde que entra hasta que sale con su receta, y desde que entra hasta que paga el adelanto. La referencia es cuánto tarda la óptica en papel o en su sistema de hoy (supuesto, hasta medirlo en una óptica real).

**Huecos conocidos:** no hay un servicio de medida rápida distinto del examen completo, ni un turno de quién sigue.

### P-OPT-15 El mostrador con mucha gente

**Dónde:** «Venta de mostrador» en Finanzas (ADR 0173), el escáner del inventario y la caja.

- [ ] Vender un producto sin ficha (lentes de sol, de lectura ya hechos, estuches, líquidos o cordones) son pocos toques: escanear o buscar, cobrar y dar el ticket.
- [ ] Unos lentes de lectura ya hechos se venden por mostrador, sin receta, porque son un producto. Unos lentes graduados a medida no se venden sin receta.
- [ ] Un ajuste o una reparación rápida (cambiar un tornillo, una plaqueta o enderezar la montura) se cobra o se registra gratis sin abrir una ficha, o con la ficha si la óptica la quiere.
- [ ] Dos vendedores cobrando a la vez no se pisan el ticket ni el stock.
- [ ] Al final del día, la caja cuadra con lo vendido, con y sin ficha.

### P-OPT-16 Campañas de medida masiva

En empresas, colegios o «regreso a clases», una óptica mide la vista a decenas de personas en un día, a veces fuera de la óptica.

- [ ] Se pueden registrar y medir muchas personas seguidas, sin repetir lo común (la empresa, el colegio, la fecha).
- [ ] Si no hay internet en el lugar, se dice qué pasa con lo anotado.
- [ ] Después se sabe quién necesita lentes y se le ofrece la venta.
- [ ] Un menor medido en el colegio tiene la autorización de su representante.

**Huecos conocidos:** no hay nada para campañas; «regreso a clases» solo existe como promoción en la demo. Antes de proponer construirlo, aplicar la pregunta del `AGENTS.md` raíz.

### P-OPT-17 La receta que no se convirtió en venta

- [ ] Quien se midió y se fue sin comprar queda a la vista, y se le puede ofrecer después (una oportunidad o un recordatorio), sin escribirle si no quiere mensajes.
- [ ] Quien compró los lentes, pero no los de sol o los de contacto que se le recomendaron, también.

**Huecos conocidos:** no se encontró este seguimiento para la receta; revisarlo con las oportunidades comunes.

---

## El recorrido del cliente en el tiempo

La persona llega porque no ve bien, porque se le rompieron los lentes o por su control anual. La examinan, sale con una receta, elige la montura y las lunas, paga un adelanto, el taller hace los lentes, le avisan que están listos, los recoge y se los ajustan. Si no ve bien, se rehacen. Al año vuelve a su control. Cada ronda que toque el examen, la receta o los pedidos recorre uno entero (caso RO1).

### Etapa 1 · El examen de la vista

- [ ] Antecedentes de la vista (usa lentes o no, cirugías, enfermedades del ojo, diabetes e hipertensión) y, si es menor, quién lo acompaña.
- [ ] La agudeza sin y con corrección, de lejos y de cerca, por ojo, en la notación de la óptica.
- [ ] La refracción por ojo, la distancia pupilar monocular y, si hace falta, la adición, el prisma y la salud del ojo.
- [ ] Si hay algo que debe ver un oftalmólogo, se ve y se deriva (P-OPT-03).

### Etapa 2 · La receta

- [ ] Sale del examen sin volver a escribir los números, de anteojos y de lentes de contacto aparte.
- [ ] La firma el optómetra con su colegiatura, con fecha y vigencia.
- [ ] La que trae de su oftalmólogo se transcribe y se verifica.

### Etapa 3 · La venta y el pedido

- [ ] La venta toma la receta vigente, la montura del inventario y las lunas, y cobra el adelanto en un solo ticket.
- [ ] El pedido lleva una copia exacta de la receta y las medidas para montar; el taller no abre la historia.
- [ ] Una receta vencida o sin verificar se avisa al vender y no lo impide.

### Etapa 4 · El taller y el aviso

- [ ] El pedido avanza (por enviar, en laboratorio, por revisar, listo y entregado), y cada paso dice quién lo marcó y cuándo.
- [ ] Al marcar «Listo», sale «Tus lentes están listos» y el pedido dice si salió, llegó o falló.

### Etapa 5 · La entrega y la adaptación

- [ ] Al entregar se cobra lo que falta y se comprueba que ve bien con los lentes.
- [ ] Si no ve bien, el pedido se rehace con su motivo, sin cobrar otra vez, y lo que se hizo mal queda dicho (P-OPT-07).

### Etapa 6 · El control anual

- [ ] «Invitar a volver» a los 12 meses y el «Control anual de la vista» al firmar.
- [ ] En el control se compara con la receta anterior: cuánto cambió cada ojo.

### Cómo recorrerlo en una ronda

Una persona `QA` nueva hace las etapas 1 a 5 el mismo día, marcando los pasos del taller con el rol Taller. Las etapas 5 y 6 se ven también con clientes de la demo de la óptica que ya tienen pedidos en cada paso y recetas de años anteriores. Se recorre con los roles de vistIA: optómetra, Ventas, Taller, Caja y recepción.

---

## P-OPT-01 Registro del cliente y su responsable

Común con los demás productos (P-ODO-01, P-MED-01).

- [ ] Un menor queda con su representante, y el examen dice quién lo acompañó.
- [ ] Quien solo compra en el mostrador no necesita ficha (ADR 0173), y una venta de mostrador no entra en la cuenta de un paciente.

## P-OPT-02 Examen de la vista

**Dónde:** `AO/examination.tsx`, con las reglas en `O/eye-exam.ts` y el servicio en `SO/examination.ts`. Se guarda en `encounter.examination`.

- [ ] **Agudeza visual** por ojo, sin y con corrección, de lejos y de cerca: Snellen en pies o metros con la línea parcial (20/25+1, 6/6−2), decimal, Jaeger, N o M de cerca, y CD, MM, PL o NPL cuando no lee la cartilla. Una notación que no existe se rechaza junto al campo.
- [ ] **Refracción** por ojo: esfera y cilindro en pasos de 0,25 D, eje de 1 a 180 solo con cilindro, adición hasta +12,00 y prisma con su base (y un segundo si es compuesto). Un cilindro sin eje, o un eje sin cilindro, se dice.
- [ ] La notación del cilindro (negativo o positivo) es la que usa la óptica y no se mezcla. **Hoy no existe:** no hay notación elegida ni transposición, y una receta externa en cilindro positivo se guarda tal cual.
- [ ] **Distancia pupilar** monocular de cada ojo (la que pide el taller) y binocular de lejos y de cerca.
- [ ] **Salud del ojo:** examen externo, pupilas, presión intraocular (con un decimal, si hay equipo) y fondo de ojo, o la constancia de que no se hizo. Lo no examinado nunca queda como normal.
- [ ] **La salud del ojo dice en qué ojo.** Hoy el examen externo, las pupilas y el fondo de ojo se anotan una sola vez para los dos (`O/eye-exam.ts`), así que «fondo de ojo con hallazgos» no dice cuál.
- [ ] Lo que una óptica mide a menudo tiene dónde anotarse: la **lensometría** de los lentes que usa (la base para comparar y para saber si el error fue de la receta), la agudeza con **estenopeico** (si mejora es refractivo; si no, se deriva), la **queratometría** para los lentes de contacto, y el método y la hora de la presión. Hoy no existen.
- [ ] Sin signos vitales: una óptica no los toma.
- [ ] Todos los errores vuelven a la vez, cada uno junto a su dato.
- [ ] En un niño: quién lo acompaña (hoy es opcional y no mira la edad), si se hizo la refracción con cicloplejía (hoy no hay campo) y la agudeza por ojo para detectar la ambliopía.
- [ ] El examen sale igual en la Historia, el PDF y la copia de la historia. En FHIR hoy salen solo Observations del examen: ni la receta como VisionPrescription, ni la distancia pupilar, ni quién acompaña.

**Fuentes:** ISO 21987 (pasos de graduación); HL7 FHIR VisionPrescription; ADR 0170.

## P-OPT-03 Derivar al oftalmólogo

**Dónde:** `referralSigns` (`O/eye-exam.ts`) y la orden de interconsulta común.

- [ ] Se avisa, sin frenar: presión del ojo alta, fondo de ojo o pupilas con hallazgos, una agudeza con corrección que no llega a 20/40, o que solo cuenta dedos o ve luz.
- [ ] El aviso está a la vista al terminar el examen **y al hacer la receta**. Hoy solo aparece en el examen (`AO/examination.tsx`), no en `AO/prescriptions-section.tsx`.
- [ ] La derivación lleva lo que el oftalmólogo necesita (qué se encontró, en qué ojo y la agudeza) y deja constancia de que se le dijo a la persona. Hoy la salud del ojo no dice en qué ojo (P-OPT-02).
- [ ] Lo que la persona cuenta y es urgente (P-OPT-10) no espera al examen.
- [ ] Una diferencia grande con la receta anterior, una diferencia grande entre los dos ojos (ambliopía en un niño, aunque los dos pasen 20/40) o una visión que no mejora con estenopeico también sugieren derivar. Hoy `referralSigns` no mira nada de esto.

**Huecos conocidos:** la constancia de que se le explicó la derivación y si la persona fue (el rechazo informado está en P-COM-13); no compara con la receta anterior ni entre ojos.
**Fuentes:** ADR 0170; guías de práctica de la AOA (American Optometric Association) para derivar.

## P-OPT-04 Receta de lentes

**Dónde:** `optical.lens_prescription`, con las reglas en `O/lens-prescription.ts`, el servicio en `SO/lens-prescriptions.ts`, el PDF en `SO/lens-prescription-pdf.ts`, la API en `apps/api/src/routes/optical/lens-prescriptions.ts` y la pantalla en `AO/prescriptions-section.tsx`.

- [ ] De anteojos o de lentes de contacto, aparte. La de contacto lleva curva base, diámetro y marca, sin prisma.
- [ ] La de la óptica sale de la refracción del examen, una de cada tipo por atención, sin volver a escribir los números.
- [ ] La de lentes de contacto se **propone** compensada por la distancia al vértice desde ±4,00 D (un −8,00 pasa a −7,25) y el optómetra la corrige con la prueba del lente: nunca se usa la del anteojo sin revisar.
- [ ] La firma quien atendió, con su colegiatura (CTMP), también con la atención ya firmada.
- [ ] **La receta coincide con el examen firmado.** Hoy se puede emitir con la atención en borrador (`SO/lens-prescriptions.ts`); si después cambia el examen, los dos dicen cosas distintas.
- [ ] La externa (la del oftalmólogo) se transcribe con quién la firmó, su fecha y su foto, y queda «sin verificar» hasta que un optómetra la revise.
- [ ] Vale un año si no se dice otra cosa. Vencida o sin verificar se avisa y no impide vender.
- [ ] Emitida no cambia: solo se verifica (la externa, una vez) o se anula con motivo.
- [ ] El PDF tiene el membrete, la firma dibujada y un QR que dice si está vigente, vencida o anulada. OD y OI no se confunden en el papel. La externa no lleva QR (`SO/lens-prescription-pdf.ts`).
- [ ] El cliente la ve en «Tus documentos» del portal; la externa, solo después de verificada.
- [ ] Anular la atención anula la receta que se emitió en ella, con su motivo: la ficha la muestra anulada, su QR dice «Documento anulado» y la venta no la ofrece. La externa transcrita no cambia.
- [ ] «Emitir otra desde su examen» no se ofrece si la receta se anuló con su atención.
- [ ] En el PDF, cada signo de la graduación sale igual que en la pantalla («−2,00», «+1,50»), nunca «?» ni sin signo.

**Huecos conocidos:** cuánto dura de verdad la receta (adulto, niño, lentes de contacto) se confirma con la primera óptica real.
**Fuentes:** ISO 21987; HL7 FHIR VisionPrescription; ADR 0170.

## P-OPT-05 Lentes de contacto

**Dónde:** el servicio de adaptación de la biblioteca, la receta de contacto y el consentimiento «Adaptación de lentes de contacto» (`O/consents.ts`).

- [ ] La adaptación tiene sus sesiones y su control. Hoy la biblioteca trae adaptación y control como servicios, pero sin sesiones previstas (solo la terapia visual las trae).
- [ ] La prueba del lente queda registrada: queratometría, cómo asienta, la agudeza con el lente y el lente final. Hoy no hay campos para la prueba.
- [ ] Las indicaciones de uso y cuidado se le entregan a la persona, con los signos de alarma (ojo rojo con dolor: sacarse el lente y consultar).
- [ ] El consentimiento se firma antes de adaptar.
- [ ] La topografía corneal, si se hizo, queda ligada.

## P-OPT-06 La venta de lentes y el pedido

**Dónde:** «Vender lentes» y Pedidos (`AO/orders-section.tsx`, `AO/orders.ts`, `packages/services/src/job-orders.ts`, `packages/db/src/schema/orders.ts`); ADR 0171.

- [ ] La venta toma la receta vigente. Hoy solo ofrece la más reciente de cada tipo (`SO/lens-prescriptions.ts`): una segunda receta de anteojos (la de cerca o la ocupacional) no se puede usar.
- [ ] La montura sale del inventario (con el escáner o la búsqueda) y las lunas van a precio libre o de la lista.
- [ ] El adelanto se cobra con los medios que elija, en el mismo ticket, y todo va en una transacción. Un reintento no duplica.
- [ ] El pedido lleva la **copia exacta** de la receta: OD y OI, esfera, cilindro, eje, adición, prisma y distancia pupilar monocular, y las alturas para montar.
- [ ] **Unas lunas graduadas no se piden sin receta.** Hoy el cajón de la venta ofrece «Sin receta» sin aviso (`packages/clinic-app/src/components/orders/sale-drawer.tsx`). Sin receta solo tiene sentido una reparación o la montura propia del cliente (P-OPT-25).
- [ ] El pedido dice el tipo de luna (monofocal, bifocal o progresivo) y, con progresivos o bifocales, la altura de cada ojo es obligatoria o se avisa si falta. Hoy no hay tipo de luna y las alturas son opcionales, sin aviso.
- [ ] El taller ve lo que tiene que hacer y nada más de la historia, y su lectura queda registrada.

**Huecos conocidos:** lo que se mide para montar (distancia al vértice, ángulo pantoscópico, curvatura de la montura) se confirma con la primera óptica real; hoy son las alturas de cada ojo.

## P-OPT-07 El taller, rehacer y anular

**Dónde:** los pasos del pedido (`job_order_event`).

- [ ] Los pasos solo avanzan y dicen quién y cuándo. El taller propio puede saltar «en laboratorio».
- [ ] **«Por revisar» no se salta.** Antes de «Listo», alguien comprueba los lentes contra la receta con el lensómetro (graduación, eje y centrado) y queda qué se midió. Hoy «Marcar listo» lleva de «Por enviar» o «En laboratorio» directo a Listo (`canSkipToReady`, `packages/clinic-app/src/lib/orders.ts`), el servidor acepta cualquier salto hacia adelante, incluso hasta Entregado (`job-orders.ts`), y el paso no registra la medida.
- [ ] Rehacer crea un pedido nuevo unido al original, con su motivo, sin cobrar otra vez. El motivo distingue un error del taller, un error de la receta, que la persona no se adapta y la **garantía de adaptación** de los progresivos. Hoy el motivo es texto libre.
- [ ] **Rehacer por un error de la receta toma la receta nueva.** Hoy rehacer copia la receta y las medidas del original (`job-orders.ts`): el taller volvería a hacer los mismos números.
- [ ] Anular anula en la caja lo que no se cobró y deja lo cobrado en su cuenta.
- [ ] Anular y rehacer los hace quien lleva la caja, no el Taller.
- [ ] Un pedido hecho con una receta que después se anula lo dice en el pedido y a quien lo lleva, con su salida («Rehacer con otra receta» o «Anular»), y el diálogo de anular la atención nombra ese pedido. No frena: avisa.

## P-OPT-08 «Tus lentes están listos» y la entrega

**Dónde:** ADR 0172; el aviso al marcar «Listo», `ver_pedidos` de Sofi y «Tus pedidos» en el portal.

- [ ] El aviso sale a quien recibe los avisos de la persona y el pedido dice si salió, llegó o falló. Nunca se reenvía solo: se reenvía con un toque el que falló y, el dudoso, después de confirmarlo con la persona.
- [ ] Sofi dice en qué paso está cada pedido y cuánto falta pagar, esto último solo a quien puede oírlo. Nunca dice la receta.
- [ ] Al entregar, se cobra lo que falta (o se dice que queda debiendo), se ajusta la montura y se comprueba la visión con los lentes. La entrega queda registrada con quién la recogió, si fue otra persona. Hoy «Entregar» no guarda nota ni quién recogió, y no exige ni avisa el saldo.
- [ ] Entrega quien atiende al cliente. Hoy el Taller puede marcar «Entregado» (tiene `orders.write`) y el optómetra no puede marcar ningún paso (solo `orders.read`).

## P-OPT-09 Diagnósticos, imágenes y pruebas especiales

**Dónde:** `O/diagnoses.ts` (CIE-10 H00–H59 y CIE-11 9A–9E primero) y `O/imaging.ts`; en la biblioteca, tonometría, campo visual, topografía corneal, retinografía, tomografía óptica (OCT), visión de colores y visión binocular.

- [ ] El diagnóstico refractivo (miopía, hipermetropía, astigmatismo, presbicia) sale del buscador con las palabras de la óptica.
- [ ] **El diagnóstico, la prueba, la imagen y la orden dicen el ojo.** Hoy vistIA no tiene «dónde» (`SO/hooks.ts`: «el ojo se dice en la atención»; `NO_SITE`): un diagnóstico de un solo ojo, una retinografía del OD o una derivación por el OI no lo guardan como dato. Es el hueco más grave del producto para la regla de OD y OI.
- [ ] Cada prueba especial queda con su resultado y la imagen (retinografía, OCT, campo visual) ligada a la atención. No hay visor de cortes: las imágenes se ven como archivo.
- [ ] Un resultado que sugiere derivar (un campo visual alterado, una OCT con hallazgos) lleva a P-OPT-03.

## P-OPT-10 Señales de alarma en los mensajes

**Dónde:** `SO/agent-texts.ts` (`alarmSignals`).

- [ ] Una pérdida de visión súbita, la cortina o sombra que tapa la vista, destellos con moscas nuevas, un químico o un objeto en el ojo, el dolor de ojo fuerte con náuseas y la visión doble súbita reciben el número de emergencias y le llegan al equipo, sin indicación clínica.
- [ ] Faltan y se revisan: el ojo rojo con dolor en quien usa lentes de contacto y un golpe en el ojo.

**Fuentes:** signos de urgencia oftalmológica de la AAO (American Academy of Ophthalmology).

## P-OPT-11 Medicamentos y consentimientos

**Dónde:** `O/medications.ts` (lágrimas artificiales, antialérgicos y descongestionantes) y `O/consents.ts` (dilatación de pupilas y adaptación de lentes de contacto).

- [ ] Lo que la óptica puede indicar es lo de su lista. Hoy la pantalla deja escribir lo que no está (`O/medications.ts`): se revisa qué puede recetar un optómetra antes de dejarlo libre.
- [ ] Lo que la óptica pone en el consultorio (tropicamida, ciclopentolato, fenilefrina, proparacaína) está en la lista, para cruzarlo con las alergias. Hoy no está.
- [ ] Una gota indica el ojo (OD, OI o AO). Hoy no hay dónde decirlo como dato.
- [ ] La dilatación de pupilas pide su consentimiento y avisa que no maneje después.

**Huecos conocidos:** qué puede recetar un optómetra en el Perú se confirma antes de ampliar la lista.

## P-OPT-12 Quién ve qué en una óptica

**Dónde:** `PRODUCT_ROLES` y los permisos `orders`, `clinical.prescription` y `orders.prescription` (`packages/auth/src/permissions.ts`).

- [ ] **Ventas:** hace lo de recepción y caja, ve el inventario y los pedidos, y ve la receta vigente sin el resto de la historia.
- [ ] **Taller:** ve los pedidos con la copia de la receta y marca los pasos hasta «Listo». Hoy también puede marcar «Entregado».
- [ ] **Optómetra:** puede marcar «Revisado», que es su trabajo de control. Hoy solo ve los pedidos.
- [ ] Recepción y quien atiende ven cómo va un pedido sin cobrarlo. Lo que falta pagar solo lo ve quien ve la caja.
- [ ] Ventas y Taller no se pueden invitar en otro producto, y el servidor lo rechaza, no solo la pantalla.

## P-OPT-13 Venta de mostrador: sus reglas

**Dónde:** «Venta de mostrador» en Finanzas (ADR 0173). Cómo rinde con mucha gente está en P-OPT-15; aquí van sus reglas.

- [ ] Se vende un estuche, un líquido o unas gotas sin ficha, se paga entero y deja ticket.
- [ ] Nada clínico entra por aquí: unos lentes con graduación, y los de contacto (también los de colores, que son dispositivo médico), no se venden por mostrador sin receta. Hoy no hay ninguna regla ni marca en el producto que lo impida (`counter-sale.ts`), y la demo vende lentes de contacto mensuales y de colores como cualquier producto.
- [ ] Anular y devolver funcionan como cualquier ticket.

## P-OPT-18 Terapia visual y visión binocular

Es una de las especialidades de base de vistIA (`O/catalog.ts`), con 10 sesiones en la biblioteca y una demo de niños con parches.

- [ ] El examen tiene lo que la terapia necesita: prueba de cobertura (cover test), punto próximo de convergencia, estereopsis y motilidad. Hoy no existe.
- [ ] Las sesiones cuentan bien y cada una registra qué se hizo y cómo avanzó.
- [ ] La oclusión (horas al día) y los controles de la agudeza de cada ojo en el tiempo.
- [ ] Lo que es de un oftalmólogo (un estrabismo que puede necesitar cirugía) se deriva.

## P-OPT-19 Baja visión

Existe el servicio `evaluacion-baja-vision`, y la adición llega a +12,00 por eso.

- [ ] Las ayudas ópticas (lupas, telescopios y filtros) se registran y se venden con su indicación.
- [ ] La derivación y lo que la persona necesita para un certificado de discapacidad (CONADIS; verificar el trámite).

## P-OPT-24 Reposición de lentes de contacto

- [ ] Vender la caja de lentes de contacto pide la receta de contacto vigente, también para los de colores.
- [ ] El lote de la caja vendida queda registrado (verificar si `sellFromStock` lo guarda).

**Fuentes:** Ley 29459 (productos farmacéuticos, dispositivos médicos y productos sanitarios; verificar cómo aplica a los lentes de contacto).

## P-OPT-25 Reparación y montura propia del cliente

El servicio `reparacion-de-anteojos` existe.

- [ ] Una reparación (soldar, cambiar una pieza) es un pedido legítimo sin receta, y se distingue de unas lunas sin receta.
- [ ] Si el cliente trae su propia montura, el pedido lo dice y la óptica no la cobra ni la descuenta del stock.

---

## Si atiende un oftalmólogo

vistIA está hecho para ópticas. Si una óptica trabaja con un oftalmólogo, o si vistIA va a atender consultorios de oftalmología, estos procesos faltan. La voz los recorre con lo que hay y dice cuánto cuesta, sin darlos por pedidos: si se construyen es una decisión de producto.

### P-OPT-20 Consulta oftalmológica completa

- [ ] Biomicroscopía con lámpara de hendidura por estructura (párpados, conjuntiva, córnea, cámara anterior, iris y cristalino), presión intraocular por aplanación, gonioscopía y fondo de ojo con dilatación, cada una por ojo.
- [ ] Diagnóstico con su lateralidad (CIE-10 H00–H59 con el ojo).
- [ ] La refracción con cicloplejía en niños.
- [ ] El perfil del profesional acepta al médico oftalmólogo (CMP y su RNE). Hoy solo propone «Tecnólogo médico en optometría» y el CTMP (`O/professional.ts`).
- [ ] Una receta del oftalmólogo de la propia óptica no queda «sin verificar por un optómetra».
- [ ] La lista de medicamentos tiene lo que receta un oftalmólogo: antibióticos, corticoides e hipotensores oculares.

### P-OPT-21 Enfermedades crónicas del ojo

- [ ] **Glaucoma:** la presión en serie, el campo visual y la OCT del nervio comparados en el tiempo, los colirios con su ojo y sus controles.
- [ ] **Retinopatía diabética:** el tamizaje anual, la clasificación y el seguimiento según el grado.
- [ ] **Degeneración macular:** las inyecciones intravítreas con su ojo, sus sesiones y su control.

**Fuentes:** guías Preferred Practice Pattern de la AAO; clasificación internacional de la retinopatía diabética (ICO).

### P-OPT-22 Cirugía y procedimientos

- [ ] Catarata: la evaluación, la biometría y el cálculo del lente intraocular, el consentimiento, el ojo marcado y los controles después de la cirugía (día 1, semana 1 y mes 1).
- [ ] Láser (YAG, iridotomía) e inyecciones: el ojo, el consentimiento y el control.
- [ ] **La lateralidad se comprueba en cada paso:** ojo equivocado es el error que no se puede deshacer.

**Fuentes:** protocolo universal de cirugía segura de la OMS (marcar el sitio).

### P-OPT-23 Niños: estrabismo quirúrgico

- [ ] La evaluación del estrabismo, la decisión de operar y sus controles. La ambliopía con oclusión, que también hace la óptica, está en P-OPT-18.

---

## Casos

| Caso | Persona y situación | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| CO1 | Adulta de 45 años que ya no lee de cerca: presbicia, con astigmatismo en el OI. | 02, 04, 06 | Agudeza de lejos y de cerca; refracción con adición; receta de anteojos con el eje solo donde hay cilindro; venta de progresivos con las alturas de cada ojo. |
| CO2 | Joven de 22 años con miopía alta (−8,00) que quiere lentes de contacto. | 02, 04, 05 | La receta de contacto propuesta compensada (−7,25) y corregida con la prueba; consentimiento; indicaciones de cuidado. |
| CO3 | Niño de 6 años al que le va mal en el colegio, acompañado por su papá: hipermetropía y un ojo que ve menos. | 01, 02, 03, 04 | Quién acompaña; la agudeza de cada ojo muestra la diferencia; aviso de derivar (posible ambliopía); la receta firmada. |
| CO4 | Adulto diabético de 60 años: con corrección no pasa de 20/50 en el OD y el fondo de ojo tiene hallazgos. | 02, 03 | Los dos avisos de derivar a la vista; la orden de interconsulta con lo encontrado; constancia de que se le dijo. |
| CO5 | Cliente que trae la receta de su oftalmólogo, de hace 14 meses. | 04, 06 | Se transcribe y queda sin verificar; vencida se avisa y no impide vender; un optómetra la verifica. |
| CO6 | Los lentes llegan del taller con el eje en 90 en vez de 180. | 07, 08 | «Por revisar» lo detecta con el lensómetro (y no se puede saltar con «Marcar listo»); se rehace sin cobrar otra vez, con el motivo «error del taller»; el aviso sale cuando el nuevo está listo. |
| CO7 | La persona recoge sus lentes y no ve bien con ellos: la lensometría muestra que el taller cumplió y el error estaba en la receta. | 02, 04, 07, 08 | Se mide de nuevo y se emite otra receta; el pedido rehecho lleva **la receta nueva**, no la copia del original; el motivo dice «error de la receta». |
| CO15 | Una señora quiere su caja de lentes de contacto de colores en el mostrador, sin receta. | 13, 24 | La venta pide la receta de contacto vigente; no pasa como un producto cualquiera. |
| CO16 | Un señor trae su propia montura para que le pongan lunas nuevas, y otro trae unos anteojos con una bisagra rota. | 06, 25 | El primero lleva receta y la montura propia sin descontar stock; el segundo es una reparación sin receta. |
| CO17 | Niña de 7 años con un ojo vago, en terapia visual con parches y 10 sesiones. | 02, 18 | La agudeza de cada ojo en el tiempo; las sesiones cuentan bien; la oclusión registrada; aviso si no mejora. |
| CO8 | Por WhatsApp: «de repente veo una cortina en el ojo derecho y destellos». | 10 | Respuesta de urgencia con el número de emergencias y aviso al equipo, sin indicación. |
| CO9 | Se intenta vender unos lentes graduados por mostrador. | 13 | No se puede sin receta; el estuche sí se vende. |
| CO10 | Sábado al mediodía: entra una persona sin cita, pide que le midan la vista y compra lentes monofocales en el momento. | 14, 04, 06 | Registro mínimo; un clic para atender; medida rápida sin campos que trabe; la receta y la venta sin volver a escribir; tiempo y clics anotados de punta a punta. |
| CO11 | Tres clientes a la vez: uno compra lentes de sol, otro unos de lectura ya hechos y otro un líquido. Dos vendedores. | 15 | Cada venta en pocos toques con el escáner; los tickets y el stock no se pisan; la caja cuadra. |
| CO12 | Un señor trae su receta del oftalmólogo, elige montura y quiere los lentes para el lunes. | 04, 06 | Transcribir la receta sin errores de ojo; venta y adelanto; fecha prometida en el pedido. |
| CO13 | Campaña en un colegio: 40 niños medidos en una mañana. | 16, 01 | Hasta dónde llega la app hoy, cuánto cuesta cada niño y qué pasa con la autorización de su representante. |
| CO14 | Una persona se mide, recibe su receta y se va sin comprar. | 14, 17 | Queda como posible venta y se le puede ofrecer después. |
| CO18 | El optómetra emite la receta en la atención, Ventas vende los lentes y el optómetra anula la atención porque repitió la refracción. | 04, 06, 07 | La receta queda anulada con su motivo y el QR lo dice; el pedido avisa que su receta se anuló y ofrece rehacerlo con otra; la venta ya no la ofrece; la externa anterior sigue vigente y la venta la ofrece con su fecha. |

### El recorrido largo

| Caso | Persona | Etapas | Lo que tiene que pasar |
|---|---|---|---|
| RO2 | Un sábado de la óptica: diez clientes en dos horas, con dos vendedores, un optómetra y el taller. Mezcla de CO10, CO11, CO12 y CO14, más uno que recoge sus lentes listos. | Lo masivo | Nadie espera por la app: cada atención y cada venta van en paralelo; se sabe quién sigue; al final del día la caja cuadra y cada pedido está en su paso. Se informa el tiempo por cliente y dónde se formó la cola. |
| RO1 | Adulto de 40 años que viene porque no ve de lejos. | 1 a 6 | Examen completo; receta de anteojos firmada; venta con montura escaneada y adelanto; el taller avanza los pasos; «Por revisar» comprueba los lentes; sale «Tus lentes están listos»; entrega con el saldo cobrado; al año, el control compara la receta nueva con la anterior. |
