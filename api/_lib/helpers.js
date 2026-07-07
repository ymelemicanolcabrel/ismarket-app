"use strict";
const admin = require("./admin");
const { HttpError, statusFor } = require("./errors");
const { RateLimiterMemory } = require("rate-limiter-flexible");

const db  = admin.firestore();
const msg = admin.messaging();

// ─── Rate limiters (best-effort : réinitialisés au redémarrage à froid
//     de la fonction, contrairement à Cloud Functions qui garde une
//     instance plus stable — reste utile contre les abus basiques) ────
const limiterPaiement    = new RateLimiterMemory({ points: 5,  duration: 60  });
const limiterInscription = new RateLimiterMemory({ points: 3,  duration: 300 });
const limiterProduit     = new RateLimiterMemory({ points: 10, duration: 60  });
const limiterMessage     = new RateLimiterMemory({ points: 30, duration: 60  });
const limiterAbonnement  = new RateLimiterMemory({ points: 3,  duration: 300 });

// ─── Constantes ─────────────────────────────────────────────────
const PRIX_ABONNEMENT  = 5000;
const COMMISSION_RATE  = 0.05;
const DUREE_ESSAI_MOIS = 2;
const MONETBIL_BASE    = "https://api.monetbil.com";

// ─── Helpers génériques ─────────────────────────────────────────
function sanitize(str, maxLen = 500) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").replace(/[<>"'`]/g, "").trim().slice(0, maxLen);
}
function validerTelephone(phone) {
  return /^[0-9]{9}$/.test(String(phone || "").trim());
}
async function getUser(uid) {
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) throw new HttpError("not-found", "Utilisateur introuvable.");
  return { id: uid, ...doc.data() };
}
async function getRole(uid) {
  const doc = await db.collection("users").doc(uid).get();
  return doc.exists ? doc.data().role : null;
}
function estAbonnementActif(userData) {
  const now = Date.now();
  if (userData.subscriptionStatus === "trial") {
    const end = userData.trialEndDate?.toDate?.() || new Date(0);
    return end.getTime() > now;
  }
  if (userData.subscriptionStatus === "premium") {
    const end = userData.subscriptionExpiry?.toDate?.() || new Date(0);
    return end.getTime() > now;
  }
  return false;
}

// ─── Notifications ──────────────────────────────────────────────
async function envoyerNotifPush(userId, titre, message, data = {}) {
  try {
    const tokenDoc = await db.collection("fcm_tokens").doc(userId).get();
    if (!tokenDoc.exists) return;
    const token = tokenDoc.data().token;
    if (!token) return;
    await msg.send({
      token,
      notification: { title: titre, body: message },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
      android: {
        priority: "high",
        notification: { sound: "default", channelId: "ismarket_default", icon: "ic_notification", color: "#E8A93D" },
      },
    });
  } catch (err) {
    if (err.code === "messaging/registration-token-not-registered") {
      await db.collection("fcm_tokens").doc(userId).delete().catch(() => {});
    }
    console.warn("Push notification failed:", err.code || err.message);
  }
}

async function envoyerNotifFirestore(userId, type, titre, message, extra = {}) {
  await db.collection("notifications").add({
    userId, type, title: titre, message,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  });
  await envoyerNotifPush(userId, titre, message, { type, ...extra });
}

async function mettreAJourBadgesProduits(vendorId, updates) {
  const prods = await db.collection("products").where("vId", "==", vendorId).get();
  if (prods.empty) return;
  const batch = db.batch();
  prods.docs.forEach(d => batch.update(d.ref, {
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  await batch.commit();
}

// ─── Authentification (remplace context.auth de Firebase Callable) ─
async function verifyAuth(req) {
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer (.+)$/);
  if (!m) throw new HttpError("unauthenticated", "Connexion requise.");
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return decoded.uid;
  } catch {
    throw new HttpError("unauthenticated", "Session invalide ou expirée.");
  }
}

// ─── Wrapper HTTP commun : CORS + méthode + erreurs uniformisées ───
function withHandler(fn) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      return res.status(405).json({ error: { code: "method-not-allowed", message: "POST requis." } });
    }
    try {
      const body = req.body || {};
      const result = await fn(body, req);
      if (!res.headersSent) res.status(200).json({ data: result });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(statusFor(err.code)).json({ error: { code: err.code, message: err.message } });
      } else {
        console.error(err);
        res.status(500).json({ error: { code: "internal", message: "Erreur serveur." } });
      }
    }
  };
}

module.exports = {
  admin, db, msg,
  limiterPaiement, limiterInscription, limiterProduit, limiterMessage, limiterAbonnement,
  PRIX_ABONNEMENT, COMMISSION_RATE, DUREE_ESSAI_MOIS, MONETBIL_BASE,
  sanitize, validerTelephone, getUser, getRole, estAbonnementActif,
  envoyerNotifPush, envoyerNotifFirestore, mettreAJourBadgesProduits,
  verifyAuth, withHandler, HttpError,
};
