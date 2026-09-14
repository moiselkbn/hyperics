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
                                                       │  token:{token}       │
                                                       └──────────┬───────────┘
                                                                  ▲
                                          écriture directe via API REST de Vercel KV
                                                                  │
┌─────────────┐   navigation réelle (Playwright)   ┌──────────────────────────┐
│   PRONOTE   │◀─────────────────────────────────── │  GitHub Actions          │
│ Espace Invité│  (le protocole est chiffré AES     │  1x/h, 6h-18h            │
└─────────────┘   côté client — cf §8bis)           │  scraper Node+Playwright │
                                                      └──────────────────────────┘

┌──────────────────┐   GET webcal://.../calendar/{token}
│ Apple/Google Cal  │ ────────────────────────────────────▶ /api/calendar/[token]
└──────────────────┘   ◀─── .ics généré à la volée (lecture KV + filtre + ics)
```

**Changement clé par rapport à la première version** : le scraper ne tourne plus dans une route API
Vercel — il tourne **directement dans le job GitHub Actions**, qui pilote un vrai navigateur headless
(Playwright) et écrit le résultat dans Vercel KV via son API REST. Raison détaillée en §8bis.

## 2. Stack retenue

| Brique | Choix | Rôle |
|---|---|---|
| **Front + API** | **Next.js** (App Router) sur **Vercel** | Un seul projet pour l'interface (formulaire) et le backend (routes API) |
| **Stockage** | **Vercel KV** (Redis managé, free tier) | Modèle clé-valeur : `token → sélection`, `classId → cours`, pas besoin de relationnel |
| **Scraping** | **Node + Playwright**, exécuté **dans le job GitHub Actions** (pas sur Vercel) | Le protocole PRONOTE est chiffré côté client (AES) — il faut un vrai navigateur pour le piloter. Écrit ensuite dans Vercel KV via son API REST |
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

### Volume de requêtes estimé

Un cycle = 1 chargement de `/hp/invite` + 1 sélection par classe scrapée. Avec les ~60 classes : ~13 cycles/jour × 60 classes = ~780 "sélections classe" par jour, ~60/h en un seul burst horaire. Comparable ou inférieur au trafic organique qu'aurait généré un usage manuel de PRONOTE par une centaine d'élèves — pas un pattern qui ressemble à de l'abus (voir § 7, point de vigilance).

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

## 5. Structure des clés KV

```
classes:list                → [{ id, label, schoolYear }, ...]           # cache hebdo, toutes classes
courses:{classId}           → [{ uid, subject, teacher, room,
                                  day, start, end, weekPattern[] }, ...]  # cache horaire, toutes les classes
cancellations:{classId}     → [{ courseUid, week, date }, ...]           # idem

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

Plus aucun point bloquant connu. Prochaines étapes :
1. Écrire le scraper Node + Playwright (`scripts/scrape.mjs` ou équivalent) : charge `/hp/invite`,
   sélectionne chaque classe de `classes:list`, capture la réponse `FonctionEmploiDuTemps`, applique
   `decodeCoursePosition`/`parseDom`/`courseStartDateTime`, écrit dans Vercel KV via l'API REST.
2. Écrire le workflow GitHub Actions (cron `0 4-16 * * *`, secrets pour le token Vercel KV).
3. Construire le formulaire élève (Next.js) et le générateur `.ics` (`/api/calendar/[token]`).
