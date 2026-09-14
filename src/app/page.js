'use client'; // Cette page est interactive (clics, état) -> elle tourne dans le
// navigateur de l'élève, pas seulement sur le serveur. C'est ce que "use client"
// déclare à Next.js. Sans ça, on ne pourrait pas utiliser useState/onClick ici.

import { useEffect, useState } from 'react';

// Les 3 étapes du formulaire : choisir sa classe -> choisir ses cours -> récupérer son lien.
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
  const [classeId, setClasseId] = useState('');

  const [cours, setCours] = useState([]);
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

  async function choisirClasse(id) {
    setClasseId(id);
    setChargementCours(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/classes/${encodeURIComponent(id)}/courses`);
      if (!res.ok) throw new Error('classe introuvable');
      const data = await res.json();
      setCours(data.courses);
      // Par défaut, tous les cours sont inclus — l'élève décoche ceux qu'il ne suit pas.
      setCoursCoches(new Set(data.courses.map((c) => c.uid)));
      setEtape(ETAPES.COURS);
    } catch {
      setErreur("Impossible de charger les cours de cette classe.");
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

  async function genererLien() {
    setEnvoiEnCours(true);
    setErreur(null);
    try {
      const res = await fetch('/api/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections: [{ classId: classeId, includedCourseUids: [...coursCoches] }],
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

  return (
    <div className="min-h-dvh bg-zinc-50 px-4 py-10 dark:bg-black">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6">
        <header className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">HyperICS</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Ton horaire PRONOTE directement dans ton calendrier.
          </p>
        </header>

        {erreur && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {erreur}
          </p>
        )}

        {etape === ETAPES.CLASSE && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              1. Choisis ta classe
            </h2>
            {!classesChargees ? (
              <p className="text-sm text-zinc-500">Chargement des classes...</p>
            ) : (
              <ul className="flex flex-col divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                {classes.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => choisirClasse(c.id)}
                      disabled={chargementCours}
                      className="w-full px-4 py-3 text-left text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
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
              2. Décoche les cours que tu ne suis pas
            </h2>
            <ul className="flex flex-col divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {cours.map((c) => (
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
          </section>
        )}

        {etape === ETAPES.LIEN && lien && (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              3. Abonne-toi dans ton calendrier
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
