'use client'; // Cette page est interactive (clics, état) -> elle tourne dans le
// navigateur de l'élève, pas seulement sur le serveur. C'est ce que "use client"
// déclare à Next.js. Sans ça, on ne pourrait pas utiliser useState/onClick ici.

import { useEffect, useState } from 'react';

// Les 3 étapes du formulaire : choisir une classe -> choisir ses cours -> récupérer son lien.
// L'étape COURS peut se répéter plusieurs fois (redoublants : plusieurs classes/années).
const ETAPES = { CLASSE: 'classe', COURS: 'cours', LIEN: 'lien' };

const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

function formatHeure(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}`;
}

export default function Home() {
  // useState renvoie [valeur actuelle, fonction pour la changer]. Appeler le
  // "setter" (ex: setEtape) redéclenche un rendu du composant avec la nouvelle valeur.
  const [etape, setEtape] = useState(ETAPES.CLASSE);

  const [classes, setClasses] = useState([]);
  const [classesChargees, setClassesChargees] = useState(false);

  // Les classes déjà configurées (label + cours décochés) — un élève normal
  // n'en aura qu'une ; un redoublant peut en cumuler plusieurs.
  const [classesAjoutees, setClassesAjoutees] = useState([]);

  // La classe en cours de configuration à l'étape COURS.
  const [classeEnCours, setClasseEnCours] = useState(null); // { id, label }
  const [coursDeLaClasse, setCoursDeLaClasse] = useState([]);
  const [coursCoches, setCoursCoches] = useState(new Set());
  const [chargementCours, setChargementCours] = useState(false);

  const [lien, setLien] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);

  // useEffect exécute du code après le rendu — ici, une seule fois au chargement
  // de la page (tableau de dépendances vide `[]`), pour aller chercher la liste
  // des classes depuis notre API.
  useEffect(() => {
    fetch('/api/classes')
      .then((res) => res.json())
      .then((data) => setClasses(data.classes))
      .catch(() => setErreur('Impossible de charger la liste des classes.'))
      .finally(() => setClassesChargees(true));
  }, []);

  async function choisirClasse(c) {
    setChargementCours(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/classes/${encodeURIComponent(c.id)}/courses`);
      if (!res.ok) throw new Error('classe introuvable');
      const data = await res.json();
      setClasseEnCours(c);
      setCoursDeLaClasse(data.courses);
      // Par défaut, tous les cours sont inclus — l'élève décoche ceux qu'il ne suit pas.
      setCoursCoches(new Set(data.courses.map((co) => co.uid)));
      setEtape(ETAPES.COURS);
    } catch {
      setErreur('Impossible de charger les cours de cette classe.');
    } finally {
      setChargementCours(false);
    }
  }

  function basculerCours(uid) {
    setCoursCoches((precedent) => {
      // On part toujours de l'état précédent pour construire le nouveau Set —
      // ne jamais modifier `precedent` directement (règle d'or de React : l'état
      // est immuable, on doit toujours en créer une nouvelle version).
      const suivant = new Set(precedent);
      if (suivant.has(uid)) suivant.delete(uid);
      else suivant.add(uid);
      return suivant;
    });
  }

  // Range la classe en cours de configuration dans la liste finalisée, et
  // renvoie la liste à jour (utile car setState est asynchrone : on ne peut
  // pas relire `classesAjoutees` juste après l'avoir appelé).
  //
  // `classeEnCours` peut être null : c'est le cas quand on arrive ici depuis
  // l'étape CLASSE via "Terminer, générer mon lien" (voir plus bas) — aucune
  // classe n'est en cours de configuration, on part juste de ce qui est déjà
  // dans `classesAjoutees`.
  function finaliserClasseEnCours() {
    if (!classeEnCours) return classesAjoutees;

    const excludedCourseUids = coursDeLaClasse
      .map((c) => c.uid)
      .filter((uid) => !coursCoches.has(uid));

    const entree = { classId: classeEnCours.id, label: classeEnCours.label, excludedCourseUids };
    const suivant = [...classesAjoutees, entree];
    setClassesAjoutees(suivant);
    return suivant;
  }

  function ajouterUneAutreClasse() {
    finaliserClasseEnCours();
    setClasseEnCours(null);
    setCoursDeLaClasse([]);
    setCoursCoches(new Set());
    setEtape(ETAPES.CLASSE);
  }

  async function genererLien() {
    const toutesLesClasses = finaliserClasseEnCours();

    setEnvoiEnCours(true);
    setErreur(null);
    try {
      const res = await fetch('/api/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections: toutesLesClasses.map(({ classId, excludedCourseUids }) => ({
            classId,
            excludedCourseUids,
          })),
        }),
      });
      if (!res.ok) throw new Error('échec de la création du lien');
      const { token } = await res.json();
      setLien({
        webcal: `webcal://${window.location.host}/api/calendar/${token}`,
        https: `${window.location.origin}/api/calendar/${token}`,
      });
      setEtape(ETAPES.LIEN);
    } catch {
      setErreur('Impossible de générer ton lien pour le moment, réessaie.');
    } finally {
      setEnvoiEnCours(false);
    }
  }

  // À l'étape "choisir une classe", on masque celles déjà ajoutées (pas de
  // double sélection de la même classe).
  const classesDisponibles = classes.filter(
    (c) => !classesAjoutees.some((a) => a.classId === c.id),
  );

  return (
    <div className="min-h-dvh bg-zinc-50 px-4 py-10 dark:bg-black">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6">
        <header className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">HyperICS</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Ton horaire PRONOTE directement dans ton calendrier.
          </p>
        </header>

        {classesAjoutees.length > 0 && etape !== ETAPES.LIEN && (
          <p className="text-xs text-zinc-500">
            Classe{classesAjoutees.length > 1 ? 's' : ''} déjà ajoutée
            {classesAjoutees.length > 1 ? 's' : ''} :{' '}
            {classesAjoutees.map((c) => c.label).join(', ')}
          </p>
        )}

        {erreur && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {erreur}
          </p>
        )}

        {etape === ETAPES.CLASSE && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {classesAjoutees.length === 0 ? '1. Choisis ta classe' : 'Choisis ta seconde classe'}
            </h2>
            {classesAjoutees.length > 0 && (
              <p className="text-xs text-zinc-500">
                Pour les redoublants : cumule les classes de tes deux années.
              </p>
            )}
            {!classesChargees ? (
              <p className="text-sm text-zinc-500">Chargement des classes...</p>
            ) : (
              <ul className="flex flex-col divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                {classesDisponibles.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => choisirClasse(c)}
                      disabled={chargementCours}
                      className="w-full px-4 py-3 text-left text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {classesAjoutees.length > 0 && (
              <button
                type="button"
                onClick={genererLien}
                disabled={envoiEnCours}
                className="rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
              >
                {envoiEnCours ? 'Génération...' : 'Terminer, générer mon lien'}
              </button>
            )}
          </section>
        )}

        {etape === ETAPES.COURS && (
          <section className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setEtape(ETAPES.CLASSE)}
              className="self-start text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              ← Changer de classe
            </button>
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Décoche les cours que tu ne suis pas — {classeEnCours?.label}
            </h2>
            <ul className="flex flex-col divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {coursDeLaClasse.map((c) => (
                <li key={c.uid} className="flex items-start gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={coursCoches.has(c.uid)}
                    onChange={() => basculerCours(c.uid)}
                    className="mt-1 h-4 w-4 shrink-0 accent-zinc-900 dark:accent-zinc-50"
                  />
                  <button
                    type="button"
                    onClick={() => basculerCours(c.uid)}
                    className="flex-1 text-left"
                  >
                    <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {c.subject || 'Cours'}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {JOURS[c.dayIndex] ?? '?'} {formatHeure(c.startMinutes)}
                      {c.teacher ? ` · ${c.teacher}` : ''}
                      {c.room ? ` · ${c.room}` : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={genererLien}
              disabled={envoiEnCours || coursCoches.size === 0}
              className="rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
            >
              {envoiEnCours ? 'Génération...' : `Générer mon lien (${coursCoches.size} cours)`}
            </button>
            <button
              type="button"
              onClick={ajouterUneAutreClasse}
              disabled={envoiEnCours || coursCoches.size === 0}
              className="rounded-full border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
            >
              + Ajouter une autre classe (redoublant)
            </button>
          </section>
        )}

        {etape === ETAPES.LIEN && lien && (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Abonne-toi dans ton calendrier
            </h2>
            <a
              href={lien.webcal}
              className="rounded-full bg-zinc-900 px-5 py-3 text-center text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
            >
              S&apos;abonner (Apple/Google Calendar)
            </a>
            <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-1 text-xs text-zinc-500">
                Ou copie ce lien manuellement dans ton appli calendrier :
              </p>
              <code className="block break-all text-xs text-zinc-700 dark:text-zinc-300">
                {lien.https}
              </code>
            </div>
            <p className="text-xs text-zinc-500">
              Garde ce lien précieusement — c&apos;est lui qui donne accès à ton horaire, personne
              d&apos;autre ne peut le retrouver si tu le perds.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
