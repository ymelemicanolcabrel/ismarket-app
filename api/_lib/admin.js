/**
 * Initialise Firebase Admin SDK une seule fois (réutilisé entre invocations
 * "chaudes" de la même fonction Vercel).
 *
 * Variable d'environnement requise sur Vercel :
 *   FIREBASE_SERVICE_ACCOUNT_KEY = le JSON complet du compte de service
 *   (Firebase Console → Paramètres du projet → Comptes de service →
 *    Générer une nouvelle clé privée)
 */
"use strict";
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY manquante. Ajoutez-la dans Vercel → Settings → Environment Variables."
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = admin;
