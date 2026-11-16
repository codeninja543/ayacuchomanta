// ═══════════════════════════════════════════════════════════════════
//  /api/settings — Ajustes del sitio que se cambian desde el panel
//
//    GET /api/settings/menu_buses   → público: ["Cruz del Sur", ...]
//    PUT /api/settings/menu_buses   → admin:   { value: ["...", "...", "...", "..."] }
//    GET /api/settings/hero_fotos   → público: ["https://...jpg", ...]
//    PUT /api/settings/hero_fotos   → admin:   { value: ["https://...", ...] } (máx. 3)
//
//  Tabla: database/menu-buses.sql
// ═══════════════════════════════════════════════════════════════════
import { Router } from "express";
import { supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// Ajustes permitidos y cómo se validan
const SETTINGS = {
  // Fotos de fondo de la portada (hasta 3 enlaces https://)
  hero_fotos: {
    fallback: [],
    parse: (v) => {
      if (!Array.isArray(v)) throw "Debe ser una lista de enlaces";
      const urls = v.map((x) => String(x ?? "").trim()).filter(Boolean);
      if (urls.length > 3) throw "Máximo 3 fotos en la portada";
      const bad = urls.find((u) => !/^https?:\/\/\S+$/i.test(u) || u.length > 1000);
      if (bad) throw "Cada foto debe ser un enlace que empiece con https://";
      return urls;
    },
  },
  menu_buses: {
    fallback: [],
    parse: (v) => {
      if (!Array.isArray(v)) throw "Debe ser una lista de nombres";
      const names = v.map((x) => String(x ?? "").trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean);
      if (names.length > 4) throw "Máximo 4 empresas en el menú";
      return names;
    },
  },
};

router.get("/:key", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const def = SETTINGS[req.params.key];
  if (!def) return res.status(404).json({ error: "Ajuste no encontrado" });
  if (!supabaseMainAdmin) return res.json({ value: def.fallback });
  const { data, error } = await supabaseMainAdmin
    .from("site_settings").select("value").eq("key", req.params.key).maybeSingle();
  if (error) {
    console.warn(`⚠️ GET /api/settings/${req.params.key}:`, error.message);
    return res.json({ value: def.fallback });
  }
  res.json({ value: data?.value ?? def.fallback });
});

router.put("/:key", requireAuth, requireAdmin, async (req, res) => {
  const def = SETTINGS[req.params.key];
  if (!def) return res.status(404).json({ error: "Ajuste no encontrado" });
  if (!supabaseMainAdmin) return res.status(503).json({ error: "Supabase no está configurado" });
  let value;
  try { value = def.parse(req.body?.value); } catch (msg) { return res.status(400).json({ error: String(msg) }); }
  const { error } = await supabaseMainAdmin
    .from("site_settings")
    .upsert({ key: req.params.key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) {
    const m = String(error.message || "");
    return res.status(500).json({ error: m.includes("does not exist") || m.includes("Could not find")
      ? "Falta la tabla 'site_settings'. Ejecuta database/menu-buses.sql en Supabase."
      : m });
  }
  res.json({ value });
});

export default router;