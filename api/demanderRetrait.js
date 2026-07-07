"use strict";
const {
  admin, db, validerTelephone, verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);

  const montant   = Number(data.montant);
  const phone     = String(data.phone || "").replace(/<[^>]*>/g, "").trim().slice(0, 15);
  const operateur = String(data.operateur || "").toUpperCase();

  if (!montant || montant < 1000) throw new HttpError("invalid-argument", "Montant minimum : 1 000 F.");
  if (!validerTelephone(phone)) throw new HttpError("invalid-argument", "Numéro invalide.");
  if (!["MTN", "ORANGE"].includes(operateur)) throw new HttpError("invalid-argument", "Opérateur invalide.");

  const userRef = db.collection("users").doc(uid);

  const retraitId = await db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    if (!userDoc.exists) throw new HttpError("not-found", "Utilisateur introuvable.");
    const userData = userDoc.data();
    if (userData.role !== "vendor") throw new HttpError("permission-denied", "Réservé aux vendeurs.");
    if (userData.isSuspended) throw new HttpError("permission-denied", "Compte suspendu.");

    const balance = Number(userData.walletBalance || 0);
    if (montant > balance) throw new HttpError("failed-precondition", "Solde insuffisant.");

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
