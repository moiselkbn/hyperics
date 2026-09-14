/**
 * Écriture/lecture des données PRONOTE en cache dans Redis (Vercel Storage).
 * Voir docs/architecture.md §5 pour la structure des clés.
 */
import { createClient } from 'redis';

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
