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
 * Fusionne avec le cache existant plutôt que de l'écraser (voir §11 de
 * l'archi) : la réponse PRONOTE pour une classe s'est avérée parfois
 * incomplète d'un scrape à l'autre (un cours réel absent d'une réponse mais
 * présent dans une autre, cause exacte non confirmée côté PRONOTE). Écraser
 * ferait disparaître un cours au hasard d'un cycle horaire à l'autre. La
 * fusion accumule : un cours vu au moins une fois reste visible, ses champs
 * (salle/prof/horaire) sont rafraîchis à chaque fois qu'il réapparaît dans un
 * scrape. Contrepartie assumée : un cours réellement supprimé par l'école ne
 * disparaîtrait pas de notre cache (cas non géré pour le MVP — voir backlog).
 *
 * @param {{ classes: {id: string, label: string}[], coursesByClassId: Record<string, object[]> }} resultat
 */
export async function saveScrapeResult({ classes, coursesByClassId }) {
  const redis = await getClient();

  await redis.set('classes:list', JSON.stringify(classes));

  const classIds = Object.keys(coursesByClassId);

  // 1) Lit l'existant pour chaque classe scrapée, en un seul aller-retour.
  const lecture = redis.multi();
  for (const classId of classIds) lecture.get(`courses:${classId}`);
  const existantsBruts = await lecture.exec();

  // 2) Fusionne par clé stable de cours (uid = hash du contenu, voir
  //    scraper.js), puis écrit tout, en un seul aller-retour.
  const ecriture = redis.multi();
  classIds.forEach((classId, i) => {
    const existants = existantsBruts[i] ? JSON.parse(existantsBruts[i]) : [];
    const frais = coursesByClassId[classId];

    const parUid = new Map(existants.map((c) => [c.uid, c]));
    for (const c of frais) parUid.set(c.uid, c); // le scrape frais rafraîchit les champs

    ecriture.set(`courses:${classId}`, JSON.stringify([...parUid.values()]));
  });
  await ecriture.exec();
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
