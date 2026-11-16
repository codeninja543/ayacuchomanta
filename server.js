import dotenv from "dotenv";
import express from "express";
import cors from "cors";
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

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middlewares ────────────────────────────────
app.use(cors({
  origin: "*",
  credentials: false,
}));
app.use(express.json());

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

app.get("/api/diagnostico", (_req, res) => {
  res.json({
    SUPABASE_URL_MAIN: process.env.SUPABASE_URL_MAIN ? "✅ definida" : "❌ FALTA",
    SUPABASE_ANON_KEY_MAIN: process.env.SUPABASE_ANON_KEY_MAIN ? "✅ definida" : "❌ FALTA",
    SUPABASE_SERVICE_ROLE_KEY_MAIN: process.env.SUPABASE_SERVICE_ROLE_KEY_MAIN ? "✅ definida" : "❌ FALTA",
  });
});

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

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});


app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});