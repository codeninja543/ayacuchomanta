import { Router } from "express";
import { supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { counterLimiter, ratingLimiter, requireUuidParam, cleanText, optionalUrl } from "../middleware/security.js";

const router = Router();

function normalizePlaceMetrics(place) {
  if (!place) return place;
  // eslint-disable-next-line no-unused-vars
  const { created_by, ...publicPlace } = place; // no exponer quién lo creó
  return {
    ...publicPlace,
    views: Number(place.views ?? 0) || 0,
    reservations: Number(place.reservations ?? place.reservation_count ?? place.bookings ?? 0) || 0,
    direction_clicks: Number(place.direction_clicks ?? place.directions_clicks ?? 0) || 0,
    // Si el lugar no tiene días configurados (null/undefined), asumimos que
    // atiende todos los días en vez de mostrarlo como "cerrado" siempre.
    open_days: Array.isArray(place.open_days) ? place.open_days : [0, 1, 2, 3, 4, 5, 6],
  };
}

async function incrementPlaceCounter(placeId, column) {
  // 1) Intento atómico vía RPC (evita condiciones de carrera)
  const { error: rpcError } = await supabaseMainAdmin.rpc("increment_place_counter", {
    p_place_id: placeId,
    p_column: column,
  });

  if (!rpcError) return true;

  const rpcMessage = String(rpcError?.message || "");
  const rpcMissing = rpcMessage.includes("does not exist") || rpcMessage.includes("Could not find");
  if (!rpcMissing) {
    console.warn(`⚠️ RPC increment_place_counter falló para ${column} en ${placeId}:`, rpcError.message);
  }

  // 2) Fallback: leer valor actual y escribir +1
  try {
    const { data, error: selectError } = await supabaseMainAdmin
      .from("places")
      .select(column)
      .eq("id", placeId)
      .maybeSingle();

    if (selectError) {
      console.error(`❌ La columna "${column}" no existe o no se pudo leer en "places":`, selectError.message);
      return false;
    }
    if (!data) {
      console.warn(`⚠️ No se encontró el lugar ${placeId} al incrementar ${column}`);
      return false;
    }

    const currentValue = Number(data[column] ?? 0) || 0;
    const { error: updateError } = await supabaseMainAdmin
      .from("places")
      .update({ [column]: currentValue + 1 })
      .eq("id", placeId);

    if (updateError) {
      console.error(`❌ No se pudo actualizar "${column}" para el lugar ${placeId}:`, updateError.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`❌ Error inesperado al incrementar "${column}" en el lugar ${placeId}:`, err);
    return false;
  }
}

// ──────────────────────────────────────────────
// Validación de los datos que llegan del panel (crear / editar lugar)
// ──────────────────────────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function buildPlacePayload(body) {
  const b = body || {};
  const name = cleanText(b.name, 120);
  const category = cleanText(b.category, 40);
  const description = cleanText(b.description, 2000);
  const address = cleanText(b.address, 200);
  if (!name || !category || !description || !address || !b.photo_url_1) {
    throw new Error("Campos obligatorios: nombre, categoría, descripción, dirección y foto principal");
  }
  if (!/^[a-z0-9_]+$/i.test(category)) throw new Error("Categoría no válida");

  const time = (v) => { const t = cleanText(v, 5); return t && TIME_RE.test(t) ? t : null; };
  const days = Array.isArray(b.open_days)
    ? [...new Set(b.open_days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [0, 1, 2, 3, 4, 5, 6];

  return {
    name, category, description, address,
    website: optionalUrl(b.website, "Sitio web", 500),
    facebook: optionalUrl(b.facebook, "Facebook", 300),
    instagram: optionalUrl(b.instagram, "Instagram", 300),
    tiktok: optionalUrl(b.tiktok, "TikTok", 300),
    phone: cleanText(b.phone, 30),
    delivery_phone: cleanText(b.delivery_phone, 30),
    photo_url_1: optionalUrl(b.photo_url_1, "Foto principal", 1000, { allowRelative: true }),
    photo_url_2: optionalUrl(b.photo_url_2, "Foto 2", 1000, { allowRelative: true }),
    photo_url_3: optionalUrl(b.photo_url_3, "Foto 3", 1000, { allowRelative: true }),
    promotion: cleanText(b.promotion, 300),
    how_to_get_there: cleanText(b.how_to_get_there, 1000),
    map_url: optionalUrl(b.map_url, "Google Maps", 1000),
    opening_hours: cleanText(b.opening_hours, 200),
    opens_at: time(b.opens_at),
    closes_at: time(b.closes_at),
    open_days: days,
    rating: Math.max(0, Math.min(5, parseFloat(b.rating) || 0)),
  };
}

// ──────────────────────────────────────────────
// Rotación diaria por turnos (round-robin)
//
// Cada 24 horas, un negocio distinto pasa a ser el primero de la lista.
// No usa azar: es un desplazamiento (rotate) determinista basado en
// cuántos días han pasado desde una fecha de referencia fija, así que
// es reproducible y justo — con el tiempo todos los negocios tienen su
// turno de aparecer primero.
// ──────────────────────────────────────────────
const ROTATION_EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getDailyRotationOffset(totalItems) {
  if (!totalItems || totalItems <= 0) return 0;
  const daysSinceEpoch = Math.floor((Date.now() - ROTATION_EPOCH) / ONE_DAY_MS);
  return daysSinceEpoch % totalItems;
}

/** Rota el array de modo que el elemento en `offset` pase a ser el primero. */
function applyDailyRotation(items) {
  try {
    const offset = getDailyRotationOffset(items.length);
    if (offset === 0) return items;
    return [...items.slice(offset), ...items.slice(0, offset)];
  } catch (e) {
    // Si algo falla en la rotación, nunca debe tumbar el endpoint:
    // devolvemos el orden original sin rotar.
    console.error("⚠️ Error en applyDailyRotation, usando orden sin rotar:", e);
    return items;
  }
}

// ──────────────────────────────────────────────
// GET /api/places
// Parámetros opcionales: category (string), limit (number, máx 100)
// ──────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const category = typeof req.query.category === "string" ? req.query.category.slice(0, 40) : "";
    const safeLimit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 100));

    let query = supabaseMainAdmin
      .from("places")
      .select("*")
      .order("created_at", { ascending: true });

    if (category && category !== "all") {
      if (category === "__otros__") {
               const main = [
          "hotel", "hospedajes", "grass_sintetico", "tour_ayacucho",
          "pizzas_karaoke", "pizzas", "karaoke", "cafe", "discotecas",
          "tabernas", "cevicherias", "bares", "heladerias",
          "recreo", "pasteleria", "hamburguesas", "antojitos",
          "jugueteria", "flores",
        ];
        query = query.not("category", "in", `(${main.join(",")})`);
      } else {
        query = query.eq("category", category);
      }
    }

    const { data, error } = await query;
    if (error) {
      console.error("❌ Error consultando places en GET /api/places:", error);
      throw error;
    }

    const rotated = applyDailyRotation((data ?? []).map(normalizePlaceMetrics));
    res.json(rotated.slice(0, safeLimit));
  } catch (err) {
    console.error("❌ GET /api/places falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// GET /api/places/featured
// 8 lugares para el carousel, con la misma rotación diaria que el grid
// ──────────────────────────────────────────────
router.get("/featured", async (_req, res) => {
  try {
    const { data, error } = await supabaseMainAdmin
      .from("places")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("❌ Error consultando places en GET /api/places/featured:", error);
      throw error;
    }

    const rotated = applyDailyRotation((data ?? []).map(normalizePlaceMetrics));
    res.json(rotated.slice(0, 8));
  } catch (err) {
    console.error("❌ GET /api/places/featured falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// POST /api/places/:id/reserve
// Incrementa el contador de reservas del negocio
// ──────────────────────────────────────────────
router.post("/:id/reserve", counterLimiter, requireUuidParam, async (req, res) => {
  try {
    const { id } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(404).json({ error: "Lugar no encontrado" });
    }

    const ok = await incrementPlaceCounter(id, "reservations");
    if (!ok) {
      return res.status(500).json({
        success: false,
        error: "No se pudo registrar la reserva. Verifica que la tabla 'places' tenga la columna 'reservations' (ver backend/sql/counters.sql).",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ POST /api/places/:id/reserve falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// POST /api/places/:id/directions
// Incrementa el contador de clics en "Cómo llegar"
// ──────────────────────────────────────────────
router.post("/:id/directions", counterLimiter, requireUuidParam, async (req, res) => {
  try {
    const { id } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(404).json({ error: "Lugar no encontrado" });
    }

    const ok = await incrementPlaceCounter(id, "direction_clicks");
    if (!ok) {
      return res.status(500).json({
        success: false,
        error: "No se pudo registrar el clic en 'Cómo llegar'. Verifica que la tabla 'places' tenga la columna 'direction_clicks' (ver backend/sql/counters.sql).",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ POST /api/places/:id/directions falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// POST /api/places/:id/rate
// Guarda una calificación de 1 a 5 y actualiza el promedio
// ──────────────────────────────────────────────
router.post("/:id/rate", ratingLimiter, requireUuidParam, async (req, res) => {
  try {
    if (!supabaseMainAdmin) {
      console.error("❌ POST /:id/rate: supabaseMainAdmin es null — falta SUPABASE_SERVICE_ROLE_KEY_MAIN en las variables de entorno del backend.");
      return res.status(500).json({ error: "El servidor no está configurado correctamente para guardar calificaciones. Falta SUPABASE_SERVICE_ROLE_KEY_MAIN." });
    }

    const { id } = req.params;
    const { rating } = req.body ?? {};
    const numericRating = Number(rating);

    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: "La calificación debe estar entre 1 y 5" });
    }

    const safeRating = Math.max(1, Math.min(5, Math.round(numericRating)));

    const { error: insertError } = await supabaseMainAdmin
      .from("place_ratings")
      .insert({ place_id: id, rating: safeRating });

    if (insertError) {
      console.error("❌ No se pudo guardar en place_ratings (¿falta crear la tabla en Supabase?):", insertError.message);
      return res.status(500).json({
        error: "No se pudo guardar tu calificación. Falta configurar la tabla 'place_ratings' en la base de datos.",
      });
    }

    const { data: rows, error: rowsError } = await supabaseMainAdmin
      .from("place_ratings")
      .select("rating")
      .eq("place_id", id);

    if (rowsError) throw rowsError;

    const values = (rows ?? []).map(item => Number(item.rating) || 0).filter(Boolean);
    const average = values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : safeRating;

    const { error: updateError } = await supabaseMainAdmin
      .from("places")
      .update({ rating: average, rating_count: values.length })
      .eq("id", id);

    if (updateError) throw updateError;

    res.json({ rating: average, rating_count: values.length });
  } catch (err) {
    console.error("❌ POST /api/places/:id/rate falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// GET /api/places/:id
// Detalle completo + lugares relacionados
// ──────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(404).json({ error: "Lugar no encontrado" });
    }

    const { data: place, error } = await supabaseMainAdmin
      .from("places")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("Error fetching place:", id, error.message);
      throw error;
    }
    if (!place) {
      console.warn("Place not found for id:", id);
      return res.status(404).json({ error: "Lugar no encontrado" });
    }

    const nextViews = (Number(place.views ?? 0) || 0) + 1;
    const viewsOk = await incrementPlaceCounter(id, "views");
    if (!viewsOk) {
      console.error(`❌ No se pudo incrementar "views" para el lugar ${id}. Verifica que la columna exista (ver backend/sql/counters.sql).`);
    }

    const { data: related } = await supabaseMainAdmin
      .from("places")
      .select("*")
      .eq("category", place.category)
      .neq("id", id)
      .order("rating", { ascending: false })
      .limit(6);

    res.json({
      place: normalizePlaceMetrics({ ...place, views: nextViews }),
      related: (related ?? []).map(normalizePlaceMetrics),
    });
  } catch (err) {
    console.error("❌ GET /api/places/:id falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// POST /api/places  (solo admin)
// ──────────────────────────────────────────────
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    let payload;
    try { payload = buildPlacePayload(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    payload.created_by = req.user?.id ?? null;

    const { data, error } = await supabaseMainAdmin
      .from("places")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(normalizePlaceMetrics(data));
  } catch (err) {
    console.error("❌ POST /api/places falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// PUT /api/places/:id  (solo admin)
// ──────────────────────────────────────────────
router.put("/:id", requireUuidParam, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let payload;
    try { payload = buildPlacePayload(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { data, error } = await supabaseMainAdmin
      .from("places")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json(normalizePlaceMetrics(data));
  } catch (err) {
    console.error("❌ PUT /api/places/:id falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ──────────────────────────────────────────────
// DELETE /api/places/:id  (solo admin)
// ──────────────────────────────────────────────
router.delete("/:id", requireUuidParam, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabaseMainAdmin
      .from("places")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE /api/places/:id falló:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;