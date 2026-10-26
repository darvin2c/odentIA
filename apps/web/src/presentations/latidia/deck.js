(() => {
  const stage = document.getElementById("stage");
  const slides = [...stage.querySelectorAll(".slide")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const C = { sky: "#4fc3d7", mint: "#a6f0d8", amber: "#f5c46b", warn: "#e8927c" };
  let index = 0, step = 0;
  let timers = [], rafs = new Set(), cleanups = [];

  /* ---------- Escala ---------- */
  // De pie (teléfono o tableta), el escenario entero quedaba como una franja con el texto a 3–10 px:
  // ahí las partes van una debajo de otra, cada una al ancho de la pantalla, y arriba el aviso
  // «Gira el teléfono…» (clase «stacked» en <html>). Acostado y en el escritorio, como siempre.
  const viewport = document.getElementById("viewport");
  const standing = matchMedia("(orientation: portrait) and (max-width: 1100px)");
  let stacked = false, fromScroll = false;
  /** Dónde queda la parte en curso al bajar: su centro a esta altura de la ventana. */
  const READ_AT = 0.35;
  function fit() {
    stacked = standing.matches;
    document.documentElement.classList.toggle("stacked", stacked);
    if (!stacked) {
      viewport.style.height = viewport.style.paddingBottom = "";
      const s = Math.min(innerWidth / 1920, innerHeight / 1080);
      stage.style.transform = `scale(${s}) translate(-50%, -50%)`;
      return;
    }
    const s = viewport.clientWidth / 1920;
    stage.style.transform = `scale(${s})`;
    viewport.style.height = stage.offsetHeight * s + "px";
    // Aire al final para que la última parte también llegue a la altura de lectura.
    viewport.style.paddingBottom = Math.max(0, innerHeight * (1 - READ_AT) - 540 * s) + "px";
  }
  /** Lleva la parte n a la altura de lectura (solo de pie). */
  function reveal(n, smooth) {
    if (!stacked) return;
    const r = slides[n].getBoundingClientRect();
    scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight * READ_AT, behavior: smooth && !reduce ? "smooth" : "auto" });
  }
  addEventListener("resize", fit); fit();
  standing.addEventListener("change", () => { fit(); if (stacked) reveal(index, false); else scrollTo(0, 0); });

  /* ---------- Utilidades de escena ---------- */
  const later = (fn, ms) => timers.push(setTimeout(fn, reduce ? Math.min(ms, 30) : ms));
  function loop(fn) {
    const id = { v: 0 };
    const run = (now) => { if (fn(now) !== false) { id.v = requestAnimationFrame(run); } else rafs.delete(id); };
    id.v = requestAnimationFrame(run); rafs.add(id);
  }
  function stopScenes() { timers.forEach(clearTimeout); timers = []; rafs.forEach(r => cancelAnimationFrame(r.v)); rafs.clear(); cleanups.splice(0).forEach(f => { try { f(); } catch (e) {} }); }
  const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d; };
  function typeInto(node, text, ms, done) {
    let i = 0; node.textContent = "";
    const t = () => { node.textContent = text.slice(0, ++i); if (i < text.length) later(t, ms); else if (done) done(); };
    later(t, ms);
  }

  /* ---------- Navegación por partes y momentos ---------- */
  const layersOf = (s) => [...s.querySelectorAll(":scope > .layer")];

  function show(n, k, fresh) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    const layers = layersOf(slides[n]);
    k = Math.max(0, Math.min(layers.length - 1, k));
    const slideChanged = n !== index || fresh;
    slides.forEach((s, i) => { s.classList.toggle("on", i === n); s.setAttribute("aria-hidden", i === n ? "false" : "true"); });
    const target = layers[k];
    const newScene = target.dataset.scene;
    if (slideChanged || newScene || k < step) stopScenes();
    layers.forEach((l, i) => {
      const visible = i === k || (l.classList.contains("stay") && i < k);
      const was = l.classList.contains("cur");
      l.classList.toggle("gone", i < k && !visible);
      if (visible && (!was || (i === k && slideChanged))) { l.classList.remove("cur"); void l.offsetWidth; }
      l.classList.toggle("cur", visible);
    });
    // Los momentos de la parte que no se ven vuelven a su lugar.
    slides.forEach((s, i) => { if (i !== n) layersOf(s).forEach(l => l.classList.remove("cur", "gone")); });
    const restartStay = slideChanged || k < step;
    index = n; step = k;
    stage.classList.toggle("cold", target.classList.contains("prob"));
    // Escena del momento actual (o de la capa que se queda debajo, si recién se entra).
    layers.forEach((l, i) => {
      if (!l.dataset.scene) return;
      if (i === k || (restartStay && l.classList.contains("stay") && i < k)) scenes[l.dataset.scene]?.(l);
    });
    document.getElementById("count").textContent = String(n + 1).padStart(2, "0") + " / " + String(slides.length).padStart(2, "0");
    document.getElementById("progress").style.width = ((n + (k + 1) / layers.length) / slides.length * 100) + "%";
    const notes = slides[n].querySelector(".notes");
    document.getElementById("notesTitle").textContent = "Guion · parte " + (n + 1) + " de " + slides.length;
    document.getElementById("notesText").textContent = notes ? notes.textContent : "";
    try { history.replaceState(null, "", "#p" + (n + 1)); } catch (e) {}
    // De pie, la parte nueva sube a la vista (salvo cuando fue el propio desplazamiento el que la eligió).
    if (stacked && slideChanged && !fromScroll) reveal(n, !fresh);
  }
  function next() {
    const layers = layersOf(slides[index]);
    if (step < layers.length - 1) show(index, step + 1);
    else if (index < slides.length - 1) show(index + 1, 0);
  }
  function prev() {
    if (step > 0) show(index, step - 1);
    else if (index > 0) show(index - 1, layersOf(slides[index - 1]).length - 1);
  }

  /* ---------- Escenas ---------- */
  const scenes = {};
  // 1 · La portada: la línea de pulso en 3D (cover-3d.js). Cada latido enciende el nombre de un agente.
  scenes.cover = (layer) => {
    const names = [...layer.querySelectorAll("[data-beat]")];
    const onBeat = (e) => {
      const b = names[e.detail % names.length];
      if (!b) return;
      b.classList.add("beat");
      later(() => b.classList.remove("beat"), 380);
    };
    addEventListener("cover-beat", onBeat);
    const go = () => window.Cover3D && window.Cover3D.start(document.getElementById("coverScene"));
    if (window.Cover3D) go(); else addEventListener("cover-ready", go, { once: true });
    cleanups.push(() => { removeEventListener("cover-beat", onBeat); removeEventListener("cover-ready", go); window.Cover3D && window.Cover3D.stop(); });
  };

  // 2 · Rosa, esa noche. Problema y respuesta son espejo: el mismo teléfono (el de Rosa), el mismo
  // mensaje y la misma hora. Sin respuesta, a los 11 minutos reserva en otro consultorio; con Sofi,
  // en segundos queda en tu agenda. Después, toda la noche: una persona por mensaje.
  const ROSA_MSG = "Hola, ¿atienden mañana? Tengo fiebre y me duele mucho la garganta 🤒";
  /** Quién escribió esa noche, a qué hora y qué le dejó hecho Sofi (cita, urgencia o una respuesta). */
  const P1NIGHT = [
    ["Sofía", "19:12", "cita"], ["Jorge", "19:40", ""], ["Ana", "20:05", ""], ["Pedro", "20:31", "cita"],
    ["Carmen", "21:02", ""], ["Hugo", "21:26", ""], ["Marta", "21:50", ""], ["Diego", "22:13", "cita"],
    ["Raúl", "22:58", ""], ["Rosa", "23:41", "cita"], ["Elena", "23:55", "urg"], ["Tomás", "00:12", ""],
    ["Inés", "00:48", "cita"], ["Carla", "02:13", "urg"], ["Paula", "05:55", ""], ["Rocío", "06:22", ""],
    ["Iván", "06:40", ""], ["Nora", "06:58", ""], ["Óscar", "07:10", "cita"], ["Bea", "07:24", ""],
    ["Julio", "07:38", ""], ["Silvia", "07:49", "cita"], ["Mateo", "07:58", "cita"],
  ];
  /** Los que esperaron y reservaron en otro consultorio (Rosa entre ellos). */
  const P1GONE = [1, 3, 7, 9, 10, 15, 16];
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  /** El teléfono de quien escribe: lo que ve esa persona, en su canal. */
  function phoneBuild(sc, who, channel, cls = "") {
    sc.innerHTML = `<div class="phone lph ${cls}"><div class="phone-top"><span class="av cs">SM</span><div><b>Consultorio San Martín</b><span>${channel} · lo que ve ${who}</span></div></div><div class="chat"></div></div>
      <div class="p1wait"></div>`;
    const phone = sc.querySelector(".lph"), chat = sc.querySelector(".chat"), av = sc.querySelector(".av"), name = sc.querySelector(".phone-top b"), wait = sc.querySelector(".p1wait");
    const say = (cls, text, time) => { const d = el("div", "msg " + cls, `${text}<small>${time}</small>`); chat.appendChild(d); return d; };
    const note = (html, cls = "") => { const d = el("div", "p1seen " + cls, html); chat.appendChild(d); return d; };
    const typing = (cls = "") => { const d = el("div", "typing left " + cls, "<i></i><i></i><i></i>"); chat.appendChild(d); return d; };
    const stamp = (text, ok) => chat.appendChild(el("div", "p1stamp" + (ok ? " ok" : ""), text));
    const counter = (cls) => { const d = el("div", cls, "<b></b><span></span>"); wait.appendChild(d); return { set: (big, small) => { d.children[0].textContent = big; d.children[1].textContent = small; } }; };
    return { sc, phone, chat, av, name, wait, say, note, typing, stamp, counter };
  }

  function p1Build(sc) {
    const w = phoneBuild(sc, "Rosa", "WhatsApp");
    sc.insertAdjacentHTML("beforeend", `<div class="p1night"><p class="p1nhead"></p><div class="p1people"></div><div class="p1box"><h3></h3><div class="row"></div></div><div class="p1end"></div></div>`);
    const scale = () => stage.getBoundingClientRect().width / 1920;
    const at = (node) => { const r = node.getBoundingClientRect(), q = sc.getBoundingClientRect(), s = scale(); return { x: (r.left - q.left) / s, y: (r.top - q.top) / s }; };
    // Cambia de conversación en el teléfono: otro consultorio, o de vuelta al tuyo.
    const open = async (place) => {
      w.chat.classList.add("swap"); await p6wait(320);
      w.chat.innerHTML = "";
      w.av.textContent = place === "otro" ? "PN" : "SM"; w.av.className = "av " + (place === "otro" ? "other" : "cs");
      w.name.textContent = place === "otro" ? "Policlínico Norte · otro consultorio" : "Consultorio San Martín";
      w.chat.classList.remove("swap");
    };
    return { ...w, open, at,
      night: sc.querySelector(".p1night"), head: sc.querySelector(".p1nhead"), people: sc.querySelector(".p1people"),
      box: sc.querySelector(".p1box"), boxTitle: sc.querySelector(".p1box h3"), boxRow: sc.querySelector(".p1box .row"), end: sc.querySelector(".p1end") };
  }

  // Toda la noche, en una pantalla: cada persona que escribió y adónde fue a parar.
  async function p1Night(w, ok) {
    w.phone.classList.add("away"); w.wait.style.opacity = "0";
    await p6wait(450);
    w.night.classList.toggle("ok", ok); w.box.classList.toggle("ok", ok); w.end.classList.toggle("ok", ok);
    w.night.classList.add("on");
    w.head.innerHTML = ok
      ? `Esa noche escribieron <b>${P1NIGHT.length} personas</b>. Sofi les respondió a todas.`
      : `Y no fue solo Rosa: esa noche escribieron <b>${P1NIGHT.length} personas</b>.`;
    w.boxTitle.textContent = ok ? "Nuevas en tu agenda" : "Reservaron en otro consultorio";
    const tiles = P1NIGHT.map(([who, time], i) => {
      const t = el("div", "p1p", `<i>${who[0]}</i><span><b>${who}</b><small>${time}</small></span>`);
      t.style.animationDelay = `${i * 45}ms`; w.people.appendChild(t); return t;
    });
    await p6wait(1600);
    // Lo que va a la caja: en el problema, los que reservaron en otro consultorio; en la respuesta, las citas nuevas.
    const moving = ok ? P1NIGHT.map((item, i) => (item[2] === "cita" ? i : -1)).filter((i) => i >= 0) : P1GONE;
    if (ok) {
      for (const [i, t] of tiles.entries()) later(() => t.classList.add(P1NIGHT[i][2] === "urg" ? "urg" : "done"), i * 55);
      await p6wait(P1NIGHT.length * 55 + 500);
    }
    for (const i of moving) {
      const t = tiles[i];
      if (!ok) t.classList.add("left");
      await p6wait(ok ? 120 : 260);
      const slot = el("i", "", P1NIGHT[i][0][0]); slot.style.visibility = "hidden"; w.boxRow.appendChild(slot);
      const from = w.at(t.querySelector("i")), to = w.at(slot);
      const fly = el("div", "p1fly" + (ok ? " ok" : ""), P1NIGHT[i][0][0]); fly.style.left = from.x + "px"; fly.style.top = from.y + "px"; w.sc.appendChild(fly);
      if (!ok) t.classList.add("gone");
      await p6anim(ok ? 420 : 560, (e) => { fly.style.left = (from.x + (to.x - from.x) * e) + "px"; fly.style.top = (from.y + (to.y - from.y) * e - Math.sin(e * Math.PI) * 60) + "px"; });
      fly.remove(); slot.style.visibility = "visible";
    }
    await p6wait(600);
    const urgent = P1NIGHT.filter((item) => item[2] === "urg").length;
    w.end.appendChild(el("div", "", ok
      ? `<b>08:00</b> · Recepción abre: <b>${P1NIGHT.length} de ${P1NIGHT.length}</b> respondidos y <b>${moving.length} citas</b> nuevas en tu agenda.`
      : `<b>08:00</b> · Recepción abre: <b>${P1NIGHT.length} mensajes</b> sin responder.`));
    await p6wait(1400);
    w.end.appendChild(el("div", "", ok
      ? `<b>0 pacientes</b> se fueron a otro consultorio · <b>${urgent} urgencias</b> recibieron el 106 y quedaron avisadas`
      : `<b>${P1GONE.length} pacientes</b> se fueron a otro consultorio · <b>S/ 560</b> en consultas que no entraron`));
  }

  // 2 · Problema: nadie le contesta a Rosa y reserva en otro consultorio.
  scenes.notifs = async () => {
    const w = p1Build(document.getElementById("p1scene"));
    const clock = document.getElementById("p1clock");
    clock.textContent = "23:41";
    await p6wait(900);
    w.say("me", ROSA_MSG, "23:41");
    const seen = w.note("Enviado · 23:41");
    await p6wait(1100);
    const ours = w.counter("");
    for (let m = 1; m <= 11; m++) {
      clock.textContent = hhmm(23 * 60 + 41 + m);
      seen.classList.add("late"); seen.innerHTML = `Enviado · sin respuesta · <b>${m} min</b>`;
      ours.set(`${m} min`, "y tu consultorio no le contesta");
      await p6wait(m < 3 ? 520 : 300);
    }
    await p6wait(800);
    // Le escribe a otro consultorio, que contesta en un minuto.
    await w.open("otro");
    w.say("me", "Hola, ¿atienden mañana? Tengo fiebre y me duele la garganta", "23:52");
    await p6wait(700);
    let t = w.typing();
    await p6wait(1100); t.remove(); clock.textContent = "23:53";
    w.say("clinic", "¡Hola, Rosa! Sí, mañana a las 10:00. ¿Te la reservo?", "23:53");
    w.counter("other").set("1 min", "y otro consultorio le contesta");
    await p6wait(1500);
    w.say("me", "Sí, por favor", "23:53");
    await p6wait(600); t = w.typing();
    await p6wait(900); t.remove(); clock.textContent = "23:54";
    w.say("clinic", "Listo: te esperamos mañana a las 10:00.", "23:54");
    await p6wait(500); w.stamp("Reservó en otro consultorio", false);
    await p6wait(2000);
    // A la mañana, recepción le contesta: ya es tarde.
    await w.open("tuyo");
    clock.textContent = "08:00";
    w.say("me", ROSA_MSG, "23:41");
    w.note(`Sin respuesta · <b>8 h 19 min</b>`, "late");
    ours.set("8 h", "y tu consultorio no le contesta");
    await p6wait(900);
    w.say("clinic", "Buenos días, Rosa. ¿En qué te podemos ayudar?", "08:00");
    await p6wait(1500); clock.textContent = "08:03";
    w.say("me", "Gracias, ya reservé en otro consultorio.", "08:03");
    await p6wait(2600);
    await p1Night(w, false);
  };

  // 2 · Respuesta (espejo): el mismo mensaje a la misma hora; Sofi contesta en segundos y agenda.
  scenes.chat = async () => {
    const w = p1Build(document.getElementById("r1scene"));
    w.av.classList.add("warm");
    const clock = document.getElementById("r1clock");
    clock.textContent = "23:41";
    await p6wait(900);
    w.say("me", ROSA_MSG, "23:41");
    const seen = w.note("Enviado · 23:41");
    await p6wait(600);
    let t = w.typing("sky");
    await p6wait(1200); t.remove(); seen.remove();
    w.say("sofi2", "Hola, Rosa. Soy Sofi, del Consultorio San Martín. Mañana hay 09:00 o 11:30 con la Dra. Vela. La consulta cuesta S/ 80. ¿Cuál prefieres?", "23:41");
    w.counter("sky").set("8 s", "y Sofi le contesta");
    await p6wait(1700); clock.textContent = "23:42";
    w.say("me", "A las 9, por favor", "23:42");
    await p6wait(600); t = w.typing("sky");
    await p6wait(1000); t.remove();
    w.say("sofi2", "Listo: mañana a las 09:00 con la Dra. Vela, en Av. Perú 1820. Te recuerdo temprano.", "23:42");
    await p6wait(800); w.chat.appendChild(el("div", "msg log", "Sofi · Agendó · → Agenda, jue 09:00"));
    await p6wait(700); w.stamp("No le escribió a otro consultorio", true);
    w.counter("sky").set("0", "veces que buscó otro consultorio");
    await p6wait(2600);
    // La mañana, como en el problema: recepción abre y encuentra la noche hecha.
    clock.textContent = "08:00";
    await p1Night(w, true);
  };

  // 3 · Señales de alarma. Problema: a las 2:13 un bot de menú le ofrece una cita a Carla y nadie lee
  // su mensaje hasta las 8. Respuesta: Sofi le da el 106 y el teléfono del consultorio, y avisa al equipo.
  const CARLA_MSG = "Estoy embarazada de 30 semanas y estoy sangrando. ¿Qué hago?";
  /** Las señales de alarma que Sofi reconoce en un consultorio médico. */
  const SIGNS = ["Embarazada con sangrado", "«Ya no siento al bebé»", "Se rompió la fuente", "Labios morados", "No despierta",
    "El peor dolor de cabeza de su vida", "Vomita sangre", "Se tomó muchas pastillas"];

  scenes.alarmProb = async () => {
    const w = phoneBuild(document.getElementById("p3scene"), "Carla", "WhatsApp");
    const clock = document.getElementById("p3clock");
    w.av.textContent = "🤖"; w.av.className = "av bot"; w.name.textContent = "Consultorio · respuesta automática";
    clock.textContent = "02:13";
    await p6wait(900);
    w.say("me", CARLA_MSG, "02:13");
    await p6wait(900);
    w.say("bot", "¡Hola! 😊 Gracias por escribirnos. Para agendar una cita responde 1. Para precios, 2.", "02:13");
    await p6wait(1600); clock.textContent = "02:14";
    w.say("me", "No, es urgente. Estoy sangrando", "02:14");
    await p6wait(900);
    w.say("bot", "No entendí tu respuesta. Para agendar una cita responde 1 😊", "02:14");
    const seen = w.note("Visto por nadie · 02:14", "late");
    const ours = w.counter("");
    await p6wait(1200);
    // Las horas pasan y nadie del consultorio lo lee.
    for (const [time, wait] of [["03:00", "46 min"], ["04:30", "2 h 16 min"], ["06:00", "3 h 46 min"], ["07:30", "5 h 16 min"], ["08:00", "5 h 46 min"]]) {
      clock.textContent = time;
      seen.innerHTML = `Visto por nadie · <b>${wait}</b>`;
      ours.set(wait, "sin que nadie del consultorio lo lea");
      await p6wait(650);
    }
    await p6wait(500);
    w.stamp("Lo leyeron 5 h 46 min después", false);
  };

  scenes.alarm = async (layer) => {
    const w = phoneBuild(document.getElementById("r3scene"), "Carla", "WhatsApp", "short");
    w.av.classList.add("warm");
    const signs = layer.querySelector("#signs");
    signs.innerHTML = "";
    SIGNS.forEach((s, i) => later(() => signs.appendChild(el("span", "", s)), 300 + i * 140));
    await p6wait(900);
    w.say("me", CARLA_MSG, "02:13");
    // Sofi reconoce la primera señal de la lista.
    await p6wait(500);
    signs.firstChild?.classList.add("hit");
    const t = w.typing("sky");
    await p6wait(1200); t.remove();
    w.say("sofi2", "Carla, esto necesita atención ahora. Llama al 106 o ve a la emergencia más cercana. El teléfono del consultorio es (01) 555 0188. Ya avisé al equipo.", "02:13");
    w.counter("sky").set("6 s", "y Sofi le da el 106");
    await p6wait(1400);
    w.counter("sky").set("0", "citas ofrecidas");
    await p6wait(600);
    w.sc.appendChild(el("div", "handoff", `<div class="hd"><b>Te lo pasó el agente</b><span class="urg">Ahora</span><span class="t">WhatsApp · 02:13</span></div>
      <p>Posible urgencia: embarazada con sangrado. Sofi le dio el 106 y el teléfono del consultorio.</p>
      <p style="color:#475569; font-size:18px">Carla escribió: <q>${CARLA_MSG}</q></p>`));
  };

  // 4 · Problema: la misma persona en tres fichas; cada cosa cae en una distinta.
  scenes.p2prob = async () => {
    const sc = document.getElementById("p2scene");
    sc.innerHTML = '<div class="p2cards"></div><div class="p2alerts"></div>';
    const cardsEl = sc.querySelector(".p2cards"), alerts = sc.querySelector(".p2alerts");
    const FICHAS = [["Rosa P.", "Instagram · @rosa.paredes"], ["Rosa Paredes", "WhatsApp · número nuevo"], ["R. Paredes Luna", "Correo · rosa.p@…"]];
    const cards = [];
    for (let i = 0; i < 3; i++) {
      await p6wait(i ? 700 : 600);
      const c = el("div", "p2card", `<span class="nw">Ficha nueva</span><b>${FICHAS[i][0]}</b><span class="ch">${FICHAS[i][1]}</span>`);
      c.style.left = i * 275 + "px"; cardsEl.appendChild(c); cards.push(c);
      if (i) { const q = el("div", "p2q", "≠"); q.style.left = i * 275 - 25 + "px"; cardsEl.appendChild(q); }
    }
    const item = (i, text, hot) => cards[i].appendChild(el("div", "it" + (hot ? " hot" : ""), text));
    const alert = (text, bad) => alerts.appendChild(el("div", bad ? "bad" : "", `<i>✕</i><span>${text}</span>`));
    await p6wait(800); item(0, "Descanso médico · 3 días");
    await p6wait(500); item(1, "Cita · jue 09:00");
    await p6wait(500); item(2, "Ecografía de abdomen");
    await p6wait(500); item(2, "Alergia: penicilina", true);
    await p6wait(900); alert("La confirmación de la cita salió por Instagram. Rosa no la vio y faltó.");
    await p6wait(1300); alert("Recepción, por cuarta vez: «¿Me recuerdas tu DNI?»");
    await p6wait(1300); alert("Le llegó «Tu primera consulta con 20 % menos». Viene hace dos años.");
    await p6wait(1500); alert("La Dra. Vela abre «Rosa P.»: no ve la alergia a la penicilina.", true);
    await p6wait(1300);
    sc.appendChild(el("div", "p2foot", "3 fichas · 1 persona · su historia clínica partida en tres"));
  };

  // 4 · Respuesta: los canales llegan a una sola ficha.
  scenes.omni = () => {
    const svg = document.getElementById("omniSvg"), tl = document.getElementById("timeline");
    tl.innerHTML = "";
    const chans = ["WhatsApp", "Instagram", "Messenger", "Telegram", "Chat web", "Correo", "En la consulta"];
    const tx = 1140, ty = 600;
    let html = "";
    chans.forEach((name, i) => {
      const cx = 200 + i * 124, cy = 960;
      html += `<path id="op${i}" d="M${cx} ${cy - 24} C ${cx} 780, ${tx - 220} ${ty + 80}, ${tx} ${ty}" fill="none" stroke="rgba(183,156,240,.2)" stroke-width="2" stroke-dasharray="4 8"/>`;
      html += `<rect x="${cx - 58}" y="${cy - 24}" width="116" height="42" rx="21" fill="#301a5c" stroke="rgba(183,156,240,.35)"/><text class="chan" x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="${name.length > 9 ? 14 : 17}">${name}</text>`;
    });
    html += `<circle id="opDot" r="10" fill="#b79cf0" opacity="0"/>`;
    svg.innerHTML = html;
    const events = [[1, "Preguntó por una consulta de medicina general"], [0, "Confirmó su cita del jueves"], [6, "Consulta con la Dra. Vela"],
      [5, "Recibió su descanso médico"], [0, "Recibió su receta"], [4, "Completó sus datos"], [3, "Movió su control al lunes"], [0, "Respondió su recordatorio"]];
    const days = ["mié 23:41", "mié 23:42", "jue 09:00", "jue 09:31", "jue 09:32", "jue 18:10", "vie 10:05", "dom 08:00"];
    const dot = svg.querySelector("#opDot");
    let e = 0;
    function shoot() {
      const [ch, text] = events[e % events.length], path = svg.querySelector("#op" + ch), len = path.getTotalLength();
      const t0 = performance.now(), dur = reduce ? 1 : 1000;
      path.setAttribute("stroke", "rgba(183,156,240,.85)");
      loop((now) => {
        const p = Math.min(1, (now - t0) / dur), pt = path.getPointAtLength(len * p);
        dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y); dot.setAttribute("opacity", p < 1 ? 1 : 0);
        if (p < 1) return true;
        path.setAttribute("stroke", "rgba(183,156,240,.2)");
        if (e % events.length === 0) tl.innerHTML = "";
        tl.appendChild(el("div", "tl", `<span class="mono">${days[e % days.length]}</span><span>${text} · <span style="color:#b3a2da">${chans[ch]}</span></span>`));
        e++; later(shoot, 600);
        return false;
      });
    }
    later(shoot, 800);
  };

  // 5 · Respuesta: los corchetes de cada agente y el latido de Rosa (latido-3d.js).
  scenes.log = (layer) => {
    const go = () => window.Part4 && window.Part4.start(layer);
    if (window.Part4) go(); else addEventListener("part4-ready", go, { once: true });
    cleanups.push(() => { removeEventListener("part4-ready", go); window.Part4 && window.Part4.stop(); });
  };

  // 6 · Problema: el reloj avanza con las historias pendientes.
  scenes.lateClock = () => {
    const c = document.getElementById("lateClock");
    let m = 18 * 60;
    const t = () => { m += 4; c.textContent = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); if (m < 21 * 60 + 12) later(t, 50); };
    later(t, 400);
  };

  // 6 · Respuesta: el dictado de la consulta de Rosa. Clío propone por bloque, se corrige una cifra con
  // la voz y el médico confirma cada sugerencia; el descanso no se confirma: se emite con la firma.
  scenes.dictation = async () => {
    const said = document.getElementById("said"), blocks = document.getElementById("blocks"), state = document.getElementById("dictState");
    said.textContent = ""; blocks.innerHTML = "";
    state.textContent = "Clío escuchando · Dra. Vela · Rosa Paredes";
    const type = (text, ms) => new Promise((res) => typeInto(said, text, ms, res));
    await type("Fiebre de dos días y dolor de garganta… presión 118 76, frecuencia 96, temperatura 38,5… amígdalas aumentadas con placas blanquecinas… amigdalitis aguda… descanso tres días.", 24);
    const items = [["Motivo", "Fiebre y dolor de garganta, 2 días"], ["Signos vitales", "PA 118/76 mmHg · FC 96 lpm · T <b>38,5</b> °C"],
      ["Boca y garganta", "Con hallazgos · amígdalas aumentadas con placas blanquecinas"], ["Diagnóstico", "CIE-10 · J03.9 · Amigdalitis aguda · presuntivo"],
      ["Descanso", "3 días · se emite con tu firma"]];
    const made = [];
    for (const [k, v] of items) {
      const b = el("div", "blk", `<span class="k">${k}</span><span class="v">${v}</span><span class="ok">${k === "Descanso" ? "Emitir" : "Confirmar"}</span>`);
      blocks.appendChild(b); made.push(b);
      await p6wait(450);
    }
    state.textContent = "Dictado terminado: 5 sugerencias";
    await p6wait(1300);
    // Una corrección con la voz cambia solo esa cifra.
    said.textContent = "";
    await type("No, la temperatura es 38,4.", 45);
    const vit = made[1].querySelector(".v b");
    vit.textContent = "38,4"; vit.style.color = "var(--mint)";
    made[1].animate([{ boxShadow: "0 0 0 0 rgba(166,240,216,.6)" }, { boxShadow: "0 0 0 14px rgba(166,240,216,0)" }], { duration: 700 });
    await p6wait(1100);
    for (const b of made) {
      const ok = b.querySelector(".ok");
      b.classList.add("done");
      ok.textContent = ok.textContent === "Emitir" ? "✓ Emitido" : "✓ Confirmado";
      await p6wait(420);
    }
  };

  // 7 · Problema: la receta en papel no sabe lo que dice la historia.
  scenes.rxProb = async () => {
    const sc = document.getElementById("p7scene");
    sc.innerHTML = `<div class="rxpaper"><div class="hd"><b>Consultorio San Martín</b><span>Receta</span></div><div class="hand" id="rxWho"></div><div class="hand rx" id="rxL1"></div><div class="hand" id="rxL2"></div><div class="hand sig" id="rxSig"></div></div><div class="rxalerts"></div>`;
    const write = (id, text, ms) => new Promise((res) => typeInto(sc.querySelector("#" + id), text, ms, res));
    const alerts = sc.querySelector(".rxalerts");
    const alert = (text, bad) => alerts.appendChild(el("div", bad ? "bad" : "", `<i>✕</i><span>${text}</span>`));
    await p6wait(600);
    await write("rxWho", "Julia R. · 32 a.", 70);
    await write("rxL1", "Enalapril 10 mg", 80);
    await write("rxL2", "1 tab c/12 h x 30 d", 70);
    await write("rxSig", "Dra. E. Vela", 90);
    await p6wait(700); alert("Julia está embarazada de 12 semanas. Estaba en su historia, no en la receta.", true);
    await p6wait(1400); alert("La farmacia llama: «¿Esto dice 10 o 40?»");
    await p6wait(1300); alert("Rosa perdió su descanso y pide otro. Lo vuelven a escribir a mano.");
  };

  // 7 · Respuesta: «Emitir receta» lee la historia; después, el descanso de Rosa, emitido y enviado.
  scenes.rx = async () => {
    const sc = document.getElementById("r7scene");
    sc.innerHTML = "";
    const rx = el("div", "app", `<div class="ah"><b>Emitir receta</b><span>Julia Ramos Vega · 32 años</span></div><div class="ab">
      <div class="rem">Está embarazada, 12 semanas (registrado el 10/10/2026): revisa que cada medicamento sea seguro en el embarazo.</div>
      <span class="lbl">DCI (denominación común)</span><div class="fld on"><span class="q"></span></div><div class="out"></div></div>`);
    rx.style.cssText = "left:0; top:0; width:800px";
    sc.appendChild(rx);
    const q = rx.querySelector(".q"), out = rx.querySelector(".out");
    await p6wait(900);
    for (const ch of "enalapril") { q.textContent += ch; await p6wait(90); }
    q.classList.add("done");
    await p6wait(500);
    out.innerHTML = `<div class="stop"><span><b>Enalapril:</b> está embarazada (12 semanas) y los IECA están contraindicados en el embarazo.</span><div class="btns"><span class="btn p">Cambiar medicamento</span><span class="btn">Recetar igual, con motivo</span></div></div>`;
    await p6wait(2200);
    out.querySelector(".btn.p").classList.add("press");
    await p6wait(500);
    rx.style.animation = "none"; rx.style.transformOrigin = "top center"; rx.style.transform = "translateY(-40px) scale(.84)"; rx.style.opacity = ".3";
    // El descanso de Rosa: numerado, firmado y enviado por su canal.
    const rest = el("div", "app", `<div class="ah"><b>Descanso médico N.º 1</b><span>Rosa Paredes · 46 años</span></div><div class="ab">
      <span class="toast">✓ Descanso médico emitido.</span>
      <div class="med">3 días de descanso<span>del 22/10/2026 al 24/10/2026</span></div>
      <span class="meta">Sin diagnóstico: la persona no autorizó que figure.</span>
      <span class="meta">Emitido el 22/10/2026 por Elena Vela · CMP 045678</span>
      <div class="btns"><span class="btn">Imprimir</span><span class="btn p" id="restSend">Enviar a la persona</span></div></div>`);
    rest.style.cssText = "left:60px; top:300px; width:740px";
    sc.appendChild(rest);
    await p6wait(1800);
    const send = rest.querySelector("#restSend");
    send.classList.add("press");
    await p6wait(500);
    send.classList.remove("press");
    rest.querySelector(".ab").appendChild(el("span", "sent", "Enviado por WhatsApp · también en su enlace, 30 días"));
  };

  // 8 · La agenda de la semana: no está llena, se caen citas (problema) y Argos trae a los pacientes de vuelta a sus huecos (respuesta).
  const P6_DAYS = ["lun", "mar", "mié", "jue", "vie"], P6_HOURS = ["09:00", "10:00", "11:00", "12:00", "16:00"];
  const P6_BUSY = ["Ana P.", "Rosa P.", "Sara V.", "Tomás R.", "Elena C.", "Iván D.", "Nora F.", "Raúl M.", "Julia R.", "Óscar L.", "Paula N.", "Hugo S.", "Irene T.", "Marta Q.", "Sergio A.", "Laura E."];
  // Lo que ya estaba libre y las citas que se caen (fila-columna).
  const P6_EMPTY = ["0-2", "1-4", "2-0", "2-3", "3-1", "4-2", "4-4", "0-4", "3-3"];
  const P6_LOST = ["0-1", "1-2", "2-4", "3-0", "4-1", "1-0"];
  const P6_BACK = [
    ["LG", "Luis G.", "control de presión: 7 meses"], ["MS", "Marta S.", "12 meses sin venir"], ["CA", "Carmen A.", "no vino el martes"],
    ["PN", "Pedro N.", "niño sano: le toca"], ["JR", "Jorge R.", "control de glucosa: vencido"], ["AV", "Ana V.", "canceló el jueves"],
    ["TM", "Teresa M.", "control de presión: vencido"], ["GL", "Gabriel L.", "no vino el jueves"], ["SF", "Sofía F.", "12 meses sin venir"],
    ["DN", "Daniel N.", "control de tiroides: vencido"], ["VR", "Valeria R.", "control prenatal: le toca"], ["FT", "Fernando T.", "canceló el lunes"],
    ["BM", "Beatriz M.", "control de glucosa: vencido"], ["EC", "Emilio C.", "no vino el lunes"], ["KP", "Karla P.", "12 meses sin venir"],
  ];
  function p6Build(layer) {
    const sc = layer.querySelector(".p6sc");
    sc.innerHTML = `<div class="p6cal"><div class="p6cal-h"><b>Agenda · semana del 26</b><span>Dra. Vela · Sala 1</span></div><div class="p6grid"></div></div><div class="p6beam"></div><div class="p6drift"><h3>No volvieron</h3></div>`;
    const grid = sc.querySelector(".p6grid");
    grid.innerHTML = "<span></span>" + P6_DAYS.map(d => `<span class="d">${d}</span>`).join("");
    const slots = {}; let k = 0;
    P6_HOURS.forEach((h, r) => { grid.insertAdjacentHTML("beforeend", `<span class="h">${h}</span>`); P6_DAYS.forEach((d, c) => { const key = r + "-" + c, n = el("div", "p6slot"); grid.appendChild(n); const o = { n, d, h, name: null }; if (!P6_EMPTY.includes(key)) o.name = P6_BUSY[k++ % P6_BUSY.length]; slots[key] = o; }); });
    const busy = (key) => { const o = slots[key]; o.n.className = "p6slot"; o.n.style.removeProperty("--c"); o.n.innerHTML = `${o.name}<small>${o.h} · consulta</small>`; };
    const empty = (key) => { const o = slots[key]; o.n.className = "p6slot empty"; o.n.textContent = "Libre"; };
    const hole = (key) => { const o = slots[key]; o.n.className = "p6slot hole"; o.n.textContent = "Libre"; };
    const counter = layer.querySelector("[data-p6count]");
    const drift = sc.querySelector(".p6drift");
    const card = (p, cls = "") => { const c = el("div", "p6pt " + cls, `<span class="av">${p[0]}</span><b>${p[1]}</b><span>${p[2]}</span>`); drift.appendChild(c); return c; };
    const scale = () => stage.getBoundingClientRect().width / 1920;
    const box = (node) => { const r = node.getBoundingClientRect(), q = sc.getBoundingClientRect(), s = scale(); return { x: (r.left - q.left) / s, y: (r.top - q.top) / s, w: r.width / s, h: r.height / s }; };
    return { sc, slots, busy, empty, hole, counter, drift, card, box, beam: sc.querySelector(".p6beam"), head: sc.querySelector(".p6cal-h") };
  }
  const p6wait = (ms) => new Promise(res => later(res, ms));
  const p6anim = (ms, f) => new Promise(res => { const t0 = performance.now(), D = reduce ? 1 : ms; loop((now) => { const p = Math.min(1, (now - t0) / D); f(p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); if (p < 1) return true; res(); return false; }); });

  scenes.p6prob = async (layer) => {
    const w = p6Build(layer);
    Object.keys(w.slots).forEach(key => (P6_EMPTY.includes(key) ? w.empty(key) : w.busy(key)));
    const cards = P6_BACK.slice(0, 6).map(p => w.card(p));
    let holes = P6_EMPTY.length; w.counter.textContent = holes;
    await p6wait(900);
    for (let i = 0; i < P6_LOST.length; i++) {
      const o = w.slots[P6_LOST[i]];
      o.n.innerHTML = `${o.name}<small>${i % 2 ? "no vino" : "canceló"}</small>`;
      await p6wait(300); o.n.classList.add("gone"); await p6wait(420);
      w.hole(P6_LOST[i]); w.counter.textContent = ++holes;
      cards[i].classList.add("cold");
      await p6wait(260);
    }
  };

  scenes.p6ans = async (layer) => {
    const w = p6Build(layer);
    Object.keys(w.slots).forEach(key => (P6_EMPTY.includes(key) ? w.empty(key) : P6_LOST.includes(key) ? w.hole(key) : w.busy(key)));
    // Primero vuelven las citas que se cayeron y después se llena lo que ya estaba libre.
    const order = [...P6_LOST, ...P6_EMPTY];
    const queue = P6_BACK.slice();
    let cards = queue.splice(0, 6).map(p => w.card(p, "cold"));
    w.counter.textContent = 0;
    await p6wait(700);
    w.beam.style.opacity = 1;
    await p6anim(1300, (e) => { w.beam.style.left = (650 + e * 300) + "px"; });
    w.beam.style.opacity = 0;
    cards.forEach(c => { c.classList.remove("cold"); c.classList.add("seen"); });
    await p6wait(500);
    for (let i = 0; i < order.length; i++) {
      const c = cards.shift(), o = w.slots[order[i]], slow = i < 3;
      const cb = w.box(c);
      if (slow) {
        const seen = el("span", "p6seen", "Argos lo vio"); seen.style.left = (cb.x - 10) + "px"; seen.style.top = (cb.y - 12) + "px"; w.sc.appendChild(seen);
        await p6wait(400);
        const bub = el("div", "p6bubble", `<small>Argos · WhatsApp</small>Hola, ${c.querySelector("b").textContent.split(" ")[0]}. ${/control|sano/.test(c.querySelector("span:last-child").textContent) ? "Te toca tu control" : "Te guardé un horario"}: ¿te agendo el ${o.d} a las ${o.h}?`);
        bub.style.left = (cb.x - 400) + "px"; bub.style.top = (cb.y - 6) + "px"; w.sc.appendChild(bub);
        c.classList.remove("seen"); c.classList.add("warm");
        await p6wait(1100); bub.remove(); seen.remove();
      } else { c.classList.remove("seen"); c.classList.add("warm"); }
      // La tarjeta vuela a su hueco de la agenda.
      const ob = w.box(o.n), f = c.cloneNode(true);
      f.className = "p6pt warm p6fly"; f.style.left = cb.x + "px"; f.style.top = cb.y + "px"; f.style.width = cb.w + "px"; w.sc.appendChild(f);
      c.classList.add("out");
      const sx = cb.x, sy = cb.y, tx = ob.x + ob.w / 2 - cb.w / 2, ty = ob.y + ob.h / 2 - cb.h / 2;
      await p6anim(slow ? 900 : 520, (e) => { f.style.left = (sx + (tx - sx) * e) + "px"; f.style.top = (sy + (ty - sy) * e - Math.sin(e * Math.PI) * 110) + "px"; f.style.transform = `scale(${1 - 0.45 * e})`; f.style.opacity = String(1 - 0.6 * e); });
      f.remove(); c.remove();
      const name = f.querySelector("b").textContent, why = f.querySelector("span:last-child").textContent;
      o.n.className = "p6slot back"; o.n.style.setProperty("--c", C.amber);
      o.n.innerHTML = `${name}<small>${o.h} · ${/control|sano/.test(why) ? "control" : "consulta"}</small>`;
      w.counter.textContent = i + 1;
      // Entra el siguiente paciente que Argos encontró.
      const next = queue.shift(); if (next) { const n = w.card(next, "seen"); cards.push(n); }
      if (!slow) await p6wait(120);
    }
    w.head.insertAdjacentHTML("beforeend", "<em>Semana llena ✓</em>");
  };

  // 9 · El caos de armar el reporte a mano: descargas, búsquedas, versiones, errores y el reloj.
  const p7fmt = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  const p7sheet = (name, seed) => {
    const ERR = ["#¡REF!", "#N/A", "#¡DIV/0!", "#¡VALOR!"];
    let rows = "<tr><td>Sede</td><td>Cobrado</td><td>Consultas</td><td>Faltas</td></tr>";
    for (let r = 0; r < 5; r++) rows += `<tr><td>${["San Martín", "Los Olivos", "San Martín", "Los Olivos", "Total"][r]}</td>` + [0, 1, 2].map(c => ((r * 3 + c + seed) % 4 === 0) ? `<td class="err">${ERR[(r + c + seed) % 4]}</td>` : `<td>${(1000 + ((r + 2) * (c + 5) * 137 + seed * 311) % 9000).toLocaleString("es")}</td>`).join("") + "</tr>";
    return `<div class="bar"><i></i><i></i><i></i>${name}</div><table>${rows}</table>`;
  };
  scenes.p7prob = async (layer) => {
    const sc = layer.querySelector(".p7sc"), big = layer.querySelector("[data-p7count]");
    sc.innerHTML = "";
    const clock = el("div", "p7clock", "vie 15:00<small>empieza el reporte</small>"); sc.appendChild(clock);
    let m = 0, z = 1;
    const tickTo = async (mins, ms) => { const steps = 8; for (let i = 0; i < steps; i++) { m += mins / steps; const t = 15 * 60 + Math.round(m); big.textContent = p7fmt(Math.round(m)); clock.innerHTML = `vie ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}<small>${t > 19 * 60 ? "el consultorio cerró hace horas" : "armando el reporte"}</small>`; await p6wait(ms / steps); } };
    const win = (cls, html, x, y, w, r) => { const n = el("div", "p7w " + cls, html); n.style.left = x + "px"; n.style.top = y + "px"; n.style.width = w + "px"; n.style.setProperty("--r", r + "deg"); n.style.zIndex = ++z; sc.appendChild(n); return n; };
    // 1. Descargar de cada sistema; una descarga falla.
    const dl = win("web", `<div class="bar"><i></i><i></i><i></i>Descargas</div><div class="body">
      <div class="p7dl"><span>agenda_septiembre.csv</span><span>listo</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span>caja_san_martin.xlsx</span><span>listo</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span class="bad">caja_los_olivos.xlsx</span><span class="bad">falló</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span>consultas_export (2).csv</span><span>listo</span><div class="pb"><i></i></div></div></div>`, 10, 70, 430, -2);
    const bars = [...dl.querySelectorAll(".pb i")];
    for (let i = 0; i < bars.length; i++) { await p6wait(200); bars[i].style.width = i === 2 ? "38%" : "100%"; await tickTo(12, 420); }
    // 2. Buscar el archivo bueno entre muchas versiones.
    const fx = win("files", `<div class="bar"><i></i><i></i><i></i>Documentos › Reportes</div><div class="body"><div class="p7search">Buscar: reporte final</div>
      <div class="p7file">reporte_final.xlsx</div><div class="p7file">reporte_final (1).xlsx</div><div class="p7file">reporte_final_v2.xlsx</div><div class="p7file">reporte_final_v2_BUENO.xlsx</div><div class="p7file q">reporte_final_v3_ahora_si.xlsx · ¿cuál era?</div></div>`, 330, 40, 400, 3);
    await tickTo(40, 1300);
    // 3. Las hojas se apilan, con errores.
    const sheets = ["reporte_septiembre.xlsx", "copia_de_caja.xlsx", "reporte_sep_FINAL.xlsx", "agenda_exportada (3).csv"];
    for (let i = 0; i < sheets.length; i++) {
      win("", p7sheet(sheets[i], i), 120 + i * 70, 260 + i * 60, 470, (i % 2 ? 2 : -2) * (1 + i * 0.6));
      const cp = el("div", "p7cp", i % 2 ? "Ctrl+V" : "Ctrl+C"); cp.style.left = (90 + i * 150) + "px"; cp.style.top = (230 + i * 70) + "px"; cp.style.zIndex = ++z; sc.appendChild(cp);
      await tickTo(55, 700);
    }
    // 4. Pedir por WhatsApp lo que falta.
    win("chat", `<div class="bar"><i></i><i></i><i></i>WhatsApp · Recepción</div><div class="body"><div class="p7msg me">¿Me pasas lo de caja de Los Olivos?</div><div class="p7msg">Ya te lo mandé por correo 😅</div><div class="p7msg me">No me llegó 🙃</div></div>`, 640, 300, 330, 4);
    await tickTo(50, 1100);
    // 5. Notas y cifras que no cuadran.
    const notes = [["¿Por qué no cuadra con la caja?", 690, 560, -4], ["Falta sumar Los Olivos", 40, 620, 5], ["Revisar faltas de agosto", 520, 650, -3]];
    for (const [t, x, y, r] of notes) { const n = el("div", "p7note", t); n.style.left = x + "px"; n.style.top = y + "px"; n.style.setProperty("--r", r + "deg"); n.style.zIndex = ++z; sc.appendChild(n); await tickTo(35, 600); }
    await tickTo(57, 900);
    clock.innerHTML = clock.innerHTML.replace(/<small>.*<\/small>/, "<small>y todavía no dice qué hacer</small>");
  };

  scenes.p7ans = async (layer) => {
    const sc = layer.querySelector(".p7sc");
    sc.innerHTML = "";
    const a = el("div", "p7argos", `<div class="who"><b>Argos</b><span>agente administrador</span></div><div class="p7ask"><span class="ic">Pregúntale ›</span><span class="q"></span></div><div class="out"></div>`);
    sc.appendChild(a);
    const q = a.querySelector(".q"), text = "¿Cuánto cobramos en septiembre por sede?";
    await p6wait(600);
    for (let i = 1; i <= text.length; i++) { q.textContent = text.slice(0, i); await p6wait(38); }
    q.classList.add("done");
    const out = a.querySelector(".out");
    out.innerHTML = '<div class="p7think"><i></i><i></i><i></i></div>'; await p6wait(1100);
    out.innerHTML = `<div class="p7rep"><div class="t"><b>Cobrado en septiembre, por sede</b><span>septiembre frente a agosto</span></div><div class="tot">S/ 18.420<small>8 % más que en agosto</small></div><div class="p7bars"><div><i data-h="92"></i><span>San Martín · 11.200</span></div><div><i class="hot" data-h="58"></i><span>Los Olivos · 7.220</span></div></div></div>`;
    await p6wait(120); out.querySelectorAll(".p7bars i").forEach(i => { i.style.height = i.dataset.h + "%"; });
    await p6wait(1200);
    out.querySelector(".p7rep").insertAdjacentHTML("beforeend", `<div class="p7say"><span><b style="color:var(--amber)">Argos:</b> Los Olivos bajó 6 %: faltaron 9 pacientes y «Ofrecer otro horario» está apagada.</span><span class="go">Ver qué hacer</span></div><div class="p7calc">Así lo calculé · lo cobrado en caja del 1 al 30 de septiembre, por sede, frente a agosto</div>`);
  };

  // 8 · Los signos vitales de Luis: cuatro controles, cada 3 meses. La presión se dibuja punto por punto.
  const VITALS = [["ene", 152, 96, 86], ["abr", 146, 92, 85], ["jul", 138, 88, 83], ["oct", 132, 84, 82]];
  scenes.vitals = async () => {
    const box = document.getElementById("vitals");
    const W = 900, H = 420, L = 56, R = 30, T = 30, B = 46;
    const x = (i) => L + (i * (W - L - R)) / (VITALS.length - 1);
    const y = (v) => T + ((180 - v) / (180 - 70)) * (H - T - B);
    let grid = "";
    for (const v of [80, 100, 120, 140, 160]) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 12}" y="${y(v) + 5}" text-anchor="end">${v}</text>`;
    const months = VITALS.map(([m], i) => `<text class="ax" x="${x(i)}" y="${H - 12}" text-anchor="middle">${m}</text>`).join("");
    const line = (k) => VITALS.map((r, i) => `${i ? "L" : "M"}${x(i)} ${y(r[k])}`).join(" ");
    box.innerHTML = `<div class="vh"><b>Luis Gómez Salas · Signos vitales</b><span>62 años · hipertensión</span></div>
      <div class="tabs"><span class="on">Presión arterial</span><span>Peso</span><span>Glucosa capilar</span><span>Ver como tabla</span></div>
      <svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="grid">${grid}</g>${months}
        <path class="sys" d="${line(1)}" pathLength="1"/><path class="dia" d="${line(2)}" pathLength="1"/><g class="pts"></g></svg>
      <div class="last"><span>Última medición · oct</span><span><b>132/84</b>mmHg</span><span><b>82</b>kg</span><span class="down">−20 de sistólica en un año</span></div>`;
    const paths = [...box.querySelectorAll(".sys, .dia")], pts = box.querySelector(".pts");
    paths.forEach((p) => { p.style.strokeDasharray = "1"; p.style.strokeDashoffset = "1"; });
    await p6wait(700);
    for (let i = 0; i < VITALS.length; i++) {
      const [, s, d] = VITALS[i];
      if (i) await p6anim(700, (e) => paths.forEach((p) => { p.style.strokeDashoffset = String(1 - (i - 1 + e) / (VITALS.length - 1)); }));
      pts.insertAdjacentHTML("beforeend", `<circle class="pt" cx="${x(i)}" cy="${y(s)}" r="9" fill="#6d3fc0"/><circle class="pt" cx="${x(i)}" cy="${y(d)}" r="9" fill="#b79cf0"/>
        <text class="pv" x="${x(i)}" y="${y(s) - 20}" text-anchor="middle">${s}/${d}</text>`);
      await p6wait(250);
    }
  };

  // 12 · Problema: el uso baja mes a mes y el cobro es el mismo; cada cuota cae en el total.
  scenes.p9prob = async () => {
    const sc = document.getElementById("p9scene");
    const M = [["Julio", "Mes normal", 72], ["Agosto", "Vacaciones, poca agenda", 28], ["Septiembre", "Una sala cerrada por obras", 34], ["Octubre", "La doctora de vacaciones", 12]];
    sc.innerHTML = '<div class="p9grid">' + M.map(([m, why]) => `<div class="p9m"><b>${m}</b><span>${why}</span><div class="p9use"><span>Lo que usaste</span><span class="pct">0 %</span></div><div class="p9bar"><i></i></div></div>`).join("")
      + '</div><div class="p9tot"><span class="dl">$</span><div><span>Pagado en 4 meses</span><b>USD 0</b></div><em>Uses mucho o casi nada, pagas lo mismo.</em></div>';
    const cards = [...sc.querySelectorAll(".p9m")], tot = sc.querySelector(".p9tot b"), dl = sc.querySelector(".p9tot .dl");
    let paid = 0;
    await p6wait(700);
    for (let i = 0; i < M.length; i++) {
      const c = cards[i]; c.classList.add("on");
      c.querySelector(".p9bar i").style.width = M[i][2] + "%"; c.querySelector(".pct").textContent = M[i][2] + " %";
      await p6wait(750);
      c.appendChild(el("span", "p9chg", "−USD 150"));
      await p6wait(400);
      // La moneda sale del cobro del mes y cae en el total.
      const sr = sc.getBoundingClientRect(), k = sr.width / sc.offsetWidth, cr = c.getBoundingClientRect(), dr = dl.getBoundingClientRect();
      const coin = el("div", "p9coin", "$");
      coin.style.left = (cr.right - sr.left) / k - 90 + "px"; coin.style.top = (cr.top - sr.top) / k + 70 + "px"; sc.appendChild(coin);
      await p6wait(60);
      coin.style.left = (dr.left - sr.left) / k + 6 + "px"; coin.style.top = (dr.top - sr.top) / k + 6 + "px"; coin.style.transform = "scale(.8) rotate(360deg)";
      await p6wait(900);
      coin.remove(); dl.classList.remove("hit"); void dl.offsetWidth; dl.classList.add("hit");
      const from = paid; paid += 150;
      await p6anim(400, (e) => { tot.textContent = "USD " + Math.round(from + 150 * e); });
      c.classList.remove("on");
      await p6wait(300);
    }
  };

  // Dónde queda un nodo dentro de otro, en pixeles del escenario (sin la escala de la ventana).
  const within = (node, host) => { const r = node.getBoundingClientRect(), q = host.getBoundingClientRect(), s = stage.getBoundingClientRect().width / 1920; return { x: (r.left - q.left) / s, y: (r.top - q.top) / s, w: r.width / s, h: r.height / s }; };

  // 10 · Respuesta: cada módulo marca su precio como un taxímetro y se queda en cero; los dieciséis
  // ceros vuelan a uno solo y los corchetes se cierran sobre él.
  const ROLL = [19, 25, 29, 35, 39, 45, 49, 59, 79, 99, 120, 150];
  /** El precio de un módulo gira un instante y cae en cero. */
  async function rollZero(z, i, cur) {
    z.className = "z num roll";
    for (let t = 0; t < 7; t++) { z.textContent = cur + " " + ROLL[(i * 5 + t * 7) % ROLL.length]; await p6wait(55); }
    z.textContent = cur + " 0"; z.classList.remove("roll"); void z.offsetWidth; z.classList.add("set");
  }
  scenes.sys0 = async (layer) => {
    const zs = [...layer.querySelectorAll(".mod .z")], big = layer.querySelector(".sys0"), br = big.querySelector(".zero-br");
    const cur = layer.querySelector(".mosaic").dataset.cur;
    layer.querySelectorAll(".zfly, .ring").forEach(n => n.remove());
    layer.querySelectorAll(".mod.pick").forEach(n => n.classList.remove("pick"));
    layer.querySelector(".modtip").classList.remove("on"); closeScreen(layer);
    big.classList.remove("on", "shut"); layer.classList.remove("ready");
    zs.forEach(z => { z.className = "z num pend"; z.textContent = cur + " 0"; });
    // Se encienden con el mosaico (0,4 s + 0,12 s por módulo) y cada uno gira un instante antes de caer en cero.
    await Promise.all(zs.map(async (z, i) => { await p6wait(500 + i * 120); await rollZero(z, i, cur); }));
    await p6wait(500);
    // Los ceros vuelan al grande.
    const goal = within(br, layer);
    zs.forEach((z, i) => {
      const p = within(z, layer), f = el("span", "zfly", z.textContent);
      f.style.left = p.x + "px"; f.style.top = p.y + "px"; layer.appendChild(f);
      later(() => { f.style.left = goal.x + goal.w / 2 - p.w / 2 + "px"; f.style.top = goal.y + goal.h / 2 - p.h / 2 + "px"; f.style.opacity = "0"; f.style.transform = "scale(2.6)"; }, 30 + i * 35);
      later(() => f.remove(), 950 + i * 35);
    });
    await p6wait(760);
    big.classList.add("on");
    await p6wait(380);
    big.classList.add("shut"); br.appendChild(el("span", "ring"));
    await p6wait(900); layer.classList.add("ready");
  };

  // 11 · Respuesta: interruptores.
  scenes.switches = (layer) => {
    const sws = [...layer.querySelectorAll(".sw")];
    sws.forEach(s => s.classList.remove("lit"));
    sws.forEach((s, i) => later(() => s.classList.add("lit"), 1000 + i * 380));
  };

  // 12 · Cada cobro, con su moneda: los pasos se cumplen y recién ahí cae la moneda del agente.
  const resReset = (c) => { c.classList.remove("paid"); c.querySelectorAll(".st").forEach(x => x.classList.remove("on")); c.querySelector(".coin11").classList.remove("on"); };
  async function resPlay(c) {
    const st = c.querySelectorAll(".st");
    st[0].classList.add("on"); await p6wait(650);
    st[1].classList.add("on"); await p6wait(550);
    c.querySelector(".coin11").classList.add("on"); c.classList.add("paid");
  }
  scenes.vals = async (layer) => {
    const cards = [...layer.querySelectorAll(".res")];
    cards.forEach(resReset); layer.classList.remove("ready");
    await p6wait(1300);
    for (const c of cards) { await resPlay(c); await p6wait(700); }
    layer.classList.add("ready");
  };

  // 12 · Un día: solo las filas con resultado dejan moneda; cae en el total.
  scenes.day = async (layer) => {
    const out = document.getElementById("dayTotal"), day = layer.querySelector(".day");
    const rows = [...day.querySelectorAll(".row:not(.total)")];
    // La moneda es la del plan, la que trae el total al pintarse.
    const cur = out.dataset.cur || (out.dataset.cur = out.textContent.split(" ")[0]);
    out.textContent = cur + " 0,00"; day.querySelectorAll(".coin12").forEach(n => n.remove()); rows.forEach(r => r.classList.remove("lit"));
    const fmt = (v) => cur + " " + v.toFixed(2).replace(".", ",");
    let sum = 0;
    await p6wait(2100);
    for (const r of rows) {
      const price = r.querySelector(".price"), m = price.textContent.match(/[\d,]+/);
      const dot = r.querySelector(".dot"), c = dot ? getComputedStyle(dot).color : "#4fc3d7";
      r.style.setProperty("--c", c); r.classList.add("lit");
      if (!m) { await p6wait(500); r.classList.remove("lit"); continue; }
      const v = parseFloat(m[0].replace(",", ".")), dr = day.getBoundingClientRect(), k = dr.width / day.offsetWidth;
      const pr = price.getBoundingClientRect(), tr = out.getBoundingClientRect();
      const coin = el("div", "coin12", "$"); coin.style.setProperty("--c", c);
      coin.style.left = (pr.right - dr.left) / k - 40 + "px"; coin.style.top = (pr.top - dr.top) / k + "px"; day.appendChild(coin);
      await p6wait(60);
      coin.style.left = (tr.right - dr.left) / k - 40 + "px"; coin.style.top = (tr.top - dr.top) / k + "px"; coin.style.transform = "rotate(360deg)";
      await p6wait(820);
      coin.remove(); out.classList.remove("hit"); void out.offsetWidth; out.classList.add("hit");
      const from = sum; sum += v;
      await p6anim(350, (e) => { out.textContent = fmt(from + v * e); });
      r.classList.remove("lit");
      await p6wait(200);
    }
  };

  // 12 · Lo que nunca se cobra: en cada fila asoma la moneda del agente, gira y se apaga; el total
  // la siente pasar y se queda en cero.
  scenes.never = async (layer) => {
    const rows = [...layer.querySelectorAll(".nvr:not(.total)")], total = layer.querySelector(".nvr.total");
    const nv = layer.querySelector(".nv");
    rows.forEach(r => r.classList.remove("ask", "no")); total.classList.remove("done"); nv.classList.remove("done");
    await p6wait(1200);
    layer.classList.remove("ready");
    for (const r of rows) { await nvTry(r); await p6wait(380); }
    total.classList.add("done"); nv.classList.add("done");
    await p6wait(600); layer.classList.add("ready");
  };
  /** La moneda de la fila asoma, gira y se apaga; el total la siente pasar y sigue en cero. */
  async function nvTry(r) {
    const tot = r.parentElement.querySelector("#nvTotal");
    r.classList.remove("ask", "no"); void r.offsetWidth;
    r.classList.add("ask");
    await p6wait(800);
    r.classList.remove("ask"); r.classList.add("no");
    tot.classList.remove("hit"); void tot.offsetWidth; tot.classList.add("hit");
  }

  // 13 · El mismo caso: el software de registro frente a los agentes que orquestan.
  scenes.duo = () => {
    const olds = [...document.querySelectorAll("#stepsOld .so")], ia = document.getElementById("iaChip");
    const clock = document.getElementById("oldClock"), stepsN = document.getElementById("oldSteps"), queue = document.getElementById("oldQueue");
    olds.forEach(s => { s.className = "so"; s.querySelector(".bx").textContent = ""; });
    ia.classList.remove("show"); stepsN.textContent = "Pasos de tu equipo: 0"; queue.textContent = "En la cola: 0 casos más";
    const clocks = ["09:00", "09:20", "09:35", "10:05", "13:40", "13:55", "14:10"];
    clock.textContent = clocks[0];
    olds.forEach((s, i) => {
      later(() => { s.classList.add("now"); if (i === 2) ia.classList.add("show"); }, 900 + i * 1500);
      later(() => {
        s.classList.remove("now"); s.classList.add("done"); s.querySelector(".bx").textContent = "✓";
        stepsN.textContent = "Pasos de tu equipo: " + (i + 1); clock.textContent = clocks[i + 1];
        queue.textContent = "En la cola: " + (i + 1) + (i ? " casos más" : " caso más");
      }, 900 + i * 1500 + 1300);
    });

    // A la derecha: cada caso entra, pasa por los agentes que hacen falta y sale resuelto; detrás viene el siguiente.
    const box = document.getElementById("orch2"), log = document.getElementById("orchLog"), doneEl = document.getElementById("orchDone");
    log.innerHTML = ""; doneEl.textContent = "0"; box.innerHTML = "";
    const AGS = { argos: ["Argos", "administración", C.amber, 0], sofi: ["Sofi", "recepción", C.sky, 1], clio: ["Clío", "consulta", C.mint, 2] };
    const W = box.offsetWidth || 740, gap = (W - 3 * 220) / 2;
    const nodes = {};
    for (const [k, [name, role, c, i]] of Object.entries(AGS)) {
      const n = el("div", "ag2", `<span class="glow2"></span><b>${name}</b><span>${role}</span>`); n.style.setProperty("--c", c); n.style.left = i * (220 + gap) + "px"; box.appendChild(n); nodes[k] = n;
    }
    const CASES = [
      ["Luis", [["argos", "vio que le tocaba su control y lo invitó"], ["sofi", "le respondió y lo agendó el jueves 16:00"], ["clio", "ordenó su control dictado; la Dra. Vela lo confirmó"]]],
      ["Rosa", [["sofi", "contestó su mensaje de las 23:41 y la agendó"]]],
      ["Carla", [["sofi", "le dio el 106 y avisó al equipo"]]],
      ["Julia", [["clio", "propuso su nota; la Dra. Vela la confirmó"], ["argos", "dejó indicado su próximo control"]]],
      ["Marta", [["argos", "vio 12 meses sin venir y la invitó a volver"]]],
      ["Pedro", [["sofi", "movió su cita al lunes"]]],
      ["Jorge", [["clio", "dejó indicado su descanso para firmar"]]],
    ];
    const say = (k, who, what) => { const c = AGS[k][2]; log.appendChild(el("div", "", `<span class="dot" style="color:${c}"></span><b style="color:${c}; font-weight:700">${AGS[k][0]}</b><span>${who}: ${what}</span>`)); while (log.children.length > 3) log.firstChild.remove(); };
    const at = (k, tok) => ({ left: nodes[k].offsetLeft + 110 - tok.offsetWidth / 2, top: 150 });
    const place = (tok, p) => { tok.style.left = p.left + "px"; tok.style.top = p.top + "px"; };
    let done = 0, idx = 0;
    const run = async () => {
      const [who, steps] = CASES[idx++ % CASES.length];
      const tok = el("div", "tok2", who); box.appendChild(tok);
      place(tok, { left: -tok.offsetWidth - 20, top: 150 });
      await p6wait(40);
      for (const [k, what] of steps) {
        place(tok, at(k, tok)); await p6wait(430);
        nodes[k].classList.add("grab"); tok.style.setProperty("--c", AGS[k][2]); tok.classList.add("ok"); say(k, who, what);
        await p6wait(idx === 1 ? 900 : 420);
        nodes[k].classList.remove("grab"); tok.classList.remove("ok");
      }
      place(tok, { left: W + 20, top: 150 }); done++; doneEl.textContent = done;
      later(() => tok.remove(), 500);
      // El primer caso se cuenta con calma; después fluyen rápido, uno detrás de otro.
      later(run, idx === 1 ? 500 : 250);
    };
    later(run, 900);
  };

  const vsCells = (vs, n) => [...vs.querySelectorAll(".c" + n)];
  function vsReset(vs, n) {
    vsCells(vs, n).forEach(c => c.classList.remove("on", "replay"));
    vs.querySelectorAll(".c" + n + " .vbill, .c" + n + " .vflow li").forEach(c => c.classList.remove("on"));
    vs.querySelectorAll(".c" + n + " .sq").forEach(q => { q.innerHTML = "<i></i>".repeat(+q.dataset.n); });
    if (n === 4) vs.classList.remove("win");
  }
  /** Una de las tres primeras: lo que pasa con Pedro, los pasos de tu equipo y la moneda que cae igual. */
  async function vsCol(vs, n, slow) {
    const [hd, what, who, pay] = vsCells(vs, n);
    hd.classList.add("on"); await p6wait(260);
    what.classList.add("on"); await p6wait(420);
    who.classList.add("on");
    const sq = [...who.querySelectorAll(".sq i")], cnt = who.querySelector(".vsteps b");
    cnt.textContent = "0 pasos";
    for (let i = 0; i < sq.length; i++) { await p6wait(slow ? 170 : 110); sq[i].classList.add("on"); cnt.textContent = (i + 1) + (i ? " pasos" : " paso"); }
    pay.classList.add("on"); await p6wait(200);
    pay.querySelector(".vbill").classList.add("on");
  }
  /** La última columna: los corchetes se cierran sobre ella y los agentes hacen el trabajo. */
  async function vsWin(vs) {
    const [hd, what, who, pay] = vsCells(vs, 4);
    hd.classList.add("on"); await p6wait(200);
    vs.classList.add("win"); await p6wait(450);
    what.classList.add("on");
    for (const li of what.querySelectorAll("li")) { await p6wait(420); li.classList.add("on"); }
    await p6wait(250);
    who.classList.add("on"); await p6wait(450);
    pay.classList.add("on"); await p6wait(500);
    pay.querySelector(".vbill").classList.add("on");
  }
  // 13 · ¿No es lo mismo que…? Columna por columna y, al final, la del producto entre corchetes.
  scenes.vs = async (layer) => {
    const vs = layer.querySelector(".vs");
    vs.classList.remove("done"); layer.classList.remove("ready");
    [1, 2, 3, 4].forEach(n => vsReset(vs, n));
    await p6wait(1100);
    for (const n of [1, 2, 3]) { await vsCol(vs, n, n === 1); await p6wait(n === 1 ? 650 : 420); }
    await vsWin(vs);
    await p6wait(500);
    vs.classList.add("done");
    await p6wait(700); layer.classList.add("ready");
  };

  // 14 · Cifras que suben.
  scenes.perks = (layer) => {
    const nums = [...layer.querySelectorAll("[data-count]")], t0 = performance.now() + (reduce ? 0 : 400);
    loop((now) => {
      let done = true;
      nums.forEach((n, i) => {
        const to = +n.dataset.count, p = Math.max(0, Math.min(1, (now - t0 - i * 150) / 1300));
        if (p < 1) done = false;
        n.textContent = (n.dataset.prefix || "") + Math.round(to * (1 - Math.pow(1 - p, 3))) + (n.dataset.suffix || "");
      });
      return !done;
    });
  };

  // Tu semana: fila por fila, lo de hoy se tacha y aparece lo que hace el producto.
  scenes.week = (layer) => {
    const rows = [...layer.querySelectorAll(".wkr:not(.head)")];
    rows.forEach(r => r.classList.remove("on"));
    rows.forEach((r, i) => later(() => r.classList.add("on"), 1400 + i * 650));
  };

  /* ---------- Lo que se toca ---------- */
  // Dentro del escenario, lo que tiene data-tap responde al clic (o a Enter y Espacio) y no avanza la presentación.
  const taps = {};
  let tipHide = 0;
  // Un módulo con pantalla de muestra abre su ventana al costado; los demás, el globo con lo que incluye.
  let screenRun = 0;
  function openScreen(layer, b, cur) {
    const make = window.ModuleScreens?.[b.dataset.screen];
    if (!make) return false;
    const screen = make(), msc = layer.querySelector(".msc"), run = ++screenRun;
    msc.querySelector(".msc-t").textContent = screen.title;
    msc.querySelector(".msc-s").textContent = screen.sub;
    msc.querySelector(".msc-zero").textContent = cur + " 0 al mes";
    msc.querySelector(".msc-b").replaceChildren(screen.body);
    layer.querySelector(".modtip").classList.remove("on");
    layer.classList.add("mopen");
    // Si se cierra o se abre otra antes de terminar, la anterior deja de avanzar.
    screen.play((ms) => p6wait(ms).then(() => { if (run !== screenRun) throw 0; })).catch(() => {});
    setTimeout(() => msc.querySelector(".msc-x").focus({ preventScroll: true }), 50);
    return true;
  }
  function closeScreen(layer) {
    if (!layer || !layer.classList.contains("mopen")) return false;
    screenRun++; layer.classList.remove("mopen");
    layer.querySelectorAll(".mod.pick").forEach(n => n.classList.remove("pick"));
    return true;
  }
  taps.mclose = (b) => closeScreen(b.closest(".layer"));
  taps.mod = (b) => {
    const layer = b.closest(".layer"), tip = layer.querySelector(".modtip"), z = b.querySelector(".z");
    const cur = layer.querySelector(".mosaic").dataset.cur, mods = [...layer.querySelectorAll(".mod")];
    mods.forEach(m => m.classList.toggle("pick", m === b));
    rollZero(z, mods.indexOf(b), cur);
    if (openScreen(layer, b, cur)) return;
    tip.innerHTML = `<b>${b.children[1].textContent}</b><span>${b.dataset.what}</span><em>${cur} 0 al mes</em>`;
    const p = within(b, layer), up = p.y > 420;
    tip.style.left = Math.max(140, Math.min(1920 - 140 - 420, p.x + p.w / 2 - 210)) + "px";
    tip.style.top = up ? "" : p.y + p.h + 14 + "px";
    tip.style.bottom = up ? 1080 - p.y + 14 + "px" : "";
    tip.classList.remove("on"); void tip.offsetWidth; tip.classList.add("on");
    clearTimeout(tipHide);
    tipHide = setTimeout(() => { tip.classList.remove("on"); b.classList.remove("pick"); }, 4500);
  };
  taps.res = async (c) => { resReset(c); await p6wait(150); resPlay(c); };
  taps.nvr = (r) => nvTry(r);
  taps.vs = async (hd) => {
    const vs = hd.closest(".vs"), n = +hd.dataset.col;
    // Mientras se repite, ninguna columna queda atenuada; al terminar, vuelve el contraste si la del producto ya está.
    vs.classList.remove("done");
    vsReset(vs, n); hd.classList.add("replay");
    await p6wait(120);
    await (n === 4 ? vsWin(vs) : vsCol(vs, n, true));
    await p6wait(600);
    if (vs.classList.contains("win")) vs.classList.add("done");
    hd.classList.remove("replay");
  };
  const tapOf = (t) => t instanceof Element ? t.closest("[data-tap]") : null;
  stage.addEventListener("click", (e) => {
    const t = tapOf(e.target);
    // Dentro de la ventana de un módulo, un clic no avanza la presentación.
    if (!t && e.target instanceof Element && e.target.closest(".layer.cur .msc")) { e.stopPropagation(); return; }
    if (!t || !t.closest(".layer.cur")) return;
    e.stopPropagation(); taps[t.dataset.tap]?.(t);
  });

  /* ---------- Controles ---------- */
  // Sin mover el puntero por un momento, los botones se apartan (de pie y con el guion abierto, siempre a la vista).
  let idleT = 0;
  const wake = () => {
    document.body.classList.remove("idle"); clearTimeout(idleT);
    idleT = setTimeout(() => { if (!stacked && document.getElementById("notesPanel").hidden) document.body.classList.add("idle"); }, 2500);
  };
  ["mousemove", "pointerdown", "keydown"].forEach(t => addEventListener(t, wake, { passive: true }));
  wake();
  document.getElementById("next").addEventListener("click", (e) => { e.stopPropagation(); next(); });
  document.getElementById("prev").addEventListener("click", (e) => { e.stopPropagation(); prev(); });
  const notesBtn = document.getElementById("notesBtn"), notesPanel = document.getElementById("notesPanel");
  const toggleNotes = () => { notesPanel.hidden = !notesPanel.hidden; notesBtn.setAttribute("aria-pressed", String(!notesPanel.hidden)); };
  notesBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleNotes(); });
  document.getElementById("full").addEventListener("click", async (e) => {
    e.stopPropagation();
    try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch (err) {}
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && closeScreen(stage.querySelector(".layer.mopen"))) { e.preventDefault(); return; }
    const t = tapOf(e.target);
    if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (t.closest(".layer.cur")) taps[t.dataset.tap]?.(t); return; }
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); prev(); }
    else if (e.key === "Home") show(0, 0);
    else if (e.key === "End") show(slides.length - 1, 0);
    else if (e.key === "n" || e.key === "N") toggleNotes();
    else if (e.key === "f" || e.key === "F") document.getElementById("full").click();
  });
  viewport.addEventListener("click", (e) => {
    // De pie, tocar otra parte la abre; tocar la que está en curso avanza como siempre.
    if (stacked) {
      const i = slides.indexOf(e.target.closest(".slide"));
      if (i >= 0 && i !== index) { show(i, 0); return; }
    }
    (e.clientX > innerWidth * 0.3 ? next : prev)();
  });
  let sx = null, sy = 0;
  addEventListener("touchstart", e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  addEventListener("touchend", e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    // De pie se baja con el dedo: solo un gesto claramente de lado cambia de momento.
    if (Math.abs(dx) > 40 && (!stacked || Math.abs(dx) > 2 * Math.abs(dy))) (dx < 0 ? next : prev)();
    sx = null;
  });
  // De pie, al dejar de bajar, la parte que queda a la altura de lectura pasa a ser la actual y empieza.
  let settle = 0;
  addEventListener("scroll", () => {
    if (!stacked) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      const line = innerHeight * READ_AT;
      let best = index, dist = Infinity;
      slides.forEach((s, i) => { const r = s.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - line); if (d < dist) { dist = d; best = i; } });
      if (best !== index) { fromScroll = true; show(best, 0); fromScroll = false; }
    }, 160);
  }, { passive: true });

  const m = /^#p(\d+)$/.exec(location.hash);
  show(m ? +m[1] - 1 : 0, 0, true);
})();
