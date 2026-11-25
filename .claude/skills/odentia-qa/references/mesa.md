# La mesa

La mesa es la forma de convocar a las voces de `voces.md` y de conducirlas. Tiene un moderador, fases con una salida cada una y un acta que usan las etapas que siguen. Sirve para tres cosas:

- **Sobre un área**, sin ningún cambio: «lanza la mesa sobre Cobros», o la ronda periódica. Encuentra problemas por su cuenta. Es la ronda de `SKILL.md`: usa la primera vuelta de este archivo, confirma, y sigue con la propuesta, la segunda vuelta y el acta de cada entrega, hasta dejar todo listo para programar (su apartado 5).
- **Sobre un cambio**, dentro de `odentia-entrega` (su etapa 1): las dos vueltas y el acta.
- **Antes de entregar** (apartado 8 de `SKILL.md`): las voces recorren los criterios del acta sobre el cambio ya hecho.

Una voz simulada no es una clínica real. La mesa encuentra a tiempo lo que sería caro corregir después; no aprueba, y lo que diga nunca se presenta como evidencia de que una clínica lo encuentre fácil. Tampoco anticipa los errores del código que todavía no existe: esos los encuentra la QA antes de entregar. De la mesa se espera lo que es de diseño: un concepto que sobra, un rol sin permiso, un dato que no llega, el caso de otro día.

## El moderador

Es la sesión principal. No es una voz y no opina sobre el diseño: prepara, reparte, comprueba y decide. Sin alguien con estas funciones, las voces contestan lo mismo, nadie resuelve los choques y el acta no le sirve a nadie.

1. **Conoce los hechos antes de llamar a nadie.** Lee él mismo el código del área (ruta o componente → servicio → tablas → permiso en `packages/auth/src/permissions.ts`) y recorre una vez el caso principal en la pantalla de hoy. No lo delega: quien no conoce los hechos no nota cuando una voz inventa.
2. **Decide el tamaño** de la mesa y el modelo de cada voz, y lo dice en una línea con el motivo.
3. **Arma el expediente y la ficha** de cada voz.
4. **Guarda los pendientes conocidos** del área sin pasarlos a las voces.
5. **Comprueba** en el código lo que las voces afirman, descarta lo que no tiene caso y hace que dos voces que chocan se lean.
6. **Decide** y escribe el acta. Al usuario le lleva solo lo que es decisión de producto: una pregunta por decisión, con su recomendación.
7. **Anota** cómo rindió la mesa, para que mejore.

## Quién entra: según el sistema

La mesa llama solo a las voces del sistema que toca el cambio o el área. Una voz de otro sistema no suma: no tiene nada que recorrer y su informe es ruido que se paga. Primero se decide el sistema; después el tamaño quita voces, y un riesgo puede sumar una del mismo sistema.

- **En un cambio**, el sistema sale de los archivos: `git diff --name-only origin/main...HEAD`.
- **Sobre un área**, del pedido: «lanza la mesa sobre la portada» es la web; «QA de los pedidos de gestorIA» es gestorIA.

| Lo que cambia | Sistema | Voces | Experta del negocio | Recorrido base |
|---|---|---|---|---|
| `apps/web/` | La web de las clínicas (odentIA, latidIA y vistIA) | Comercial, novato (quien llega de Google) y auditor. Diseño UX si cambia cómo se ve o se arma una página. Desarrollo si toca rutas, el mapa del sitio o un formulario que llama a la API. Clínica solo si la página explica algo clínico, como una guía | Comercial | De la búsqueda a la cuenta: la página, la llamada a la acción y la invitación o el registro |
| `gestoria/` | gestorIA | Comercial, novato, desarrollo, auditor y diseño UX. Nunca clínica | Comercial | Subir un producto con tallas y stock, venderlo en «Probar a Sofi», anotar un pedido, cobrarlo con captura y entregarlo |
| `apps/dental-clinic/` y las carpetas `dental/` de `packages/` | odentIA | Novato, clínica, desarrollo, auditor y diseño UX. Comercial solo si el área vende | Clínica, con `clinica/odontologia.md` | Registrar un paciente, reservar, atender, subir una imagen, recetar, firmar y cobrar, en odentIA |
| `apps/medical-clinic/` y las carpetas `medical/` | latidIA | Las mismas | Clínica, con `clinica/medicina.md` | El mismo, en latidIA |
| `apps/optical-clinic/` y las carpetas `optical/` | vistIA | Las mismas | Clínica, con `clinica/optica.md` | El mismo, en vistIA |
| El resto de `apps/` y `packages/`, y `e2e/` | Lo común de las clínicas | Las de las clínicas, en cada producto al que llega | Clínica, con el catálogo de cada producto | El de cada producto al que llega |
| `shared/packages/` | Todo sistema que lo usa | Desarrollo y diseño UX en cada sistema que lo usa; las demás, solo donde cambia lo que la persona hace | La del sistema donde cambia | El de cada sistema donde cambia algo visible |
| `admin/` | La administración | Sin voces: la recorre quien implementa (`odentia-entrega`) | — | — |
| `docs/`, `.claude/` y los `AGENTS.md` | Ninguno | Sin voces | — | — |

- **Comercial entra en las clínicas solo si el área vende:** Oportunidades, el presupuesto que se presenta y se acepta, la Bandeja y lo que Sofi dice para reservar, y el registro y la primera vez de una clínica en el panel (`apps/panel`).
- **Si el cambio toca dos sistemas**, entra la unión, y cada voz recorre solo el sistema por el que entró. Un cambio en una página de la web y en un servicio de las clínicas lleva a comercial en la web y a las voces de las clínicas en la app.
- **El recorrido base es solo el del sistema que cambia.** Un cambio de la web no recorre la atención de odentIA, y uno de gestorIA no recorre la web.
- **Experta del negocio** es la voz que sabe cómo se trabaja ese negocio de verdad: clínica en las clínicas, comercial en gestorIA y en la web. Entra segunda, después del novato.
- **En gestorIA y en la web, los catálogos de las otras voces tienen pocos flujos todavía.** Cada voz arma los suyos leyendo el `AGENTS.md` del sistema y su código, y los devuelve en «Para mi catálogo».

El moderador lo dice en una línea al empezar: «Sistema: gestorIA. Voces: comercial, novato, desarrollo y auditor; diseño UX no, porque no cambia ninguna pantalla».

## El tamaño

Va según el riesgo del cambio, no es el mismo para todo. Una mesa completa para mover un formulario gasta más de lo que ahorra, y una mesa que siempre cuesta lo mismo se termina saltando.

| Tamaño | Cuándo | Qué corre |
|---|---|---|
| **Sin mesa** | Cambio interno, un texto, o un error con causa clara cuyo arreglo no cambia lo que la persona ve o hace | Nada; la QA antes de entregar corre igual |
| **Corta** | Mover un formulario, un cambio dentro de un patrón que ya existe, un error cuyo arreglo cambia lo que la persona ve | El moderador hace su parte y una sola vuelta con 1 o 2 voces y 2 o 3 casos cada una: la de quien hace la tarea y desarrollo |
| **Completa** | Función nueva, un recorrido que cambia, un lienzo aprobado, o cualquier cosa de dinero, firmas o datos clínicos | Las dos vueltas |
| **Sobre un área** | La ronda, sin cambio | La primera vuelta con las voces del sistema que el área pida, y la confirmación de `SKILL.md` |

**Sube sola si aparece un riesgo.** Si al preparar o al recorrer resulta que el cambio toca dinero, firmas, datos clínicos o permisos, o que lo va a ver otro rol, entra la voz que corresponde dentro del sistema (clínica para lo clínico, auditor para el dinero, el stock y los estados, desarrollo para los permisos, comercial para lo que se promete o se vende) aunque la mesa haya empezado corta. Clínica entra siempre que se toquen datos o decisiones clínicas, y no entra cuando el área no es clínica: ahí no tiene nada que recorrer. Lo mismo comercial: no entra donde nada se vende ni se promete.

En un lienzo ya aprobado, lo decidido no se reabre: la mesa busca lo que falta o choca.

## El modelo de cada voz

Cada voz es su propio subagente en `.claude/agents/`, y su archivo fija el modelo y el esfuerzo de partida, para que no dependa de acordarse:

| Subagente | Modelo y esfuerzo | Por qué |
|---|---|---|
| `voz-desarrollo` | Opus, alto | Leer el código es lo que más errores reales encuentra |
| `voz-clinica` | Opus, alto | El juicio clínico con fuentes; un error sale caro |
| `voz-ux` | Opus, alto | Juzga cómo se ve, busca la causa en los informes de todas y propone el rediseño |
| `voz-comercial` | Sonnet, alto | Juzga textos, el camino a la venta y cómo vende Sofi |
| `voz-auditor` | Sonnet, alto | Recalcula y cruza datos; sube a Opus si toca dinero o stock |
| `voz-novato` | Sonnet, medio | Debe tropezar con la pantalla, no con la herramienta |
| `voz-verificador` | Haiku, bajo | Corre el guion de un hallazgo y copia lo que pasa; sube a Sonnet si no hay guion |

Si un subagente no aparece (la sesión se abrió antes de que existiera su archivo), se lanza `general-purpose` con el modelo y el esfuerzo de la tabla, y la ficha le dice que lea su archivo de `.claude/agents/` como sus instrucciones.

El moderador lo sube o lo baja en la llamada (`model` y `effort` de la herramienta de agentes): no se elige el más barato ni el mismo para todas, sino el que pide la tarea, por lo que hace la voz y por el tamaño de lo que tiene delante.

- **Pide el modelo más capaz y esfuerzo alto** lo que depende de razonar sobre mucho a la vez y donde un error sale caro: leer el código a fondo, el juicio clínico con fuentes, buscar una causa raíz, y cualquier voz en un área grande o de dinero, firmas o datos clínicos.
- **Pide un modelo intermedio y esfuerzo medio** lo que es recorrer con método algo acotado: unos pocos casos en una pantalla, contar pasos, recalcular cifras, proponer con patrones que ya existen.
- **Pide un modelo rápido y esfuerzo bajo** lo mecánico: repetir pasos ya escritos para confirmar un hallazgo, verificar que un arreglo pasa o correr el guion del recorrido base. Con el guion del hallazgo ya escrito («Navegar rápido y barato» de `SKILL.md`), repetirlo es correrlo y leer lo que devuelve.
- **El piso es que maneje bien el navegador.** Un modelo que tropieza con la herramienta y no con la pantalla produce falsas alarmas. El novato no tiene que ser brillante, pero sí usar la app sin tropezar por su cuenta.
- **El tamaño mueve un escalón.** La misma voz sube en una mesa completa o un área larga y baja en una mesa corta.
- **Si una voz vuelve genérica** (opina sin casos, no cita, se queda en la primera pantalla), se lanza de nuevo un escalón arriba antes de seguir. No se usa un informe flojo.

El moderador anota siempre, por voz, el modelo, el esfuerzo, los tokens y cuántos hallazgos suyos se confirmaron: sin esa línea la mesa no puede aprender. Con eso se ajusta: una voz que rinde igual en dos mesas con un escalón menos baja también en su archivo de `.claude/agents/`, y una que deja escapar lo suyo sube.

## Reglas de las voces en la mesa

Se suman a «Para todas» de `voces.md`.

- **Nadie opina sin recorrer.** Cada hallazgo nombra su caso y su paso («C3, paso 4»). Lo que llega sin caso no entra al acta. Las mesas que opinaron anticiparon poco de lo que después encontró la QA; la que recorrió casos con fechas e importes fue la que más anticipó.
- **Primero lo de hoy, en la pantalla real.** En local, con la demo del sistema (apartado 2 de `SKILL.md`: la de las clínicas, Calzados Rosa en gestorIA, la web levantada en local), y navegando como dice «Navegar rápido y barato» del mismo `SKILL.md`. Desarrollo recorre además en el código, con `archivo:línea`. Recién después se recorre el mismo caso con el cambio puesto, sobre el lienzo o la propuesta. Así la voz parte de lo que pasa, no de lo que imagina.
- **Cada voz arma sus casos.** Antes de mirar la pantalla escribe los suyos desde su trabajo (su método está en `voces.md`), con datos concretos: nombres, fechas, montos, piezas. Entre ellos van siempre uno de otro día (el borrador de ayer, la vuelta del paciente, la sesión siguiente), uno donde la persona se equivoca y corrige, y uno a 390 px si la tarea se hace en celular. Si la demo no trae lo que el caso necesita, lo crea; si no puede, dice qué falta, y eso queda para sumarlo a la demo.
- **El código que corre.** Quien lee el código lee el de la rama que corre en la demo, no una copia de otra rama: en el estudio de la atención (16 nov 2026) las voces leyeron al principio una rama vieja, y solo valieron las citas de la confirmación, que leyó el código vigente.
- **De punta a punta.** El recorrido empieza donde empieza la persona (Inicio, el paciente que llega, el mensaje que entra) y sigue hasta donde termina (el cobro, el PDF, lo que le llega al paciente, el día siguiente). Nadie entra directo a la pantalla que cambia: lo que un cambio rompe suele estar en lo vecino.
- **Las giras.** Además de sus casos, cada voz hace al menos dos giras: un recorrido con un solo tema. Son la forma de encontrar lo que nadie pidió mirar. La del teclado no es opcional para diseño UX: en la primera mesa nadie la hizo, y lo que se escapó fue justo lo de teclado y nombres de botones.

  | Gira | Qué recorre | Quién la hace primero |
  |---|---|---|
  | Del dinero | Cada cifra del área, recalculada a mano | Auditor |
  | Del dato | El mismo dato en todos los lugares donde aparece | Auditor, clínica |
  | Del día siguiente | Lo que quedó a medias ayer y la vuelta del paciente | Clínica, novato |
  | Del rol ajeno | Lo mismo, visto y hecho por otro rol | Desarrollo, novato |
  | Del error | Equivocarse a propósito y corregir | Novato, diseño UX |
  | De la interrupción | Dejar la tarea a medias, hacer otra y volver | Novato, diseño UX |
  | Del borde | Vacío, repetido, doble clic, dos pestañas, lo que no debería poder hacerse | Desarrollo |
  | Del teclado | La tarea entera sin ratón: foco visible, orden, cada botón con nombre para el lector de pantalla | Diseño UX, siempre |
  | Del cliente que se va | El camino entero hasta la venta (de la búsqueda a la cuenta, del primer mensaje al pedido pagado), hasta encontrar dónde se pierde | Comercial |

  Una gira que no encuentra nada se anota con lo que recorrió. No se rellena.
- **Lo que se afirma del código lleva su cita.** Un permiso, una tabla o un «esto ya existe» van con `archivo:línea`, o se marcan como supuesto. Las afirmaciones falsas de las mesas fueron casi todas de este tipo, sobre permisos y sobre el esquema.
- **Cada voz en lo suyo.** Contesta su pregunta (la de su apartado «En la mesa» de `voces.md`) y deja lo demás a quien le toca. Lo que ve fuera de lo suyo lo anota en una línea, sin desarrollarlo.

### Lo que devuelve cada voz en la mesa

1. **Mis casos:** la lista, con sus datos, y las giras que hizo.
2. **Recorrido de hoy**, por caso: la tabla de pasos, clics y lo que pasó, con capturas.
3. **Con el cambio puesto** (en la segunda vuelta): el mismo caso, paso por paso, y dónde cambia.
4. **Hallazgos**, el más grave primero, cada uno con su caso y su paso. Completos los de más peso y en una línea el resto.
5. **Lo que encontré y nadie preguntó.**
6. **Lo que recorrí y no encontré**, con los caminos que hizo. «No encontré nada» vale solo si dice dónde buscó.
7. **Causa raíz** y **cómo debe ser**, si los tiene.
8. **No pude ver**, y por qué.

## El proceso

### 0. El expediente

Lo arma el moderador en la carpeta de la mesa (`~/odentia-qa/<fecha>-mesa-<tema>/`, fuera del repositorio porque es público):

- **El problema**, en una frase y con las palabras de la persona. Sobre un área, la frase es el trabajo que esa área resuelve.
- **El mapa** del código que leyó, con `archivo:línea`.
- **Cómo entrar:** direcciones, cuentas por rol y los datos de la demo que sirven al área. Sin esto las voces no pueden recorrer.
- **Lo ya decidido**, que no se reabre.
- **Los pendientes conocidos** del área: lo que dejaron las entregas anteriores (memoria y PR), los informes de `~/odentia-qa/` y los issues abiertos. Van en otra carpeta, `~/odentia-qa/moderador/<fecha>-mesa-<tema>/`, que las voces no reciben ni pueden abrir por error: en la carpeta de la mesa, una voz lo leyó antes de armar sus casos y dejó de servir como prueba ciega.
- **El tamaño, las voces y el modelo de cada una**, con el motivo.

**La ficha de cada voz es neutra.** Dice qué sistema, qué área o qué cambio es, para quién, cómo entrar y lo ya decidido. No lleva preguntas, sospechas, hallazgos de antes ni «fíjate en…»: una voz a la que se le dice qué mirar encuentra eso y nada más, y cinco voces con las mismas preguntas devuelven cinco veces la misma respuesta. Cada voz recibe su ficha, «Para todas» y su apartado de `voces.md` enteros, y las reglas y el formato de salida de este archivo. De su catálogo recibe el índice y las secciones de los flujos que el área toca, no el archivo entero: el moderador nombra los códigos (`P-ODO-05`, `O-AGE-01`) y la voz lee el índice con `grep -n "^##" <catálogo>` por si falta uno. El de odontología pasa de 20 mil tokens y casi todo es de otras áreas. El novato recibe solo lo que vería esa persona: el área y su rol, no el motivo del cambio.

La mesa termina antes de que alguien programe. Si otra sesión ya está implementando, la mesa llega tarde: se dice así y se corre como revisión de lo hecho, no como mesa.

### 1. Primera vuelta: el problema

Sin ninguna solución a la vista. Entran quienes viven la tarea: el novato en el rol que la hace y la experta del negocio si la tarea es suya (clínica en lo clínico, comercial en lo que se vende o se promete). Sobre un área entran además las otras voces del sistema que el área pida, cada una con su método «en la app» de `voces.md`. Cada voz por separado, sin ver a las otras. Si varias recorren a la vez sobre la misma base, cada una crea sus propios datos y no toca los ajenos; lo que una voz ve cambiar por lo que hizo otra se anota como tal y se repite a solas en la confirmación.

Sale de aquí dónde duele de verdad hoy y los casos de cada voz. El moderador los junta en el **banco de casos** (C1, C2…), sin repetir y con el resultado que la persona espera en cada uno.

Sobre un área, aquí sigue la confirmación de `SKILL.md` (su apartado 4). Después la mesa continúa con lo confirmado: una propuesta, una segunda vuelta y un acta por cada entrega. Una ronda que se queda en la lista de problemas no dejó nada listo.

### 2. La propuesta

Las voces no pueden recorrer algo que no está definido. Con lo que salió de la primera vuelta, diseño UX arma una o dos formas de resolverlo, con su método «en la mesa»: cada una con los pasos contados sobre los casos del banco y con el patrón que ya existe. Si hay lienzo, la propuesta es el lienzo. Si el pedido ya define la solución (un error, un pendiente con forma), el moderador la escribe en media página y este paso no llama a nadie.

### 3. Segunda vuelta: la propuesta

Cada voz recorre los casos del banco con la propuesta puesta, a la vez y por separado, y contesta su pregunta:

| Voz | Su pregunta | Lo que entrega |
|---|---|---|
| Novato | ¿Lo entiende y lo termina solo? | El relato de cada caso, con sus dudas y las palabras que no entiende |
| Clínica | ¿Es seguro y es como se atiende? | Las comprobaciones del catálogo que mejoran, se rompen o siguen sin cumplirse, con su fuente |
| Desarrollo | ¿Se puede, y qué rompe? | La operación que ya existe, lo que falta, la migración, cada producto y los estados que quedan mal |
| Auditor | ¿Dice la verdad y vale lo que cuesta? | Qué recortar o quitar, y las promesas sin servicio o sin permiso |
| Diseño UX | ¿Es la forma más simple? | Si no armó la propuesta: los pasos que sobran y con qué patrón se quitan |
| Comercial | ¿Vende? | Los pasos del camino a la venta que cambian, si en cada caso se vende más, igual o menos, y las promesas nuevas con el servicio que las cumple |

El novato de esta vuelta es uno nuevo: el que ya vio el problema entiende por qué se hizo el cambio y deja de servir. Las voces de la primera vuelta que siguen aquí continúan como el mismo subagente, con sus casos.

### 4. Comprobar y cruzar

1. **Comprobar.** El moderador mira en el código cada afirmación sobre permisos, tablas u operaciones antes de que entre al acta. Lo falso se descarta y se cuenta.
2. **Juntar.** Lo que varias voces dicen igual es un solo punto. Lo que viene sin caso se descarta.
3. **Choques.** Si dos voces piden cosas opuestas, cada una lee lo que escribió la otra y responde una sola vez. Después decide el moderador, en este orden: seguridad clínica y permisos primero, luego lo más simple que cumpla. Un problema que se vio en un recorrido pesa más que uno hipotético.
4. **Cruzar con los pendientes.** Compara lo que salió con los pendientes guardados. Los que nadie volvió a encontrar entran igual al acta, marcados «no visto por la mesa», y se anota qué voz debió verlos.
5. **Al usuario**, solo lo que depende del producto, cada cosa como pregunta y con recomendación.

### 5. El acta

Una página. Es lo único de la mesa que usan las etapas siguientes, y por eso lleva criterios que se pueden comprobar en pantalla. Va en la carpeta de la mesa, como tablero si hay lienzo y en «Decisiones y límites que quedan» del PR.

```markdown
**La mesa** (<tamaño>; voces: …)

- **Se queda:** …
- **Se quita:** … (por qué)
- **Cambia:** …
- **Casos y criterios:**
  - C1 · <quién y qué hace, con sus datos>: al terminar, <lo que se ve y lo que quedó guardado>.
  - C2 · …
- **El mismo dato en:** <los lugares donde debe verse igual>
- **En la Ayuda:** <los temas que cambian y la pregunta que debe poder contestar, dicha como la haría la persona>
- **Procesos clínicos que toca:** … (lo que mejora o se rompe en cada uno)
- **Pendientes de antes:** <cuáles se resuelven aquí y cuáles siguen>
- **Fuera de este cambio:** …
- **Por confirmar con una clínica real:** …
- **Para tu decisión:** … (solo si hay; con recomendación)
```

Al usuario se le muestra en lo posible en menos de 10 líneas: los criterios completos quedan en el archivo.

### 6. Lo que sigue

- **Implementar** sigue el acta punto por punto.
- **Probar:** los criterios que se puedan volver prueba automática, se vuelven.
- **La QA antes de entregar** recorre cada caso del acta en la pantalla y marca cada criterio (cumple, no cumple, no se pudo ver), además de lo suyo.
- **La Ayuda** va en el mismo cambio, con lo que dice la línea «En la Ayuda» del acta. En la QA antes de entregar, el novato le hace esa pregunta y el auditor comprueba la respuesta contra la pantalla (sus apartados en `voces.md`).
- **El PR** lista los criterios con su resultado, y qué se le preguntó a la Ayuda y qué contestó.

### 7. La mesa aprende

Cuando termina la QA antes de entregar, o la ronda siguiente sobre esa área, el moderador compara lo que se encontró con lo que la mesa había dicho, y anota en la fila de `~/odentia-qa/recorrido.md`:

- cuántos problemas de diseño se encontraron después y cuántos había anticipado la mesa;
- cuántos pendientes guardados volvió a encontrar sola;
- cuántas afirmaciones de las voces eran falsas;
- por voz: modelo, esfuerzo, tokens, minutos y hallazgos confirmados.

Los errores del código nuevo no cuentan en contra de la mesa: no podía verlos.

### Cada voz tiene su catálogo, y crece

Una voz que empieza de cero cada vez vuelve a encontrar lo mismo y vuelve a dejar escapar lo mismo. Por eso cada voz tiene un catálogo de sus flujos, con las comprobaciones de cada uno, lo que ya falló y los casos para recorrerlo:

| Voz | Catálogo | Qué guarda |
|---|---|---|
| Clínica | `clinica/odontologia.md`, `medicina.md`, `optica.md`, `comunes.md` | Los procesos clínicos |
| Novato | `catalogos/tareas.md` | Las tareas de cada rol en su día (recepción, caja, ventas, paciente) y dónde tropieza quien las hace |
| Desarrollo | `catalogos/operaciones.md` | Las operaciones de negocio (reservar, cobrar, anular, firmar…) y lo que cada una debe cumplir siempre |
| Auditor | `catalogos/verdad.md` | Las cifras y los datos que deben coincidir, con todos los lugares donde aparece cada uno |
| Diseño UX | `catalogos/medidas.md` | Las tareas frecuentes con sus pasos medidos, para saber si una mejora o empeora |
| Comercial | `catalogos/ventas.md` | Lo que hace vender y lo que hace perder la venta: la web, gestorIA y lo comercial de las clínicas |

- **Es el piso, no el techo.** Cada voz revisa las comprobaciones de los flujos que el área toca, una por una, y además arma sus casos y hace sus giras. El catálogo es lo que la voz ya sabe; no es una lista de sospechas sobre este cambio, y por eso no rompe la ficha neutra.
- **Buscar lo que falta es parte de cada recorrido.** Cada voz devuelve **Para mi catálogo**: flujos nuevos, comprobaciones que faltan en uno que ya está y casos, con el texto listo para sumarlo. Si no encontró nada nuevo, dice dónde buscó.
- **Lo que se escapó entra al catálogo de quien debía verlo.** Cuando la QA o una ronda encuentra algo que la mesa no vio, el moderador lo suma como comprobación, con el caso que lo mostró, en «Ya falló». Así el mismo problema no se escapa dos veces. Si igual se repite, el problema es el método de la voz, y se cambia en `voces.md`.
- **También se poda.** Una comprobación de algo que ya no existe se quita, y dos que dicen lo mismo se unen. Un catálogo que solo crece se deja de leer entero.
- **Se escribe leyendo el código y la pantalla**, no un ADR ni la memoria: lo que dice «Dónde» se comprueba que existe.
- **El repositorio es público.** Un fallo de permisos, de aislamiento o de datos nunca se escribe en un catálogo, ni datos de personas.
- **Cuándo se escribe:** en una entrega, en el mismo PR. En una ronda, queda en el informe y lo suma la entrega siguiente que toque el área, como dice el apartado 7 de `SKILL.md`.

El catálogo de desarrollo no es un inventario del código: la estructura se lee del código. Guarda lo que el código no dice solo, que es lo que cada operación debe cumplir y cómo ya falló.
