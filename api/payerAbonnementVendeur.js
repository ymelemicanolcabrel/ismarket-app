"use strict";
const fetch = require("node-fetch");
const {
  admin, db, limiterAbonnement, PRIX_ABONNEMENT, MONETBIL_BASE,
  validerTelephone, getRole, verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

function baseUrl() {
  return process.env.APP_BASE_URL || `https://${process.env.VERCEL_URL}`;
}

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  try { await limiterAbonnement.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de tentatives."); }

  const role = await getRole(uid);
  if (role !== "vendor" && role !== "admin")
    throw new HttpError("permission-denied", "Réservé aux vendeurs.");

  const { subPayId, telephone, operateur } = data;
  if (!subPayId || !telephone || !operateur)
    throw new HttpError("invalid-argument", "Paramètres manquants.");
  if (!validerTelephone(telephone))
    throw new HttpError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(String(operateur).toUpperCase()))
    throw new HttpError("invalid-argument", "Opérateur invalide.");

  const subDoc = await db.collection("subscription_payments").doc(subPayId).get();
  if (!subDoc.exists) throw new HttpError("not-found", "Paiement introuvable.");
  if (subDoc.data().vendorId !== uid) throw new HttpError("permission-denied", "Non autorisé.");

  const SERVICE_KEY = process.env.MONETBIL_KEY;
  const NOTIFY_URL  = `${baseUrl()}/api/webhookMonetbil`;

  let monetbilRes;
  try {
    const params = new URLSearchParams({
      service:     SERVICE_KEY,
      amount:      String(PRIX_ABONNEMENT),
      phonenumber: String(telephone).trim(),
      operator:    String(operateur).toUpperCase(),
      order_id:    `sub_${subPayId}`,
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
    throw new HttpError("unavailable", "Monetbil inaccessible.");
  }

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
