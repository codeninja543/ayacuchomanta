import "dotenv/config";
import { Router } from "express";
import { supabaseMain, supabaseMainAdmin } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  loginLimiter, signupLimiter, passwordResetLimiter, sessionLimiter,
  isAccountLocked, registerLoginFailure, clearLoginFailures,
  isEmail, passwordProblem, cleanText,
} from "../middleware/security.js";

const router = Router();

function hasAdminRole(value) {
  return typeof value === "string" && /admin/i.test(value);
}

function isMissingTableError(error) {
  const msg = error?.message?.toString?.().toLowerCase?.() ?? "";
  return msg.includes("relation \"user_roles\" does not exist")
    || msg.includes("relation \"profiles\" does not exist")
    || msg.includes("table \"user_roles\" does not exist")
    || msg.includes("table \"profiles\" does not exist")
    || msg.includes("could not find the table");
}

async function getProfileRole(userId) {
  try {
    const client = supabaseMainAdmin || supabaseMain;
    const { data, error } = await client
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) {
        console.warn("⚠️  getProfileRole: tabla profiles no existe, usando fallback");
        return null;
      }
      console.warn("⚠️  getProfileRole error:", error.message);
      return null;
    }

    if (data?.role) {
      return data.role;
    }

    const { error: insertError } = await client.from("profiles").insert({ id: userId, role: "user" });
    if (insertError && !/duplicate key|already exists|23505/i.test(insertError.message || "")) {
      console.warn("⚠️  No se pudo crear el perfil del usuario:", insertError.message);
    }

    return null;
  } catch (err) {
    console.warn("⚠️  getProfileRole failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function checkIsAdmin(userId, user = null) {
  try {
    const profileRole = await getProfileRole(userId);
    if (hasAdminRole(profileRole)) {
      return true;
    }

    const client = supabaseMainAdmin || supabaseMain;
    const byId = await client
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .ilike("role", "%admin%")
      .maybeSingle();

    if (byId.error) {
      console.warn("⚠️  checkIsAdmin error by user_id:", byId.error.message);
    }
    if (byId.data) return true;

    // SEGURIDAD: solo app_metadata (lo cambia el servidor). user_metadata lo puede editar el usuario.
    const appRole = user?.app_metadata?.role;
    if (hasAdminRole(appRole)) return true;
    const appRoles = user?.app_metadata?.roles;
    if (Array.isArray(appRoles) && appRoles.some((role) => hasAdminRole(role))) return true;

    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    // Por correo: solo con el correo verificado
    if (user?.email && user?.email_confirmed_at && adminEmails.includes(user.email.toLowerCase())) {
      return true;
    }

    return false;
  } catch (err) {
    console.warn("⚠️  checkIsAdmin failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

router.post("/signup", signupLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = req.body?.password;
    const full_name = cleanText(req.body?.full_name, 120);
    if (!isEmail(email)) return res.status(400).json({ error: "Escribe un correo válido" });
    const pwProblem = passwordProblem(password);
    if (pwProblem) return res.status(400).json({ error: pwProblem });

    // Solo se guarda el nombre: nunca datos de rol que vengan del navegador
    const { data, error } = await supabaseMain.auth.signUp({ email, password, options: { data: { full_name } } });
    if (error) {
      console.warn("⚠️ signup:", error.message);
      // Mensaje genérico: no revela si el correo ya existe
      return res.status(400).json({ error: "No se pudo crear la cuenta. Revisa los datos o inicia sesión." });
    }

    if (data.user?.id) {
      const client = supabaseMainAdmin || supabaseMain;
      try {
        await client.from("profiles").upsert({ id: data.user.id, role: "user" }, { onConflict: "id", ignoreDuplicates: true });
      } catch (upsertErr) {
        console.warn("⚠️  No se pudo inicializar el perfil del usuario:", upsertErr instanceof Error ? upsertErr.message : upsertErr);
      }
    }

    res.status(201).json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("❌ signup:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "No se pudo crear la cuenta" });
  }
});

router.post("/signin", loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = req.body?.password;
    if (!isEmail(email) || typeof password !== "string" || !password || password.length > 200) {
      return res.status(400).json({ error: "Escribe tu correo y contraseña" });
    }

    // Bloqueo temporal de la cuenta tras 5 intentos fallidos
    const lockedMin = isAccountLocked(email);
    if (lockedMin) {
      return res.status(429).json({ error: `Demasiados intentos fallidos. Inténtalo en ${lockedMin} min.` });
    }

    const { data, error } = await supabaseMain.auth.signInWithPassword({ email, password });
    if (error || !data?.user) {
      registerLoginFailure(email);
      // Mensaje genérico: no revela si el correo existe
      return res.status(401).json({ error: "Correo o contraseña incorrectos" });
    }
    clearLoginFailures(email);

    const profileRole = await getProfileRole(data.user.id);
    const isAdmin = await checkIsAdmin(data.user.id, data.user);
    res.json({ user: data.user, session: data.session, isAdmin, role: profileRole });
  } catch (err) {
    console.error("❌ signin:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "No se pudo iniciar sesión" });
  }
});

router.post("/signout", async (req, res) => {
  res.json({ success: true });
});

router.post("/refresh", sessionLimiter, async (req, res) => {
  try {
    const refresh_token = req.body?.refresh_token;
    if (typeof refresh_token !== "string" || !refresh_token || refresh_token.length > 2048) {
      return res.status(400).json({ error: "Sesión inválida" });
    }
    const { data, error } = await supabaseMain.auth.refreshSession({ refresh_token });
    if (error || !data?.session) return res.status(401).json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("❌ refresh:", err instanceof Error ? err.message : err);
    res.status(401).json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
  }
});

router.get("/me", sessionLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || token.length > 4096 || token.split(".").length !== 3) return res.status(401).json({ error: "No autenticado" });
    const { data, error } = await supabaseMain.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Sesión inválida o expirada" });
    const profileRole = await getProfileRole(data.user.id);
    const isAdmin = await checkIsAdmin(data.user.id, data.user);
    res.json({ user: data.user, isAdmin, role: profileRole });
  } catch (err) {
    console.error("❌ me:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Diagnóstico de permisos: solo administradores
router.get("/debug", requireAuth, requireAdmin, async (req, res) => {
  const isAdmin = await checkIsAdmin(req.user.id, req.user);
  res.json({
    email: req.user.email,
    email_confirmed: Boolean(req.user.email_confirmed_at),
    isAdmin,
    env: {
      SUPABASE_URL_MAIN: Boolean(process.env.SUPABASE_URL_MAIN),
      SUPABASE_ANON_KEY_MAIN: Boolean(process.env.SUPABASE_ANON_KEY_MAIN),
      SUPABASE_SERVICE_ROLE_KEY_MAIN: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY_MAIN),
    },
  });
});

router.post("/forgot-password", passwordResetLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: "Escribe un correo válido" });
  try {
    await supabaseMain.auth.resetPasswordForEmail(email);
  } catch (err) {
    console.warn("⚠️ forgot-password:", err instanceof Error ? err.message : err);
  }
  // Siempre la misma respuesta: no revela si el correo está registrado
  res.json({ success: true });
});

router.get("/google", sessionLimiter, async (_req, res) => {
  try {
    const firstFrontend = (process.env.FRONTEND_URL || "").split(",")[0].trim();
    const redirectTo = process.env.GOOGLE_CALLBACK_URL || (firstFrontend ? firstFrontend + "/" : "") || "http://localhost:5173/";
    const { data, error } = await supabaseMain.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
        scopes: ["email", "profile"],
      },
    });

    if (error) throw error;

    res.json({ url: data?.url ?? null });
  } catch (err) {
    console.error("❌ Error iniciando OAuth con Google:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "No se pudo iniciar con Google" });
  }
});

// ──────────────────────────────────────────────
// GET /api/auth/users  (solo admin)
// Lista todos los usuarios registrados: email, si entraron con Google
// o con contraseña, fecha de registro y último acceso.
// ──────────────────────────────────────────────
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!supabaseMainAdmin) {
      return res.status(500).json({ error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY_MAIN en el backend" });
    }

    const perPage = 1000;
    let page = 1;
    let allUsers = [];

    // Supabase pagina de a máximo ~1000 usuarios por llamada; recorremos
    // todas las páginas por si hay más de 1000 registrados.
    while (true) {
      const { data, error } = await supabaseMainAdmin.auth.admin.listUsers({ page, perPage });
      if (error) throw error;

      const pageUsers = data?.users ?? [];
      allUsers = allUsers.concat(pageUsers);

      if (pageUsers.length < perPage) break;
      page += 1;
      if (page > 20) break; // límite de seguridad (20,000 usuarios)
    }

    const users = allUsers
      .map((u) => {
        const identities = Array.isArray(u.identities) ? u.identities : [];
        const providers = identities.length
          ? identities.map((i) => i.provider)
          : [u.app_metadata?.provider].filter(Boolean);

        return {
          id: u.id,
          email: u.email ?? null,
          full_name: u.user_metadata?.full_name || u.user_metadata?.name || null,
          avatar_url: u.user_metadata?.avatar_url || u.user_metadata?.picture || null,
          providers: providers.length ? providers : ["email"],
          created_at: u.created_at ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          email_confirmed_at: u.email_confirmed_at ?? null,
        };
      })
      .sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));

    res.json({ users, total: users.length });
  } catch (err) {
    console.error("❌ GET /api/auth/users falló:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "No se pudo obtener la lista de usuarios" });
  }
});

export default router;