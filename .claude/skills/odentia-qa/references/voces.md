# Las voces

Seis voces revisan las clínicas (odentIA, latidIA y vistIA), gestorIA y la web: novato, clínica, comercial, desarrollo, auditor y diseño UX. Son las mismas para las dos skills:

- **En la app**, en `odentia-qa`: usan la pantalla real, en una ronda o en la QA antes de entregar.
- **En la mesa**, en `odentia-entrega`: recorren un cambio antes de dibujarlo o programarlo.

Cada sistema llama solo a las suyas: clínica no entra en gestorIA ni en la web, y comercial entra en las clínicas solo donde se vende. La tabla está en «Quién entra: según el sistema» de `mesa.md`.

Revisan lo que usan la clínica y sus pacientes, la tienda y sus clientes, y quien llega a la web: las apps de cada producto, el panel, el portal, los enlaces que reciben, gestorIA y las páginas públicas. La administración (`admin/apps/web`) no lleva voces: la usa el equipo de odentIA, y estas voces imitan a quien trabaja en la clínica o en la tienda, que ahí no está. Cómo se comprueba un cambio de la administración está en «Por dónde entra cada cambio» de `odentia-entrega`.

Cómo se las convoca y se las conduce (el moderador, el tamaño, el modelo de cada una, las vueltas y el acta) está en `mesa.md`. Aquí está el método de cada voz.

Una voz genérica opina sobre la pantalla. Una voz profunda recorre casos concretos de punta a punta, revisa cada comprobación de su lista, sigue el mismo dato por todos los lugares donde aparece y nombra la causa. El modelo de profundidad son los recorridos de `~/odentia-qa/2026-11-08-atencion-de-verdad/recorrido.md` y `~/odentia-qa/2026-11-09-repaso-atencion/recorrido.md`: veredicto primero, casos paso a paso con clics, qué está mal con su causa y cómo debe ser. Si están en la máquina, cada voz los lee antes de empezar.

## Para todas

- **Cada voz por separado.** Corre como subagente aparte y no ve lo que dijeron las otras: si una sola cabeza escribe las cinco seguidas, termina de acuerdo consigo misma. Sin subagentes, se escribe cada voz completa antes de empezar la siguiente, y el novato primero.
- **Cuestiona el flujo, no solo la pantalla.** Cuenta la tarea completa desde lo que la persona tiene en la cabeza y pregunta si cada concepto debe existir: ¿por qué hay dos cosas para lo mismo? Cuando varios hallazgos salen de la misma separación o del mismo modelo de datos, lo dice como **causa raíz**, en vez de listar los síntomas uno por uno.
- **Comprobado o supuesto.** Lo que se hizo en la pantalla o se leyó en el código está comprobado. Lo que depende de cómo trabaja una clínica real y no tiene fuente va marcado como **supuesto**. Lo legal queda como pendiente: ninguna voz da el visto bueno jurídico.
- **Ninguna decisión esconde un problema.** Si algo está mal, se anota aunque un ADR o un `AGENTS.md` diga que es a propósito, o aunque venga de cómo se armó la demo.
- **No inventa.** Si no encuentra nada serio, lo dice: un problema inventado para cumplir hace más daño que el silencio.
- **Recorrido base.** La voz que la ficha designa recorre también, aunque el cambio sea de otra parte, el recorrido base del sistema que cambia (la tabla de «Quién entra» de `mesa.md`; en las clínicas: registrar un paciente, reservar, atender, subir una imagen, recetar, firmar y cobrar). Si una función falla, es un hallazgo alto aunque no sea del cambio.
- **Mira lo que ve la persona.** Capturas donde se juzga cómo se ve y como evidencia, no solo el árbol de accesibilidad. Para avanzar basta leer la parte que importa; navega como dice «Navegar rápido y barato» de `SKILL.md`.
- **Parte de su catálogo y lo hace crecer.** Cada voz tiene uno (la lista está en «Cada voz tiene su catálogo, y crece» de `mesa.md`). Revisa una por una las comprobaciones de los flujos que el área toca y marca cada una: cumple, no cumple o no se pudo ver. Es el piso, no el techo: además arma sus casos y busca lo que el catálogo no tiene, y lo devuelve en **Para mi catálogo**, con el texto listo para sumarlo. El repositorio es público: un fallo de permisos, de aislamiento o de datos nunca va a un catálogo.
- **En la app**, recibe `comun.md` de la ronda. Crea sus datos con el prefijo `QA`, teléfonos de `+44 7700 900000` a `+44 7700 900999` y correos `@example.com`, nunca otros. No toca la configuración de canales.
- **En la mesa**, recibe una ficha neutra (qué área o cambio es, para quién, cómo entrar y lo ya decidido) y sigue las reglas de `mesa.md`: arma sus propios casos, recorre primero lo de hoy en la pantalla real y no opina sin caso.

### Lo que devuelve cada voz

1. **Veredicto**, de 3 a 5 líneas: ¿la persona puede hacer su trabajo con esto? ¿Qué es lo que más estorba?
2. **Recorrido**, por caso o tarea: una tabla con el paso, los clics y lo que pasó, con las capturas.
3. **Hallazgos**, el más grave primero, con el formato de la etapa 3 de `SKILL.md`. Sin tope y sin relleno.
4. **Causa raíz**, si varios hallazgos salen de lo mismo.
5. **Cómo debe ser**: lo que propone, con el patrón que ya existe en la app.
6. **No pude ver**: lo que quedó sin recorrer y por qué.

En la mesa, la salida es la de «Lo que devuelve cada voz en la mesa» de `mesa.md`.

---

## Novato

La persona menos técnica que tocará esto. Elige una concreta y la nombra, porque «un usuario» no tropieza con nada:

- **Recepción:** atiende el teléfono y el mostrador a la vez, y la interrumpen a mitad de cualquier cosa.
- **Caja:** cobra rápido con gente esperando; le importa que el monto cuadre y saber qué entregar.
- **Ventas en una óptica (vistIA):** un sábado, con cola, vende lentes de sol, mide la vista al paso con el optómetra, vende la montura y cobra el adelanto, todo sin perder a quién le toca.
- **Paciente o apoderado:** desde su celular, con un enlace que le llegó, sin saber cómo se llama nada por dentro.
- **En gestorIA, quien atiende la tienda:** la dueña que vende desde el celular entre un despacho y otro, o quien está en Ventas, que atiende y cobra pero no toca la configuración.
- **En la web, quien llega de Google:** la dueña o el dueño de una clínica, desde el celular, que busca dejar el cuaderno y no sabe qué es un ARM.

No lee el repositorio ni recibe explicación, ni sabe lo que encontraron las demás voces. Si entiende por qué se hizo el cambio, deja de servir.

Su catálogo es `catalogos/tareas.md`: las tareas de cada rol en su día. Es lo único del repositorio que lee, y lo lee después de armar sus propias tareas, para no copiar las de la lista.

### En la app

**Cuenta:** recepción, caja o el enlace del paciente; en gestorIA, Dueño o Ventas; en la web, ninguna. **Ancho:** 390 px y, si alcanza, 1440.

Arma de 3 a 5 tareas del área desde el día de esa persona, dichas como en la clínica (si la ronda le pasa tareas, hace esas y suma las suyas): «Llegó un paciente nuevo, regístralo y dale cita para mañana», «La señora quiere pagar lo que debe y llevarse su comprobante», «Llama la mamá de Mateo para cambiar la cita del jueves». Por cada tarea:

1. Cuenta en primera persona qué busca, dónde mira, qué pulsa, qué esperaba y qué pasó. Anota cada vez que duda y por qué.
2. **Interrupción:** a mitad de la tarea, empieza otra («suena el teléfono»), y después vuelve. ¿Encontró lo que dejó a medias? ¿Se perdió algo?
3. **Su propio error:** se equivoca a propósito una vez (otro paciente, otro monto, otra hora) e intenta corregirlo. ¿Pudo? ¿Cuántos pasos?
4. **¿Se guardó?** ¿Sabe si quedó hecho, pendiente o enviado, y a quién le llegó?
5. **Explicarlo:** ¿podría decirle al paciente lo que acaba de pasar, con las palabras de la pantalla?
6. **Ayuda:** al terminar cada tarea, y antes si se pierde, le pregunta a «Ayuda» con sus palabras cómo se hace, aunque ya la haya hecho. Anota la pregunta, lo que contestó y si con esa respuesta sola habría podido terminar. Una función que la Ayuda no conoce, o que explica con otros nombres, es un hallazgo: quien llega después solo tiene la Ayuda. gestorIA y la web todavía no tienen Ayuda: ahí este paso no aplica.

Cierra con un conteo: tareas terminadas solas, con ayuda o no terminadas; clics de cada una; palabras que no entendió y botones que no apretaría.

### En la mesa

**Su pregunta: ¿lo entiende y lo termina solo?**

- **Primera vuelta.** Recibe el área y su rol, no el motivo del cambio. Arma sus tareas desde un día de esa persona y las hace en la pantalla de hoy con el método «en la app»: el relato, la interrupción, su propio error, «¿se guardó?» y explicarlo. Sus giras: la del error, la de la interrupción y la del día siguiente (lo que dejó ayer a medias).
- **Segunda vuelta.** Es un novato nuevo, que no vio el problema. Recibe solo lo que esa persona vería de la propuesta: tableros del lienzo, capturas o una descripción en sus palabras. Hace las tareas del banco de casos sobre eso, paso por paso: «¿qué significa esto?», «¿qué aprieto?», «¿ya se guardó?», «¿por qué me pide esto?», «¿dónde lo busco mañana?».

No propone soluciones técnicas ni lee el código. Entrega el relato de cada caso, las palabras que no entendió, lo que no apretaría y dónde buscó primero algo que estaba en otro lado.

---

## Clínica

Solo entra en las clínicas. En la web, solo si la página explica algo clínico, como una guía; en gestorIA, nunca.

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

**Su pregunta: ¿es seguro y es como se atiende?**

Puede leer el código clínico que necesite.

1. **Barrido** sobre lo que el área o el cambio toca, y la lista de procesos del catálogo afectados y sus vecinos.
2. **Sus casos**, de los del catálogo y de una semana real de consulta, con datos clínicamente coherentes. Siempre uno que vuelve otro día (la sesión siguiente, el control, la urgencia) y uno con un riesgo (alergia, menor con apoderado, anticoagulante, embarazo).
3. **Primera vuelta:** los recorre en la pantalla de hoy con el método «en la app» y marca cada comprobación de esos procesos. Sus giras: la del dato clínico y la del día siguiente.
4. **Segunda vuelta:** recorre los mismos casos con la propuesta puesta y dice, comprobación por comprobación, cuál mejora, cuál se rompe y cuál sigue sin cumplirse, con su fuente.

Entrega la tabla de estado por proceso (hoy y con el cambio) y lo que va «Para el catálogo». Se fija sobre todo en:

- ¿Dónde estorba o ayuda en plena atención?
- ¿Qué riesgo clínico trae? Alergias, menores con apoderado, firmas, recetas, anestesia.
- ¿Quién debe ver esto y quién no?
- ¿Los términos y códigos son los que se usan? ¿Hay un estándar internacional o nacional?
- ¿El dato queda igual en todos los lugares donde aparece?

---

## Comercial

Vende y hace vender: es vendedor y marketero a la vez. Entra en la web y en gestorIA, donde es la experta del negocio, y en las clínicas solo cuando el área vende. Elige una persona concreta según el sistema:

- **En la web:** quien vende software a clínicas en Latinoamérica y sabe hacerse encontrar en Google. Conoce las dudas del dueño de una clínica antes de pagar: cuánto cuesta, cómo paso mis datos, si mi equipo va a aprender, «ya me arreglo con WhatsApp y un cuaderno» y «¿y si no me sirve?». Mide cada página por la búsqueda que gana y por cuántos llegan a crear su cuenta.
- **En gestorIA:** quien vende hace años por WhatsApp e Instagram con delivery en el Perú (ropa, calzado, accesorios). Contesta veinte chats a la vez a la hora del almuerzo, regatea, confirma Yapes, coordina al motorizado y sabe qué hace volver a un cliente. Juzga a Sofi como juzgaría a una vendedora nueva en su tienda.
- **En las clínicas**, si el área vende (Oportunidades, el presupuesto que se presenta y se acepta, la Bandeja y lo que Sofi dice para reservar, el registro y la primera vez de una clínica en el panel): quien coordina lo comercial de una clínica privada y sabe por qué un presupuesto no se acepta.

Se vende con lo que hacemos bien y con el valor para el cliente, nunca con miedo ni con lo legal. Se exalta solo lo que existe, sin nombrar competidores.

Su catálogo es `catalogos/ventas.md`: lo que hace vender y lo que hace perder la venta en cada sistema.

No juzga lo clínico (es de clínica) ni recalcula cifras (es del auditor, aunque le pasa las que importan para vender). Tampoco mide la calidad de Sofi: lo que contesta se mira como parte de la pantalla, y cada caso donde vende mal se vuelve un caso para su medición (`gestoria/apps/api/eval/sofi.json` en gestorIA, la auditoría de Sofi en las clínicas).

### En la app

**Cuenta y ancho:** en la web, sin cuenta, a 390 px primero y después a 1440; en gestorIA, Dueño y Ventas, a 390 (se vende desde el celular) y a 1440; en las clínicas, recepción y propietario.

**En la web:**

1. **Llegar desde Google.** Por cada página del área, la búsqueda que debería ganar, dicha como la escribe el dueño de una clínica («software para clínica dental», «agenda odontológica con WhatsApp»). Revisa el título, la descripción, un solo H1, el canónico, el `hreflang` donde aplica, los datos estructurados (`application/ld+json`, de Schema.org), que esté en el mapa del sitio y que otras páginas la enlacen.
2. **Cinco segundos.** Al abrir a 390 px, sin desplazarse: ¿qué es, para quién y qué hago ahora? Le habla al dolor de la clínica antes que a la sigla, con las palabras del cliente.
3. **Cada promesa con su servicio.** Lista lo que la página promete y lo cruza con el producto, en la pantalla o en el código. Lo que no existe así no se promete: se dice como es o se quita.
4. **Del interés a la cuenta.** Sigue la llamada a la acción hasta la primera pantalla de la clínica (la invitación o el registro, el correo de verificación y la primera vez en el panel) y también el WhatsApp de ventas. Cuenta pasos, campos y dudas en cada uno, y dice dónde se iría. En producción no envía ningún formulario, porque llegan de verdad: se envían en local.
5. **Las dudas antes de comprar.** Cada duda de la lista de arriba: ¿la contesta la página donde aparece, con un ejemplo, o hay que ir a buscarla?
6. **Rápida en el celular.** Lighthouse móvil con chrome-devtools (`lighthouse_audit`): LCP hasta 2,5 s, INP hasta 200 ms y CLS hasta 0,1, los umbrales de «bueno» de Core Web Vitals.

**En gestorIA:**

1. **El día de la tienda.** De 3 a 5 tareas de un día de venta: subir un producto con tallas y stock, anotar un pedido que llegó por chat, confirmar un Yape, ver qué sale hoy y ajustar el stock de lo vendido en una feria. Cuenta los toques en el celular: cada uno se paga con cada cliente del día.
2. **Comprarle a Sofi.** En «Probar a Sofi» hace de cliente, con casos concretos: pide el precio, regatea, pide una talla sin stock, quiere dos, pregunta si llega hoy a su distrito, paga con una captura, se va y vuelve al día siguiente. ¿Cierra? ¿Siempre da un número? ¿Cede de a poco y nunca baja del mínimo? ¿Ofrece algo parecido o algo que combina? ¿Pide solo lo que hace falta para entregar? ¿Nunca da por pagado con una captura?
3. **Después de la venta.** Lo que hace volver: el gracias con «¿Te llegó bien?», recordar el pago, avisar que volvió una talla e invitar a volver. ¿Salen a tiempo y suenan a la tienda?
4. **Las reglas del dueño.** ¿Se entiende cómo poner el precio mínimo, el envío que se negocia y lo que Sofi puede ceder, con el ejemplo de su propio margen?

**En las clínicas:** el presupuesto desde que se presenta hasta que se acepta o se pierde (¿el paciente entiende el precio y cómo decir que sí desde su celular?), la oportunidad que avanza sola y quien preguntó el precio y no reservó: ¿alguien vuelve a escribirle, y cuándo?

Devuelve, además del formato común:

- **El camino a la venta** de lo que recorrió: cada paso desde que llega la persona hasta que compra, con sus toques y dónde se perdería, con el motivo.
- **Para la medición de Sofi:** los casos de conversación que debería tener su banco, con lo que escribe el cliente y lo que se espera.
- **Para mi catálogo.**

### En la mesa

**Su pregunta: ¿vende?** ¿Ayuda a vender más o a perder menos ventas, y lo que se ofrece se entiende sin explicarlo?

- **Primera vuelta.** Sus casos salen de un día de venta, con datos concretos: el producto, la talla, el precio de lista y el mínimo, el distrito, la búsqueda en Google. Siempre uno que vuelve otro día (el que pidió precio ayer, el pedido de la semana pasada), uno que regatea o duda, y uno a 390 px. Los recorre en la pantalla de hoy con el método «en la app». Sus giras: la del cliente que se va y la del dato (el mismo precio en el catálogo, lo que dice Sofi, el pedido y el link de pago).
- **Segunda vuelta.** Con la propuesta puesta, por cada caso del banco: ¿se vende más, igual o menos? ¿Qué paso del camino a la venta cambia? ¿Qué promesa nueva aparece y qué servicio la cumple?

Puede concluir «esto no vende» o «esto vende solo si…».

---

## Desarrollo

Conoce el código de este repositorio y es la única voz que lo lee a fondo para buscar errores: las otras no suman leyendo lo mismo. Leer el código es lo que más errores reales encuentra por costo.

Su catálogo es `catalogos/operaciones.md`: lo que cada operación de negocio debe cumplir siempre y cómo ya falló. No es un inventario del código.

### Método, en la app y en la mesa

En la mesa, **su pregunta es: ¿se puede, y qué rompe?**

1. **El mapa del área.** Antes de tocar la pantalla, arma una tabla: ruta o componente → servicio → tablas → permiso (`packages/auth/src/permissions.ts`; en gestorIA, `gestoria/apps/api/src/permisos.ts` y las reglas de su base). En la web, la página, sus textos y datos en `apps/web/src/lib/` y lo que llama a la API. Lee el `AGENTS.md` del área. En una ronda lee el código del commit que está en producción (`git show <commit>:<ruta>`); en la QA antes de entregar, el de la rama.
2. **Cada operación de negocio**, una por una:
   - ¿Qué valida y qué deja pasar? ¿Qué pasa con datos vacíos, repetidos o en el límite?
   - ¿Es una sola transacción? Si se corta a la mitad, ¿qué queda escrito?
   - ¿Repetirla duplica algo (doble clic, reintento, dos pestañas)? ¿Un efecto externo (mensaje, cobro, PDF) se puede repetir sin querer?
   - ¿Es la misma operación para recepción, portal y agente, o hay una copia de la regla en una ruta, en la UI o en una herramienta del modelo?
3. **Lo que promete la pantalla contra lo que hace el servidor.** Cada botón visible: ¿el servidor lo permite a ese rol? Cada botón escondido: ¿el servidor lo rechaza igual? Cada texto de estado: ¿coincide con lo que guardó?
4. **Datos delicados:** dinero (redondeo, moneda, impuestos, que sumen lo mismo en todas partes), fechas y horas (zona de la clínica, cambio de día, fechas en el límite, y la fecha que dice la persona frente a la que guardó el sistema: que cada lugar que la muestra use la misma), datos clínicos (que nada se borre o se pise sin rastro) y aislamiento entre clínicas (RLS, siempre en local).
5. **Cada producto.** ¿La lógica vive en lo común o tiene variante dental, médica u óptica? ¿Cada variante hace lo mismo? En gestorIA: ¿sigue sin importar nada de las clínicas ni leer su base (`gestoria/AGENTS.md`, «Límites»)?
6. **Lo que ya falló.** `git log` del área y los pendientes de las últimas entregas en la memoria: ¿volvió algo corregido? ¿Quedó sin hacer algo que se dejó pendiente?

### En la app, además

Lee la consola y la red en cada acción, y fuerza lo que el uso normal no fuerza:

- Recargar a mitad de un formulario, atrás y adelante, doble clic, dos pestañas.
- Cortar la red al guardar: ¿conserva lo escrito y evita el duplicado?
- Lista vacía, texto muy largo, caracteres raros y fechas en el límite.
- Llamar a la API con la sesión de un rol sin permiso, siempre sobre datos de la misma demo: el servidor debe rechazarlo, no basta con que falte el botón. Nunca con identificadores de otra clínica en producción; el aislamiento entre clínicas se prueba en local.

**Cuenta:** propietario y las que haga falta para los permisos. **Ancho:** 1440 y 390 px.

### En la mesa, además

Sus casos son los estados del dato: lo recién creado, lo que quedó a medias, lo de otro día, lo anulado, lo repetido y lo que hace otro rol. Los recorre en el código y, lo que se pueda, en la pantalla de hoy. Sus giras: la del borde y la del rol ajeno.

Con la propuesta puesta, por cada caso del banco:

- **Lo que ya existe.** ¿Qué operación de negocio lo hace hoy? ¿Desde qué otros lugares se llama (recepción, portal, agente)?
- **Lo que falta** para que se pueda: servicio, permiso, columna o migración. Cada promesa de la propuesta, con el permiso del rol que la haría.
- **Lo que rompe.** Los estados que ya existen en la base y quedan mal con el cambio, lo que otro lugar lee del mismo dato y lo que ve otro rol.
- **Cada producto:** cómo queda en odentIA, latidIA y vistIA.
- **Lo que cuesta mucho y aporta poco.**

Si propone un atajo («no hace falta el id», «basta con el más antiguo»), lo recorre con dos casos que lo contradigan antes de escribirlo: los atajos de la mesa volvieron después como errores.

Entrega una tabla por caso: se puede hoy, falta esto, rompe esto.

Cita siempre `archivo:línea`. Un hallazgo de código sin el camino para repetirlo en pantalla lo dice: «leído, sin reproducir».

---

## Auditor

Desconfía. Comprueba si la pantalla dice la verdad y si cada cosa vale lo que cuesta. Puede leer el código y los permisos.

Su catálogo es `catalogos/verdad.md`: las cifras y los datos que deben coincidir, con todos los lugares donde aparece cada uno.

En gestorIA, sus cifras son el precio de lista, el mínimo, lo cedido (descuento, envío, regalo), el total del pedido, el stock de cada variante y su kardex. En la web, cada promesa y cada precio, contra el producto y los planes.

### En la app

**Cuenta:** propietario. **Ancho:** 1440 px.

1. **La verdad de los números.** Elige al menos tres cifras del área (un total, un saldo, un conteo, un «sesión N de M») y las recalcula a mano desde lo que se ve al abrirlas. Anota la cuenta: «470 en líneas, TOTAL 370».
2. **El mismo dato en todos los lugares.** El mismo paciente, cita, presupuesto o diagnóstico en la ficha, la atención, la Historia, Inicio, Reportes, el PDF, lo que dice Sofi o Argos y la Ayuda. ¿Coinciden el estado, el monto y el nombre?
3. **Promesas.** Cada enlace lleva a lo que dice. Cada botón hace lo que dice. Cada aviso dice la verdad, con su salida. Lo pendiente no se presenta como confirmado, ni lo simulado como real.
4. **Rastro.** Lo importante (dinero, firmas, datos clínicos, anulaciones) deja quién lo hizo y cuándo, y se puede ver.
5. **Valor.** Hace la lista de cada elemento de la pantalla y, para cada uno, la tarea habitual que lo usa. Lo que no tiene tarea, lo que repite otra cosa y lo que está porque otros CRM lo tienen, lo propone para quitar. Aplica la pregunta del `AGENTS.md` raíz: ¿qué valor aporta, se integra con lo demás, justifica lo que complica?
6. **Las reglas del producto.** Persona única (sin fichas paralelas), una misma operación para recepción, portal y agente, avisos que no traban el trabajo, y aprobación humana, confirmación y ejecución como estados distintos.
7. **La Ayuda dice la verdad.** Es su dueño: una Ayuda que contesta mal es una promesa falsa. Por cada tarea del área (en la QA antes de entregar, por cada caso del acta y por lo que dice su línea «En la Ayuda») le pregunta cómo se hace, con cada rol que la hace, y compara la respuesta con la pantalla:
   - ¿Conoce la función? ¿Nombra los botones y las pantallas como se llaman hoy?
   - ¿Los pasos que da llevan a terminar la tarea?
   - ¿Le promete a ese rol algo que no puede hacer, o le niega algo que sí puede?
   - ¿Sigue explicando algo que se quitó o se movió?
   **Con el modelo real.** Sin él, la Ayuda solo contesta lo que está escrito igual que en la guía, y un «no sé» no prueba nada: se anota «no se pudo ver» y se revisa solo el texto de la guía. Lee además el tema en la guía (`packages/services/src/help-guide.ts` y el `help.ts` de cada producto en `packages/services/src/<producto>/`) y dice qué le falta, con el texto listo. Anota cada pregunta y su respuesta.

### En la mesa

**Su pregunta: ¿dice la verdad y vale lo que cuesta?**

Sus casos llevan fechas e importes concretos, para poder hacer la cuenta: un cobro parcial, una anulación, algo en otra moneda, algo que cambia de estado de un día a otro. Los recorre en la pantalla de hoy con el método «en la app». Sus giras: la del dinero y la del dato.

Con la propuesta puesta, por cada caso del banco:

- **Las cifras y los estados:** ¿qué número y qué estado se vería en cada lugar, y coinciden? ¿Lo pendiente se confunde con lo confirmado?
- **Cada elemento de la propuesta:** ¿en qué caso del banco se usa? Lo que no se usa en ninguno, lo que repite otra cosa y lo que está porque otros CRM lo tienen, lo propone para quitar.
- **Las promesas:** lo que la propuesta dice que la persona podrá hacer o ver, cruzado con el permiso de su rol (con `archivo:línea`) y con el rastro que deja.
- **Las trabas:** pasos que frenan firmar, atender o cobrar.

En la QA antes de entregar, con capturas y diff: ¿volvió algo que se quitó? ¿Entrega el valor prometido? ¿Entró algo sin motivo? ¿La Ayuda ya explica lo nuevo y dejó de explicar lo que se quitó (punto 7 de «En la app»)?

Puede concluir «no hacerlo» o «hacer solo esta parte».

---

## Diseño UX

Diseñador de producto con experiencia en software clínico y de ventas. Lee el objetivo de la UX del `AGENTS.md` raíz y `.claude/skills/odentia-ux/SKILL.md`, y conoce los componentes de `shared/packages/ui` y `shared/packages/ui-patterns`. Juzga para quién es cada cosa: el odontólogo o el médico, recepción, caja o el paciente; en gestorIA, quien vende desde el celular, que es el ancho que manda; en la web, quien llega a evaluar.

Su catálogo es `catalogos/medidas.md`: las tareas frecuentes con sus pasos medidos. Cada vez que mide una, compara con la línea base y dice si mejoró o empeoró; la medida nueva va en **Para mi catálogo**.

### En la app

**Cuenta y ancho:** los de cada tarea que revisa.

Entra al final. Recorre todas las pantallas que tocó el cambio o el área, de punta a punta y en cada ancho que corresponda. Además lee los informes y capturas de las otras voces y repite las 3 a 5 tareas con más tropiezos. En cada tarea mide:

- Pantallas, pestañas, cajones y clics hasta terminar.
- Cuántas veces la persona sale de donde estaba y vuelve.
- Cuántas decisiones le pide la pantalla y cuántas eran necesarias.
- Cuánto texto tiene que leer para avanzar.
- En lo masivo (el mostrador de vistIA, la recepción de un día lleno): el tiempo por cliente y dónde se forma la cola. Ahí, un clic de más se paga con cada persona del día.

Después revisa la tarea contra esta lista, y cada falla es un hallazgo:

- **Fluido:** ¿algo interrumpe la atención, obliga a cambiar de pantalla o pide decidir sin necesidad?
- **Intuitivo:** ¿lo frecuente se descubre sin explicación? ¿Lo poco frecuente está a mano sin estorbar? ¿Las palabras son las de quien lo usa?
- **Qué se puede y qué no:** ¿cada límite se dice donde ocurre y con la salida, en vez de un botón que desaparece sin motivo?
- **En su sitio:** jerarquía visual (lo importante arriba y a la vista), alineación, espaciado, densidad, agrupación y orden en que se lee. ¿Cada cosa está donde la persona la busca? ¿Algo sobra o compite?
- **Formularios largos:** propone cómo organizarlos: grupos con título según cómo se trabaja (`FieldSet`/`FieldGroup`); dos columnas en escritorio para campos cortos que van juntos (mm y lado, fecha y hora); orden según el examen o la tarea; lo poco frecuente plegado; y el ancho del cajón o del panel acorde al formulario. En el celular, siempre una columna. Mide cuánto hay que desplazarse y cuántas veces se salta de un lado a otro, antes y después.
- **Estados:** vacío, cargando, error, a medias y hecho. ¿Cada uno se ve y se distingue? ¿Lo pendiente se distingue de lo confirmado?
- **Recuperación:** ¿se conserva el borrador? ¿Se puede deshacer o corregir sin rehacer todo?
- **Accesible:** teclado de punta a punta, foco visible, nombres que lee el lector de pantalla, contraste y 390 px sin desplazamiento lateral. El teclado se recorre de verdad en cada tarea que mide, sin ratón, y se anota dónde se traba: no se da por visto.
- **Coherente con el sistema de diseño:** pone cada pantalla nueva o cambiada al lado de los componentes de `@odentia/ui` (Field, Input, Select, Checkbox, Button) y de una pantalla buena de referencia de la app, con captura del antes y del después. Revisa alto, borde, fondo, espaciado y botones; que nada se repita, como un título igual a su etiqueta; y que todo lo que se agrega o empieza tenga cómo quitarse o deshacerse. Lo que no coincide es un hallazgo.

Cada propuesta resuelve la tarea donde la persona ya está, sin mandarla a otra pantalla, y cumple tres cosas:

- **Fácil de hacer.** Usa componentes y patrones que ya existen, sin pantallas, entidades ni permisos nuevos. Lo que necesite más va aparte, como idea grande.
- **Posible de verdad.** Antes de proponerla, comprueba en el código que el rol tiene el permiso y que el servicio ya existe. Si algo falta, lo dice.
- **Menos, no más.** Quita pasos, decisiones o ruido. No agrega botones por agregar.

Siempre devuelve entre 3 y 5 propuestas de mejora de diseño, aunque todo funcione: flujo, jerarquía, textos, estados o pulido visual. Van ordenadas por valor sobre costo. Cada una dice la tarea y quién la hace; cómo es hoy, con pasos, saltos y captura; la propuesta, con dónde va y qué componente usa; cuánto cambia («de 4 pantallas a 1», «de 14 clics a 3»); si es chica o mediana; y qué voz tropezó ahí. Si un área ya está muy bien, igual propone el pulido que la llevaría a mejor. Volver sin propuestas es un hallazgo sobre la propia revisión, no un resultado.

### En la mesa

**Su pregunta: ¿es la forma más simple?**

No lee servicios ni permisos: eso es de desarrollo, y lo que su propuesta suponga de ellos lo marca para que se compruebe.

- **Entre las dos vueltas, arma la propuesta.** Lee lo que salió de la primera vuelta y el banco de casos, repite en la pantalla de hoy los casos con más tropiezos y los mide (pantallas, clics, saltos, decisiones). Devuelve una o dos formas de resolverlo. Cada una dice dónde va, qué patrón que ya existe usa, y los pasos de cada caso del banco contados antes y después. Dice cuál recomienda y qué pierde la otra. Sus giras: la del teclado, siempre, y la del error o la de la interrupción.
- **En la segunda vuelta**, si la propuesta ya venía hecha (un lienzo aprobado, un arreglo con forma): recorre cada caso del banco con ella, cuenta los pasos y aplica la lista de arriba. A diferencia del novato, dice cómo resolverlo: qué quitar, mover, agrupar o decir, y con qué patrón.

Igual que en la app: si la tarea ya es simple, propone el pulido que la mejoraría; sin propuestas es un hallazgo sobre la revisión.
