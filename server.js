import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

import placesRouter from "./routes/places.js";
import authRouter from "./routes/auth.js";
import businessRequestsRouter from "./routes/businessRequests.js";
import { adsRouter, eventsRouter, busesRouter } from "./routes/content.js";
import settingsRouter from "./routes/settings.js";
import { apiLimiter } from "./middleware/security.js";

const app = express();
const PORT = process.env.PORT || 3001;
// Render pone RENDER=true automáticamente
const isProd = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

// Render está detrás de 1 proxy: así se usa la IP real del visitante (límites por IP)
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── HTTPS obligatorio en producción ────────────
app.use((req, res, next) => {
  if (isProd && req.headers["x-forwarded-proto"] === "http") {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// ── Cabeceras de seguridad (HSTS, nosniff, anti-clickjacking, CSP…) ──
app.use(helmet({
  contentSecurityPolicy: false,                       // se pone abajo, solo para /api
  crossOriginResourcePolicy: { policy: "cross-origin" }, // la página (otro dominio) puede leer la API
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: "deny" },
}));
app.use("/api", (_req, res, next) => {
  // La API solo devuelve JSON: no debe ejecutar nada ni mostrarse dentro de otra página
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.set("Cache-Control", res.get("Cache-Control") || "no-store");
  next();
});

// ── CORS: solo tu página puede usar este backend ──
// En Render pon FRONTEND_URL con la dirección de tu página (puedes poner varias separadas por coma).
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean),
  ...(isProd ? [] : ["http://localhost:5173", "http://localhost:4173"]),
];
app.use(cors({
  origin: (origin, cb) => {
    // Sin "origin" = llamadas directas (navegador al abrir /api/health, Render, etc.)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: "200kb", strict: true }));

// ── Límite general de solicitudes por IP ──
app.use("/api", apiLimiter);

// ── API ────────────────────────────────────────
app.use("/api/places", placesRouter);
app.use("/api/auth", authRouter);
app.use("/api/business-requests", businessRequestsRouter);
app.use("/api/ads", adsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/buses", busesRouter);
app.use("/api/settings", settingsRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ── Diagnóstico — confirma si las variables de entorno están bien
// cargadas, sin exponer las claves secretas. Visita /api/diagnostico
// en el navegador (local o producción) para verlo.
app.get("/api/diagnostico", (_req, res) => {
  res.json({
    SUPABASE_URL_MAIN: process.env.SUPABASE_URL_MAIN ? "✅ definida" : "❌ FALTA",
    SUPABASE_ANON_KEY_MAIN: process.env.SUPABASE_ANON_KEY_MAIN ? "✅ definida" : "❌ FALTA",
    SUPABASE_SERVICE_ROLE_KEY_MAIN: process.env.SUPABASE_SERVICE_ROLE_KEY_MAIN ? "✅ definida" : "❌ FALTA",
  });
});

// ── Servir el frontend ya compilado (producción) ───────────────────────
// Soporta dos ubicaciones posibles de "dist" según cómo esté armado el
// repo: backend/dist (si el build se copia ahí) o ../frontend/dist
// (si el repo tiene carpetas frontend/ y backend/ separadas, como en
// este proyecto). Usa la primera que exista; si ninguna existe (por
// ejemplo en desarrollo local, donde el frontend corre con Vite en
// otro puerto), simplemente no sirve estáticos y deja que las rutas
// /api/* sigan funcionando igual.
const candidateDistPaths = [
  path.join(__dirname, "dist"),
  path.join(__dirname, "..", "frontend", "dist"),
];
const distPath = candidateDistPaths.find((p) => fs.existsSync(p));

if (distPath) {
  console.log(`📦 Sirviendo frontend estático desde: ${distPath}`);
  app.use(express.static(distPath));

  // Cualquier ruta que no sea /api/* devuelve index.html (React Router)
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  console.warn("⚠️  No se encontró carpeta dist del frontend — modo solo-API (normal en desarrollo con Vite aparte).");
}

// 404 catch-all (solo llega aquí si no hay dist, o si es una ruta /api/* inexistente)
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// ── Errores: nunca mostrar detalles internos al visitante ──
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Datos inválidos" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Los datos enviados son demasiado grandes" });
  console.error("❌ Error no controlado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

// ── Start ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});