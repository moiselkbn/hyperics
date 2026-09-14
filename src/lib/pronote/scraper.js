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
 * Convertit une entrée brute `ListeCours[i]` de PRONOTE en cours normalisé
 * (avec jour/heure décodés), prêt à être filtré/stocké.
 */
function normaliserCours(coursBrut) {
  const { dayIndex, startMinutes, durationMinutes } = decodeCoursePosition(coursBrut.p, coursBrut.d);
  const weeks = parseDom(coursBrut.dom);

  // Les infos utiles (matière/prof/salle/groupe) sont dans listeC, indexées par code G.
  const champ = (code) => coursBrut.listeC?.find((c) => c.G === code)?.C;
  const libelleDe = (c) => (Array.isArray(c) ? c.map((x) => x.L).join(', ') : c?.L) || null;

  return {
    uid: coursBrut.N,
    dayIndex,
    startMinutes,
    durationMinutes,
    weeks,
    subject: libelleDe(champ(0)),
    teacher: libelleDe(champ(1)),
    room: libelleDe(champ(3)),
    comment: champ(5)?.str || null,
  };
}

/**
 * Récupère la liste des classes ("promotions") avec leur ID stable PRONOTE,
 * via la réponse `FonctionRenvoyerListeDeRessource` déclenchée à l'ouverture
 * du sélecteur de classe.
 *
 * @returns {Promise<{ id: string, label: string }[]>}
 */
async function listerClasses(page) {
  const reponseAttendue = attendreReponseFonction(page, 'FonctionRenvoyerListeDeRessource');
  const combobox = page.getByRole('combobox', { name: /promotion/i });
  await combobox.click();
  const response = await reponseAttendue;
  const json = await response.json();
  await page.keyboard.press('Escape'); // referme la liste ouverte pour la déclencher

  const liste = json?.dataSec?.data?.ListeRessources?.Liste ?? [];
  return liste.map((r) => ({ id: r.N, label: r.L }));
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
