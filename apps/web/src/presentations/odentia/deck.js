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
    // El guion solo viene con /presentacion/fundadores?guion: la que reciben las clínicas no lo trae.
    const notesTitle = document.getElementById("notesTitle"), notesText = document.getElementById("notesText");
    if (notesTitle) notesTitle.textContent = "Guion · parte " + (n + 1) + " de " + slides.length;
    if (notesText) notesText.textContent = notes ? notes.textContent : "";
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

  // 1 · La portada 3D del inicio de la web («D3» de @odentia/brand-scene): cada trabajo de un jueves
  // de ejemplo entra por un canal, un agente lo resuelve y se enciende una de las 32 piezas.
  const OUT = [["cita", "cita agendada", "citas agendadas"], ["nota", "nota confirmada", "notas confirmadas"],
    ["vuelta", "paciente de vuelta", "pacientes de vuelta"], ["tarea", "caso para tu equipo", "casos para tu equipo"]];
  scenes.cover = () => {
    const B = window.BrandScene;
    if (!B) return;
    const AG = B.AGENTS, CHANS = B.CHANS, D = B.DAY, dir = B.dir, via = B.via;
    ["Sofi · agente de recepción", "Clío · agente clínico", "Argos · agente administrador"].forEach((n, i) => { if (AG[i]) AG[i].name = n; });
    const cv = document.getElementById("d3cv"), area = document.getElementById("coverScene");
    const live = { step: 0, hover: -1, still: reduce };
    let hold = 0, cycle = 0;
    const host = {
      state: () => live, anchor: (ch) => [CHANS[ch].ax, 42], panelPt: () => [150, 505],
      cap: document.getElementById("d3cap"), lineIn: document.getElementById("d3in"),
      lineOut: document.getElementById("d3out"), dot: document.getElementById("d3dot"),
    };
    const sc = new B.ToothScene(host);
    const raf = requestAnimationFrame(() => sc.start(cv));
    const ul = document.getElementById("d3chans");
    ul.innerHTML = "";
    const lis = CHANS.map((c, i) => {
      const li = el("li", "", c.label);
      li.style.left = c.left + "px"; li.style.width = c.width + "px"; li.style.setProperty("--d", (0.15 + i * 0.09).toFixed(2) + "s");
      ul.appendChild(li); return li;
    });
    const who = document.getElementById("d3who"), meta = document.getElementById("d3meta"), txt = document.getElementById("d3txt");
    const bar = document.getElementById("d3bar"), outs = document.getElementById("d3outs"), cap = host.cap;
    let lastTxt = "";
    function render() {
      const still = live.still, step = still ? 32 : live.step, hover = live.hover;
      const counts = {};
      for (let k = 0; k < step; k++) counts[D.ev[k].out] = (counts[D.ev[k].out] || 0) + 1;
      const nEv = step > 0 && !still ? D.ev[step - 1] : null;
      let cur, focusEv = null;
      if (hover >= 0) {
        const e = D.ev[D.slotOf[hover]]; focusEv = e;
        cur = { agent: AG[e.agent].name, color: AG[e.agent].color, ch: via(e), where: e.where, meta: "La pieza que señalas · " + e.time, text: e.text, cls: "ztxt" };
      } else if (step === 32) {
        cur = { agent: "Tus tres agentes", color: "#ffffff", ch: "", where: "", meta: "Jueves · 32 de 32", text: "Un jueves completo de ejemplo: 32 trabajos que llegaron por siete vías y quedaron resueltos mientras tu equipo atendía.", cls: "ztxt" };
      } else if (step === 0) {
        cur = { agent: "Tus tres agentes", color: "#ffffff", ch: "", where: "", meta: "Jueves · 06:59", text: "Empieza el día en una clínica de ejemplo.", cls: "ztxt" };
      } else {
        const e = D.ev[step - 1]; focusEv = e;
        cur = { agent: AG[e.agent].name, color: AG[e.agent].color, ch: via(e), where: e.where, meta: "Jueves · " + e.time + " · " + step + " de 32", text: e.text, cls: step % 2 ? "ztxt n1" : "ztxt n2" };
      }
      lis.forEach((li, i) => {
        li.className = "zch" + (i === 6 ? " cons" : "") + (cycle % 2 ? " b" : " a") +
          (focusEv && focusEv.ch === i ? " on" + (hover >= 0 ? "" : step % 2 ? " s1" : " s2") : "");
        li.style.setProperty("--c", focusEv ? AG[focusEv.agent].color : "#4fc3d7");
      });
      who.style.setProperty("--c", cur.color);
      who.innerHTML = "<i></i>" + cur.agent + (cur.ch ? '<span class="zbdg">' + cur.ch + "</span>" : "") + (cur.where ? '<span class="zbdg to">→ ' + cur.where + "</span>" : "");
      meta.textContent = cur.meta;
      if (cur.text !== lastTxt) { txt.className = cur.cls; txt.textContent = cur.text; lastTxt = cur.text; }
      bar.style.width = ((step / 32) * 100).toFixed(1) + "%";
      outs.innerHTML = OUT.map(([k, one, many]) => "<span><b>" + (counts[k] || 0) + "</b>" + ((counts[k] || 0) === 1 ? one : many) + "</span>").join("");
      cap.style.setProperty("--c", nEv ? AG[nEv.agent].color : "#4fc3d7");
      cap.children[0].textContent = nEv ? dir(nEv) : ""; cap.children[1].textContent = nEv ? nEv.msg : "";
    }
    render();
    const timer = reduce ? 0 : setInterval(() => {
      if (live.step < 32) live.step++;
      else if (hold < 3) { hold++; return; }
      else { live.step = 0; hold = 0; cycle++; }
      sc.stepAt = performance.now();
      render();
    }, 1500);
    const move = (e) => {
      const r = cv.getBoundingClientRect(), k = cv.clientWidth / (r.width || 1);
      const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
      sc.tmx = Math.max(-1, Math.min(1, (x / cv.clientWidth) * 2 - 1));
      sc.tmy = Math.max(-1, Math.min(1, -((y / cv.clientHeight) * 2 - 1)));
      const step = live.still ? 32 : live.step;
      let best = -1, bd = 26;
      (sc.scr || []).forEach((p, i) => { const dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bd && D.slotOf[i] < step) { bd = dd; best = i; } });
      if (best !== live.hover) { live.hover = best; render(); }
    };
    const leave = () => { sc.tmx = 0; sc.tmy = 0; if (live.hover !== -1) { live.hover = -1; render(); } };
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerleave", leave);
    cleanups.push(() => {
      cancelAnimationFrame(raf); clearInterval(timer); sc.stop();
      area.removeEventListener("pointermove", move); area.removeEventListener("pointerleave", leave);
    });
  };

  // 2 · Lucía, esa noche. Problema y respuesta son espejo: el mismo teléfono (el de Lucía), el
  // mismo mensaje y la misma hora. Sin respuesta, a los 11 minutos reserva en otra clínica; con
  // Sofi, en segundos queda en tu agenda. Después, toda la noche: una persona por mensaje.
  const LUCIA_MSG = "Hola, ¿tienen cita el viernes? Me duele una muela 😣";
  /** Quién escribió esa noche, a qué hora y qué le dejó hecho Sofi (cita, urgencia o una respuesta). */
  const P1NIGHT = [
    ["Sofía", "19:12", "cita"], ["Jorge", "19:40", ""], ["Ana", "20:05", ""], ["Pedro", "20:31", "cita"],
    ["Carla", "21:02", ""], ["Luis", "21:26", ""], ["Marta", "21:50", ""], ["Diego", "22:13", "cita"],
    ["Lucía", "22:47", "cita"], ["Raúl", "23:05", ""], ["Elena", "23:31", "urg"], ["Tomás", "00:12", ""],
    ["Inés", "00:48", "cita"], ["Hugo", "01:30", "urg"], ["Paula", "05:55", ""], ["Rosa", "06:22", ""],
    ["Iván", "06:40", ""], ["Nora", "06:58", ""], ["Óscar", "07:10", "cita"], ["Bea", "07:24", ""],
    ["Julio", "07:38", ""], ["Silvia", "07:49", "cita"], ["Mateo", "07:58", "cita"],
  ];
  /** Los que esperaron y reservaron en otra clínica (Lucía entre ellos). */
  const P1GONE = [1, 3, 7, 8, 10, 13, 16];
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  function p1Build(sc) {
    sc.innerHTML = `<div class="phone lph"><div class="phone-top"><span class="av cs">CS</span><div><b>Clínica Sonrisa</b><span>Instagram · lo que ve Lucía</span></div></div><div class="chat"></div></div>
      <div class="p1wait"></div>
      <div class="p1night"><p class="p1nhead"></p><div class="p1people"></div><div class="p1box"><h3></h3><div class="row"></div></div><div class="p1end"></div></div>`;
    const phone = sc.querySelector(".lph"), chat = sc.querySelector(".chat"), av = sc.querySelector(".av"), name = sc.querySelector(".phone-top b"), wait = sc.querySelector(".p1wait");
    const scale = () => stage.getBoundingClientRect().width / 1920;
    const at = (node) => { const r = node.getBoundingClientRect(), q = sc.getBoundingClientRect(), s = scale(); return { x: (r.left - q.left) / s, y: (r.top - q.top) / s }; };
    const say = (who, text, time) => { const d = el("div", "msg " + who, `${text}<small>${time}</small>`); chat.appendChild(d); return d; };
    const note = (html, cls = "") => { const d = el("div", "p1seen " + cls, html); chat.appendChild(d); return d; };
    const typing = (cls = "") => { const d = el("div", "typing left " + cls, "<i></i><i></i><i></i>"); chat.appendChild(d); return d; };
    const stamp = (text, ok) => chat.appendChild(el("div", "p1stamp" + (ok ? " ok" : ""), text));
    const counter = (cls) => { const d = el("div", cls, "<b></b><span></span>"); wait.appendChild(d); return { set: (big, small) => { d.children[0].textContent = big; d.children[1].textContent = small; } }; };
    // Cambia de conversación en el teléfono: otra clínica, o de vuelta a la tuya.
    const open = async (clinic) => {
      chat.classList.add("swap"); await p6wait(320);
      chat.innerHTML = "";
      av.textContent = clinic === "otra" ? "DN" : "CS"; av.className = "av " + (clinic === "otra" ? "other" : "cs");
      name.textContent = clinic === "otra" ? "Dental Norte · otra clínica" : "Clínica Sonrisa";
      chat.classList.remove("swap");
    };
    return { sc, phone, chat, av, say, note, typing, stamp, counter, open, wait, at,
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
      : `Y no fue solo Lucía: esa noche escribieron <b>${P1NIGHT.length} personas</b>.`;
    w.boxTitle.textContent = ok ? "Nuevas en tu agenda" : "Reservaron en otra clínica";
    const tiles = P1NIGHT.map(([who, time], i) => {
      const t = el("div", "p1p", `<i>${who[0]}</i><span><b>${who}</b><small>${time}</small></span>`);
      t.style.animationDelay = `${i * 45}ms`; w.people.appendChild(t); return t;
    });
    await p6wait(1600);
    // Lo que va a la caja: en el problema, los que reservaron en otra clínica; en la respuesta, las citas nuevas.
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
      ? `<b>0 pacientes</b> se fueron a otra clínica · <b>${urgent} urgencias</b> ya avisadas a la Dra. Ana`
      : `<b>${P1GONE.length} pacientes</b> se fueron a otra clínica · <b>USD 840</b> que no entraron`));
  }

  // 2 · Problema: nadie le contesta a Lucía y reserva en otra clínica.
  scenes.notifs = async () => {
    const w = p1Build(document.getElementById("p1scene"));
    const clock = document.getElementById("p1clock");
    clock.textContent = "22:47";
    await p6wait(900);
    w.say("me", LUCIA_MSG, "22:47");
    const seen = w.note("Enviado · 22:47");
    await p6wait(1100);
    const ours = w.counter("");
    for (let m = 1; m <= 11; m++) {
      clock.textContent = hhmm(22 * 60 + 47 + m);
      seen.classList.add("late"); seen.innerHTML = `Enviado · sin respuesta · <b>${m} min</b>`;
      ours.set(`${m} min`, "y tu clínica no le contesta");
      await p6wait(m < 3 ? 520 : 300);
    }
    await p6wait(800);
    // Le escribe a otra clínica, que contesta en un minuto.
    await w.open("otra");
    w.say("me", "Hola, ¿tienen cita el viernes? Me duele una muela", "22:58");
    await p6wait(700);
    let t = w.typing();
    await p6wait(1100); t.remove(); clock.textContent = "22:59";
    w.say("clinic", "¡Hola, Lucía! Sí, el viernes a las 16:30. ¿Te la reservo?", "22:59");
    w.counter("other").set("1 min", "y otra clínica le contesta");
    await p6wait(1500);
    w.say("me", "Sí, por favor", "22:59");
    await p6wait(600); t = w.typing();
    await p6wait(900); t.remove(); clock.textContent = "23:00";
    w.say("clinic", "Listo: te esperamos el viernes a las 16:30.", "23:00");
    await p6wait(500); w.stamp("Reservó en otra clínica", false);
    await p6wait(2000);
    // A la mañana, recepción le contesta: ya es tarde.
    await w.open("tuya");
    clock.textContent = "08:00";
    w.say("me", LUCIA_MSG, "22:47");
    w.note(`Sin respuesta · <b>9 h 13 min</b>`, "late");
    ours.set("9 h", "y tu clínica no le contesta");
    await p6wait(900);
    w.say("clinic", "Buenos días, Lucía. ¿En qué te podemos ayudar?", "08:00");
    await p6wait(1500); clock.textContent = "08:03";
    w.say("me", "Gracias, ya reservé en otra clínica.", "08:03");
    await p6wait(2600);
    await p1Night(w, false);
  };

  // 2 · Respuesta (espejo): el mismo mensaje a la misma hora; Sofi contesta en segundos y agenda.
  scenes.chat = async () => {
    const w = p1Build(document.getElementById("r1scene"));
    w.av.classList.add("warm");
    const clock = document.getElementById("r1clock");
    clock.textContent = "22:47";
    await p6wait(900);
    w.say("me", LUCIA_MSG, "22:47");
    const seen = w.note("Enviado · 22:47");
    await p6wait(600);
    let t = w.typing("sky");
    await p6wait(1200); t.remove(); seen.remove();
    w.say("sofi2", "Hola, Lucía. Soy Sofi, de Clínica Sonrisa. El viernes tengo 10:00 o 16:30 con la Dra. Ana. ¿Cuál te queda mejor?", "22:47");
    w.counter("sky").set("8 s", "y Sofi le contesta");
    await p6wait(1700); clock.textContent = "22:48";
    w.say("me", "16:30, por favor", "22:48");
    await p6wait(600); t = w.typing("sky");
    await p6wait(1000); t.remove();
    w.say("sofi2", "Listo: viernes 16:30 con la Dra. Ana. Te recuerdo un día antes.", "22:48");
    await p6wait(800); w.chat.appendChild(el("div", "msg log", "Sofi · Agendó · → Agenda, viernes 16:30"));
    await p6wait(700); w.stamp("No le escribió a otra clínica", true);
    w.counter("sky").set("0", "veces que buscó otra clínica");
    await p6wait(2600);
    // La mañana, como en el problema: recepción abre y encuentra la noche hecha.
    clock.textContent = "08:00";
    await p1Night(w, true);
  };

  // 3 · Problema: la misma persona en tres fichas; cada cosa cae en una distinta.
  scenes.p2prob = async () => {
    const sc = document.getElementById("p2scene");
    sc.innerHTML = '<div class="p2cards"></div><div class="p2alerts"></div>';
    const cardsEl = sc.querySelector(".p2cards"), alerts = sc.querySelector(".p2alerts");
    const FICHAS = [["Lucía T.", "Instagram · @lu.torres"], ["Lucia Torres", "WhatsApp · número nuevo"], ["L. Torres", "Correo · lucia.t@…"]];
    const cards = [];
    for (let i = 0; i < 3; i++) {
      await p6wait(i ? 700 : 600);
      const c = el("div", "p2card", `<span class="nw">Ficha nueva</span><b>${FICHAS[i][0]}</b><span class="ch">${FICHAS[i][1]}</span>`);
      c.style.left = i * 275 + "px"; cardsEl.appendChild(c); cards.push(c);
      if (i) { const q = el("div", "p2q", "≠"); q.style.left = i * 275 - 25 + "px"; cardsEl.appendChild(q); }
    }
    const item = (i, text, hot) => cards[i].appendChild(el("div", "it" + (hot ? " hot" : ""), text));
    const alert = (text, bad) => alerts.appendChild(el("div", bad ? "bad" : "", `<i>✕</i><span>${text}</span>`));
    await p6wait(800); item(0, "Presupuesto · ortodoncia");
    await p6wait(500); item(1, "Cita · vie 16:30");
    await p6wait(500); item(2, "Radiografía panorámica");
    await p6wait(500); item(2, "Alergia: penicilina", true);
    await p6wait(900); alert("La confirmación de la cita salió por Instagram. Lucía no la vio y faltó.");
    await p6wait(1300); alert("Recepción, por cuarta vez: «¿Me recuerdas tu nombre?»");
    await p6wait(1300); alert("Le llegó «20 % en tu primera visita». Viene hace dos años.");
    await p6wait(1500); alert("La Dra. Ana abre «Lucía T.»: no ve la alergia a la penicilina.", true);
    await p6wait(1300);
    sc.appendChild(el("div", "p2foot", "3 fichas · 1 persona · su historia partida en tres"));
  };

  // 3 · Respuesta: los canales llegan a una sola ficha.
  scenes.omni = () => {
    const svg = document.getElementById("omniSvg"), tl = document.getElementById("timeline");
    tl.innerHTML = "";
    const chans = ["WhatsApp", "Instagram", "Messenger", "Telegram", "Chat web", "Correo", "En la consulta"];
    const tx = 1140, ty = 600;
    let html = "";
    chans.forEach((name, i) => {
      const cx = 200 + i * 124, cy = 960;
      html += `<path id="op${i}" d="M${cx} ${cy - 24} C ${cx} 780, ${tx - 220} ${ty + 80}, ${tx} ${ty}" fill="none" stroke="rgba(79,195,215,.2)" stroke-width="2" stroke-dasharray="4 8"/>`;
      html += `<rect x="${cx - 58}" y="${cy - 24}" width="116" height="42" rx="21" fill="#0f2e38" stroke="rgba(143,176,184,.35)"/><text class="chan" x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="${name.length > 9 ? 14 : 17}">${name}</text>`;
    });
    html += `<circle id="opDot" r="10" fill="#4fc3d7" opacity="0"/>`;
    svg.innerHTML = html;
    const events = [[1, "Preguntó por un blanqueamiento"], [0, "Confirmó su evaluación"], [6, "Evaluación con la Dra. Ana"],
      [5, "Recibió su presupuesto"], [0, "Aceptó el presupuesto"], [4, "Completó sus datos"], [5, "Recibió su receta"], [3, "Movió su cita al lunes"]];
    const days = ["lun 09:14", "lun 09:20", "mar 16:30", "mar 17:02", "mié 11:45", "mié 11:50", "vie 18:10", "sáb 10:05"];
    const dot = svg.querySelector("#opDot");
    let e = 0;
    function shoot() {
      const [ch, text] = events[e % events.length], path = svg.querySelector("#op" + ch), len = path.getTotalLength();
      const t0 = performance.now(), dur = reduce ? 1 : 1000;
      path.setAttribute("stroke", "rgba(79,195,215,.8)");
      loop((now) => {
        const p = Math.min(1, (now - t0) / dur), pt = path.getPointAtLength(len * p);
        dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y); dot.setAttribute("opacity", p < 1 ? 1 : 0);
        if (p < 1) return true;
        path.setAttribute("stroke", "rgba(79,195,215,.2)");
        if (e % events.length === 0) tl.innerHTML = "";
        tl.appendChild(el("div", "tl", `<span class="mono">${days[e % days.length]}</span><span>${text} · <span style="color:#8fb0b8">${chans[ch]}</span></span>`));
        e++; later(shoot, 600);
        return false;
      });
    }
    later(shoot, 800);
  };

  // 4 · Respuesta: registro de acciones en vivo.
  scenes.log = (layer) => {
    const go = () => window.Part4 && window.Part4.start(layer);
    if (window.Part4) go(); else addEventListener("part4-ready", go, { once: true });
    cleanups.push(() => { removeEventListener("part4-ready", go); window.Part4 && window.Part4.stop(); });
  };

  // 4 en la v2 (?v2) · La clínica en 3D: todos los momentos de la parte son la misma escena. Solo se baja si
  // se usa y, si no se puede bajar, queda lo que se lee.
  let clinic = null, clinicFailed = false;
  const clinicFlat = (slide) => { clinicFailed = true; slide.classList.add("cl-flat"); };
  scenes.clinic = (layer) => {
    if (clinicFailed) return;
    const slide = layer.closest(".slide"), step = +layer.dataset.step;
    const run = (m) => { try { m.start(slide, step, (k) => show(slides.indexOf(slide), k)); } catch (e) { clinicFlat(slide); } };
    let off = false;
    if (clinic) run(clinic);
    else import("./clinic-3d.js").then((m) => { clinic = m; if (!off) run(m); }).catch(() => clinicFlat(slide));
    cleanups.push(() => { off = true; clinic?.stop(); });
  };

  // 5 · Problema: el reloj avanza con las notas pendientes.
  scenes.lateClock = () => {
    const c = document.getElementById("lateClock");
    let m = 18 * 60;
    const t = () => { m += 4; c.textContent = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); if (m < 20 * 60 + 12) later(t, 60); };
    later(t, 400);
  };

  // 5 · Respuesta: el dictado se ordena en bloques que el odontólogo confirma.
  scenes.dictation = () => {
    const said = document.getElementById("said"), blocks = document.getElementById("blocks");
    said.textContent = ""; blocks.innerHTML = "";
    const text = "Dolor al frío en la muela de abajo, lado izquierdo… pieza 36, caries profunda en oclusal… hacemos resina y control en seis meses.";
    typeInto(said, text, 32);
    const items = [["Motivo", "Dolor al frío, muela inferior izquierda"], ["Hallazgo", "Pieza 36 · caries profunda en oclusal"],
      ["Diagnóstico", "CIE-10 · K02.1 · Caries de la dentina"], ["Plan", "Resina en pieza 36 · control en 6 meses"]];
    items.forEach(([k, v], i) => later(() => {
      const b = el("div", "blk", `<span class="k">${k}</span><span class="v">${v}</span><span class="ok">Confirmar</span>`);
      blocks.appendChild(b);
      later(() => { b.classList.add("done"); b.querySelector(".ok").textContent = "✓ Confirmado"; }, 2600 + (items.length - i) * 250);
    }, 1800 + i * 700));
  };

  // 6 · La agenda de la semana: no está llena, se caen citas (problema) y los pacientes vuelven a sus huecos (respuesta).
  const P6_DAYS = ["lun", "mar", "mié", "jue", "vie"], P6_HOURS = ["09:00", "10:00", "11:00", "12:00", "16:00"];
  const P6_BUSY = ["Ana P.", "Luis G.", "Sara V.", "Tomás R.", "Elena C.", "Iván D.", "Nora F.", "Raúl M.", "Julia B.", "Óscar L.", "Paula N.", "Hugo S.", "Irene T.", "Marta Q.", "Sergio A.", "Laura E."];
  // Lo que ya estaba libre y las citas que se caen (fila-columna).
  const P6_EMPTY = ["0-2", "1-4", "2-0", "2-3", "3-1", "4-2", "4-4", "0-4", "3-3"];
  const P6_LOST = ["0-1", "1-2", "2-4", "3-0", "4-1", "1-0"];
  const P6_BACK = [
    ["PR", "Pedro R.", "último control: marzo"], ["LM", "Lucía M.", "último control: febrero"], ["JC", "Javier C.", "presupuesto: 21 días"],
    ["RM", "Rosa M.", "no vino el martes"], ["CS", "Carla S.", "último control: enero"], ["MT", "Mario T.", "presupuesto: 14 días"],
    ["AV", "Andrea V.", "control vencido"], ["GL", "Gabriel L.", "no vino el jueves"], ["SF", "Sofía F.", "presupuesto en pausa"],
    ["DN", "Daniel N.", "control vencido"], ["VR", "Valeria R.", "último control: abril"], ["FT", "Fernando T.", "presupuesto: 9 días"],
    ["BM", "Beatriz M.", "control vencido"], ["EC", "Emilio C.", "no vino el lunes"], ["KP", "Karla P.", "último control: mayo"],
  ];
  function p6Build(layer) {
    const sc = layer.querySelector(".p6sc");
    sc.innerHTML = `<div class="p6cal"><div class="p6cal-h"><b>Agenda · semana del 20</b><span>Dra. Ana · Unidad dental 1</span></div><div class="p6grid"></div></div><div class="p6beam"></div><div class="p6drift"><h3>No volvieron</h3></div>`;
    const grid = sc.querySelector(".p6grid");
    grid.innerHTML = "<span></span>" + P6_DAYS.map(d => `<span class="d">${d}</span>`).join("");
    const slots = {}; let k = 0;
    P6_HOURS.forEach((h, r) => { grid.insertAdjacentHTML("beforeend", `<span class="h">${h}</span>`); P6_DAYS.forEach((d, c) => { const key = r + "-" + c, n = el("div", "p6slot"); grid.appendChild(n); const o = { n, d, h, name: null }; if (!P6_EMPTY.includes(key)) o.name = P6_BUSY[k++ % P6_BUSY.length]; slots[key] = o; }); });
    const busy = (key) => { const o = slots[key]; o.n.className = "p6slot"; o.n.style.removeProperty("--c"); o.n.innerHTML = `${o.name}<small>${o.h} · control</small>`; };
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
        const bub = el("div", "p6bubble", `<small>Sofi · WhatsApp</small>Hola, ${c.querySelector("b").textContent.split(" ")[0]}. ¿Te agendo el ${o.d} a las ${o.h}?`);
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
      o.n.className = "p6slot back"; o.n.style.setProperty("--c", C.sky);
      o.n.innerHTML = `${name}<small>${o.h} · ${why.startsWith("presupuesto") ? "tratamiento" : "control"}</small>`;
      w.counter.textContent = i + 1;
      // Entra el siguiente paciente que Argos encontró.
      const next = queue.shift(); if (next) { const n = w.card(next, "seen"); cards.push(n); }
      if (!slow) await p6wait(120);
    }
    w.head.insertAdjacentHTML("beforeend", "<em>Semana llena ✓</em>");
  };

  // 7 · El caos de armar el reporte a mano: descargas, búsquedas, versiones, errores y el reloj.
  const p7fmt = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  const p7sheet = (name, seed) => {
    const ERR = ["#¡REF!", "#N/A", "#¡DIV/0!", "#¡VALOR!"];
    let rows = "<tr><td>Sede</td><td>Cobrado</td><td>Citas</td><td>Faltas</td></tr>";
    for (let r = 0; r < 5; r++) rows += `<tr><td>${["Centro", "Norte", "Centro", "Norte", "Total"][r]}</td>` + [0, 1, 2].map(c => ((r * 3 + c + seed) % 4 === 0) ? `<td class="err">${ERR[(r + c + seed) % 4]}</td>` : `<td>${(1000 + ((r + 2) * (c + 5) * 137 + seed * 311) % 9000).toLocaleString("es")}</td>`).join("") + "</tr>";
    return `<div class="bar"><i></i><i></i><i></i>${name}</div><table>${rows}</table>`;
  };
  scenes.p7prob = async (layer) => {
    const sc = layer.querySelector(".p7sc"), big = layer.querySelector("[data-p7count]");
    sc.innerHTML = "";
    const clock = el("div", "p7clock", "vie 15:00<small>empieza el reporte</small>"); sc.appendChild(clock);
    let m = 0, z = 1;
    const tickTo = async (mins, ms) => { const steps = 8; for (let i = 0; i < steps; i++) { m += mins / steps; const t = 15 * 60 + Math.round(m); big.textContent = p7fmt(Math.round(m)); clock.innerHTML = `vie ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}<small>${t > 19 * 60 ? "la clínica cerró hace horas" : "armando el reporte"}</small>`; await p6wait(ms / steps); } };
    const win = (cls, html, x, y, w, r) => { const n = el("div", "p7w " + cls, html); n.style.left = x + "px"; n.style.top = y + "px"; n.style.width = w + "px"; n.style.setProperty("--r", r + "deg"); n.style.zIndex = ++z; sc.appendChild(n); return n; };
    // 1. Descargar de cada sistema; una descarga falla.
    const dl = win("web", `<div class="bar"><i></i><i></i><i></i>Descargas</div><div class="body">
      <div class="p7dl"><span>agenda_septiembre.csv</span><span>listo</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span>caja_sede_centro.xlsx</span><span>listo</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span class="bad">caja_sede_norte.xlsx</span><span class="bad">falló</span><div class="pb"><i></i></div></div>
      <div class="p7dl"><span>presupuestos_export (2).csv</span><span>listo</span><div class="pb"><i></i></div></div></div>`, 10, 70, 430, -2);
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
    win("chat", `<div class="bar"><i></i><i></i><i></i>WhatsApp · Recepción</div><div class="body"><div class="p7msg me">¿Me pasas lo de caja de la sede Norte?</div><div class="p7msg">Ya te lo mandé por correo 😅</div><div class="p7msg me">No me llegó 🙃</div></div>`, 640, 300, 330, 4);
    await tickTo(50, 1100);
    // 5. Notas y cifras que no cuadran.
    const notes = [["¿Por qué no cuadra con la caja?", 690, 560, -4], ["Falta sumar la sede Norte", 40, 620, 5], ["Revisar faltas de agosto", 520, 650, -3]];
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
    out.innerHTML = `<div class="p7rep"><div class="t"><b>Cobrado en septiembre, por sede</b><span>septiembre frente a agosto</span></div><div class="tot">$ 18.420<small>8 % más que en agosto</small></div><div class="p7bars"><div><i data-h="92"></i><span>Centro · 11.200</span></div><div><i class="hot" data-h="58"></i><span>Norte · 7.220</span></div></div></div>`;
    await p6wait(120); out.querySelectorAll(".p7bars i").forEach(i => { i.style.height = i.dataset.h + "%"; });
    await p6wait(1200);
    out.querySelector(".p7rep").insertAdjacentHTML("beforeend", `<div class="p7say"><span><b style="color:var(--amber)">Argos:</b> la sede Norte bajó 6 %: faltaron 9 citas y «Reprogramar tras una inasistencia» está apagada.</span><span class="go">Ver qué hacer</span></div>`);
  };

  // 8 · Lucía en el mostrador: seis lugares, la palabra exacta y el reloj; después, el buscador.
  const p8fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const p8type = async (node, text, ms) => { node.classList.remove("done"); node.textContent = ""; for (let i = 1; i <= text.length; i++) { node.textContent = text.slice(0, i); await p6wait(ms); } node.classList.add("done"); };
  const p8desk = (sc, text) => {
    sc.innerHTML = `<div class="p8desk"><span class="av">LT</span><div class="who"><span class="l">Lucía, en el mostrador</span><div class="bub in"></div></div><div class="p8queue"><span class="l">En espera</span><div class="p8qs"></div><span class="ring" hidden>☏ 2 llamadas sin contestar</span></div></div><div class="p8area"></div>`;
    sc.querySelector(".bub").textContent = text;
    return { bub: sc.querySelector(".bub"), qs: sc.querySelector(".p8qs"), ring: sc.querySelector(".ring"), area: sc.querySelector(".p8area") };
  };
  const P8Q = "¿Cuánto me falta pagar de la ortodoncia? ¿Y mi radiografía?";
  scenes.p8prob = async (layer) => {
    const sc = layer.querySelector(".p8sc"), big = layer.querySelector("[data-p8count]");
    const { qs, ring, area } = p8desk(sc, P8Q);
    let secs = 0; big.textContent = "0:00";
    const clock = (to, ms) => { const from = secs; secs = to; return p6anim(ms, (e) => { big.textContent = p8fmt(from + (to - from) * e); }); };
    const queue = (n) => { while (qs.children.length < n) qs.appendChild(el("i", "", ["MR", "JP", "AC"][qs.children.length])); };
    const win = (cls, title, x, y, r, body) => { const w = el("div", "p8w " + cls, `<div class="bar"><i></i><i></i><i></i><span>${title}</span></div><div class="body">${body}</div>`); w.style.left = x + "px"; w.style.top = y + "px"; w.style.setProperty("--r", r + "deg"); area.appendChild(w); return w; };
    await p6wait(900);
    // Pacientes: sin la tilde no aparece, y con el apellido primero tampoco.
    const w1 = win("", "Pacientes", 0, 0, -1.5, `<div class="sb">⌕ <span class="q"></span></div><div class="out"></div>`);
    const q1 = w1.querySelector(".q"), o1 = w1.querySelector(".out");
    await p6wait(350);
    let t = clock(35, 1300); await p8type(q1, "lucia", 120);
    o1.innerHTML = `<div class="no">Sin resultados para «lucia»</div><span class="note">Está guardada como «Lucía», con tilde.</span>`; await t; queue(1);
    await p6wait(1100);
    t = clock(70, 1400); await p8type(q1, "torres lucia", 70);
    o1.innerHTML = `<div class="no">Sin resultados para «torres lucia»</div><span class="note">Está como «Lucía Torres».</span>`; await t;
    await p6wait(1000);
    o1.innerHTML = `<div class="pg">Revisando la lista a mano · página <b>1</b> de 38</div>`;
    const pg = o1.querySelector("b"); t = clock(140, 1900);
    for (let p = 2; p <= 12; p++) { await p6wait(150); pg.textContent = p; }
    o1.insertAdjacentHTML("beforeend", `<div class="hitrow">Lucía Torres · +51 992 154 378</div>`); await t;
    await p6wait(600);
    // Presupuestos: otra pantalla con otros filtros.
    const w2 = win("", "Presupuestos", 480, 24, 2, `<div class="filters"><span>Paciente ▾</span><span>Fecha ▾</span><span>Estado ▾</span><span>Sede ▾</span></div><div class="out"></div>`);
    t = clock(205, 1900);
    for (const f of w2.querySelectorAll(".filters span")) { await p6wait(380); f.classList.add("on"); }
    w2.querySelector(".out").innerHTML = `<div class="hitrow">Ortodoncia fija · USD 1.800</div><span class="note">¿Y cuánto pagó? Eso está en otro lado.</span>`; await t;
    await p6wait(800);
    // El Excel de pagos, con el nombre escrito de otra forma.
    const w3 = win("xlw", "pagos_2026.xlsx", 30, 230, -1, `<div class="sb">Buscar: <span class="q"></span></div><div class="out"></div>`);
    const o3 = w3.querySelector(".out");
    t = clock(285, 2200); await p8type(w3.querySelector(".q"), "Lucía", 120);
    o3.innerHTML = `<div class="no">No se encontró «Lucía»</div><span class="note">La anotaron como «LUCIA TORRES».</span>`;
    await p6wait(1000); ring.hidden = false; queue(2);
    o3.innerHTML = `<table><tr><td>12/03</td><td>LUCIA TORRES</td><td>500</td></tr><tr><td>18/04</td><td>L. TORRES</td><td>440</td></tr><tr><td>20/05</td><td>LUCIA T.</td><td>440</td></tr><tr><td colspan="2">Debe</td><td class="err">#¡REF!</td></tr></table>`; await t;
    await p6wait(700);
    // WhatsApp: el voucher, tres semanas atrás.
    const w4 = win("wa", "WhatsApp · recepción", 490, 270, 2.5, `<div class="msgs"><span class="d">hoy</span><div class="m">¿Tienen cita el sábado?</div><div class="m">Ya les transferí</div></div>`);
    const d4 = w4.querySelector(".d"); t = clock(370, 2000);
    for (const day of ["ayer", "hace 1 semana", "hace 2 semanas", "hace 3 semanas"]) { await p6wait(430); d4.textContent = day; }
    w4.querySelector(".msgs").insertAdjacentHTML("beforeend", `<div class="m pic">[foto] voucher_lucia.jpg</div>`); await t;
    await p6wait(600);
    // La carpeta de radiografías: archivos sin el nombre de nadie.
    const w5 = win("", "Radiografías › 2026 › marzo", 220, 420, -2.5, `<div class="files"></div><span class="note warn">¿Cuál es la de Lucía?</span>`);
    const fl = w5.querySelector(".files"); t = clock(460, 2100);
    for (const f of ["IMG_2231.jpg", "IMG_2232.jpg", "escaneo (4).pdf", "IMG_2240.jpg", "pano_marzo.jpg", "IMG_2241.jpg"]) { await p6wait(230); fl.insertAdjacentHTML("beforeend", `<span>▣ ${f}</span>`); }
    await t; queue(3);
    await p6wait(900);
    sc.insertAdjacentHTML("beforeend", `<div class="p8stamp">Si pasa 20 veces al día: <b>2 h 33 min</b> buscando cada día · <b>56 h</b> al mes</div>`);
  };

  // Íconos de lucide, los mismos de la ventana real.
  const P8I = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    persona: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    cita: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
    documento: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    dinero: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    servicio: '<path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/><path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="6.5" cy="9.5" r=".5"/>',
    respuesta: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  };
  const p8svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${P8I[k]}</svg>`;
  const p8tile = (k, sm, cls = k) => `<span class="tile ${cls}${sm ? " sm" : ""}">${p8svg(k)}</span>`;
  const p8own = (k, title, badge, detail, enter, d = 0) => `<div class="own${enter ? " sel" : ""}" style="animation-delay:${d}ms">${p8tile(k, false, k === "help" ? "help" : k)}<span class="tx"><span class="t1">${title}${badge ? `<span class="badge">${badge}</span>` : ""}</span>${detail ? `<span class="t2">${detail}</span>` : ""}</span>${enter ? `<span class="enter">Enter · ${enter}</span>` : ""}</div>`;
  const p8kid = (k, kind, title, meta, d) => `<div class="kid" style="animation-delay:${d}ms"><span class="ln"></span>${p8tile(k, true)}<span class="k">${kind}</span><span class="t">${title}</span><span class="m">${meta}</span></div>`;
  scenes.p8ans = async (layer) => {
    const sc = layer.querySelector(".p8sc"), big = layer.querySelector("[data-p8count]");
    const { bub, qs, area } = p8desk(sc, P8Q);
    ["MR", "JP", "AC"].forEach(n => qs.appendChild(el("i", "", n))); sc.querySelector(".ring").hidden = false;
    big.textContent = "0:00";
    const say = (text) => { bub.classList.remove("in"); void bub.offsetWidth; bub.textContent = text; bub.classList.add("in"); };
    await p6wait(700);
    const ck = el("div", "p8ck", `<div class="in">${p8svg("search")}<span class="q"></span><span class="flt">${p8svg("filter")}Filtrar</span><kbd>Esc</kbd></div><div class="list"></div><div class="ft"><span>↑ ↓ moverse · Enter abrir · Esc cerrar</span><span>Ctrl K abre y cierra</span></div>`);
    area.appendChild(ck);
    const q = ck.querySelector(".q"), list = ck.querySelector(".list");
    const why = (html) => { sc.querySelector(".p8why")?.remove(); const n = el("div", "p8why", html); n.style.top = (190 + ck.offsetHeight + 20) + "px"; sc.appendChild(n); };
    await p6wait(800);
    const clock = p6anim(1100, (e) => { big.textContent = p8fmt(4 * e); });
    await p8type(q, "lucia", 110); await clock;
    list.innerHTML = p8own("persona", "Lucía Torres", "Paciente", "+51 992 154 378", "Abrir ficha")
      + p8kid("dinero", "Debe", "Ortodoncia fija", "USD 420", 110)
      + p8kid("dinero", "Comprobante", "B001-000231", "USD 440 · 20 may", 220)
      + p8kid("documento", "Documento", "Radiografía panorámica", "12 mar", 330)
      + p8kid("cita", "Cita", "Evaluación con la Dra. Ana", "vie 16:30", 440)
      + `<div class="more" style="animation-delay:550ms"><span class="ln"></span>+ 3 más de Lucía Torres</div>`
      + p8own("persona", "Lucía Méndez", "Paciente", "+51 987 410 552", "", 650);
    why(`<b>sin tildes</b>«lucia» encuentra a «Lucía», y todo lo suyo aparece debajo de su nombre.`);
    for (const n of [...qs.children]) { await p6wait(260); n.remove(); }
    sc.querySelector(".ring").hidden = true;
    await p6wait(2200);
    say("¿Y cuánto cuesta una limpieza?");
    await p6wait(1400);
    list.innerHTML = ""; sc.querySelector(".p8why")?.remove();
    await p8type(q, "limpieza", 90);
    list.innerHTML = `<div class="grp">Por lo que quisiste decir</div>`
      + p8own("servicio", "Profilaxis", "Servicio", "USD 35", "Abrir")
      + p8own("respuesta", "¿Cada cuánto me hago una limpieza?", "Respuesta del agente", "La respuesta que da Sofi", "", 140)
      + `<div style="height:10px"></div>`
      + p8own("help", "Preguntarle a Ariadna: «limpieza»", "", "Responde con la guía del sistema", "", 280);
    why(`<b>por significado</b>No escribiste «Profilaxis». La encontró igual.`);
    await p6wait(2200); say("Perfecto, gracias.");
  };

  // 11 · Problema: el uso baja mes a mes y el cobro es el mismo; cada cuota cae en el total.
  scenes.p9prob = async () => {
    const sc = document.getElementById("p9scene");
    const M = [["Julio", "Mes normal", 72], ["Agosto", "Vacaciones, poca agenda", 28], ["Septiembre", "Una sede cerrada por obras", 34], ["Octubre", "Nadie usó el módulo nuevo", 12]];
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

  // 9 · Respuesta: cada módulo marca su precio como un taxímetro y se queda en cero; los dieciséis
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

  // 10 · Respuesta: interruptores.
  scenes.switches = (layer) => {
    const sws = [...layer.querySelectorAll(".sw")];
    sws.forEach(s => s.classList.remove("lit"));
    sws.forEach((s, i) => later(() => s.classList.add("lit"), 1000 + i * 380));
  };

  // 11 · El total del día que cuenta.
  // 11 · Cada cobro, con su moneda: los pasos se cumplen y recién ahí cae la moneda del agente.
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

  // 11 · Un día: solo las filas con resultado dejan moneda; cae en el total.
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

  // 11 · Lo que nunca se cobra: en cada fila asoma la moneda del agente, gira y se apaga; el total
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

  // 12 · El mismo caso: el software de registro frente a los agentes que orquestan.
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
    const AGS = { argos: ["Argos", "administración", C.amber, 0], sofi: ["Sofi", "recepción", C.sky, 1], clio: ["Clío", "clínica", C.mint, 2] };
    const W = box.offsetWidth || 740, gap = (W - 3 * 220) / 2;
    const nodes = {};
    for (const [k, [name, role, c, i]] of Object.entries(AGS)) {
      const n = el("div", "ag2", `<span class="glow2"></span><b>${name}</b><span>${role}</span>`); n.style.setProperty("--c", c); n.style.left = i * (220 + gap) + "px"; box.appendChild(n); nodes[k] = n;
    }
    const CASES = [
      ["Pedro", [["argos", "vio que no vino a su control"], ["sofi", "le escribió y agendó el jueves 17:30"], ["clio", "dejó lista su historia para la consulta"]]],
      ["Lucía", [["sofi", "contestó su mensaje de las 22:47 y la agendó"]]],
      ["Mario", [["clio", "propuso su nota; la Dra. Ana la confirmó"], ["argos", "dejó programado su control de 6 meses"]]],
      ["Rosa", [["argos", "vio su presupuesto sin respuesta"], ["sofi", "lo retomó y Rosa lo aceptó"]]],
      ["Ana", [["sofi", "movió su cita al lunes"]]],
      ["Jorge", [["argos", "vio un saldo pendiente"], ["sofi", "le envió el enlace de pago"]]],
      ["Elena", [["clio", "preparó su receta para firmar"]]],
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
  // 12 · ¿No es lo mismo que…? Columna por columna y, al final, la del producto entre corchetes.
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

  // 13 · Cifras que suben.
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
    idleT = setTimeout(() => { if (!stacked && (document.getElementById("notesPanel")?.hidden ?? true)) document.body.classList.add("idle"); }, 2500);
  };
  ["mousemove", "pointerdown", "keydown"].forEach(t => addEventListener(t, wake, { passive: true }));
  wake();
  document.getElementById("next").addEventListener("click", (e) => { e.stopPropagation(); next(); });
  document.getElementById("prev").addEventListener("click", (e) => { e.stopPropagation(); prev(); });
  const notesBtn = document.getElementById("notesBtn"), notesPanel = document.getElementById("notesPanel");
  const toggleNotes = () => { if (!notesPanel) return; notesPanel.hidden = !notesPanel.hidden; notesBtn.setAttribute("aria-pressed", String(!notesPanel.hidden)); };
  notesBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleNotes(); });
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

  // En la v2 la clínica se prepara con calma, para que no frene la primera vez que se llega a su parte.
  const clinicSlide = stage.querySelector(".slide.cl");
  if (clinicSlide) {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
    // Con tiempo máximo: mientras la portada se anima, el navegador puede no encontrar un momento libre.
    idle(() => {
      import("./clinic-3d.js").then((mod) => { clinic = mod; mod.prepare(clinicSlide); }).catch(() => clinicFlat(clinicSlide));
    }, { timeout: 2500 });
  }
})();
