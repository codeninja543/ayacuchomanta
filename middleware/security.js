// ═══════════════════════════════════════════════════════════════════
//  SEGURIDAD DEL BACKEND
//   - Límites de solicitudes por IP (fuerza bruta / abuso)
//   - Bloqueo temporal de una cuenta tras varios intentos fallidos
//   - Validadores reutilizables (UUID, URLs seguras, textos)
// ═══════════════════════════════════════════════════════════════════
import rateLimit from "express-rate-limit";

const json429 = (msg) => (_req, res) =>
  res.status(429).json({ error: msg || "Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo." });

const limiter = (windowMin, max, msg) =>
  rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: json429(msg),
  });

// ── Límites por IP ─────────────────────────────────────────────────
/** Todo /api: 600 solicitudes cada 15 min por IP (uso normal muy por debajo) */
export const apiLimiter = limiter(15, 600);
/** Iniciar sesión: 10 intentos cada 15 min por IP */
export const loginLimiter = limiter(15, 10, "Demasiados intentos de inicio de sesión. Espera 15 minutos.");
/** Crear cuenta: 5 por hora por IP */
export const signupLimiter = limiter(60, 5, "Demasiados registros desde esta conexión. Inténtalo más tarde.");
/** Recuperar contraseña: 5 por hora por IP */
export const passwordResetLimiter = limiter(60, 5, "Demasiadas solicitudes de recuperación. Inténtalo más tarde.");
/** Renovar sesión / Google: 60 cada 15 min por IP */
export const sessionLimiter = limiter(15, 60);
/** Contadores públicos (vistas de "cómo llegar", reservas): 60 cada 15 min por IP */
export const counterLimiter = limiter(15, 60);
/** Calificaciones: 10 por hora por IP */
export const ratingLimiter = limiter(60, 10, "Ya enviaste varias calificaciones. Inténtalo más tarde.");

// ── Bloqueo por cuenta (fuerza bruta distribuida en varias IPs) ────
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // email → { count, first, lockedUntil }

export function isAccountLocked(email) {
  const k = String(email || "").toLowerCase();
  const f = fails.get(k);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil > Date.now()) return Math.ceil((f.lockedUntil - Date.now()) / 60000);
  if (f.lockedUntil && f.lockedUntil <= Date.now()) fails.delete(k);
  return 0;
}

export function registerLoginFailure(email) {
  const k = String(email || "").toLowerCase();
  const now = Date.now();
  const f = fails.get(k);
  if (!f || now - f.first > LOCK_MS) { fails.set(k, { count: 1, first: now, lockedUntil: 0 }); return; }
  f.count += 1;
  if (f.count >= MAX_FAILS) f.lockedUntil = now + LOCK_MS;
}

export function clearLoginFailures(email) {
  fails.delete(String(email || "").toLowerCase());
}

// Limpieza periódica de memoria
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of fails) if (now - f.first > LOCK_MS && (!f.lockedUntil || f.lockedUntil < now)) fails.delete(k);
}, 10 * 60 * 1000).unref();

// ── Validadores ────────────────────────────────────────────────────
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Middleware: responde 404 si :id no es un UUID válido */
export function requireUuidParam(req, res, next) {
  if (!UUID_RE.test(String(req.params.id || ""))) return res.status(404).json({ error: "No encontrado" });
  next();
}

/** true si es un enlace http(s) válido (bloquea javascript:, data:, etc.) */
export function isSafeHttpUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v) || /\s/.test(v)) return false;
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

/** Texto seguro: string, sin caracteres de control, recortado al máximo */
export function cleanText(value, max = 500) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  // eslint-disable-next-line no-control-regex
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
  return s || null;
}

/** Ruta interna del sitio ("/img/foto.jpg"), sin "//" ni "\\" que lleven a otro dominio */
export function isSafeRelativePath(value) {
  return typeof value === "string" && /^\/(?![\/\\])[^\s]*$/.test(value.trim());
}

/** Enlace http(s) opcional: devuelve el enlace o null; lanza error si es inseguro */
export function optionalUrl(value, field, max = 1000, { allowRelative = false } = {}) {
  const s = cleanText(value, max);
  if (!s) return null;
  if (isSafeHttpUrl(s) || (allowRelative && isSafeRelativePath(s))) return s;
  throw new Error(`El enlace de "${field}" debe empezar con https://`);
}

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Contraseña fuerte: 8+ caracteres, con letras y números */
export function passwordProblem(pw) {
  if (typeof pw !== "string") return "Contraseña inválida";
  if (pw.length < 8) return "La contraseña debe tener al menos 8 caracteres";
  if (pw.length > 72) return "La contraseña es demasiado larga (máximo 72 caracteres)";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "La contraseña debe tener letras y números";
  return "";
}