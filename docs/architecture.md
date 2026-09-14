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
                                                       │     Vercel KV        │
                                                       │  classes:list        │
                                                       │  courses:{classId}   │
                                                       │  cancellations:{id}  │
                                                       │  active_classes(set) │
                                                       │  token:{token}       │
                                                       └──────────┬───────────┘
                                                                  ▲
                                       scrape ciblé (active_classes seulement)
                                                                  │
┌─────────────┐   1x/h, 6h-18h (GitHub Actions cron)   ┌──────────────────────┐
│   PRONOTE   │◀─────────────────────────────────────── │  /api/cron/scrape    │
│ Espace Invité│  POST appelfonction (séquentiel, delay) │  (route API Vercel)  │
└─────────────┘                                          └──────────────────────┘

┌──────────────────┐   GET webcal://.../calendar/{token}
│ Apple/Google Cal  │ ────────────────────────────────────▶ /api/calendar/[token]
└──────────────────┘   ◀─── .ics généré à la volée (lecture KV + filtre + ics)
```

## 2. Stack retenue

| Brique | Choix | Rôle |
|---|---|---|
| **Front + API** | **Next.js** (App Router) sur **Vercel** | Un seul projet pour l'interface (formulaire) et le backend (routes API) |
| **Stockage** | **Vercel KV** (Redis managé, free tier) | Modèle clé-valeur : `token → sélection`, `classId → cours`, pas besoin de relationnel |
| **Déclenchement du scraping** | **GitHub Actions (cron)** → appelle `/api/cron/scrape` | Vercel Cron gratuit = 1x/jour max ; GitHub Actions permet une fréquence horaire gratuitement |
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

### Volume de requêtes estimé (avant optimisation par classes actives)

Un cycle = 1 init de session + 1 appel par classe scrapée. Avec les ~60 classes : ~61 requêtes/cycle × 13 = ~800 requêtes/jour, ~65/h en un seul burst horaire. Comparable ou inférieur au trafic organique qu'aurait généré un usage manuel de PRONOTE par une centaine d'élèves — pas un pattern qui ressemble à de l'abus (voir § 6, point de vigilance).

Avec l'optimisation "classes actives" (§ 4), ce volume baisse encore puisqu'on ne scrape que les classes réellement utilisées (probablement 5-15 au lancement, pas 60).

### Bonnes pratiques appliquées

1. **Appels séquentiels avec délai** (~200-500ms entre chaque classe) plutôt qu'en parallèle → évite un pic brutal de requêtes simultanées.
2. **`classes:list` cachée séparément et rafraîchie en hebdo seulement** (mapping nom↔ID stable) → pas besoin de la re-télécharger à chaque cycle horaire.

## 4. Optimisation : ne scraper que les classes actives

### Problème

Scraper les ~60 classes à chaque cycle alors que seule une fraction (5-15 au lancement) est réellement utilisée par des tokens existants est un gaspillage — de charge sur PRONOTE, et de complexité inutile.

### Solution : deux niveaux de cache + un index des classes actives

| Donnée | Fréquence | Portée |
|---|---|---|
| `classes:list` | Hebdo | **Toutes** les classes — nécessaire pour peupler le sélecteur du formulaire, même avant toute inscription |
| `courses:{classId}` | Horaire (6h-18h) | **Seulement** les classes présentes dans `active_classes` |
| `active_classes` (SET Redis) | Mis à jour à chaque nouvelle sélection | Liste des `classId` référencés par au moins un token existant |

### Flux

1. Élève choisit sa classe dans le formulaire (liste tirée de `classes:list`, toujours à jour en cache).
2. Si `courses:{classId}` est absent du cache (aucun élève n'a encore choisi cette classe) → **scrape à la demande** de cette seule classe, en synchrone, le temps que l'élève arrive à l'étape de sélection des cours. Cette classe est ajoutée à `active_classes`.
3. Si `courses:{classId}` est déjà en cache → affichage immédiat, pas de scrape supplémentaire.
4. Le cron horaire ne parcourt ensuite que `active_classes` pour les mises à jour récurrentes.

**Effet de bord accepté** : le tout premier élève d'une classe a un léger délai (quelques secondes, le temps du scrape à la demande) ; les suivants sur la même classe ne l'ont pas.

**Nettoyage** (optionnel, non-bloquant pour le MVP) : `active_classes` peut légèrement se désynchroniser avec le temps (tokens expirés dont la classe reste listée comme active). Impact minime — au pire quelques classes scrapées en trop. Un recalcul périodique (scan des tokens existants, ex: hebdo) permet de garder l'index propre si besoin, mais n'est pas requis pour lancer.

## 5. Structure des clés KV

```
classes:list                → [{ id, label, schoolYear }, ...]           # cache hebdo, toutes classes
courses:{classId}           → [{ uid, subject, teacher, room,
                                  day, start, end, weekPattern[] }, ...]  # cache horaire, classes actives seulement
cancellations:{classId}     → [{ courseUid, week, date }, ...]           # idem
active_classes              → SET de classId                            # index des classes à scraper en cron

token:{token}                → {
                                  selections: [
                                    { classId, schoolYear, includedCourseUids: [...] }
                                  ],
                                  createdAt, lastAccessAt
                                }                                        # TTL ~90j, reset à chaque GET
```

Le cas redoublant reste géré nativement : `selections` est un tableau, donc un redoublant a deux entrées (année N-1 partielle + année N complète) sous le même token.

## 6. Flux clé : génération du `.ics`

1. `GET /api/calendar/{token}` (appelé périodiquement par le client calendrier — Apple/Google Calendar, en pull, pas en push).
2. Lire `token:{token}` dans KV → absent (expiré/inconnu) → 404.
3. Reset du TTL (`EXPIRE token:{token} 90j`) → marque l'usage comme actif.
4. Pour chaque entrée de `selections` : lire `courses:{classId}` + `cancellations:{classId}`, filtrer par `includedCourseUids`.
5. Générer le VCALENDAR (lib `ics`) → retourner avec `Content-Type: text/calendar`.

**Limite connue du standard webcal (pas propre à l'implémentation)** : le rafraîchissement est décidé par le client (Apple Calendar : quelques heures ; Google Calendar : souvent 8-24h), pas par le serveur. Même avec un scraping horaire, un élève peut ne voir la mise à jour que plus tard selon son app. À mentionner dans l'interface/FAQ pour gérer les attentes.

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

## 9. Reste à faire avant de coder le générateur `.ics`

Plus aucun point bloquant connu. Prochaine étape : écrire le scraper (`/api/cron/scrape`) qui
récupère `ListeCours` par classe, applique `decodeCoursePosition`/`parseDom`/`courseStartDateTime`,
et stocke le résultat normalisé dans `courses:{classId}` (Vercel KV).
