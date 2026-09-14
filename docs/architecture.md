# HyperICS — Architecture technique

> Basé sur [`docs/preproduction.md`](./preproduction.md) (v2, zéro compte/zéro login).
> Statut : proposition validée en discussion, à jour au 14/09/2026.

## 1. Vue d'ensemble

```
┌─────────────┐   formulaire (classe/année/cours)   ┌──────────────────────┐
│   Élève     │ ────────────────────────────────────▶│  Frontend (Next.js)  │
│ (navigateur)│◀──── lien webcal/{token} ─────────────│  déployé sur Vercel  │
└─────────────┘                                       └──────────┬───────────┘
                                                                  │ API routes
                                                                  ▼
                                                       ┌──────────────────────┐
                                                       │  Redis (Vercel        │
                                                       │  Storage, provider    │
                                                       │  Redis officiel)      │
                                                       │  classes:list         │
                                                       │  courses:{classId}    │
                                                       │  cancellations:{id}   │
                                                       │  token:{token}        │
                                                       └──────────┬───────────┘
                                                                  ▲
                                       connexion Redis directe (REDIS_URL, npm `redis`)
                                                                  │
┌─────────────┐   navigation réelle (Playwright)   ┌──────────────────────────┐
│   PRONOTE   │◀─────────────────────────────────── │  GitHub Actions          │
│ Espace Invité│  (le protocole est chiffré AES     │  1x/h, 6h-18h            │
└─────────────┘   côté client — cf §8bis)           │  scraper Node+Playwright │
                                                      └──────────────────────────┘

┌──────────────────┐   GET webcal://.../calendar/{token}
│ Apple/Google Cal  │ ────────────────────────────────────▶ /api/calendar/[token]
└──────────────────┘   ◀─── .ics généré à la volée (lecture Redis + filtre + ics)
```

**Changements clés par rapport à la première version** :
- Le scraper ne tourne plus dans une route API Vercel — il tourne **directement dans le job GitHub
  Actions**, qui pilote un vrai navigateur headless (Playwright). Raison détaillée en §8bis.
- "Vercel KV" (le produit d'origine) est déprécié — remplacé par une intégration Marketplace
  **Redis** (provider Redis officiel), avec le même modèle clé-valeur. Le scraper et l'app Next.js
  s'y connectent directement via `REDIS_URL` (client npm `redis`, protocole Redis standard), pas via
  une API REST comme envisagé initialement.

## 2. Stack retenue

| Brique | Choix | Rôle |
|---|---|---|
| **Front + API** | **Next.js** (App Router) sur **Vercel** | Un seul projet pour l'interface (formulaire) et le backend (routes API) |
| **Stockage** | **Redis** (Vercel Storage → Marketplace, provider Redis, free tier) | Modèle clé-valeur : `token → sélection`, `classId → cours`, pas besoin de relationnel. Connexion via `REDIS_URL` + client npm `redis` |
| **Scraping** | **Node + Playwright**, exécuté **dans le job GitHub Actions** (pas sur Vercel) | Le protocole PRONOTE est chiffré côté client (AES) — il faut un vrai navigateur pour le piloter. Écrit ensuite dans Redis directement (même `REDIS_URL`, exposé en secret GitHub Actions) |
| **Déclenchement du scraping** | **GitHub Actions (cron)**, 1x/h 6h-18h | Vercel Cron gratuit = 1x/jour max ; GitHub Actions permet une fréquence horaire gratuitement, et n'a pas la limite de 10s des fonctions Vercel (nécessaire pour Playwright) |
| **Génération `.ics`** | Lib `ics` (npm) dans `/api/calendar/[token]` | Génération à la volée à chaque appel du client calendrier, jamais de fichier stocké |
| **Rétention** | TTL Redis sur `token:{token}` (~90j), reset à chaque accès | Auto-nettoyage, pas de job de purge à écrire |

Voir échanges précédents pour le détail des alternatives écartées (PHP+VPS, MySQL/Postgres, Supabase/Firebase, Vercel Cron seul) — non repris ici pour rester synthétique.

## 3. Fréquence de scraping : 1x/h entre 6h et 18h

### Planning (GitHub Actions)

```yaml
on:
  schedule:
    - cron: '0 4-16 * * *'   # toutes les heures, 6h-18h heure Belgique (CEST, été)
```

**Note fuseau horaire** : GitHub Actions planifie en UTC. `4-16 UTC` correspond à `6h-18h` en CEST (été, applicable à la rentrée de septembre). Au passage en heure d'hiver (CET, fin octobre), le planning glissera d'1h (`5h-17h` local) — décalage accepté sans ajustement manuel, impact négligeable sur l'objectif (éviter le scraping nocturne).

→ **13 cycles/jour** (6h, 7h, ..., 18h), largement sous la contrainte "max 3x/jour".

### Volume de requêtes estimé — et mesuré ✅

Un cycle = 1 chargement de `/hp/invite` + 1 sélection par classe scrapée. Avec les ~60 classes : ~13 cycles/jour × 60 classes = ~780 "sélections classe" par jour, ~60/h en un seul burst horaire. Comparable ou inférieur au trafic organique qu'aurait généré un usage manuel de PRONOTE par une centaine d'élèves — pas un pattern qui ressemble à de l'abus (voir § 7, point de vigilance).

**Mesuré en local** (14/09/2026, scraper Playwright réel) : ~4,4s pour 8 classes → **~33s pour scraper les 60 classes**, délai anti-burst inclus. Bien plus rapide que l'estimation initiale (2-3 min) — un cycle horaire complet a une marge confortable.

### Bonnes pratiques appliquées

1. **Sélections séquentielles avec délai** (~200-500ms entre chaque classe) plutôt qu'en parallèle → évite un pic brutal de requêtes simultanées.
2. **`classes:list` cachée séparément et rafraîchie en hebdo seulement** (mapping nom↔ID stable) → pas besoin de la re-scraper à chaque cycle horaire, juste vérifiée/mise à jour une fois par semaine.

## 4. Simplification : on scrape toutes les classes à chaque cycle

Une première version de cette archi prévoyait de ne scraper que les classes "actives" (utilisées par
au moins un token), pour économiser du temps d'exécution sur les fonctions Vercel (limitées à 10s).

**Ce n'est plus nécessaire** : le scraper tourne maintenant dans un job GitHub Actions (§8bis), qui n'a
pas cette limite de 10s — scraper les ~60 classes prend quelques minutes, largement dans le budget
d'un cycle horaire. Complexité évitée : plus besoin d'un index `active_classes`, ni de "scrape à la
demande" quand un élève choisit une classe jamais vue (source de latence UX et de code en plus).

**Compromis accepté** : on scrape ~60 classes/cycle au lieu de 5-15, ce qui reste dans une fourchette
raisonnable de trafic vis-à-vis de PRONOTE (voir volume estimé en §3, déjà comptabilisé pour 60
classes). Si jamais le volume devenait un problème réel en production, réintroduire un filtre par
classes actives reste possible sans tout redesigner (juste rajouter un index et une condition dans la
boucle du scraper).

## 5. Structure des clés Redis

Format réellement implémenté (voir [`src/lib/pronote/store.js`](../src/lib/pronote/store.js) et
[`decode.js`](../src/lib/pronote/decode.js)) :

```
classes:list                → [{ id, label }, ...]                       # cache, toutes classes
                                                                           # id = "N" PRONOTE (stable),
                                                                           # ex: "50#tmc4QgD_..."
courses:{classId}           → [{ uid, dayIndex, startMinutes,
                                  durationMinutes, weeks: number[],
                                  subject, teacher, room, comment }, ...] # cache horaire, toutes les classes
cancellations:{classId}     → [{ courseUid, week, date }, ...]           # pas encore implémenté

token:{token}                → {
                                  selections: [
                                    { classId, schoolYear, includedCourseUids: [...] }
                                  ],
                                  createdAt, lastAccessAt
                                }                                        # TTL ~90j, reset à chaque GET
                                                                           # (pas encore implémenté)
```

Le cas redoublant reste géré nativement : `selections` est un tableau, donc un redoublant a deux entrées (année N-1 partielle + année N complète) sous le même token.

## 6. Flux clé : génération du `.ics`

1. `GET /api/calendar/{token}` (appelé périodiquement par le client calendrier — Apple/Google Calendar, en pull, pas en push).
2. Lire `token:{token}` dans Redis → absent (expiré/inconnu) → 404.
3. Reset du TTL (`EXPIRE token:{token} 90j`) → marque l'usage comme actif.
4. Pour chaque entrée de `selections` : lire `courses:{classId}` + `cancellations:{classId}`, filtrer par `includedCourseUids`.
5. Générer le VCALENDAR (lib `ics`) → retourner avec `Content-Type: text/calendar`.

**Limite connue du standard webcal (pas propre à l'implémentation)** : un abonnement `.ics` fonctionne en **pull**, jamais en push — c'est le client calendrier qui vient chercher les nouveautés quand il le décide, le serveur ne peut pas le réveiller.

La fréquence de scraping (§3) ne fixe donc pas la fraîcheur vue par l'élève, elle fixe son **plafond** : avec 1x/h, ce que le client récupère n'a jamais plus d'une heure. Ce que le client fait de cette disponibilité lui appartient :

| Client | Fréquence de rafraîchissement | Réglable ? |
|---|---|---|
| Apple Calendar (macOS) | Choisie à l'abonnement : 5 min, 15 min, 1h, 1 jour, 1 semaine | ✅ par l'élève |
| Apple Calendar (iOS) | Suit *Réglages → Calendrier → Comptes → Nouvelles données* | ✅ par l'élève |
| Google Calendar | Décidée par Google, souvent 8-24h | ❌ ni par nous ni par l'élève |

**Ce qu'on fait côté serveur** : le `.ics` annonce `X-PUBLISHED-TTL:PT1H` **et** `REFRESH-INTERVAL;VALUE=DURATION:PT1H` (RFC 7986) — la même suggestion « reviens dans 1h » en deux dialectes, parce que les clients ne reconnaissent pas tous la même propriété. Ça reste une suggestion : Apple/Outlook en tiennent plus ou moins compte, Google l'ignore.

**Conséquence pratique** : un changement d'horaire est visible dans l'heure pour un élève iPhone bien réglé, le lendemain pour un élève sur Google Calendar. À expliquer dans l'interface/FAQ pour gérer les attentes.

## 6bis. Bug corrigé : les heures dépendaient du fuseau horaire du serveur (14/09/2026)

En testant `courseStartDateTime` + la génération `.ics` en local (machine réglée en heure de
Belgique), tout semblait correct. Mais la lib `ics` interprète par défaut un tableau `[y,m,j,h,min]`
comme de l'**heure locale du serveur qui exécute le code** — or Vercel/GitHub Actions tournent
généralement en UTC, pas en heure belge. Sans correction, les horaires du `.ics` auraient été décalés
d'1 à 2h (selon CET/CEST) pour tout élève dont le calendrier tourne sur ces plateformes.

**Fix** : `decode.js` calcule maintenant lui-même le décalage Bruxelles↔UTC (règle UE : changement
d'heure le dernier dimanche de mars/octobre à 01h00 UTC), sans jamais passer par l'interprétation
"heure locale" native de `Date` — le résultat est donc un instant UTC réel, correct quel que soit le
fuseau horaire de la machine qui exécute le code. `ics.js` lit ensuite les composantes UTC (`getUTC*`)
et passe `startInputType: 'utc'` à la lib. **Vérifié** en forçant `TZ=UTC`, `TZ=America/New_York`,
`TZ=Asia/Tokyo` : résultat identique dans tous les cas, y compris le passage été/hiver.

## 7. Point de vigilance (rappel de la préprod)

Le scraping PRONOTE `/hp/invite` n'est pas une API officielle/documentée — rétro-ingénierie d'un endpoint public sans authentification. Le volume estimé (§ 3) reste dans une fourchette raisonnable comparée à un usage manuel équivalent, et l'optimisation § 4 le réduit encore. Rester attentif si le volume réel dépasse largement les estimations une fois en production.

## 8. Décodage `p`/`d` — résolu ✅ (14/09/2026)

Formule établie en comparant les données JSON brutes (`FonctionEmploiDuTemps`) avec les tooltips de
la grille visuelle PRONOTE, sur 4 cours aux `p`/`d` différents (tous concordants) :

```
SLOTS_PAR_JOUR = 26            // grille 08h00-21h00, tranches de 30 min (13h × 2)
HEURE_DEBUT_JOURNEE = 08h00

dayIndex        = floor(p / 26)        // 0 = lundi, 1 = mardi, ... 4 = vendredi
slotDansJournee = p % 26
heureDébut      = 08h00 + slotDansJournee × 30 min
durée           = d × 30 min
```

`p` encode donc à la fois le jour et l'heure de la semaine (jour × 26 + position dans la journée),
`d` est une simple durée en demi-heures. Cohérent avec le réglage "13 séquences horaires max" vu
dans les préférences d'affichage PRONOTE (13h de 08h à 21h × 2 tranches de 30 min = 26 slots/jour).

Le numéro de semaine (`dom`) se convertit en date calendaire via un lundi de référence pour la
semaine 1 (`2026-09-14`, jour de la rentrée) — à ajuster si le projet est reconduit une autre année.

Implémentation : [`src/lib/pronote/decode.js`](../src/lib/pronote/decode.js) — `decodeCoursePosition()`,
`parseDom()`, `mondayOfWeek()`, `courseStartDateTime()`. Testé manuellement contre 5 cours réels
(4 mesurés le 14/09 + l'exemple du doc de préprod).

Confirmation supplémentaire trouvée dans les réponses PRONOTE elles-mêmes (`FonctionParametres` et
`DemandeParametreUtilisateur`) : `PlacesParJour: 26`, `PlacesParHeure: 2`, et une table `ListeHeures`
qui donne explicitement le début/fin de chacun des 26 créneaux (`08h00-08h30`, `08h30-09h00`, ...) —
exactement notre formule, mais fournie par le serveur. `PremierLundi: "14/09/2026"` confirme aussi la
date de référence de la semaine 1 utilisée dans `mondayOfWeek()`. À terme, on pourrait lire cette
table dynamiquement au lieu de la coder en dur, pour rester robuste si PRONOTE change un jour la
grille horaire — pas nécessaire pour le MVP.

## 8bis. Découverte : le protocole PRONOTE est chiffré côté client (14/09/2026)

En inspectant `invite.js` pour comprendre comment est généré le `hash` dans
`POST /hp/appelfonction/2/{session}/{hash}`, on trouve l'usage de `forge.js` (lib de crypto JS) avec
négociation d'une clé et d'un IV AES par session (`cleAES`, `ivAES`). Le hash observé change bel et
bien d'une session à l'autre pour un même appel (`FonctionParametres`, `FonctionEmploiDuTemps`, etc.),
ce qui exclut de le coder en dur ou de le déduire par un simple mapping fixe.

**Conséquence** : impossible de rejouer les appels PRONOTE en HTTP brut sans ré-implémenter tout
l'échange cryptographique du client (risqué et chronophage). **Solution retenue** : piloter un vrai
navigateur headless (Playwright) qui charge `/hp/invite` et laisse le JS officiel de PRONOTE gérer le
chiffrement — le scraper lit ensuite les réponses réseau JSON (déjà en clair une fois déchiffrées côté
client) exactement comme observé manuellement dans ce document.

Impact archi : voir §1 (diagramme mis à jour) et §2 (stack) — le scraper tourne dans GitHub Actions
avec Playwright, pas dans une route API Vercel (dépassé par la lenteur d'un navigateur headless vs la
limite de 10s des fonctions Vercel gratuites).

## 9. Reste à faire avant de coder le générateur `.ics`

1. ✅ **Scraper Node + Playwright** — [`src/lib/pronote/scraper.js`](../src/lib/pronote/scraper.js) :
   ouvre `/hp/invite`, ferme la pop-up d'info, liste les classes (`FonctionRenvoyerListeDeRessource`,
   donne directement label + ID stable), sélectionne chaque classe et capture la réponse
   `FonctionEmploiDuTemps`, applique le décodage (§8). Testé en local
   (`node scripts/test-scrape.mjs [n]`) — ~33s pour les 60 classes.
2. ✅ **Stockage Redis branché** — compte Vercel créé, intégration Marketplace **Redis** provisionnée
   et connectée au projet (`REDIS_URL`). [`src/lib/pronote/store.js`](../src/lib/pronote/store.js) :
   `saveScrapeResult`/`getClassesList`/`getCoursesForClass`.
   [`scripts/scrape-and-store.mjs`](../scripts/scrape-and-store.mjs) : script de production (scrape +
   écriture Redis), testé en local de bout en bout.
3. ✅ **Workflow GitHub Actions** — [`.github/workflows/scrape.yml`](../.github/workflows/scrape.yml) :
   cron `0 4-16 * * *` + déclenchement manuel (`workflow_dispatch`) pour tester. `REDIS_URL` en secret
   GitHub Actions (jamais commitée). **Validé en conditions réelles** (14/09/2026) : 64 classes, 197
   cours, écrits dans Redis en ~53s (scraping + installation Chromium comprise).
4. ✅ Construire le formulaire élève (Next.js) et le générateur `.ics` (`/api/calendar/[token]`).

## 10. Backlog — avant déploiement public (retours du 14/09/2026)

Retours après premier test manuel de l'app par le porteur du projet, à traiter **avant** le
déploiement Vercel :

1. ✅ **Cours "Anglais Q5" (3TI Web) absent** — investigué en profondeur, voir §11. Cause confirmée :
   pas un bug du scraper ; **corrigé indirectement** par la fusion au lieu de l'écrasement (§11).
2. ✅ **Multi-classe** — ajouté dans [`src/app/page.js`](../src/app/page.js) : bouton "+ Ajouter une
   autre classe" après l'étape cours, boucle vers une nouvelle sélection classe→cours, cumule dans
   `selections[]` avant l'appel à `/api/selections`. Testé (3TI Web + 2TI Web dans un même lien).

**Mis de côté pour plus tard, à ne pas oublier** : une fois le fond stabilisé, prochaine étape =
**identité visuelle + réflexion UX**. L'interface actuelle est un squelette Tailwind générique (§3.6
de la page Notion pédagogique) — le parcours (classe → cours → lien) fonctionne mais n'a pas été
pensé comme une expérience optimale.

**Explicitement dépriorisé par le porteur du projet (14/09/2026)** : la question de la visibilité
anticipée des examens (§11bis) — "problème à régler après le MVP, pas une urgence du tout". Ne pas y
retoucher avant que le reste soit stable et déployé.

## 11. Découverte critique : les identifiants PRONOTE ne sont PAS stables entre sessions (14/09/2026)

En creusant le cas "Anglais Q5" (§10), comparaison de plusieurs scrapes de la même classe "3TI Web" à
quelques heures d'intervalle : **trois identifiants `id` différents** pour la même classe réelle :

```
50#B_WKFPie0r9T0BesZorFReBHUAAg0NYzIR1ZVIYgqIU   (scrape A)
50#PBHa43vDBEQQxiLeXbQjnunOIqD0mo66f0s9jHEvg-Y    (scrape B)
50#EAynBMfmtEWkaevXF3VR7yoR31CF5Csl_V_CQax9vkU    (scrape C)
```

Même constat pour l'identifiant `N` de chaque cours individuel. PRONOTE régénère apparemment ces
identifiants opaques à chaque nouvelle session (anti-fixation de session probable, pas un bug de
notre côté).

**Impact, non détecté avant parce que jamais testé sur plusieurs scrapes consécutifs** : toute
l'architecture utilisait ces `id` comme clés stables — `courses:{classId}` dans Redis, le `classId`
stocké dans le token d'un élève, et les `uid` de cours dans `excludedCourseUids`. Un `id`/`uid` qui
change à chaque scrape aurait cassé silencieusement l'app dans l'heure suivant la création d'un lien
(prochain cycle de cron horaire = nouveaux id = plus aucune correspondance).

**Correctif** — clés stables dérivées du **contenu**, plus des identifiants opaques PRONOTE :
- Classe : le label lui-même (`"3TI Web"`) sert de clé — stable par construction.
- Cours : hash SHA-1 (tronqué à 16 caractères) de `matière|jour|heure|durée|prof|salle` — ces champs
  ne changent pas d'un scrape à l'autre, contrairement à `N`.

Voir [`cleCoursStable`](../src/lib/pronote/scraper.js) et [`listerClasses`](../src/lib/pronote/scraper.js).

## 11bis. Le cas "Anglais Q5" : conclusion honnête, incertitude assumée

Deux hypothèses examinées pour expliquer l'absence initiale du cours :

1. ~~Cours pas encore publié par l'école~~ — **écartée** : le porteur du projet avait accès au cours
   bien avant le début du projet ; son `dom` ("[2..6,10..14]") confirme qu'il ne se donne
   effectivement pas semaine 1, mais il existait bien dans PRONOTE depuis le début.
2. **Réponses `FonctionEmploiDuTemps` non déterministes entre sessions** — confirmée empiriquement :
   deux sessions fraîches, au même instant, pour la même classe, ont renvoyé des listes de cours
   différentes (un cours présent dans l'une, absent de l'autre, et vice-versa pour un autre cours).
   **Cause exacte non confirmée** — hypothèse la plus plausible : mise en cache/CDN avec des nœuds pas
   parfaitement synchronisés, gérant différemment le trafic selon son origine réseau. Argument en
   faveur : sur 5 scrapes automatisés consécutifs (GitHub Actions, infrastructure hors Belgique),
   0 n'ont capté la variante avec "Anglais Q5" ; sur ~3 sessions de navigation manuelle/interactive,
   1 l'a captée. Corrélation observée, causalité non prouvée — pas assez d'essais pour conclure
   formellement, et pas creusé plus loin sur consigne du porteur du projet (voir ci-dessous).

**Mitigation en place, indépendante de la cause exacte** : la fusion au lieu de l'écrasement (§11)
fait qu'un cours capté même une seule fois sur plusieurs scrapes reste visible durablement — donc
peu importe la cause, le système devient robuste à ce genre de réponse incomplète par nature.

**Décision du porteur du projet** : la complétude parfaite (en particulier pour les examens, publiés
tardivement par nature côté PRONOTE) est explicitement **dépriorisée, à traiter après le MVP**. Ne
pas investiguer davantage la cause du non-déterminisme avant que ce soit redevenu prioritaire.
