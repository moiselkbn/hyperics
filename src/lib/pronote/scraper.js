/**
 * Scraper PRONOTE Campus (Espace Invité) — pilote un vrai navigateur (Playwright)
 * car le protocole est chiffré côté client (voir docs/architecture.md §8bis).
 *
 * Le navigateur charge /hp/invite, laisse le JS officiel de PRONOTE gérer la
 * session/le chiffrement, puis on lit les réponses réseau JSON déjà en clair.
 *
 * Note : le sélecteur de classe n'est PAS un <select> HTML natif mais un widget
 * custom (Angular) — bouton qui ouvre une liste d'options (role="option").
 */
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { decodeCoursePosition, parseDom } from './decode.js';

const INVITE_URL = 'https://heffpm.hyperplanning.fr/hp/invite';
const DELAI_ENTRE_CLASSES_MS = 300;

/**
 * Attend la prochaine réponse `/hp/appelfonction/...` dont le champ `id` du
 * JSON correspond à `nomFonction` (ex: "FonctionEmploiDuTemps").
 */
function attendreReponseFonction(page, nomFonction, { timeout = 30000 } = {}) {
  return page.waitForResponse(
    async (response) => {
      if (!response.url().includes('/hp/appelfonction/')) return false;
      try {
        const json = await response.json();
        return json?.id === nomFonction;
      } catch {
        return false;
      }
    },
    { timeout },
  );
}

/**
 * Ferme la pop-up d'information (cookies) qui bloque l'interaction au premier
 * chargement de la page, si elle est présente.
 */
async function fermerPopupInfo(page, { timeout = 5000 } = {}) {
  const bouton = page.getByRole('button', { name: /Fermer/i }).first();
  try {
    await bouton.waitFor({ state: 'visible', timeout });
    await bouton.click();
  } catch {
    // Pas de pop-up apparue dans le délai — rien à fermer, on continue.
  }
}

/**
 * PRONOTE régénère ses identifiants opaques (`N`) à chaque nouvelle session —
 * vérifié empiriquement le 14/09/2026 : trois scrapes de la même classe "3TI
 * Web" à quelques heures d'intervalle ont donné trois `id` différents. Utiliser
 * `N` comme clé stable casserait les liens élèves au scrape horaire suivant
 * (voir docs/architecture.md §11). On dérive donc une clé stable du CONTENU du
 * cours à la place — matière/jour/heure/prof/salle, qui eux ne changent pas.
 */
function cleCoursStable({ subject, dayIndex, startMinutes, durationMinutes, teacher, room }) {
  const contenu = [subject, dayIndex, startMinutes, durationMinutes, teacher, room].join('|');
  return createHash('sha1').update(contenu).digest('hex').slice(0, 16);
}

/**
 * Convertit une entrée brute `ListeCours[i]` de PRONOTE en cours normalisé
 * (avec jour/heure décodés), prêt à être filtré/stocké.
 */
function normaliserCours(coursBrut) {
  const { dayIndex, startMinutes, durationMinutes } = decodeCoursePosition(coursBrut.p, coursBrut.d);
  const weeks = parseDom(coursBrut.dom);

  // Les infos utiles (matière/prof/salle/groupe) sont dans listeC, indexées par code G.
  const champ = (code) => coursBrut.listeC?.find((c) => c.G === code)?.C;
  const libelleDe = (c) => (Array.isArray(c) ? c.map((x) => x.L).join(', ') : c?.L) || null;

  const subject = libelleDe(champ(0));
  const teacher = libelleDe(champ(1));
  const room = libelleDe(champ(3));

  return {
    uid: cleCoursStable({ subject, dayIndex, startMinutes, durationMinutes, teacher, room }),
    dayIndex,
    startMinutes,
    durationMinutes,
    weeks,
    subject,
    teacher,
    room,
    comment: champ(5)?.str || null,
  };
}

/**
 * Récupère la liste des classes ("promotions") via `FonctionRenvoyerListeDeRessource`,
 * déclenchée à l'ouverture du sélecteur de classe.
 *
 * Le champ `N` renvoyé par PRONOTE pour chaque classe n'est PAS stable d'une
 * session à l'autre (voir la note dans `cleCoursStable`, même constat pour les
 * classes que pour les cours) — on utilise donc le label lui-même comme clé
 * (ex: "3TI Web"), stable par construction puisque c'est le nom que l'école
 * utilise pour désigner la classe.
 *
 * @returns {Promise<{ id: string, label: string }[]>} id === label (gardés
 *   séparés dans le type pour ne pas devoir toucher le reste du code qui
 *   distingue déjà "clé de stockage" et "libellé affiché").
 */
async function listerClasses(page) {
  const reponseAttendue = attendreReponseFonction(page, 'FonctionRenvoyerListeDeRessource');
  const combobox = page.getByRole('combobox', { name: /promotion/i });
  await combobox.click();
  const response = await reponseAttendue;
  const json = await response.json();
  await page.keyboard.press('Escape'); // referme la liste ouverte pour la déclencher

  const liste = json?.dataSec?.data?.ListeRessources?.Liste ?? [];
  return liste.map((r) => ({ id: r.L, label: r.L }));
}

/**
 * Scrape l'emploi du temps annuel de toutes les classes PRONOTE.
 *
 * @param {object} [options]
 * @param {number} [options.delayMs] - délai entre deux classes (anti-burst)
 * @param {number} [options.limit] - ne scraper que les N premières classes (pratique pour tester)
 * @param {(label: string, index: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{ classes: {id: string, label: string}[], coursesByClassId: Record<string, object[]> }>}
 */
export async function scrapeAllClasses({ delayMs = DELAI_ENTRE_CLASSES_MS, limit, onProgress } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Pas de "networkidle" : PRONOTE garde une connexion de long-polling ouverte
  // en permanence (/hp/appelpolling/...), qui empêcherait ce wait de résoudre.
  await page.goto(INVITE_URL, { waitUntil: 'load' });
  await fermerPopupInfo(page);

  let classes = await listerClasses(page);
  if (limit) classes = classes.slice(0, limit);

  const combobox = page.getByRole('combobox', { name: /promotion/i });
  const coursesByClassId = {};

  for (let i = 0; i < classes.length; i++) {
    const { id, label } = classes[i];
    onProgress?.(label, i, classes.length);

    const reponseAttendue = attendreReponseFonction(page, 'FonctionEmploiDuTemps');
    await combobox.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    const response = await reponseAttendue;
    const json = await response.json();

    const listeCours = json?.dataSec?.data?.ListeCours ?? [];
    coursesByClassId[id] = listeCours.map(normaliserCours);

    if (i < classes.length - 1) {
      await page.waitForTimeout(delayMs);
    }
  }

  await browser.close();

  return { classes, coursesByClassId };
}
