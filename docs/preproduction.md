# HyperICS — Notes de préproduction

> Référence technique et produit issue de la phase de cadrage (13-14 sept. 2026), avant développement.
> Version détaillée/collaborative : voir la page Notion "Préproduction — Questions à trancher" (sous HyperICS).

## 1. Pitch

Mini-app qui génère un flux `.ics` (calendrier) par classe à partir des horaires publiés par l'école
sur PRONOTE Campus (Espace Invité), pour que les élèves puissent voir leur horaire directement dans
Apple Calendar / Google Calendar / etc., sans devoir se connecter à la plateforme à chaque fois.

**Problème résolu** : l'export `.ics` natif d'Hyperplanning/PRONOTE n'est pas activé par l'école (HEFF).
Les élèves doivent se connecter manuellement et sélectionner l'année scolaire pour voir leur horaire —
pénible, surtout pour ceux ayant des cours répartis sur deux années différentes.

**Contexte** : rentrée scolaire le 14/09/2026 — lancement visé au plus vite (délai max 1-2 semaines).

## 2. Utilisateurs & périmètre

- Cible : élèves de la HEFF (15-18 ans), ~20 utilisateurs attendus au lancement, jusqu'à ~1000 max.
- **Zéro compte, zéro login** : chaque élève configure sa sélection de cours une fois et reçoit un lien
  unique/anon (`/calendar/{token}`) qu'il s'abonne dans son calendrier. Les updates arrivent auto si
  PRONOTE change.
- MVP : sélectionner classe(s) + année(s) + cours → obtenir un lien webcal unique → s'y abonner.
- Nice-to-have (V2+) : synchronisation temps réel, notifications ciblées, compte optionnel pour
  retrouver une ancienne sélection.
- Pas de dimension sociale, pas de multi-langue (français uniquement).
- Design : minimaliste, mobile-first, identité visuelle entièrement à créer.

### 2.1. Architecture : source commune, sélections anon

L'école permet aux élèves de choisir parmi les cours proposés (certains optionnels/électifs). De plus,
les redoublants mélangent des cours de l'année actuelle et de l'année précédente (ex: validé 75% des
cours année N, redouble donc 25% année N + tous les cours année N+1).

**Conséquence** : chaque élève a une sélection unique. **Approche** : pas de compte/identité stockée,
juste un token opaque qui mappe une sélection donnée :
- Élève configure une fois : classe(s), année(s), cours inclus/exclus.
- Backend génère un token unique (`abc123...`) et stocke : `{token: "abc123...", sélection: {...}}`
- Élève reçoit lien : `/calendar/abc123...` → s'y abonne dans son calendrier (webcal).
- À chaque sync calendrier, le backend lit la sélection derrière le token, filtre les cours PRONOTE,
  génère le `.ics` frais.

**Avantages** : zéro RGPD (pas d'identité), zéro login, ultra-simple MVP, facile à partager (un élève
peut donner son lien à un copain). Seul risque : perte du lien → reconfigurer (acceptable).

## 3. Modèle économique & contraintes

- Gratuit, pas de monétisation.
- Solo dev (moi), budget ~0€.
- Hébergement prévu : gratuit managé (type Vercel/Netlify + Supabase/Firebase si stockage nécessaire).
- KPI de succès initial : ~10 utilisateurs actifs.
- Feedback : formulaire simple pour bugs/commentaires.

## 4. Accès aux données — validé techniquement ✅

Source des horaires : **PRONOTE Campus, Espace Invité**, accessible sans identifiant à
`https://heffpm.hyperplanning.fr/hp/invite`.

### Fonctionnement observé (tests du 13 et 14/09/2026)

- L'URL ne change jamais quelle que soit la classe/année choisie dans les sélecteurs — c'est une SPA
  (Angular) qui communique via des appels JSON en arrière-plan.
- Au chargement, une session numérique est créée (ex. `699797`, `1149858`, différente à chaque visite).
  Tous les appels suivants passent par `POST /hp/appelfonction/2/{session}/{hash}`.
- **Liste des classes** : un appel `FonctionRenvoyerListeDeRessource` renvoie la liste complète des
  classes ("promotions", ~60 pour la HEFF Waterside) avec un identifiant **stable** par classe :
  ```json
  {"L":"1AT","N":"50#Xes_vNhr_5QJ9bFZVfoz0VhMPYvI76jXtzHCDUVrGNM","G":1}
  ```
  → à mapper/cacher une bonne fois pour toutes (nom lisible ↔ identifiant PRONOTE).

- **Horaire d'une classe** : un appel `FonctionEmploiDuTemps` renvoie les cours en JSON **lisible, non
  chiffré**. Exemple d'entrée de cours réelle (classe 3TI Web, test du 14/09) :
  ```json
  {
    "N": "10#xcFqU2mdeydfhYyTFuLJ2G_5YXiie9z_bFh1Nx0YGfk",
    "p": 28, "d": 6,
    "dom": "[1..6,8..13]",
    "listeC": [
      {"G": 14, "C": [{"L": "<3TI Web>TWEB-501"}]},
      {"G": 0,  "C": {"L": "Nouvelle technologie Q5"}},
      {"G": 1,  "C": [{"L": "Lemal"}]},
      {"G": 3,  "C": [{"L": "L346"}]},
      {"G": 5,  "C": {}}
    ]
  }
  ```
  Codes de contenu (`G` dans `listeC`) identifiés : `0` = matière, `1` = professeur(s), `3` = salle,
  `5` = commentaire libre (ex. convocation à une réunion), `14` = groupe/classe.

  Champs clés au niveau du cours :
  - `p` / `d` : position et durée dans la grille horaire (granularité à finir de décoder — probablement
    liée au réglage "Nombre de séquences horaires maximum" vu dans les préférences d'affichage, = 13).
  - `dom` : liste des **numéros de semaine** (1 à 54, cf. sélecteur de semaines du site) où ce cours
    récurre sur l'année. **Une seule requête par classe suffit donc probablement à capter tout le
    pattern annuel**, pas besoin de re-scraper semaine par semaine.
  - `ListeAnnulationsCours` (au niveau de la réponse) : liste séparée des annulations ponctuelles —
    permet de garder le `.ics` à jour sans tout re-scraper.

### Conséquences pour l'architecture

- **Source commune, tokens anonymes** : PRONOTE sert les horaires complets par classe (une seule
  requête par classe suffit, cf. champ `dom` de récurrence annuelle). Chaque élève reçoit un token
  opaque → backend cherche la sélection derrière le token → filtre + génère `.ics` frais.
- **Zéro données personnelles** : pas d'email, pas de nom, juste `{token, sélection}` anon. RGPD
  minimal (pas de données identifiantes, donc peu de droits d'accès/suppression à gérer). Rétention
  simple : poubelle les tokens après X mois d'inactivité.
- **Scalabilité optimisée** : source = ~60 classes à interroger max, cachée. Clients = jusqu'à ~1000
  tokens anon, mais génération `.ics` = juste un filtre sur les données brutes → quasi pas de charge.
  Pas de requête PRONOTE par élève, une bonne fois par jour suffit.
- Le backend doit : 1) initialiser une session PRONOTE sur `/hp/invite`, 2) récupérer liste classes
  une fois (cache), 3) boucle quotidienne : pour chaque classe, appeler `FonctionEmploiDuTemps` →
  stocker/mettre à jour en mémoire ou cache léger, 4) à la demande d'un token, charger sa sélection,
  filtrer les cours, générer son `.ics` perso.
- Reste à faire avant de coder le générateur `.ics` : finir de décoder `p`/`d` en heure de début/fin
  réelle (comparer plusieurs cours connus visuellement sur la grille pour caler l'échelle).

### Point de vigilance

Ce mécanisme n'est pas une API documentée/officielle — c'est de la rétro-ingénierie d'un endpoint
public (accès libre, sans identifiant). Usage prévu : interne à l'école, sans but commercial, sans
requêtes abusives (fréquence de rafraîchissement raisonnable, ex. quelques fois par jour).

## 5. Décisions techniques prises

| Sujet | Décision |
|---|---|
| Plateformes cibles | Web app (iOS via Safari/PWA, Android possible plus tard) |
| Type d'app | Web App (pas de natif) |
| Auth | **Aucune** — lien unique/token par sélection, zéro login, zéro compte |
| Hébergement | Gratuit managé (Vercel/Netlify pour le front + Edge Functions/Supabase pour le backend léger) |
| Modèle de données | Token opaque → sélection anon (classe(s), année(s), cours inclus/exclus). Source PRONOTE (classe → tous cours) stockée en cache/mémoire, rafraîchie ~quotidien. |
| API externe | Scraping PRONOTE `/hp/invite` en backend (public, sans auth) pour les horaires bruts. Pas d'API tierce officielle utilisée. |
| Stockage | Juste `{token: "abc123...", sélection: {...}}` anon — pas d'identité, pas de RGPD lourd. Poubelle tokens après ~3 mois inactivité. |

## 6. Prochaines étapes

### Phase 1 : Infrastructure & générateur `.ics`
1. Décoder précisément `p`/`d` → heures réelles de début/fin de cours (benchmark sur grille visuelle PRONOTE).
2. Choisir la stack :
   - **Front** : React/Vue/Svelte léger, hébergé sur Vercel/Netlify.
   - **Backend** : Vercel Functions ou Supabase Edge Functions pour scraping + génération `.ics`.
   - **Données** : cache en mémoire (Redis, ou simple JSON reloadé) pour les horaires PRONOTE bruts +
     KV store léger (Vercel KV, Supabase) pour tokens/sélections anon.
3. Construire le scraper backend (cron quotidien) :
   - Bootstrap session PRONOTE sur `/hp/invite` (sans identifiant).
   - Récupérer liste des classes une fois (cache stable).
   - Pour chaque classe, appeler `FonctionEmploiDuTemps` → stocker/mettre à jour en mémoire/KV.
   - Détecter annulations ponctuelles (`ListeAnnulationsCours`).
4. Générateur `.ics` :
   - Endpoint `/api/calendar/{token}` qui récupère la sélection derrière le token.
   - Filtre les cours PRONOTE selon la sélection.
   - Convertit en `.ics` (iCalendar format), retourne flux webcal (content-type `text/calendar`).

### Phase 2 : Interface & tokens
5. Interface minimale (form mobile-first) :
   - Choix classe(s) + année(s) → sélection cours (checkboxes par matière).
   - Bouton "Générer mon lien" → backend crée token unique, stocke sélection.
   - Retourne lien `/calendar/{token}` → copie en clipboard, s'abonne dans calendrier (webcal://).
6. Page "Récupérer mon lien" (optionnel MVP) : retrouver via token URL ou régénérer.

### Phase 3 : Lancement
7. Déploiement sur Vercel/Netlify + KV store (très rapide, quelques heures).
8. Test alpha avec ~3 élèves de classes différentes → feedback sur UX, horaires corrects, updates.
9. Déploiement public + diffusion via groupes WhatsApp de classe.
10. Monitoring simple : erreurs, nombre de tokens actifs (KPI initial : 10 utilisateurs).
