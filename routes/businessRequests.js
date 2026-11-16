import { Router } from "express";
import { supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

const ALLOWED_CATEGORIES = [
  "hotel", "hospedajes", "grass_sintetico", "tour_ayacucho",
  "pizzas_karaoke", "pizzas", "karaoke", "cafe", "discotecas", "tabernas",
  "cevicherias", "bares", "heladerias", "pasteleria", "hamburguesas",
  "antojitos", "jugueteria", "flores", "recreo", "otros",
];

const clean = (v, max = 500) =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

// Rate limit simple en memoria: 5 solicitudes por hora por IP
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= 5) {
    return res.status(429).json({ error: "Demasiadas solicitudes. Intenta más tarde o usa el botón de Soporte." });
  }
  recent.push(now);
  hits.set(ip, recent);
  next();
}

// ──────────────────────────────────────────────
// POST /api/business-requests   (requiere iniciar sesión)
// Un dueño envía los datos de su negocio para publicarlo.
// ──────────────────────────────────────────────
const social = (v) => {
  const s = clean(v, 300);
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
};

router.post("/", requireAuth, rateLimit, async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot anti-bots: si viene lleno, fingimos éxito
    if (b.website_hp) return res.status(201).json({ ok: true });

    const payload = {
      business_name: clean(b.business_name, 120),
      category: clean(b.category, 40),
      description: clean(b.description, 1000),
      address: clean(b.address, 200),
      owner_name: clean(b.owner_name, 120),
      phone: clean(b.phone, 30),
      email: clean(b.email, 120) || null,
      opening_hours: clean(b.opening_hours, 200) || null,
      website: clean(b.website, 200) || null,
      facebook: social(b.facebook),
      instagram: social(b.instagram),
      tiktok: social(b.tiktok),
      user_id: req.user?.id ?? null,
      user_email: req.user?.email ?? null,
      map_url: clean(b.map_url, 500) || null,
      photo_urls: Array.isArray(b.photo_urls)
        ? b.photo_urls.map((u) => clean(u, 500)).filter((u) => /^https?:\/\//i.test(u)).slice(0, 3)
        : [],
      status: "pendiente",
    };

    const missing = ["business_name", "category", "description", "address", "owner_name", "phone"]
      .filter((k) => !payload[k]);
    if (missing.length) {
      return res.status(400).json({ error: "Faltan campos obligatorios: " + missing.join(", ") });
    }
    if (!ALLOWED_CATEGORIES.includes(payload.category)) {
      return res.status(400).json({ error: "Categoría no válida" });
    }
    if (!/^[+\d][\d\s-]{6,}$/.test(payload.phone)) {
      return res.status(400).json({ error: "Teléfono / WhatsApp no válido" });
    }
    if (!supabaseMainAdmin) {
      return res.status(503).json({ error: "Servicio no disponible por ahora" });
    }

    const { error } = await supabaseMainAdmin.from("business_requests").insert(payload);
    if (error) {
      console.error("❌ POST /api/business-requests:", error);
      return res.status(500).json({ error: "No se pudo guardar la solicitud. Usa el botón de Soporte." });
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("❌ POST /api/business-requests falló:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ──────────────────────────────────────────────
// GET /api/business-requests   (solo admin)
// ──────────────────────────────────────────────
router.get("/", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseMainAdmin
      .from("business_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// PATCH /api/business-requests/:id   (solo admin) — cambiar estado
// ──────────────────────────────────────────────
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = clean(req.body?.status, 20);
    if (!["pendiente", "aprobado", "rechazado"].includes(status)) {
      return res.status(400).json({ error: "Estado no válido" });
    }
    const { error } = await supabaseMainAdmin
      .from("business_requests").update({ status }).eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
