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
 * Calcule la date du lundi d'une semaine PRONOTE donnée, en arithmétique UTC
 * pure (jours entiers uniquement — sans heure, donc sans ambiguïté de fuseau).
 *
 * @param {number} weekNumber - numéro de semaine PRONOTE (1 à 54)
 * @param {string} [referenceMondayISO] - date ISO du lundi de la semaine 1
 * @returns {Date} minuit UTC du lundi correspondant (sert de repère calendaire,
 *   pas un instant réel — voir courseStartDateTime pour l'heure précise)
 */
export function mondayOfWeek(weekNumber, referenceMondayISO = SEMAINE_1_LUNDI_ISO) {
  const [annee, mois, jour] = referenceMondayISO.split('-').map(Number);
  const referenceMs = Date.UTC(annee, mois - 1, jour);
  const lundiMs = referenceMs + (weekNumber - 1) * 7 * 24 * 60 * 60 * 1000;
  return new Date(lundiMs);
}

// PRONOTE (HEFF) est en Belgique : l'heure affichée est toujours l'heure de
// Bruxelles (CET l'hiver = UTC+1, CEST l'été = UTC+2), quel que soit le
// fuseau horaire du serveur qui exécute ce code (Vercel/GitHub Actions
// tournent en UTC). On calcule donc le décalage nous-mêmes plutôt que de
// laisser l'objet Date natif interpréter les heures dans le fuseau local du
// serveur — sinon le résultat serait faux dès que ce code tourne ailleurs
// que sur une machine réglée en heure belge (voir docs/architecture.md §6bis).

/** Dernier dimanche du mois donné, à 01h00 UTC (instant du changement d'heure UE). */
function dernierDimancheUTC(annee, moisIndex0) {
  // Le jour 0 du mois suivant = le dernier jour du mois courant.
  const dernierJour = new Date(Date.UTC(annee, moisIndex0 + 1, 0, 1, 0, 0));
  dernierJour.setUTCDate(dernierJour.getUTCDate() - dernierJour.getUTCDay());
  return dernierJour;
}

/**
 * Décalage (en minutes) entre l'heure de Bruxelles et UTC pour une date UTC
 * donnée : +120 (CEST, été) ou +60 (CET, hiver). Règle UE : le changement a
 * lieu à 01h00 UTC le dernier dimanche de mars (hiver→été) et d'octobre
 * (été→hiver).
 */
function decalageBruxellesMinutes(dateUTC) {
  const annee = dateUTC.getUTCFullYear();
  const debutEte = dernierDimancheUTC(annee, 2); // mars
  const finEte = dernierDimancheUTC(annee, 9); // octobre
  const estEte = dateUTC >= debutEte && dateUTC < finEte;
  return estEte ? 120 : 60;
}

/**
 * Calcule l'instant UTC réel de début d'une occurrence de cours, à partir de
 * l'heure locale de Bruxelles décodée (§8). Indépendant du fuseau horaire du
 * serveur qui exécute ce code.
 *
 * @param {number} weekNumber - numéro de semaine PRONOTE (issu de `dom`)
 * @param {number} dayIndex - 0 = lundi ... 4 = vendredi (issu de decodeCoursePosition)
 * @param {number} startMinutes - minutes depuis minuit, heure de Bruxelles (issu de decodeCoursePosition)
 * @returns {Date} l'instant UTC réel (ex: 09h00 heure de Bruxelles en septembre → 07h00 UTC)
 */
export function courseStartDateTime(weekNumber, dayIndex, startMinutes) {
  const lundiMs = mondayOfWeek(weekNumber).getTime();
  const jourMs = lundiMs + dayIndex * 24 * 60 * 60 * 1000;
  const decalage = decalageBruxellesMinutes(new Date(jourMs));
  const instantMs = jourMs + startMinutes * 60 * 1000 - decalage * 60 * 1000;
  return new Date(instantMs);
}
