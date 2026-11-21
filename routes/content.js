
import { Router } from "express";
import { supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { requireUuidParam, isSafeHttpUrl, isSafeRelativePath, cleanText } from "../middleware/security.js";

// ── Validadores de campos ──────────────────────────────────────────
const T = {
  text:  (max = 200) => ({ parse: v => { if (typeof v !== "string" && typeof v !== "number") throw "Dato inválido"; return cleanText(v, max); } }),
  image: () => ({ parse: v => { const s = String(v).trim(); if (!isSafeHttpUrl(s)) throw "El enlace de la foto debe empezar con https://"; return s.slice(0, 1000); } }),
  // Enlace: https://… o ruta interna "/buses" (nunca "//otro-sitio" ni "javascript:")
  link:  () => ({ parse: v => { const s = String(v).trim(); if (!isSafeHttpUrl(s) && !isSafeRelativePath(s)) throw "El enlace debe empezar con https:// o /"; return s.slice(0, 500); } }),
  date:  () => ({ parse: v => { const s = String(v).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw "Fecha inválida (AAAA-MM-DD)"; return s; } }),
  int:   () => ({ parse: v => Math.max(-9999, Math.min(9999, Math.trunc(Number(v) || 0))) }),
  oneOf: (values) => ({ parse: v => { if (!values.includes(v)) throw `Valor no permitido: ${v}`; return v; } }),
};

// ── Fábrica de rutas CRUD ──────────────────────────────────────────
// Errores de "falta la columna X" (si aún no se ejecutó el SQL nuevo)
const missingColumn = (error, col) => {
  const m = String(error?.message || "");
  return m.includes(col) && /column|schema cache|does not exist/i.test(m);
};

function crudRouter({ table, label, fields, required, order, prepare, expires, extraCleanup }) {
  const router = Router();
  const missing = res => res.status(503).json({ error: "Supabase no está configurado (falta SUPABASE_SERVICE_ROLE_KEY_MAIN)" });
  const dbError = (res, error) => {
    const msg = String(error?.message || "");
    if (msg.includes("does not exist") || msg.includes("Could not find the table")) {
      return res.status(500).json({ error: `Falta la tabla '${table}' en Supabase. Ejecuta el SQL de la carpeta database/.` });
    }
    console.error(`❌ ${table}:`, msg);
    return res.status(500).json({ error: "Error de base de datos" });
  };
  const sorted = q => order.reduce((acc, [col, asc]) => acc.order(col, { ascending: asc }), q);

  // Limpia y valida lo que llega del panel
  function parseBody(body, isNew) {
    const out = {};
    for (const [key, f] of Object.entries(fields)) {
      if (!(key in body)) continue;
      const raw = body[key];
      out[key] = raw === null || raw === undefined || String(raw).trim() === "" ? null : f.parse(raw);
    }
    if (typeof body.active === "boolean") out.active = body.active;
    if (prepare) Object.assign(out, prepare(body, isNew));
    for (const key of required) {
      if ((isNew && out[key] == null) || (key in out && out[key] == null)) throw `Falta: ${key === "image_url" ? "enlace de la foto" : key}`;
    }
    return out;
  }

  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!supabaseMainAdmin) return res.json([]);
    if (expires) cleanupExpired(); // borra los vencidos (como máximo cada 10 min)
    let q = supabaseMainAdmin.from(table).select("*").eq("active", true);
    if (expires) q = q.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    let { data, error } = await sorted(q);
    if (error && expires && missingColumn(error, "expires_at")) {
      ({ data, error } = await sorted(supabaseMainAdmin.from(table).select("*").eq("active", true)));
    }
    if (error) { console.warn(`⚠️ GET /api/${table}:`, error.message); return res.json([]); }
    res.json(data ?? []);
  });

  router.get("/all", requireAuth, requireAdmin, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!supabaseMainAdmin) return missing(res);
    if (expires) await cleanupExpired(true);
    const { data, error } = await sorted(supabaseMainAdmin.from(table).select("*"));
    if (error) return dbError(res, error);
    res.json(data ?? []);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    let row;
    try { row = parseBody(req.body ?? {}, true); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    let { data, error } = await supabaseMainAdmin.from(table).insert({ ...row, active: row.active ?? true }).select("*").single();
    if (error && expires && missingColumn(error, "expires_at")) {
      // eslint-disable-next-line no-unused-vars
      const { expires_at, ...rest } = row;
      ({ data, error } = await supabaseMainAdmin.from(table).insert({ ...rest, active: rest.active ?? true }).select("*").single());
    }
    if (error) return dbError(res, error);
    res.status(201).json(data);
  });

  router.patch("/:id", requireUuidParam, requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    let patch;
    try { patch = parseBody(req.body ?? {}, false); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No hay cambios" });
    let { data, error } = await supabaseMainAdmin.from(table).update(patch).eq("id", req.params.id).select("*").maybeSingle();
    if (error && expires && missingColumn(error, "expires_at")) {
      // eslint-disable-next-line no-unused-vars
      const { expires_at, ...rest } = patch;
      if (!Object.keys(rest).length) return res.status(400).json({ error: "Para usar la duración ejecuta database/anuncios-duracion.sql" });
      ({ data, error } = await supabaseMainAdmin.from(table).update(rest).eq("id", req.params.id).select("*").maybeSingle());
    }
    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: `${label} no encontrado` });
    res.json(data);
  });

  router.delete("/:id", requireUuidParam, requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    const { data, error } = await supabaseMainAdmin.from(table).delete().eq("id", req.params.id).select("id");
    if (error) return dbError(res, error);
    if (!data?.length) return res.status(404).json({ error: `${label} no encontrado` });
    res.json({ success: true });
  });

  // ── Eliminación automática de los vencidos ──
  let lastCleanup = 0;
  async function cleanupExpired(force = false) {
    if (!expires || !supabaseMainAdmin) return;
    const now = Date.now();
    if (!force && now - lastCleanup < 10 * 60 * 1000) return;
    lastCleanup = now;
    const { data, error } = await supabaseMainAdmin.from(table).delete()
      .lt("expires_at", new Date(now).toISOString()).select("id");
    if (error) { if (!missingColumn(error, "expires_at")) console.warn(`⚠️ limpieza ${table}:`, error.message); }
    else if (data?.length) console.log(`🧹 ${table}: ${data.length} vencido(s) eliminado(s)`);
    if (extraCleanup) {
      const r = await extraCleanup(supabaseMainAdmin.from(table).delete()).select("id");
      if (r.error) console.warn(`⚠️ limpieza ${table}:`, r.error.message);
      else if (r.data?.length) console.log(`🧹 ${table}: ${r.data.length} pasado(s) eliminado(s)`);
    }
  }
  if (expires) {
    // Revisa cada hora mientras el servidor está encendido
    setInterval(() => cleanupExpired(true), 60 * 60 * 1000).unref();
    setTimeout(() => cleanupExpired(true), 15 * 1000).unref();
  }

  return router;
}

/** Fecha AAAA-MM-DD en Perú (UTC-5), desplazada `offsetDays` días */
function limaDate(offsetDays = 0) {
  return new Date(Date.now() - 5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

// "duration_days" (del panel): 0 = sin límite · N = se elimina solo en N días
function durationToExpires(body) {
  if (!("duration_days" in body) || body.duration_days === null || body.duration_days === "") return {};
  const days = Number(body.duration_days);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw "La duración debe ser de 0 a 365 días";
  return { expires_at: days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString() };
}

// ── Anuncios ───────────────────────────────────────────────────────
export const adsRouter = crudRouter({
  table: "ads", label: "Anuncio",
  fields: {
    placement: T.oneOf(["carrusel", "destacado"]),
    title: T.text(120), place: T.text(80), note: T.text(60),
    link: T.link(), image_url: T.image(), sort_order: T.int(),
  },
  required: ["placement", "title", "image_url"],
  order: [["placement", true], ["sort_order", true], ["created_at", false]],
  expires: true,
  prepare: durationToExpires,
});

// ── Eventos ────────────────────────────────────────────────────────
export const eventsRouter = crudRouter({
  table: "events", label: "Evento",
  fields: {
    title: T.text(120), date: T.date(), time: T.text(30), place: T.text(120),
    description: T.text(300), image_url: T.image(), link: T.link(),
  },
  required: ["title", "date"],
  order: [["date", true], ["created_at", true]],
  expires: true,
  prepare: durationToExpires,
  // Se borra solo 1 día después de su fecha (hora de Perú):
  // un evento del 20 sigue el 21 y se borra al empezar el 22.
  extraCleanup: q => q.lt("date", limaDate(-1)),
});

// ── Buses ──────────────────────────────────────────────────────────
export const busesRouter = crudRouter({
  table: "buses", label: "Empresa de buses",
  fields: {
    name: T.text(80), description: T.text(300), price: T.text(40),
    features: T.text(200), image_url: T.image(), link: T.link(), sort_order: T.int(),
  },
  required: ["name"],
  order: [["sort_order", true], ["created_at", true]],
});