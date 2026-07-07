"use strict";
const fetch = require("node-fetch");
const {
  admin, db, limiterPaiement, MONETBIL_BASE,
  validerTelephone, verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

function baseUrl() {
  return process.env.APP_BASE_URL || `https://${process.env.VERCEL_URL}`;
}

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  try { await limiterPaiement.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de tentatives. Attendez 1 minute."); }

  const { orderId, montant, telephone, operateur } = data;
  if (!orderId || !montant || !telephone || !operateur)
    throw new HttpError("invalid-argument", "Paramètres manquants.");
  if (!validerTelephone(telephone))
    throw new HttpError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(String(operateur).toUpperCase()))
    throw new HttpError("invalid-argument", "Opérateur invalide.");
  if (Number(montant) < 100 || Number(montant) > 5000000)
    throw new HttpError("invalid-argument", "Montant hors limites.");

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new HttpError("not-found", "Commande introuvable.");
  const order = orderDoc.data();
  if (order.buyerId !== uid) throw new HttpError("permission-denied", "Non autorisé.");
  if (order.paymentStatus !== "UNPAID") throw new HttpError("failed-precondition", "Déjà traitée.");

  const SERVICE_KEY = process.env.MONETBIL_KEY;
  const NOTIFY_URL  = `${baseUrl()}/api/webhookMonetbil`;

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
    throw new HttpError("unavailable", "Monetbil inaccessible. Réessayez.");
  }

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
