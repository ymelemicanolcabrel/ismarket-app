/**
 * ISMarket — Firebase Cloud Functions v5 (Production)
 * Toutes les opérations sensibles sont côté serveur.
 * Déployez : firebase deploy --only functions
 *
 * Config requise :
 *   firebase functions:config:set monetbil.key="CLE" monetbil.secret="SECRET"
 *   firebase functions:config:set cloudinary.cloud="NOM" cloudinary.key="KEY" cloudinary.secret="SECRET"
 *   firebase functions:config:set app.vapid_key="VOTRE_VAPID_KEY"
 */

"use strict";

const functions  = require("firebase-functions");
const admin      = require("firebase-admin");
const fetch      = require("node-fetch");
const crypto     = require("crypto");
const { RateLimiterMemory } = require("rate-limiter-flexible");

admin.initializeApp();
const db  = admin.firestore();
const msg = admin.messaging();

// ─── Rate Limiters ──────────────────────────────────────────────
const limiterPaiement     = new RateLimiterMemory({ points: 5,  duration: 60  });
const limiterInscription  = new RateLimiterMemory({ points: 3,  duration: 300 });
const limiterProduit      = new RateLimiterMemory({ points: 10, duration: 60  });
const limiterMessage      = new RateLimiterMemory({ points: 30, duration: 60  });
const limiterAbonnement   = new RateLimiterMemory({ points: 3,  duration: 300 });

// ─── Constantes ─────────────────────────────────────────────────
const PRIX_ABONNEMENT    = 5000;  // F CFA / mois
const COMMISSION_RATE    = 0.05;  // 5%
const DUREE_ESSAI_MOIS   = 2;
const MONETBIL_BASE      = "https://api.monetbil.com";

// ─── Helpers ────────────────────────────────────────────────────
function sanitize(str, maxLen = 500) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").replace(/[<>"'`]/g, "").trim().slice(0, maxLen);
}
function validerTelephone(phone) {
  return /^[0-9]{9}$/.test(String(phone || "").trim());
}
async function getUser(uid) {
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) throw new functions.https.HttpsError("not-found", "Utilisateur introuvable.");
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

// ─── Notifications Push ─────────────────────────────────────────
async function envoyerNotifPush(userId, titre, message, data = {}) {
  try {
    // Récupérer le token FCM de l'utilisateur
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
        notification: {
          sound: "default",
          channelId: "ismarket_default",
          icon: "ic_notification",
          color: "#E8A93D",
        },
      },
    });
  } catch (err) {
    // Token invalide ou expiré → supprimer
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
  // Push en même temps
  await envoyerNotifPush(userId, titre, message, { type, ...extra });
}

// ════════════════════════════════════════════════════════════════
// 1. ENREGISTRER TOKEN FCM
// ════════════════════════════════════════════════════════════════
exports.enregistrerTokenFCM = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Connexion requise.");
  const { token } = data;
  if (!token || typeof token !== "string") throw new functions.https.HttpsError("invalid-argument", "Token invalide.");
  await db.collection("fcm_tokens").doc(context.auth.uid).set({
    token,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 2. INSCRIPTION UTILISATEUR
// ════════════════════════════════════════════════════════════════
exports.inscrireUtilisateur = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  try { await limiterInscription.consume(uid); }
  catch { throw new functions.https.HttpsError("resource-exhausted", "Trop de tentatives."); }

  const name  = sanitize(data.name, 80);
  const phone = sanitize(data.phone, 15);
  const role  = ["buyer", "vendor"].includes(data.role) ? data.role : "buyer";

  if (!name || name.length < 2) throw new functions.https.HttpsError("invalid-argument", "Nom invalide.");
  if (!validerTelephone(phone)) throw new functions.https.HttpsError("invalid-argument", "Numéro invalide.");

  const existing = await db.collection("users").doc(uid).get();
  if (existing.exists) throw new functions.https.HttpsError("already-exists", "Profil déjà créé.");

  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setMonth(trialEnd.getMonth() + DUREE_ESSAI_MOIS);

  const userData = {
    name, phone, role,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    active: true, isSuspended: false, isCertified: false, reportCount: 0,
  };

  if (role === "vendor") {
    Object.assign(userData, {
      subscriptionStatus: "trial",
      trialStartDate: admin.firestore.FieldValue.serverTimestamp(),
      trialEndDate: trialEnd,
      subscriptionExpiry: null,
      walletBalance: 0,
    });
  }

  await db.collection("users").doc(uid).set(userData);
  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 3. INITIER PAIEMENT COMMANDE (Monetbil)
// ════════════════════════════════════════════════════════════════
exports.initierPaiement = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Connexion requise.");
  const uid = context.auth.uid;
  try { await limiterPaiement.consume(uid); }
  catch { throw new functions.https.HttpsError("resource-exhausted", "Trop de tentatives. Attendez 1 minute."); }

  const { orderId, montant, telephone, operateur } = data;
  if (!orderId || !montant || !telephone || !operateur)
    throw new functions.https.HttpsError("invalid-argument", "Paramètres manquants.");
  if (!validerTelephone(telephone))
    throw new functions.https.HttpsError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(String(operateur).toUpperCase()))
    throw new functions.https.HttpsError("invalid-argument", "Opérateur invalide.");
  if (Number(montant) < 100 || Number(montant) > 5000000)
    throw new functions.https.HttpsError("invalid-argument", "Montant hors limites.");

  // Vérifier que la commande appartient à cet acheteur et est non payée
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Commande introuvable.");
  const order = orderDoc.data();
  if (order.buyerId !== uid) throw new functions.https.HttpsError("permission-denied", "Non autorisé.");
  if (order.paymentStatus !== "UNPAID") throw new functions.https.HttpsError("failed-precondition", "Déjà traitée.");

  const SERVICE_KEY = functions.config().monetbil.key;
  const PROJECT_ID  = process.env.GCLOUD_PROJECT;
  const NOTIFY_URL  = `https://us-central1-${PROJECT_ID}.cloudfunctions.net/webhookMonetbil`;

  let monetbilRes;
  try {
    const params = new URLSearchParams({
      service:     SERVICE_KEY,
      amount:      String(Math.round(Number(montant))),
      phonenumber: String(telephone).trim(),
      operator:    String(operateur).toUpperCase(),
      order_id:    orderId,
      notify_url:  NOTIFY_URL,
      locale:      "fr",
    });
    const res = await fetch(`${MONETBIL_BASE}/v2.1/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    monetbilRes = await res.json();
  } catch (err) {
    throw new functions.https.HttpsError("unavailable", "Monetbil inaccessible. Réessayez.");
  }

  // Enregistrer la tentative de paiement
  const payRef = await db.collection("payments").add({
    orderId, buyerId: uid,
    amount: Number(montant),
    operator: String(operateur).toUpperCase(),
    phone: String(telephone).trim(),
    status: "INITIATED",
    type: "order",
    monetbilRef: monetbilRes.payment_ref || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("orders").doc(orderId).update({
    paymentStatus: "PENDING",
    paymentRef:    monetbilRes.payment_ref || null,
    paymentId:     payRef.id,
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:    !!monetbilRes.success,
    status:     monetbilRes.status || "UNKNOWN",
    paymentRef: monetbilRes.payment_ref || null,
    message:    monetbilRes.message || "",
  };
});

// ════════════════════════════════════════════════════════════════
// 4. WEBHOOK MONETBIL (confirmation paiement commande ET abonnement)
// ════════════════════════════════════════════════════════════════
exports.webhookMonetbil = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { order_id, status, payment_ref, operator, amount } = req.body;
  if (!order_id || !status) return res.status(400).send("Paramètres manquants");

  const validStatuses = ["success", "failed", "cancelled", "expired", "pending"];
  if (!validStatuses.includes(String(status).toLowerCase())) return res.status(400).send("Statut invalide");

  const statusMap = {
    success:   "PAID",
    failed:    "FAILED",
    cancelled: "CANCELLED",
    expired:   "EXPIRED",
    pending:   "PENDING",
  };
  const newStatus = statusMap[String(status).toLowerCase()];

  try {
    // Détecter si c'est un paiement de commande ou d'abonnement
    // Les IDs d'abonnement commencent par "sub_"
    if (String(order_id).startsWith("sub_")) {
      await traiterWebhookAbonnement(order_id, newStatus, payment_ref);
    } else {
      await traiterWebhookCommande(order_id, newStatus, payment_ref);
    }
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Erreur serveur");
  }
});

async function traiterWebhookCommande(orderId, newStatus, paymentRef) {
  const orderRef = db.collection("orders").doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data();

  const orderStatus = newStatus === "PAID" ? "confirmed" : ["CANCELLED","FAILED","EXPIRED"].includes(newStatus) ? "cancelled" : "pending";
  await orderRef.update({ paymentStatus: newStatus, orderStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  // Mettre à jour le paiement
  const paySnap = await db.collection("payments").where("orderId", "==", orderId).limit(1).get();
  if (!paySnap.empty) {
    await paySnap.docs[0].ref.update({ status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  if (newStatus === "PAID") {
    // Créditer le wallet du vendeur (net après commission)
    if (order.vId && order.vId !== "system") {
      const commission = Math.round((order.totalPrice || 0) * COMMISSION_RATE);
      const net = (order.totalPrice || 0) - commission;
      await db.collection("users").doc(order.vId).update({
        walletBalance: admin.firestore.FieldValue.increment(net),
      });
      await db.collection("wallet_transactions").add({
        vendorId: order.vId, orderId, type: "sale",
        amount: net, commission, totalSale: order.totalPrice,
        productName: order.productName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection("platform_revenue").add({
        orderId, amount: commission, type: "commission",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Incrémenter soldCount du produit
      if (order.productId) {
        await db.collection("products").doc(order.productId).update({
          soldCount: admin.firestore.FieldValue.increment(1),
        }).catch(() => {});
      }
      // Notifier le vendeur
      await envoyerNotifFirestore(order.vId, "sale",
        "💰 Nouvelle vente !",
        `${order.productName} — ${net.toLocaleString("fr-FR")} F CFA crédités.`,
        { orderId }
      );
    }
    // Notifier l'acheteur
    if (order.buyerId) {
      await envoyerNotifFirestore(order.buyerId, "payment",
        "✅ Paiement confirmé !",
        `Votre commande "${order.productName}" a été confirmée.`,
        { orderId }
      );
    }
  } else if (["FAILED","CANCELLED","EXPIRED"].includes(newStatus) && order.buyerId) {
    await envoyerNotifFirestore(order.buyerId, "payment",
      "❌ Paiement échoué",
      `Le paiement pour "${order.productName}" a échoué (${newStatus.toLowerCase()}).`,
      { orderId }
    );
  }
}

async function traiterWebhookAbonnement(subPayId, newStatus, paymentRef) {
  // subPayId = "sub_FIRESTORE_DOC_ID"
  const docId = String(subPayId).replace("sub_", "");
  const subRef = db.collection("subscription_payments").doc(docId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) return;
  const subData = subDoc.data();

  await subRef.update({ status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  if (newStatus === "PAID" && subData.vendorId) {
    // Renouveler l'abonnement pour 1 mois
    const now = new Date();
    // Si déjà premium et pas expiré → prolonger depuis la date d'expiration
    const vendorDoc = await db.collection("users").doc(subData.vendorId).get();
    const vendorData = vendorDoc.exists ? vendorDoc.data() : {};
    let baseDate = now;
    if (vendorData.subscriptionStatus === "premium" && vendorData.subscriptionExpiry) {
      const currentExpiry = vendorData.subscriptionExpiry.toDate?.() || new Date(vendorData.subscriptionExpiry);
      if (currentExpiry.getTime() > now.getTime()) baseDate = currentExpiry;
    }
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + 1);

    await db.collection("users").doc(subData.vendorId).update({
      subscriptionStatus: "premium",
      subscriptionExpiry: newExpiry,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Mettre à jour TOUS les produits du vendeur avec les nouveaux badges
    await mettreAJourBadgesProduits(subData.vendorId, {
      vendorPremium: true,
      vendorTrial: false,
    });

    // Notifier le vendeur
    await envoyerNotifFirestore(subData.vendorId, "subscription",
      "🌟 Abonnement Premium activé !",
      `Votre abonnement est actif jusqu'au ${newExpiry.toLocaleDateString("fr-FR")}.`,
      {}
    );
  } else if (["FAILED","CANCELLED","EXPIRED"].includes(newStatus) && subData.vendorId) {
    await envoyerNotifFirestore(subData.vendorId, "subscription",
      "❌ Paiement abonnement échoué",
      `Le paiement de votre abonnement a échoué (${newStatus.toLowerCase()}).`,
      {}
    );
  }
}

// ════════════════════════════════════════════════════════════════
// 5. PAYER ABONNEMENT VENDEUR
// ════════════════════════════════════════════════════════════════
exports.payerAbonnementVendeur = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Connexion requise.");
  const uid = context.auth.uid;
  try { await limiterAbonnement.consume(uid); }
  catch { throw new functions.https.HttpsError("resource-exhausted", "Trop de tentatives."); }

  const role = await getRole(uid);
  if (role !== "vendor" && role !== "admin")
    throw new functions.https.HttpsError("permission-denied", "Réservé aux vendeurs.");

  const { subPayId, telephone, operateur } = data;
  if (!subPayId || !telephone || !operateur)
    throw new functions.https.HttpsError("invalid-argument", "Paramètres manquants.");
  if (!validerTelephone(telephone))
    throw new functions.https.HttpsError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(String(operateur).toUpperCase()))
    throw new functions.https.HttpsError("invalid-argument", "Opérateur invalide.");

  // Vérifier que ce paiement appartient à ce vendeur
  const subDoc = await db.collection("subscription_payments").doc(subPayId).get();
  if (!subDoc.exists) throw new functions.https.HttpsError("not-found", "Paiement introuvable.");
  if (subDoc.data().vendorId !== uid) throw new functions.https.HttpsError("permission-denied", "Non autorisé.");

  const SERVICE_KEY = functions.config().monetbil.key;
  const PROJECT_ID  = process.env.GCLOUD_PROJECT;
  const NOTIFY_URL  = `https://us-central1-${PROJECT_ID}.cloudfunctions.net/webhookMonetbil`;

  let monetbilRes;
  try {
    const params = new URLSearchParams({
      service:     SERVICE_KEY,
      amount:      String(PRIX_ABONNEMENT),
      phonenumber: String(telephone).trim(),
      operator:    String(operateur).toUpperCase(),
      order_id:    `sub_${subPayId}`, // Préfixe pour distinguer dans le webhook
      notify_url:  NOTIFY_URL,
      locale:      "fr",
    });
    const res = await fetch(`${MONETBIL_BASE}/v2.1/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    monetbilRes = await res.json();
  } catch (err) {
    throw new functions.https.HttpsError("unavailable", "Monetbil inaccessible.");
  }

  // Mettre à jour le paiement d'abonnement
  await db.collection("subscription_payments").doc(subPayId).update({
    status: "PENDING",
    monetbilRef: monetbilRes.payment_ref || null,
    operator: String(operateur).toUpperCase(),
    phone: String(telephone).trim(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success:    !!monetbilRes.success,
    status:     monetbilRes.status || "UNKNOWN",
    paymentRef: monetbilRes.payment_ref || null,
    message:    monetbilRes.message || "",
  };
});

// ════════════════════════════════════════════════════════════════
// 6. VÉRIFIER STATUT PAIEMENT COMMANDE
// ════════════════════════════════════════════════════════════════
exports.verifierStatutPaiement = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const { orderId } = data;
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Commande introuvable.");
  const order = orderDoc.data();
  if (order.buyerId !== context.auth.uid)
    throw new functions.https.HttpsError("permission-denied", "Non autorisé.");

  // Si toujours PENDING → interroger Monetbil
  if (order.paymentStatus === "PENDING" && order.paymentRef) {
    try {
      const SERVICE_KEY = functions.config().monetbil.key;
      const res = await fetch(
        `${MONETBIL_BASE}/payment/v1/checkPayment?service=${SERVICE_KEY}&paymentRef=${order.paymentRef}`
      );
      const remote = await res.json();
      if (remote.status && remote.status !== "pending") {
        const statusMap = { success: "PAID", failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED" };
        const newStatus = statusMap[remote.status] || order.paymentStatus;
        if (newStatus !== order.paymentStatus) {
          // Déclencher le même traitement que le webhook
          await traiterWebhookCommande(orderId, newStatus, order.paymentRef);
          return { paymentStatus: newStatus, orderStatus: newStatus === "PAID" ? "confirmed" : "cancelled" };
        }
      }
    } catch (_) {}
  }

  return { paymentStatus: order.paymentStatus, orderStatus: order.orderStatus };
});

// ════════════════════════════════════════════════════════════════
// 7. VÉRIFIER STATUT PAIEMENT ABONNEMENT
// ════════════════════════════════════════════════════════════════
exports.verifierStatutAbonnement = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const { subPayId } = data;
  const subDoc = await db.collection("subscription_payments").doc(subPayId).get();
  if (!subDoc.exists) throw new functions.https.HttpsError("not-found", "Paiement introuvable.");
  const subData = subDoc.data();
  if (subData.vendorId !== context.auth.uid)
    throw new functions.https.HttpsError("permission-denied", "Non autorisé.");

  // Si toujours PENDING → interroger Monetbil
  if (subData.status === "PENDING" && subData.monetbilRef) {
    try {
      const SERVICE_KEY = functions.config().monetbil.key;
      const res = await fetch(
        `${MONETBIL_BASE}/payment/v1/checkPayment?service=${SERVICE_KEY}&paymentRef=${subData.monetbilRef}`
      );
      const remote = await res.json();
      if (remote.status && remote.status !== "pending") {
        const statusMap = { success: "PAID", failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED" };
        const newStatus = statusMap[remote.status] || subData.status;
        if (newStatus !== subData.status) {
          await traiterWebhookAbonnement(`sub_${subPayId}`, newStatus, subData.monetbilRef);
          // Recharger les données utilisateur mises à jour
          const userDoc = await db.collection("users").doc(context.auth.uid).get();
          return { status: newStatus, userData: userDoc.exists ? userDoc.data() : null };
        }
      }
    } catch (_) {}
  }

  return { status: subData.status };
});

// ════════════════════════════════════════════════════════════════
// 8. CLOUDINARY SIGNATURE (sécurisée)
// ════════════════════════════════════════════════════════════════
exports.cloudinarySignature = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const role = await getRole(context.auth.uid);
  if (!["vendor", "admin"].includes(role))
    throw new functions.https.HttpsError("permission-denied", "Réservé aux vendeurs.");

  const timestamp  = Math.round(Date.now() / 1000);
  const apiSecret  = functions.config().cloudinary.secret;
  const cloudName  = functions.config().cloudinary.cloud;
  const apiKey     = functions.config().cloudinary.key;
  const folder     = data.folder || "ismarket/products";

  const toSign     = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature  = crypto.createHash("sha1").update(toSign).digest("hex");

  return { signature, timestamp, apiKey, cloudName, folder };
});

// ════════════════════════════════════════════════════════════════
// 9. PUBLIER PRODUIT (validation côté serveur)
// ════════════════════════════════════════════════════════════════
exports.publierProduit = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  try { await limiterProduit.consume(uid); }
  catch { throw new functions.https.HttpsError("resource-exhausted", "Trop de publications. Attendez 1 minute."); }

  const vendor = await getUser(uid);
  if (!["vendor", "admin"].includes(vendor.role))
    throw new functions.https.HttpsError("permission-denied", "Réservé aux vendeurs.");
  if (vendor.isSuspended)
    throw new functions.https.HttpsError("permission-denied", "Compte suspendu.");
  if (vendor.role === "vendor" && !estAbonnementActif(vendor))
    throw new functions.https.HttpsError("permission-denied", "Abonnement expiré.");

  const name     = sanitize(data.name, 120);
  const desc     = sanitize(data.description, 1000);
  const imageUrl = sanitize(data.imageUrl, 500);
  const price    = Number(data.price);
  const category = sanitize(data.category, 50);
  const city     = sanitize(data.city || "", 60);
  const lat      = typeof data.lat === "number" ? data.lat : null;
  const lng      = typeof data.lng === "number" ? data.lng : null;

  if (!name || name.length < 3) throw new functions.https.HttpsError("invalid-argument", "Nom invalide.");
  if (isNaN(price) || price < 100 || price > 10000000) throw new functions.https.HttpsError("invalid-argument", "Prix invalide.");
  const validCats = ["electronique","mode","sante","alimentation","maison","autre"];
  if (!validCats.includes(category)) throw new functions.https.HttpsError("invalid-argument", "Catégorie invalide.");

  const isPremium = vendor.subscriptionStatus === "premium" && estAbonnementActif(vendor);
  const isTrial   = vendor.subscriptionStatus === "trial"   && estAbonnementActif(vendor);

  const ref = await db.collection("products").add({
    name, description: desc, price, category, city, lat, lng,
    image: imageUrl,
    vId: uid, vendorName: vendor.name,
    vendorCertified: vendor.isCertified || false,
    vendorPremium:   isPremium,
    vendorTrial:     isTrial,
    rating: 0, reviewCount: 0, soldCount: 0,
    active: true, reported: false, reportCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, productId: ref.id };
});

// ════════════════════════════════════════════════════════════════
// 10. METTRE À JOUR STATUT COMMANDE (vendeur)
// ════════════════════════════════════════════════════════════════
exports.mettreAJourStatutCommande = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  const { orderId, newStatus } = data;
  const validStatuses = ["confirmed", "shipped", "delivered", "cancelled"];
  if (!validStatuses.includes(newStatus))
    throw new functions.https.HttpsError("invalid-argument", "Statut invalide.");

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Commande introuvable.");
  const order = orderDoc.data();

  const role = await getRole(uid);
  if (order.vId !== uid && role !== "admin")
    throw new functions.https.HttpsError("permission-denied", "Non autorisé.");
  if (order.paymentStatus !== "PAID")
    throw new functions.https.HttpsError("failed-precondition", "Paiement non confirmé.");

  await db.collection("orders").doc(orderId).update({
    orderStatus: newStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const statusLabels = { confirmed:"confirmée", shipped:"expédiée", delivered:"livrée", cancelled:"annulée" };
  const statusIcons  = { confirmed:"✅", shipped:"🚚", delivered:"🎉", cancelled:"❌" };
  if (order.buyerId) {
    await envoyerNotifFirestore(order.buyerId, "order",
      `${statusIcons[newStatus]} Commande ${statusLabels[newStatus]}`,
      `Votre commande "${order.productName}" est ${statusLabels[newStatus]}.`,
      { orderId }
    );
  }

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 11. CERTIFICATION VENDEUR (admin)
// ════════════════════════════════════════════════════════════════
exports.certifierVendeur = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const adminRole = await getRole(context.auth.uid);
  if (adminRole !== "admin") throw new functions.https.HttpsError("permission-denied", "Admin requis.");

  const { vendorId, isCertified } = data;
  if (!vendorId) throw new functions.https.HttpsError("invalid-argument", "vendorId manquant.");

  await db.collection("users").doc(vendorId).update({
    isCertified: !!isCertified,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Mettre à jour tous les produits du vendeur
  await mettreAJourBadgesProduits(vendorId, { vendorCertified: !!isCertified });

  // Notifier le vendeur
  if (isCertified) {
    await envoyerNotifFirestore(vendorId, "admin",
      "🔵 Vendeur Certifié !",
      "Félicitations ! Votre boutique a été certifiée par ISMarket.",
      {}
    );
  }

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 12. SUSPENSION VENDEUR (admin)
// ════════════════════════════════════════════════════════════════
exports.suspendreVendeur = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const adminRole = await getRole(context.auth.uid);
  if (adminRole !== "admin") throw new functions.https.HttpsError("permission-denied", "Admin requis.");

  const { vendorId, isSuspended, reason } = data;
  if (!vendorId) throw new functions.https.HttpsError("invalid-argument", "vendorId manquant.");

  await db.collection("users").doc(vendorId).update({
    isSuspended: !!isSuspended,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Désactiver / réactiver les produits
  const prods = await db.collection("products").where("vId", "==", vendorId).get();
  const batch = db.batch();
  prods.docs.forEach(d => batch.update(d.ref, { active: !isSuspended }));
  await batch.commit();

  // Notifier le vendeur
  await envoyerNotifFirestore(vendorId, "admin",
    isSuspended ? "🚫 Compte suspendu" : "✅ Compte réactivé",
    isSuspended
      ? `Votre compte a été suspendu. ${reason || "Contactez l'assistance."}`
      : "Votre compte a été réactivé.",
    {}
  );

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 13. TRAITEMENT RETRAIT (admin)
// ════════════════════════════════════════════════════════════════
exports.traiterRetrait = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const adminRole = await getRole(context.auth.uid);
  if (adminRole !== "admin") throw new functions.https.HttpsError("permission-denied", "Admin requis.");

  const { retraitId, action } = data;
  if (!["approved", "rejected"].includes(action))
    throw new functions.https.HttpsError("invalid-argument", "Action invalide.");

  const doc = await db.collection("withdrawal_requests").doc(retraitId).get();
  if (!doc.exists) throw new functions.https.HttpsError("not-found", "Demande introuvable.");
  const retrait = doc.data();

  await db.collection("withdrawal_requests").doc(retraitId).update({
    status: action,
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
    processedBy: context.auth.uid,
  });

  if (action === "rejected" && retrait.vendorId && retrait.amount) {
    // Rembourser le wallet
    await db.collection("users").doc(retrait.vendorId).update({
      walletBalance: admin.firestore.FieldValue.increment(retrait.amount),
    });
    await db.collection("wallet_transactions").add({
      vendorId: retrait.vendorId, type: "refund",
      amount: retrait.amount, reason: "Retrait rejeté",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await envoyerNotifFirestore(retrait.vendorId, "wallet",
      "❌ Retrait rejeté",
      `Votre demande de retrait de ${retrait.amount.toLocaleString("fr-FR")} F a été rejetée. Le montant a été recrédité.`,
      {}
    );
  } else if (action === "approved" && retrait.vendorId) {
    await envoyerNotifFirestore(retrait.vendorId, "wallet",
      "✅ Retrait approuvé !",
      `Votre retrait de ${(retrait.amount||0).toLocaleString("fr-FR")} F via ${retrait.operator} a été approuvé.`,
      {}
    );
  }

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 13bis. DEMANDER UN RETRAIT (vendeur) — débit atomique sécurisé
// ════════════════════════════════════════════════════════════════
// NOTE : cette fonction remplace l'ancienne écriture directe du client sur
// walletBalance, qui était bloquée par firestore.rules (le client n'a pas
// le droit de modifier walletBalance lui-même). Toute la logique de
// réservation du solde passe maintenant côté serveur, dans une transaction.
exports.demanderRetrait = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;

  const montant  = Number(data.montant);
  const phone    = sanitize(data.phone, 15);
  const operateur = String(data.operateur || "").toUpperCase();

  if (!montant || montant < 1000) throw new functions.https.HttpsError("invalid-argument", "Montant minimum : 1 000 F.");
  if (!validerTelephone(phone)) throw new functions.https.HttpsError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(operateur)) throw new functions.https.HttpsError("invalid-argument", "Opérateur invalide.");

  const userRef = db.collection("users").doc(uid);

  const retraitId = await db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    if (!userDoc.exists) throw new functions.https.HttpsError("not-found", "Utilisateur introuvable.");
    const userData = userDoc.data();
    if (userData.role !== "vendor") throw new functions.https.HttpsError("permission-denied", "Réservé aux vendeurs.");
    if (userData.isSuspended) throw new functions.https.HttpsError("permission-denied", "Compte suspendu.");

    const balance = Number(userData.walletBalance || 0);
    if (montant > balance) throw new functions.https.HttpsError("failed-precondition", "Solde insuffisant.");

    tx.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(-montant) });

    const withdrawalRef = db.collection("withdrawal_requests").doc();
    tx.set(withdrawalRef, {
      vendorId: uid, vendorName: userData.name || "Vendeur",
      amount: montant, operator: operateur, phone,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const txRef = db.collection("wallet_transactions").doc();
    tx.set(txRef, {
      vendorId: uid, type: "withdrawal", amount: montant,
      operator: operateur, phone, status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return withdrawalRef.id;
  });

  return { success: true, retraitId };
});

// ════════════════════════════════════════════════════════════════
// 14. NOTER UN PRODUIT (post-achat obligatoire)
// ════════════════════════════════════════════════════════════════
exports.noterProduit = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  const { productId, note, commentaire } = data;
  const noteNum = Number(note);
  if (!productId || isNaN(noteNum) || noteNum < 1 || noteNum > 5)
    throw new functions.https.HttpsError("invalid-argument", "Note invalide (1–5).");

  // Vérifier achat confirmé
  const orderSnap = await db.collection("orders")
    .where("buyerId", "==", uid)
    .where("productId", "==", productId)
    .where("paymentStatus", "==", "PAID")
    .limit(1).get();
  if (orderSnap.empty)
    throw new functions.https.HttpsError("permission-denied", "Achat requis pour noter.");

  // Vérifier pas déjà noté
  const existing = await db.collection("reviews")
    .where("buyerId", "==", uid).where("productId", "==", productId).limit(1).get();
  if (!existing.empty) throw new functions.https.HttpsError("already-exists", "Déjà noté.");

  const userDoc = await db.collection("users").doc(uid).get();
  const commentClean = sanitize(commentaire || "", 500);

  await db.collection("reviews").add({
    buyerId: uid,
    buyerName: userDoc.exists ? userDoc.data().name : "Acheteur",
    productId, note: noteNum, commentaire: commentClean,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Recalculer la moyenne
  const allReviews = await db.collection("reviews").where("productId", "==", productId).get();
  const total = allReviews.docs.reduce((s, d) => s + (d.data().note || 0), 0);
  const avg = +(total / allReviews.size).toFixed(1);
  await db.collection("products").doc(productId).update({ rating: avg, reviewCount: allReviews.size });

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 15. CHAT — CRÉER OU OBTENIR
// ════════════════════════════════════════════════════════════════
exports.obtenirOuCreerChat = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  const { vendorId, productId } = data;
  if (!vendorId || vendorId === uid) throw new functions.https.HttpsError("invalid-argument", "Vendeur invalide.");

  const chatSnap = await db.collection("chats")
    .where("participants", "array-contains", uid)
    .where("productId", "==", productId).limit(1).get();
  if (!chatSnap.empty) return { chatId: chatSnap.docs[0].id };

  const [productDoc, buyerDoc, vendorDoc] = await Promise.all([
    db.collection("products").doc(productId).get(),
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(vendorId).get(),
  ]);

  const ref = await db.collection("chats").add({
    participants: [uid, vendorId],
    buyerId: uid, vendorId, productId,
    productName:  productDoc.exists ? productDoc.data().name : "Produit",
    buyerName:    buyerDoc.exists ? buyerDoc.data().name : "Acheteur",
    vendorName:   vendorDoc.exists ? vendorDoc.data().name : "Vendeur",
    lastMessage: "", lastAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    [`unread_${uid}`]: 0, [`unread_${vendorId}`]: 0,
  });
  return { chatId: ref.id };
});

// ════════════════════════════════════════════════════════════════
// 16. CHAT — ENVOYER MESSAGE
// ════════════════════════════════════════════════════════════════
exports.envoyerMessage = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const uid = context.auth.uid;
  try { await limiterMessage.consume(uid); }
  catch { throw new functions.https.HttpsError("resource-exhausted", "Trop de messages."); }

  const { chatId, texte } = data;
  const texteClean = sanitize(texte, 1000);
  if (!texteClean) throw new functions.https.HttpsError("invalid-argument", "Message vide.");

  const chatDoc = await db.collection("chats").doc(chatId).get();
  if (!chatDoc.exists) throw new functions.https.HttpsError("not-found", "Conversation introuvable.");
  const chat = chatDoc.data();
  if (!chat.participants.includes(uid)) throw new functions.https.HttpsError("permission-denied", "Accès refusé.");

  const userDoc = await db.collection("users").doc(uid).get();
  const senderName = userDoc.exists ? userDoc.data().name : "Utilisateur";

  await db.collection("chats").doc(chatId).collection("messages").add({
    senderId: uid, senderName, texte: texteClean,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), read: false,
  });

  const otherId = chat.participants.find(p => p !== uid);
  await db.collection("chats").doc(chatId).update({
    lastMessage: texteClean,
    lastAt: admin.firestore.FieldValue.serverTimestamp(),
    [`unread_${otherId}`]: admin.firestore.FieldValue.increment(1),
  });

  await envoyerNotifPush(otherId, `💬 ${senderName}`, texteClean.slice(0, 80), { type: "chat", chatId });

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 17. SIGNALEMENT
// ════════════════════════════════════════════════════════════════
exports.signalerContenu = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Non authentifié.");
  const { targetId, targetType, reason } = data;
  if (!["product","user"].includes(targetType)) throw new functions.https.HttpsError("invalid-argument", "Type invalide.");

  await db.collection("reports").add({
    reporterId: context.auth.uid, targetId, targetType,
    reason: sanitize(reason || "", 300),
    createdAt: admin.firestore.FieldValue.serverTimestamp(), resolved: false,
  });

  const col = targetType === "product" ? "products" : "users";
  await db.collection(col).doc(targetId).update({
    reportCount: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});

  return { success: true };
});

// ════════════════════════════════════════════════════════════════
// 18. CRON — Vérifier abonnements expirés (toutes les 6h)
// ════════════════════════════════════════════════════════════════
exports.verifierAbonnementsExpires = functions.pubsub
  .schedule("every 6 hours")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    // Chercher les vendeurs Premium dont l'abonnement a expiré
    const snap = await db.collection("users")
      .where("role", "==", "vendor")
      .where("subscriptionStatus", "==", "premium")
      .get();

    const batch = db.batch();
    const notifications = [];

    for (const doc of snap.docs) {
      const vendor = doc.data();
      if (!vendor.subscriptionExpiry) continue;
      const expiry = vendor.subscriptionExpiry.toDate?.() || new Date(0);
      if (expiry.getTime() <= Date.now()) {
        // Marquer comme expiré
        batch.update(doc.ref, {
          subscriptionStatus: "expired",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Mettre à jour les badges des produits
        notifications.push({ vendorId: doc.id, vendor });
      }
    }

    await batch.commit();

    for (const { vendorId, vendor } of notifications) {
      await mettreAJourBadgesProduits(vendorId, { vendorPremium: false, vendorTrial: false });
      await envoyerNotifFirestore(vendorId, "subscription",
        "⚠️ Abonnement expiré",
        "Votre abonnement Premium a expiré. Renouvelez pour continuer à publier.",
        {}
      );
    }

    console.log(`Vérification abonnements: ${notifications.length} expirations traitées.`);
    return null;
  });

// ════════════════════════════════════════════════════════════════
// 19. HELPER — Mettre à jour badges sur tous les produits d'un vendeur
// ════════════════════════════════════════════════════════════════
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
