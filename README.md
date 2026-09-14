# HyperICS

Mini-app qui génère un flux `.ics` (calendrier) personnalisé par élève à partir des horaires
publiés par l'école sur **PRONOTE Campus (Espace Invité)**, pour le consulter directement dans
Apple Calendar, Google Calendar, etc. — sans avoir à se reconnecter à la plateforme à chaque fois.

**Pourquoi** : l'export `.ics` natif de PRONOTE n'est pas activé par l'école (HEFF). Les élèves
doivent se connecter manuellement et sélectionner l'année scolaire à chaque consultation — pénible,
surtout pour ceux ayant des cours répartis sur deux années différentes (redoublants).

**Zéro compte, zéro login** : chaque élève configure sa sélection de cours une fois (classe(s),
année(s), cours à inclure/exclure) et reçoit un lien unique à s'abonner dans son calendrier. Pas de
données personnelles stockées.

## Statut

🚧 En développement actif — voir [`docs/`](./docs) pour le détail des décisions produit et techniques.

## Documentation

- [`docs/preproduction.md`](./docs/preproduction.md) — cadrage produit, accès aux données PRONOTE, décisions prises
- [`docs/architecture.md`](./docs/architecture.md) — architecture technique, stack, flux de scraping et de génération `.ics`

## Stack

- **[Next.js](https://nextjs.org)** (App Router, JavaScript) — front + routes API dans un seul projet
- **[Vercel](https://vercel.com)** — hébergement gratuit du front et du backend
- **Vercel KV** (Redis managé) — stockage clé-valeur des sélections (`token → sélection`) et du cache d'horaires PRONOTE
- **GitHub Actions** — déclenche le scraping PRONOTE de façon planifiée (contourne la limite de fréquence du cron Vercel gratuit)
- **[`ics`](https://www.npmjs.com/package/ics)** — génération du fichier calendrier au format iCalendar

Voir [`docs/architecture.md`](./docs/architecture.md) pour le détail des choix et des alternatives écartées.

## Lancer le projet en local

Prérequis : [Node.js](https://nodejs.org) (v20+).

```bash
npm install
npm run dev
```

Le site est ensuite accessible sur [http://localhost:3000](http://localhost:3000).

## Contribuer

Projet open source sous licence MIT (voir [`LICENSE`](./LICENSE)). Les issues et pull requests sont
les bienvenues, notamment de la part d'élèves d'autres écoles utilisant PRONOTE/Hyperplanning.

⚠️ Le scraping repose sur un endpoint public non-documenté de PRONOTE (voir
[`docs/architecture.md`](./docs/architecture.md#7-point-de-vigilance-rappel-de-la-préprod)) — merci
de garder toute contribution respectueuse d'un usage raisonnable (pas de sur-sollicitation du
serveur de l'école).

## Licence

[MIT](./LICENSE) © 2026 Moïse Lukebanu
