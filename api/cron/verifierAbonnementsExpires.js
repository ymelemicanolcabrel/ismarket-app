"use strict";
const { admin, db, mettreAJourBadgesProduits, envoyerNotifFirestore } = require("../_lib/helpers");

module.exports = async (req, res) => {
  // Vercel Cron envoie automatiquement ce header d'autorisation.
  const authHeader = req.headers.authorization || "";
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Non autorisé");
  }

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
      batch.update(doc.ref, {
        subscriptionStatus: "expired",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      notifications.push({ vendorId: doc.id });
    }
  }

  await batch.commit();

  for (const { vendorId } of notifications) {
    await mettreAJourBadgesProduits(vendorId, { vendorPremium: false, vendorTrial: false });
    await envoyerNotifFirestore(vendorId, "subscription",
      "⚠️ Abonnement expiré",
      "Votre abonnement Premium a expiré. Renouvelez pour continuer à publier.",
      {});
  }

  res.status(200).json({ ok: true, expirations: notifications.length });
};
