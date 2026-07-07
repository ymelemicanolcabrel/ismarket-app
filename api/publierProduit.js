"use strict";
const {
  admin, db, limiterProduit, sanitize, getUser, estAbonnementActif,
  verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  try { await limiterProduit.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de publications. Attendez 1 minute."); }

  const vendor = await getUser(uid);
  if (!["vendor", "admin"].includes(vendor.role))
    throw new HttpError("permission-denied", "Réservé aux vendeurs.");
  if (vendor.isSuspended) throw new HttpError("permission-denied", "Compte suspendu.");
  if (vendor.role === "vendor" && !estAbonnementActif(vendor))
    throw new HttpError("permission-denied", "Abonnement expiré.");

  const name     = sanitize(data.name, 120);
  const desc     = sanitize(data.description, 1000);
  const imageUrl = sanitize(data.imageUrl, 500);
  const price    = Number(data.price);
  const category = sanitize(data.category, 50);
  const city     = sanitize(data.city || "", 60);
  const lat      = typeof data.lat === "number" ? data.lat : null;
  const lng      = typeof data.lng === "number" ? data.lng : null;

  if (!name || name.length < 3) throw new HttpError("invalid-argument", "Nom invalide.");
  if (isNaN(price) || price < 100 || price > 10000000) throw new HttpError("invalid-argument", "Prix invalide.");
  const validCats = ["electronique", "mode", "sante", "alimentation", "maison", "autre"];
  if (!validCats.includes(category)) throw new HttpError("invalid-argument", "Catégorie invalide.");

  const isPremium = vendor.subscriptionStatus === "premium" && estAbonnementActif(vendor);
  const isTrial   = vendor.subscriptionStatus === "trial"   && estAbonnementActif(vendor);

  const ref = await db.collection("products").add({
    name, description: desc, price, category, city, lat, lng,
    image: imageUrl,
    vId: uid, vendorName: vendor.name,
    vendorCertified: vendor.isCertified || false,
    vendorPremium: isPremium,
    vendorTrial: isTrial,
    rating: 0, reviewCount: 0, soldCount: 0,
    active: true, reported: false, reportCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, productId: ref.id };
});
