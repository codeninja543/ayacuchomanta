// ═══════════════════════════════════════════════════════════════════
//  CONTENIDO EDITABLE DESDE EL PANEL DE ADMINISTRADOR
//
//    /api/ads     → anuncios (carrusel grande + destacados)
//    /api/events  → eventos del banner del inicio
//    /api/buses   → empresas de buses Lima ⇄ Ayacucho
//
//  Cada uno tiene las mismas rutas:
//    GET    /            → público, solo los activos
//    GET    /all         → admin, todos
//    POST   /            → admin, crear
//    PATCH  /:id         → admin, editar / ocultar / mostrar
//    DELETE /:id         → admin, eliminar
//
//  Tablas: database/anuncios.sql y database/eventos-buses.sql
// ═══════════════════════════════════════════════════════════════════
import { Router } from "express";
import { supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

// ── Validadores de campos ──────────────────────────────────────────
const isHttp = v => /^https?:\/\/\S+$/i.test(v);
const T = {
  text:  (max = 200) => ({ parse: v => String(v).trim().slice(0, max) }),
  image: () => ({ parse: v => { const s = String(v).trim(); if (!isHttp(s)) throw "El enlace de la foto debe empezar con https://"; return s.slice(0, 1000); } }),
  link:  () => ({ parse: v => { const s = String(v).trim(); if (!isHttp(s) && !s.startsWith("/")) throw "El enlace debe empezar con https:// o /"; return s.slice(0, 500); } }),
  date:  () => ({ parse: v => { const s = String(v).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw "Fecha inválida (AAAA-MM-DD)"; return s; } }),
  int:   () => ({ parse: v => Math.trunc(Number(v) || 0) }),
  oneOf: (values) => ({ parse: v => { if (!values.includes(v)) throw `Valor no permitido: ${v}`; return v; } }),
};

// ── Fábrica de rutas CRUD ──────────────────────────────────────────
function crudRouter({ table, label, fields, required, order }) {
  const router = Router();
  const missing = res => res.status(503).json({ error: "Supabase no está configurado (falta SUPABASE_SERVICE_ROLE_KEY_MAIN)" });
  const dbError = (res, error) => {
    const msg = String(error?.message || "");
    if (msg.includes("does not exist") || msg.includes("Could not find the table")) {
      return res.status(500).json({ error: `Falta la tabla '${table}' en Supabase. Ejecuta el SQL de la carpeta database/.` });
    }
    return res.status(500).json({ error: msg || "Error de base de datos" });
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
    for (const key of required) {
      if ((isNew && out[key] == null) || (key in out && out[key] == null)) throw `Falta: ${key === "image_url" ? "enlace de la foto" : key}`;
    }
    return out;
  }

  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!supabaseMainAdmin) return res.json([]);
    const { data, error } = await sorted(supabaseMainAdmin.from(table).select("*").eq("active", true));
    if (error) { console.warn(`⚠️ GET /api/${table}:`, error.message); return res.json([]); }
    res.json(data ?? []);
  });

  router.get("/all", requireAuth, requireAdmin, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!supabaseMainAdmin) return missing(res);
    const { data, error } = await sorted(supabaseMainAdmin.from(table).select("*"));
    if (error) return dbError(res, error);
    res.json(data ?? []);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    let row;
    try { row = parseBody(req.body ?? {}, true); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    const { data, error } = await supabaseMainAdmin.from(table).insert({ ...row, active: row.active ?? true }).select("*").single();
    if (error) return dbError(res, error);
    res.status(201).json(data);
  });

  router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    let patch;
    try { patch = parseBody(req.body ?? {}, false); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No hay cambios" });
    const { data, error } = await supabaseMainAdmin.from(table).update(patch).eq("id", req.params.id).select("*").maybeSingle();
    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: `${label} no encontrado` });
    res.json(data);
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseMainAdmin) return missing(res);
    const { data, error } = await supabaseMainAdmin.from(table).delete().eq("id", req.params.id).select("id");
    if (error) return dbError(res, error);
    if (!data?.length) return res.status(404).json({ error: `${label} no encontrado` });
    res.json({ success: true });
  });

  return router;
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
