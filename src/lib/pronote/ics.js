/**
 * Génère le contenu d'un fichier .ics à partir de la sélection d'un élève
 * (voir docs/architecture.md §6).
 */
import { createEvents } from 'ics';
import { courseStartDateTime } from './decode.js';
import { getCoursesForClass } from './store.js';

/**
 * Convertit un Date JS (qui contient un instant UTC réel, voir decode.js) en
 * tableau [année, mois, jour, heure, minute] attendu par la lib `ics`.
 *
 * Important : on lit les composantes en UTC (`getUTC*`), pas en heure locale
 * (`get*`) — sinon le résultat dépendrait du fuseau horaire du serveur qui
 * exécute ce code. Combiné à `startInputType: 'utc'` (voir plus bas), la lib
 * `ics` traite ces valeurs comme de l'UTC sans re-conversion.
 */
function versDateIcs(date) {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  ];
}

/**
 * Construit les événements iCalendar (une occurrence par semaine où le cours
 * a lieu) pour une sélection donnée.
 *
 * @param {{ classId: string, includedCourseUids?: string[] }[]} selections
 *   `includedCourseUids` absent/null = tous les cours de la classe inclus.
 * @returns {Promise<object[]>} événements au format attendu par `ics.createEvents`
 */
async function construireEvenements(selections) {
  const evenements = [];

  for (const { classId, includedCourseUids } of selections) {
    const cours = await getCoursesForClass(classId);
    if (!cours) continue; // classe jamais scrapée (ne devrait pas arriver en usage normal)

    const coursInclus = includedCourseUids
      ? cours.filter((c) => includedCourseUids.includes(c.uid))
      : cours;

    for (const c of coursInclus) {
      for (const semaine of c.weeks) {
        const debut = courseStartDateTime(semaine, c.dayIndex, c.startMinutes);
        evenements.push({
          start: versDateIcs(debut),
          startInputType: 'utc', // debut est déjà un instant UTC réel (voir decode.js)
          duration: { minutes: c.durationMinutes },
          title: c.subject || 'Cours',
          location: c.room || undefined,
          description: c.teacher ? `Prof. ${c.teacher}` : undefined,
          uid: `${c.uid}-s${semaine}@hyperics`,
        });
      }
    }
  }

  return evenements;
}

/**
 * Génère le contenu texte d'un fichier .ics pour une sélection d'élève.
 * @param {{ classId: string, includedCourseUids?: string[] }[]} selections
 * @returns {Promise<string>}
 */
export async function generateIcsForSelections(selections) {
  const evenements = await construireEvenements(selections);
  const { error, value } = createEvents(evenements);
  if (error) throw error;
  return value;
}
