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
 * @param {{ classId: string, excludedCourseUids?: string[] }[]} selections
 *   `excludedCourseUids` absent/vide = tous les cours de la classe inclus.
 *
 *   Important : liste d'EXCLUSION, pas d'inclusion. Un cours ajouté par
 *   PRONOTE après la création du lien (ex: publié une fois sa date de début
 *   atteinte) a un uid qui n'a jamais pu figurer dans `excludedCourseUids` —
 *   il apparaît donc automatiquement, sans que l'élève ait besoin de
 *   régénérer son lien. Avec une liste d'inclusion, l'inverse se produirait :
 *   un cours inconnu au moment du clic resterait invisible pour toujours.
 * @returns {Promise<object[]>} événements au format attendu par `ics.createEvents`
 */
async function construireEvenements(selections) {
  const evenements = [];

  for (const { classId, excludedCourseUids } of selections) {
    const cours = await getCoursesForClass(classId);
    if (!cours) continue; // classe jamais scrapée (ne devrait pas arriver en usage normal)

    const exclus = new Set(excludedCourseUids || []);
    const coursInclus = cours.filter((c) => !exclus.has(c.uid));

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
 * Ajoute `REFRESH-INTERVAL` (RFC 7986) au calendrier généré.
 *
 * La lib `ics` produit déjà `X-PUBLISHED-TTL:PT1H` (l'ancienne propriété, née
 * chez Microsoft) mais pas son équivalent standardisé. Les deux disent la même
 * chose — « reviens chercher les nouveautés dans 1h » — mais les clients
 * calendrier ne reconnaissent pas tous la même, donc on met les deux.
 *
 * À garder en tête : ce n'est qu'une *suggestion*. Apple/Outlook en tiennent
 * plus ou moins compte, Google Calendar l'ignore et rafraîchit quand il veut
 * (souvent 8-24h). Voir docs/architecture.md §6.
 */
function ajouterRefreshInterval(ics) {
  const propriete = 'REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n';
  // On l'insère juste avant le premier événement (ou avant la fin du calendrier
  // s'il n'y en a aucun) : à cet endroit, elle est toujours au bon niveau, quoi
  // que la lib `ics` ait généré au-dessus.
  const ancre = ics.includes('BEGIN:VEVENT') ? 'BEGIN:VEVENT' : 'END:VCALENDAR';
  return ics.replace(ancre, propriete + ancre);
}

/**
 * Génère le contenu texte d'un fichier .ics pour une sélection d'élève.
 * @param {{ classId: string, excludedCourseUids?: string[] }[]} selections
 * @returns {Promise<string>}
 */
export async function generateIcsForSelections(selections) {
  const evenements = await construireEvenements(selections);
  const { error, value } = createEvents(evenements, {
    productId: 'hyperics',
    // Nom affiché du calendrier dans l'app de l'élève (sinon il verrait l'URL).
    calName: 'HyperICS — mon horaire',
  });
  if (error) throw error;
  return ajouterRefreshInterval(value);
}
