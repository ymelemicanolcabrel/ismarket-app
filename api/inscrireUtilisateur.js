"use strict";
const {
  admin, db, limiterInscription, DUREE_ESSAI_MOIS,
  sanitize, validerTelephone, verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  try { await limiterInscription.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de tentatives."); }

  const name  = sanitize(data.name, 80);
  const phone = sanitize(data.phone, 15);
  const role  = ["buyer", "vendor"].includes(data.role) ? data.role : "buyer";

  if (!name || name.length < 2) throw new HttpError("invalid-argument", "Nom invalide.");
  if (!validerTelephone(phone)) throw new HttpError("invalid-argument", "Numéro invalide.");

  const existing = await db.collection("users").doc(uid).get();
  if (existing.exists) throw new HttpError("already-exists", "Profil déjà créé.");

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
