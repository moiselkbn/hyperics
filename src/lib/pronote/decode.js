/**
 * Décodage des données brutes renvoyées par PRONOTE Campus (Espace Invité).
 *
 * Formule établie empiriquement le 14/09/2026 en comparant les valeurs `p`/`d`
 * des cours (JSON de `FonctionEmploiDuTemps`) avec les horaires affichés dans
 * la grille visuelle du site (voir docs/architecture.md §8 pour le détail des
 * mesures). Non documenté officiellement par PRONOTE.
 */

// La grille PRONOTE va de 08h00 à 21h00, découpée en tranches de 30 minutes :
// 13h × 2 tranches/heure = 26 tranches par jour.
const SLOTS_PAR_JOUR = 26;
const HEURE_DEBUT_JOURNEE_MINUTES = 8 * 60; // 08h00 en minutes depuis minuit
const MINUTES_PAR_SLOT = 30;

/**
 * Décode le champ `p` (position) d'un cours en jour de semaine + heure de début,
 * et le champ `d` (durée) en minutes.
 *
 * @param {number} p - position du cours dans la grille (ex: 79)
 * @param {number} d - durée du cours en tranches de 30 min (ex: 8 = 4h)
 * @returns {{ dayIndex: number, startMinutes: number, durationMinutes: number }}
 *   dayIndex : 0 = lundi, 1 = mardi, ... 4 = vendredi (5 = samedi si utilisé)
 *   startMinutes : minutes depuis minuit (ex: 510 = 08h30)
 *   durationMinutes : durée du cours en minutes
 */
export function decodeCoursePosition(p, d) {
  const dayIndex = Math.floor(p / SLOTS_PAR_JOUR);
  const slotDansJournee = p % SLOTS_PAR_JOUR;
  const startMinutes = HEURE_DEBUT_JOURNEE_MINUTES + slotDansJournee * MINUTES_PAR_SLOT;
  const durationMinutes = d * MINUTES_PAR_SLOT;

  return { dayIndex, startMinutes, durationMinutes };
}

/**
 * Parse le champ `dom` (récurrence annuelle) en tableau de numéros de semaine.
 * Format observé : "[1..6,8..13]" → plages séparées par virgules, "a..b" = intervalle inclusif.
 *
 * @param {string} dom - ex: "[1..6,8..13]" ou "[1]"
 * @returns {number[]} ex: [1,2,3,4,5,6,8,9,10,11,12,13]
 */
export function parseDom(dom) {
  const contenu = dom.replace(/[[\]]/g, '');
  return contenu.split(',').flatMap((partie) => {
    if (partie.includes('..')) {
      const [debut, fin] = partie.split('..').map(Number);
      return Array.from({ length: fin - debut + 1 }, (_, i) => debut + i);
    }
    return [Number(partie)];
  });
}

/**
 * Date du lundi de la semaine 1 de l'année scolaire — sert de référence pour
 * convertir un numéro de semaine PRONOTE en date calendaire réelle.
 * À confirmer/ajuster chaque année scolaire si le projet est reconduit.
 */
export const SEMAINE_1_LUNDI_ISO = '2026-09-14';

/**
 * Calcule la date du lundi d'une semaine PRONOTE donnée.
 * @param {number} weekNumber - numéro de semaine PRONOTE (1 à 54)
 * @param {string} [referenceMondayISO] - date ISO du lundi de la semaine 1
 * @returns {Date}
 */
export function mondayOfWeek(weekNumber, referenceMondayISO = SEMAINE_1_LUNDI_ISO) {
  const reference = new Date(`${referenceMondayISO}T00:00:00`);
  const monday = new Date(reference);
  monday.setDate(reference.getDate() + (weekNumber - 1) * 7);
  return monday;
}

/**
 * Calcule la date/heure de début réelle d'une occurrence de cours.
 *
 * @param {number} weekNumber - numéro de semaine PRONOTE (issu de `dom`)
 * @param {number} dayIndex - 0 = lundi ... 4 = vendredi (issu de decodeCoursePosition)
 * @param {number} startMinutes - minutes depuis minuit (issu de decodeCoursePosition)
 * @returns {Date}
 */
export function courseStartDateTime(weekNumber, dayIndex, startMinutes) {
  const date = mondayOfWeek(weekNumber);
  date.setDate(date.getDate() + dayIndex);
  date.setMinutes(date.getMinutes() + startMinutes);
  return date;
}
