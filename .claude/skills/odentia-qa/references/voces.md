# Las voces

Cinco voces revisan odentIA, latidIA y vistIA: novato, clínica, desarrollo, auditor y diseño UX. Son las mismas para las dos skills:

- **En la app**, en `odentia-qa`: usan la pantalla real, en una ronda o en la QA antes de entregar.
- **En la mesa**, en `odentia-entrega`: critican un cambio antes de dibujarlo o programarlo.

Una voz genérica opina sobre la pantalla. Una voz profunda recorre casos concretos de punta a punta, revisa cada comprobación de su lista, sigue el mismo dato por todos los lugares donde aparece y nombra la causa. El modelo de profundidad son los recorridos de `~/odentia-qa/2026-11-08-atencion-de-verdad/recorrido.md` y `~/odentia-qa/2026-11-09-repaso-atencion/recorrido.md`: veredicto primero, casos paso a paso con clics, qué está mal con su causa y cómo debe ser. Si están en la máquina, cada voz los lee antes de empezar.

## Para todas

- **Cada voz por separado.** Corre como subagente aparte y no ve lo que dijeron las otras: si una sola cabeza escribe las cinco seguidas, termina de acuerdo consigo misma. Sin subagentes, se escribe cada voz completa antes de empezar la siguiente, y el novato primero.
- **Cuestiona el flujo, no solo la pantalla.** Cuenta la tarea completa desde lo que la persona tiene en la cabeza y pregunta si cada concepto debe existir: ¿por qué hay dos cosas para lo mismo? Cuando varios hallazgos salen de la misma separación o del mismo modelo de datos, lo dice como **causa raíz**, en vez de listar los síntomas uno por uno.
- **Comprobado o supuesto.** Lo que se hizo en la pantalla o se leyó en el código está comprobado. Lo que depende de cómo trabaja una clínica real y no tiene fuente va marcado como **supuesto**. Lo legal queda como pendiente: ninguna voz da el visto bueno jurídico.
- **Ninguna decisión esconde un problema.** Si algo está mal, se anota aunque un ADR o un `AGENTS.md` diga que es a propósito, o aunque venga de cómo se armó la demo.
- **No inventa.** Si no encuentra nada serio, lo dice: un problema inventado para cumplir hace más daño que el silencio.
- **Mira lo que ve la persona.** Capturas, no solo el árbol de accesibilidad.
- **En la app**, recibe `comun.md` de la ronda. Crea sus datos con el prefijo `QA`, teléfonos de `+44 7700 900000` a `+44 7700 900999` y correos `@example.com`, nunca otros. No toca la configuración de canales.
- **En la mesa**, recibe una ficha: actor, tarea y resultado observable; de dónde viene (lienzo, pedido o error); a qué producto afecta; lo ya decidido, que no se reabre; y capturas, si las hay.

### Lo que devuelve cada voz

1. **Veredicto**, de 3 a 5 líneas: ¿la persona puede hacer su trabajo con esto? ¿Qué es lo que más estorba?
2. **Recorrido**, por caso o tarea: una tabla con el paso, los clics y lo que pasó, con las capturas. En la mesa, el recorrido es lo que la persona haría con el cambio puesto.
3. **Hallazgos**, el más grave primero, con el formato de la etapa 3 de `SKILL.md`. Sin tope en la app y sin relleno. En la mesa, los 5 de más peso completos y el resto en una línea cada uno.
4. **Causa raíz**, si varios hallazgos salen de lo mismo.
5. **Cómo debe ser**: lo que propone, con el patrón que ya existe en la app.
6. **No pude ver**: lo que quedó sin recorrer y por qué.

---

## Novato

La persona menos técnica que tocará esto. Elige una concreta y la nombra, porque «un usuario» no tropieza con nada:

- **Recepción:** atiende el teléfono y el mostrador a la vez, y la interrumpen a mitad de cualquier cosa.
- **Caja:** cobra rápido con gente esperando; le importa que el monto cuadre y saber qué entregar.
- **Ventas en una óptica (vistIA):** un sábado, con cola, vende lentes de sol, mide la vista al paso con el optómetra, vende la montura y cobra el adelanto, todo sin perder a quién le toca.
- **Paciente o apoderado:** desde su celular, con un enlace que le llegó, sin saber cómo se llama nada por dentro.

No lee el repositorio ni recibe explicación, ni sabe lo que encontraron las demás voces. Si entiende por qué se hizo el cambio, deja de servir.

### En la app

**Cuenta:** recepción, caja o el enlace del paciente. **Ancho:** 390 px y, si alcanza, 1440.

Recibe de 3 a 5 tareas del área, dichas como en la clínica: «Llegó un paciente nuevo, regístralo y dale cita para mañana», «La señora quiere pagar lo que debe y llevarse su comprobante», «Llama la mamá de Mateo para cambiar la cita del jueves». Por cada tarea:

1. Cuenta en primera persona qué busca, dónde mira, qué pulsa, qué esperaba y qué pasó. Anota cada vez que duda y por qué.
2. **Interrupción:** a mitad de la tarea, empieza otra («suena el teléfono»), y después vuelve. ¿Encontró lo que dejó a medias? ¿Se perdió algo?
3. **Su propio error:** se equivoca a propósito una vez (otro paciente, otro monto, otra hora) e intenta corregirlo. ¿Pudo? ¿Cuántos pasos?
4. **¿Se guardó?** ¿Sabe si quedó hecho, pendiente o enviado, y a quién le llegó?
5. **Explicarlo:** ¿podría decirle al paciente lo que acaba de pasar, con las palabras de la pantalla?
6. **Ayuda:** si se pierde, usa «Ayuda» como lo haría cualquiera, y anota si le sirvió.

Cierra con un conteo: tareas terminadas solas, con ayuda o no terminadas; clics de cada una; palabras que no entendió y botones que no apretaría.

### En la mesa

Recibe solo lo que esa persona vería: capturas, tableros del lienzo o, si aún no existen, una descripción en sus palabras. Hace el mismo relato con el cambio puesto: «¿qué significa esto?», «¿qué aprieto?», «¿ya se guardó?», «¿por qué me pide esto?». No propone soluciones técnicas.

---

## Clínica

Un profesional con años de consulta privada en el Perú. En odentIA es odontólogo general y, cuando el proceso es de una especialidad (endodoncia, periodoncia, ortodoncia, prótesis, odontopediatría, cirugía), revisa también como ese especialista. En latidIA es médico de la especialidad de la demo (pediatría en Pediatría Los Olivos) y médico general. En vistIA es optómetra con años en una óptica y, para lo que debe derivarse y para lo que haría falta si atiende un oftalmólogo, revisa también como oftalmólogo. Si el cambio es común, revisa cada producto al que llega.

Su base son los catálogos de procesos clínicos, con las comprobaciones de cada proceso y los casos para recorrerlos:

- odentIA: `references/clinica/odontologia.md`
- latidIA: `references/clinica/medicina.md`
- vistIA: `references/clinica/optica.md`
- Todos, lo que rodea a la atención (perfil del profesional, configuración, de la cita a la atención, portal, papeles, datos, materiales y Sofi): `references/clinica/comunes.md`

El catálogo es el piso, no el techo: lo que se supervisa siempre, más todo lo que el profesional encuentre en el camino. **Buscar flujos que el catálogo no tiene es parte de cada revisión, no un extra.** Un flujo que nadie puso en la lista es justo el que nadie revisa.

### Buscar los flujos que faltan

Antes de recorrer, y en la mesa también, barre el área con estas cinco fuentes y compara lo que encuentra con el catálogo:

1. **Las pantallas:** las rutas del área (`packages/clinic-app/src/routes/` y las de cada `apps/*-clinic/`), incluidas las públicas y las de impresión, y los temas de la Ayuda (`packages/services/src/help-guide.ts` y el `help.ts` de cada producto en `packages/services/src/<producto>/`).
2. **Los datos:** las tablas de `packages/db/src/schema/` (`clinical.ts`, `clinical-forms.ts`, `dental.ts`, `portal.ts`, `inventory.ts`, `agenda.ts`). Una tabla que guarda algo clínico es un flujo, aunque no tenga pantalla.
3. **Las operaciones:** los servicios del área en `packages/services/src/` (y `dental/`, `medical/`, `optical/`) y lo que puede hacer Clío o Sofi (`packages/agent/`).
4. **Las decisiones:** los ADR de `docs/decisions/` cuyo título toca el área.
5. **La consulta real:** lo que un profesional de esa especialidad hace en una semana normal (urgencias, niños, crónicos, cirugías, laboratorios, certificados, derivaciones, controles) y lo que piden las normas (historia clínica, odontograma, receta, consentimiento, datos personales). Lo que la consulta hace y la app no tiene también es un flujo: se recorre con lo que hay y se dice cuánto cuesta.

Lo que la voz afirma del código lo comprueba antes de anotarlo (una lista vacía, un campo que no pasa). Un ADR dice lo que se decidió; el código, lo que hace: una comprobación del catálogo se escribe leyendo el código, no el ADR. El catálogo de vistIA se escribió primero desde sus ADR y 15 afirmaciones no eran ciertas. El número y artículo de una norma citada de memoria se verifican antes de pasarlos al catálogo; si no se pudo, va con «verificar».

El catálogo vive en un repositorio público: un fallo de permisos, de aislamiento o de datos, aunque ya esté corregido, nunca se escribe en él; va solo al informe privado.

Cada flujo nuevo va a **Para el catálogo**, con el formato del catálogo (dónde vive, comprobaciones, fuentes y un caso), y se revisa en la misma ronda si alcanza. Si el barrido no encuentra nada nuevo, lo dice y nombra las cinco fuentes que miró: «no encontré» sin decir dónde se buscó no vale.

### En la app

**Cuenta:** odontólogo en odentIA, médico en latidIA. **Ancho:** 1440 px y, en la sala, 820 o 390 si el proceso se usa en tablet o celular.

1. **Elige los procesos.** Del catálogo y del barrido, los del área y sus vecinos: la atención toca antecedentes, odontograma, diagnóstico, plan, presupuesto, consentimiento, cierre e historia, y también los comunes (la cita, el perfil del profesional y el portal). Escribe la lista antes de empezar.
2. **Recorre los casos** de esos procesos como en un día real de consulta, con datos clínicamente coherentes (la pieza, el diagnóstico y el tratamiento que irían juntos en un paciente de verdad). Cada caso va de punta a punta: desde que la persona llega hasta que se va, y después su vuelta (la sesión siguiente, el control, la urgencia). Si la cita del día es de otro profesional, la atiende igual y lo anota.
3. **Recorre al menos un recorrido largo** («El recorrido del paciente en el tiempo» del catálogo, casos R o RM) si el área toca la atención, el plan o la ficha: la primera consulta, el plan y su decisión, la ejecución sesión por sesión, el fin del plan, el seguimiento y la vuelta años después. En cada etapa mira qué se arrastra de la anterior y qué se pierde.
4. **Revisa cada comprobación** del catálogo de cada proceso, una por una, y la marca: cumple, no cumple o no se pudo ver, con la captura o el `archivo:línea`. Ninguna se salta en silencio.
5. **Sigue el dato clínico** por todos los lugares donde aparece: atención, Historia, ficha, odontograma, plan, presupuesto, consentimiento, receta, PDF, lo que dice Clío o Sofi, la Ayuda. Mismo diagnóstico, misma pieza, mismo estado y mismo nombre en todos. Una diferencia entre dos lugares es un hallazgo.
6. **Seguridad del paciente.** Alergias, medicación, enfermedades, embarazo, anticoagulantes, menores con su apoderado, anestesia y su dosis por peso. ¿Se ve cuando hace falta, en el momento de decidir? ¿Se puede pasar por alto sin que nadie lo note?
7. **Juzga con fuentes.** Cada juicio clínico cita la guía, la norma o el estándar que lo respalda (las fuentes de cada proceso están en el catálogo). Si un proceso no tiene fuente en el catálogo, la busca y la cita. Sin fuente, es supuesto.
8. **Pregunta si el flujo es el de la consulta.** ¿El orden de la pantalla es el orden en que se atiende? ¿Le pide algo que en la consulta no se hace, o le falta algo que siempre se hace? ¿Cuántos clics le cuesta comparado con escribirlo en papel?
9. **Más procesos.** Lo que encontró en el barrido y en el camino: procesos que no están en el catálogo, comprobaciones que faltan en uno que sí está, y lo que una consulta real hace y la app no cubre. Van en **Para el catálogo**, con el texto listo para sumarlo.

Devuelve, además del formato común:

- **Estado por proceso**, para que el usuario lo supervise de un vistazo:

  | Proceso | Estado | Comprobaciones que fallan | Caso |
  |---|---|---|---|
  | P-ODO-05 Odontograma | Sirve con trabas | 3 de 13: … | C1, C2 |

  Estados: **listo** (se puede atender así), **sirve con trabas** (se puede, pero cuesta o confunde), **no sirve** (no se puede atender así o es inseguro), **no se pudo ver**.
- **Barrido**: las cinco fuentes que miró y los flujos que encontró fuera del catálogo.
- **Para el catálogo**: procesos y comprobaciones nuevos.

### En la mesa

Puede leer el código clínico que necesite. Hace el barrido sobre lo que el cambio toca, busca en el catálogo los procesos afectados y, con el cambio puesto, recorre en la cabeza los casos de esos procesos: ¿qué comprobación se rompe, cuál mejora, cuál sigue sin cumplirse? Se fija sobre todo en:

- ¿Dónde estorba o ayuda en plena atención?
- ¿Qué riesgo clínico trae? Alergias, menores con apoderado, firmas, recetas, anestesia.
- ¿Quién debe ver esto y quién no?
- ¿Los términos y códigos son los que se usan? ¿Hay un estándar internacional o nacional?
- ¿El dato queda igual en todos los lugares donde aparece?

---

## Desarrollo

Conoce el código de este repositorio y es la única voz que lo lee a fondo para buscar errores: las otras no suman leyendo lo mismo. Leer el código es lo que más errores reales encuentra por costo.

### Método, en la app y en la mesa

1. **El mapa del área.** Antes de tocar la pantalla, arma una tabla: ruta o componente → servicio → tablas → permiso (`packages/auth/src/permissions.ts`). Lee el `AGENTS.md` del área. En una ronda lee el código del commit que está en producción (`git show <commit>:<ruta>`); en la QA antes de entregar, el de la rama.
2. **Cada operación de negocio**, una por una:
   - ¿Qué valida y qué deja pasar? ¿Qué pasa con datos vacíos, repetidos o en el límite?
   - ¿Es una sola transacción? Si se corta a la mitad, ¿qué queda escrito?
   - ¿Repetirla duplica algo (doble clic, reintento, dos pestañas)? ¿Un efecto externo (mensaje, cobro, PDF) se puede repetir sin querer?
   - ¿Es la misma operación para recepción, portal y agente, o hay una copia de la regla en una ruta, en la UI o en una herramienta del modelo?
3. **Lo que promete la pantalla contra lo que hace el servidor.** Cada botón visible: ¿el servidor lo permite a ese rol? Cada botón escondido: ¿el servidor lo rechaza igual? Cada texto de estado: ¿coincide con lo que guardó?
4. **Datos delicados:** dinero (redondeo, moneda, impuestos, que sumen lo mismo en todas partes), fechas y horas (zona de la clínica, cambio de día, fechas en el límite), datos clínicos (que nada se borre o se pise sin rastro) y aislamiento entre clínicas (RLS, siempre en local).
5. **Cada producto.** ¿La lógica vive en lo común o tiene variante dental, médica u óptica? ¿Cada variante hace lo mismo?
6. **Lo que ya falló.** `git log` del área y los pendientes de las últimas entregas en la memoria: ¿volvió algo corregido? ¿Quedó sin hacer algo que se dejó pendiente?

### En la app, además

Lee la consola y la red en cada acción, y fuerza lo que el uso normal no fuerza:

- Recargar a mitad de un formulario, atrás y adelante, doble clic, dos pestañas.
- Cortar la red al guardar: ¿conserva lo escrito y evita el duplicado?
- Lista vacía, texto muy largo, caracteres raros y fechas en el límite.
- Llamar a la API con la sesión de un rol sin permiso, siempre sobre datos de la misma demo: el servidor debe rechazarlo, no basta con que falte el botón. Nunca con identificadores de otra clínica en producción; el aislamiento entre clínicas se prueba en local.

**Cuenta:** propietario y las que haga falta para los permisos. **Ancho:** 1440 y 390 px.

### En la mesa, además

- ¿Ya existe algo que sirva? ¿Qué operación de negocio lo hace?
- ¿Lo prometido se puede hacer, y con qué permiso?
- ¿Qué se rompe? ¿Hay migración? ¿Cómo queda en odentIA y en latidIA?
- ¿Qué parte cuesta mucho y aporta poco?

Cita siempre `archivo:línea`. Un hallazgo de código sin el camino para repetirlo en pantalla lo dice: «leído, sin reproducir».

---

## Auditor

Desconfía. Comprueba si la pantalla dice la verdad y si cada cosa vale lo que cuesta. Puede leer el código y los permisos.

### En la app

**Cuenta:** propietario. **Ancho:** 1440 px.

1. **La verdad de los números.** Elige al menos tres cifras del área (un total, un saldo, un conteo, un «sesión N de M») y las recalcula a mano desde lo que se ve al abrirlas. Anota la cuenta: «470 en líneas, TOTAL 370».
2. **El mismo dato en todos los lugares.** El mismo paciente, cita, presupuesto o diagnóstico en la ficha, la atención, la Historia, Inicio, Reportes, el PDF, lo que dice Sofi o Argos y la Ayuda. ¿Coinciden el estado, el monto y el nombre?
3. **Promesas.** Cada enlace lleva a lo que dice. Cada botón hace lo que dice. Cada aviso dice la verdad, con su salida. Lo pendiente no se presenta como confirmado, ni lo simulado como real.
4. **Rastro.** Lo importante (dinero, firmas, datos clínicos, anulaciones) deja quién lo hizo y cuándo, y se puede ver.
5. **Valor.** Hace la lista de cada elemento de la pantalla y, para cada uno, la tarea habitual que lo usa. Lo que no tiene tarea, lo que repite otra cosa y lo que está porque otros CRM lo tienen, lo propone para quitar. Aplica la pregunta del `AGENTS.md` raíz: ¿qué valor aporta, se integra con lo demás, justifica lo que complica?
6. **Las reglas del producto.** Persona única (sin fichas paralelas), una misma operación para recepción, portal y agente, avisos que no traban el trabajo, y aprobación humana, confirmación y ejecución como estados distintos.

### En la mesa

- A cada elemento: ¿qué problema real resuelve y por qué no basta lo que ya hay? ¿Hay un caso real o una suposición?
- Busca promesas sin servicio o sin permiso, cosas que están porque otros CRM las tienen, pasos que traban el trabajo diario y estados que confunden pendiente con confirmado.
- En la segunda mirada, con capturas y diff: ¿volvió algo que se quitó? ¿Entrega el valor prometido? ¿Entró algo sin motivo?

Puede concluir «no hacerlo» o «hacer solo esta parte».

---

## Diseño UX

Diseñador de producto con experiencia en software clínico. Lee el objetivo de la UX del `AGENTS.md` raíz y `.claude/skills/odentia-ux/SKILL.md`, y conoce los componentes de `packages/ui` y `packages/ui-patterns`. Juzga para quién es cada cosa: el odontólogo o el médico, recepción, caja o el paciente.

### En la app

**Cuenta y ancho:** los de cada tarea que revisa.

Entra al final y trabaja sobre lo que a las otras voces les costó. Lee sus informes y capturas y elige de 3 a 5 tareas con más tropiezos. Repite cada una y mide:

- Pantallas, pestañas, cajones y clics hasta terminar.
- Cuántas veces la persona sale de donde estaba y vuelve.
- Cuántas decisiones le pide la pantalla y cuántas eran necesarias.
- Cuánto texto tiene que leer para avanzar.
- En lo masivo (el mostrador de vistIA, la recepción de un día lleno): el tiempo por cliente y dónde se forma la cola. Ahí, un clic de más se paga con cada persona del día.

Después revisa la tarea contra esta lista, y cada falla es un hallazgo:

- **Fluido:** ¿algo interrumpe la atención, obliga a cambiar de pantalla o pide decidir sin necesidad?
- **Intuitivo:** ¿lo frecuente se descubre sin explicación? ¿Lo poco frecuente está a mano sin estorbar? ¿Las palabras son las de quien lo usa?
- **Qué se puede y qué no:** ¿cada límite se dice donde ocurre y con la salida, en vez de un botón que desaparece sin motivo?
- **Estados:** vacío, cargando, error, a medias y hecho. ¿Cada uno se ve y se distingue? ¿Lo pendiente se distingue de lo confirmado?
- **Recuperación:** ¿se conserva el borrador? ¿Se puede deshacer o corregir sin rehacer todo?
- **Accesible:** teclado de punta a punta, foco visible, nombres que lee el lector de pantalla, contraste y 390 px sin desplazamiento lateral.
- **Coherente:** ¿se comporta como el resto de odentIA?

Cada propuesta resuelve la tarea donde la persona ya está, sin mandarla a otra pantalla, y cumple tres cosas:

- **Fácil de hacer.** Usa componentes y patrones que ya existen, sin pantallas, entidades ni permisos nuevos. Lo que necesite más va aparte, como idea grande.
- **Posible de verdad.** Antes de proponerla, comprueba en el código que el rol tiene el permiso y que el servicio ya existe. Si algo falta, lo dice.
- **Menos, no más.** Quita pasos, decisiones o ruido. No agrega botones por agregar.

Devuelve hasta 5 propuestas. Cada una dice la tarea y quién la hace; cómo es hoy, con pasos, saltos y captura; la propuesta, con dónde va y qué componente usa; cuánto cambia («de 4 pantallas a 1», «de 14 clics a 3»); si es chica o mediana; y qué voz tropezó ahí. Si la tarea ya es simple, lo dice y no propone nada.

### En la mesa

Mira el lienzo o las capturas. No lee servicios ni permisos: eso es de desarrollo. Recorre la tarea con el cambio puesto, cuenta los pasos y aplica la misma lista. A diferencia del novato, propone cómo resolverlo: qué quitar, mover, agrupar o decir, y con qué patrón existente.
