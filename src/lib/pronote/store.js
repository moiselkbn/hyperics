/**
 * Écriture/lecture des données PRONOTE en cache dans Redis (Vercel Storage).
 * Voir docs/architecture.md §5 pour la structure des clés.
 */
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';

// Durée de vie d'un lien élève sans activité (§5/§6 de l'archi) : 90 jours,
// reset à chaque fois que le calendrier est consulté (voir touchSelection).
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

let client;

/**
 * Récupère un client Redis connecté (réutilisé entre les appels dans le même
 * processus). Nécessite la variable d'environnement REDIS_URL.
 */
async function getClient() {
  if (client?.isOpen) return client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL manquante — voir docs/architecture.md §5');
  client = createClient({ url });
  client.on('error', (err) => console.error('Erreur Redis:', err.message));
  await client.connect();
  return client;
}

/** Ferme la connexion Redis — à appeler en fin de script (ex: fin du job de scraping). */
export async function closeStore() {
  if (client?.isOpen) await client.quit();
}

/**
 * Enregistre le résultat d'un scrape complet : la liste des classes et les
 * cours de chaque classe, chacun sous sa propre clé Redis.
 *
 * @param {{ classes: {id: string, label: string}[], coursesByClassId: Record<string, object[]> }} resultat
 */
export async function saveScrapeResult({ classes, coursesByClassId }) {
  const redis = await getClient();

  await redis.set('classes:list', JSON.stringify(classes));

  // multi() regroupe les écritures en une seule transaction (plus rapide, atomique).
  const multi = redis.multi();
  for (const [classId, courses] of Object.entries(coursesByClassId)) {
    multi.set(`courses:${classId}`, JSON.stringify(courses));
  }
  await multi.exec();
}

/** Lit la liste des classes en cache (ou null si jamais scrapée). */
export async function getClassesList() {
  const redis = await getClient();
  const raw = await redis.get('classes:list');
  return raw ? JSON.parse(raw) : null;
}

/** Lit les cours en cache d'une classe (ou null si jamais scrapée). */
export async function getCoursesForClass(classId) {
  const redis = await getClient();
  const raw = await redis.get(`courses:${classId}`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Crée un nouveau lien élève (token opaque) et enregistre sa sélection.
 *
 * @param {{ classId: string, excludedCourseUids: string[] }[]} selections
 *   un élément par classe/année choisie — plusieurs éléments pour un redoublant
 *   (voir docs/architecture.md §5). `excludedCourseUids` = cours décochés par
 *   l'élève, PAS les cours retenus — voir la note dans ics.js pour pourquoi.
 * @returns {Promise<string>} le token généré, à mettre dans le lien webcal
 */
export async function createSelection(selections) {
  const redis = await getClient();
  const token = randomBytes(24).toString('base64url'); // opaque, non-devinable

  const data = {
    selections,
    createdAt: new Date().toISOString(),
    lastAccessAt: new Date().toISOString(),
  };

  await redis.set(`token:${token}`, JSON.stringify(data), { EX: TOKEN_TTL_SECONDS });
  return token;
}

/**
 * Lit la sélection derrière un token, et prolonge sa durée de vie (§6 de
 * l'archi : le TTL est reset à chaque consultation du calendrier).
 *
 * @returns {Promise<{selections: object[], createdAt: string, lastAccessAt: string} | null>}
 */
export async function getSelectionAndTouch(token) {
  const redis = await getClient();
  const raw = await redis.get(`token:${token}`);
  if (!raw) return null;

  const data = JSON.parse(raw);
  data.lastAccessAt = new Date().toISOString();
  await redis.set(`token:${token}`, JSON.stringify(data), { EX: TOKEN_TTL_SECONDS });

  return data;
}
