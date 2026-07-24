# 🔥🤝 Urgence Entraide Incendie

Site citoyen ultra-simple pour mettre en relation, en urgence, les personnes touchées par les incendies (secteur Biscarrosse / Lège-Cap-Ferret / Bassin d'Arcachon) avec des personnes solidaires proposant un logement, une chambre ou du matériel.

**100% statique, aucun serveur, aucune base de données à configurer.** Prêt à déployer immédiatement.

---

## 🚀 Déploiement sur GitHub Pages (2 minutes)

1. Crée un nouveau dépôt GitHub (public), par ex. `urgence-entraide-incendie`.
2. Mets-y les 3 fichiers de ce dossier (`index.html`, `style.css`, `app.js`) à la racine.
3. **Settings → Pages → Source : "Deploy from a branch"** → branche `main`, dossier `/ (root)` → **Save**.
4. Après ~1 minute, le site est en ligne : `https://TON-PSEUDO.github.io/urgence-entraide-incendie/`.

C'est tout. Aucune autre étape n'est nécessaire.

---

## 📲 Comment ça circule sans serveur : le partage WhatsApp

Le site n'a pas de base de données partagée : chaque annonce est enregistrée dans le `localStorage` de l'appareil qui l'a créée. La propagation se fait autrement, et c'est volontaire :

- Chaque annonce a un bouton **« Partager sur WhatsApp »**.
- Le message envoyé contient un **lien spécial** qui encode l'annonce elle-même (commune, description, contact...).
- Quand quelqu'un ouvre ce lien (depuis WhatsApp, SMS, n'importe où), l'annonce est **automatiquement ajoutée à son propre fil local** — pas besoin de la ressaisir.
- Une bannière verte confirme l'import.

Concrètement : une victime publie un besoin de logement → elle appuie sur « Partager sur WhatsApp » → elle l'envoie dans le groupe d'entraide local → tous ceux qui cliquent sur le lien voient l'annonce apparaître dans leur propre fil, avec bouton d'appel direct. C'est un réseau qui se construit annonce par annonce, au fil des partages.

**Limite à connaître** : sans partage, une annonce reste invisible pour les autres visiteurs qui arrivent sur le site "à froid" (sans lien). Pour une portée maximale, il faut que chaque annonce soit relayée activement dans les groupes WhatsApp / Facebook / SMS locaux. Le bouton de partage apparaît d'ailleurs automatiquement juste après chaque publication pour encourager ce réflexe.

---

## 🛠️ Tester en local

Aucun serveur requis, on peut ouvrir `index.html` directement dans un navigateur (double-clic), ou pour un rendu plus fidèle :

```bash
cd urgence-entraide-incendie
python3 -m http.server 8000
```

Puis ouvre `http://localhost:8000`.

---

## ✏️ Personnalisation rapide

- **Communes proposées** : tableau `COMMUNES` en haut de `app.js` + `<select id="f-commune">` dans `index.html`.
- **Couleurs** : bloc `tailwind.config` en haut de `index.html` (`urgent` = ember/rouge-brique, `solid` = pine/vert forêt, `signal` = ambre, `wa` = vert WhatsApp, `warm`/`ink`/`sand` = fond, texte, gris chaud).
- **Numéros d'urgence / lien préfecture** : bandeau tout en haut de `index.html`.
- **Message WhatsApp** : fonction `whatsappMessage()` dans `app.js`.

---

## 🎨 Direction artistique

Le site est traité comme un **bulletin citoyen / registre d'incident** plutôt que comme une appli chat générique :

- **Couleurs** : fond « cendre » chaud (`#EEEDE6`), texte charbon (`#22262A`), accent ember (`#D6451B`, urgence/besoin), accent pine (`#1E4B3C`, solidarité/offre), ambre signal pour les alertes secondaires, sable (`#C9B995`) pour les bordures.
- **Typographie** : uniquement des polices système (aucun webfont chargé) pour rester rapide sur un réseau dégradé en évacuation ; hiérarchie posée via graisse noire/majuscules tracées pour les titres, et une police monospace système pour les métadonnées (horodatage, prénom du contact) façon tampon officiel.
- **Motif signature** : la rayure de danger (`.hazard-stripe`, ember/charbon en diagonale) reprise du balisage de chantier/sécurité civile, utilisée avec parcimonie (haut de page, logo, en-tête des modales).
- **Cartes** : tranche colorée à gauche (ember = besoin, pine = offre) façon dossier, plutôt que des badges arrondis génériques.
- **Formes** : coins fermes (rounded-md/lg) plutôt que des pastilles tout-arrondi, pour un rendu plus officiel/civique que ludique — tout en gardant de grosses zones tactiles.

---

## 🧪 Suite de tests automatisée

`test.js` fait tourner l'app réelle dans un navigateur simulé (jsdom) et vérifie 34 comportements : publication, facettes, pagination, recherche, tri, suppression, échappement anti-XSS, lien de partage, dégradation de l'autocomplétion hors-ligne, etc.

```bash
cd urgence-entraide-incendie
npm install
npm test
```

À relancer avant chaque déploiement si tu modifies `app.js` ou `index.html` — ça détecte en quelques secondes une régression qu'un test manuel pourrait manquer.

**Limite connue** : le test ne peut pas appeler la vraie API `api-adresse.data.gouv.fr` (réseau non disponible dans certains environnements sandboxés) ; il vérifie en revanche que l'app ne plante pas et se rabat sur la saisie libre si l'API est injoignable. Fais un test manuel du champ Ville une fois déployé pour confirmer que les suggestions s'affichent bien en conditions réelles.

---

## ✨ Nouvelles fonctionnalités

### Statut des annonces
Chaque annonce a désormais un statut : **🟢 Ouvert**, **⏸️ En pause**, ou **✅ Pourvu**. L'auteur d'une annonce (visible uniquement sur ses propres annonces) peut le changer directement depuis sa carte, sans avoir à la supprimer. Les annonces non-ouvertes sont visuellement estompées et exclues du tableau de bord ("offres disponibles" / "besoins en attente"). Une case à cocher "Masquer pourvues/en pause" permet de les cacher complètement du fil.

**⚠️ Action requise si Firebase était déjà configuré** : republie les nouvelles règles de sécurité Firestore fournies dans `firebase-config.js` (elles autorisent maintenant la mise à jour du champ statut). Sans ça, le changement de statut restera local uniquement, sans blocage.

### Carte interactive
Bouton **"🗺️ Carte"** à côté du fil : affiche les annonces sur une carte OpenStreetMap (via Leaflet, gratuit, sans clé). Seules les annonces dont la ville a été choisie via les suggestions d'autocomplétion (pas en saisie libre) y apparaissent, car ce sont les seules dont on connaît les coordonnées GPS précises.

### Géolocalisation "autour de moi"
Bouton **"📍 Autour de moi"** : demande la position de l'appareil (avec sa permission) et active un tri "Plus proche" basé sur la distance réelle à vol d'oiseau.

### Affiches PDF imprimables
Bouton **"🖨️ Affiche"** sur chaque carte : génère un PDF A4 avec le type d'aide, le lieu, la description et le contact en gros caractères, prêt à imprimer et coller pour les personnes sans smartphone.

### Mode hors-ligne (PWA)
Le site est maintenant installable (icône sur l'écran d'accueil mobile ou en app de bureau) et reste consultable sans réseau : le squelette de l'app (HTML/JS/CSS) est mis en cache via un service worker, et les dernières annonces synchronisées restent visibles (via le cache local déjà existant). La publication de nouvelles annonces nécessite toujours une connexion.

---

## 💾 Les données survivent-elles aux mises à jour du site ?

**Oui, dès que Firestore est configuré.** Les fichiers du site (`index.html`, `app.js`, `style.css`) et les annonces elles-mêmes vivent à deux endroits complètement séparés :
- Les **fichiers** sont hébergés sur GitHub Pages (ou autre) — c'est ce que tu redéploies à chaque amélioration.
- Les **annonces** vivent dans Firestore, une base de données Google indépendante.

Redéployer une nouvelle version du site **ne touche jamais** au contenu de Firestore. Je m'engage à ne jamais changer le nom de la collection (`annonces`) ni la structure des champs sans compatibilité ascendante, pour qu'une mise à jour future ne rende jamais d'anciennes annonces illisibles.

**Filet de sécurité supplémentaire** : si des annonces ont été créées *avant* que Firestore soit configuré (ou pendant une panne réseau temporaire), elles sont automatiquement migrées vers le fil partagé dès que la connexion s'établit — sans jamais disparaître du fil entre-temps. Testé et vérifié automatiquement.

**Le seul cas où des données restent "locales"** : tant que `firebase-config.js` n'est pas configuré, les annonces créées ne sont visibles que sur l'appareil qui les a créées (mode de secours). Dès que tu configures Firestore, tout ce qui existe déjà localement sur chaque appareil sera renvoyé vers le fil partagé automatiquement au prochain chargement du site sur cet appareil.

---

## 🌍 Partage global des annonces (mise à jour importante)

**Problème corrigé** : dans la version précédente, chaque visiteur ne voyait que ses propres annonces (+ celles reçues par lien WhatsApp explicite). Sans partage automatique, le site ne remplissait pas son rôle dès qu'il y avait plusieurs utilisateurs indépendants.

**Solution** : le site utilise maintenant [Firebase Firestore](https://firebase.google.com/) (gratuit) comme base de données partagée. Une fois configuré, **toutes les annonces publiées par n'importe qui apparaissent instantanément dans le fil de tout le monde**, en temps réel, sans rechargement de page.

### Configuration (5 minutes, gratuit, sans carte bancaire)

Toutes les instructions détaillées sont dans **`firebase-config.js`** (commentaire en haut du fichier). En résumé :
1. Créer un projet sur [console.firebase.google.com](https://console.firebase.google.com)
2. Activer Firestore Database (mode test)
3. Coller les règles de sécurité fournies dans `firebase-config.js` (accès public en lecture/écriture — adapté à une situation d'urgence sans système de comptes, mais à ne pas garder pour un usage permanent)
4. Copier ta configuration Firebase (`apiKey`, `projectId`, etc.) dans `firebase-config.js`
5. Recharger le site → le badge sous les boutons "Demander/Proposer" doit passer à **🟢 Partagé en temps réel avec tous les visiteurs**

**Tant que ce n'est pas configuré**, le site continue de fonctionner en mode local de secours (badge ⚪), avec le même comportement qu'avant : mieux que rien, mais pas de partage automatique entre visiteurs. Le site se dégrade aussi automatiquement vers ce mode si la connexion à Firestore échoue (réseau très dégradé), pour ne jamais planter.

### Catégories d'aide étendues

En plus de Logement entier et Chambre d'amis, le formulaire propose maintenant :
- ☕ **Accueil de jour** (se reposer, se doucher, recharger son téléphone sans hébergement complet)
- 🍽️ **Nourriture / eau** (séparée du matériel)
- 📦 **Matériel d'urgence** (lit de camp, vêtements, chargeurs…)
- 🚗 **Transport**
- ❔ **Autre**

---

## 🔧 Bug corrigé (retour "les boutons ne fonctionnent pas")

En testant le chargement réel de la page (et pas seulement le code en isolation), j'ai identifié une vraie faille de robustesse : **tout le site dépendait à 100 % d'un script externe (`cdn.tailwindcss.com`) chargé au moment de l'affichage pour générer l'ensemble de la CSS**, y compris la classe `.hidden` qui pilote l'affichage des modales, du fil, de la pagination et des suggestions d'adresse. Si ce CDN est lent, bloqué (bloqueur de pub, pare-feu d'établissement) ou temporairement indisponible — un scénario plausible sur un réseau dégradé pendant une évacuation — les clics fonctionnaient toujours en JavaScript, mais l'interface pouvait apparaître visuellement cassée : c'est probablement ce qui a été perçu comme "les boutons ne marchent pas".

Trois correctifs appliqués :

1. **Filet de sécurité CSS local** (`style.css`) : les règles critiques (`.hidden`, positionnement des modales, en-tête fixe) sont maintenant dupliquées en CSS pur, servi localement avec la page — donc garanties de fonctionner même si le CDN Tailwind échoue entièrement. Vérifié par test automatisé : modale correctement positionnée (`display: flex; position: fixed`) même CDN coupé.
2. **`el()` défensif** (`app.js`) : si un id attendu est introuvable dans la page (cas typique : cache de navigateur qui sert un vieux `app.js` avec un nouvel `index.html`, ou l'inverse, après une mise à jour), le reste du script continue de fonctionner au lieu de planter entièrement — avec un message clair dans la console pour le diagnostic.
3. **Anti-cache** : `app.js` et `style.css` sont désormais chargés avec un paramètre de version (`?v=2`) à incrémenter à chaque déploiement, pour éviter qu'un navigateur serve une version obsolète après une mise à jour. Une bannière rouge s'affiche aussi automatiquement en cas d'erreur JS fatale imprévue, plutôt que de laisser le site silencieusement inopérant.

---

## 📋 Fonctionnement en bref

- **Fil public dès l'arrivée** : aucune identification requise pour consulter les annonces. Le prénom + téléphone ne sont demandés que dans le formulaire de publication (mémorisés localement pour préremplir la fois suivante).
- **CTA permanents** : les boutons « 🆘 Demander » / « 🏡 Proposer » restent visibles en permanence dans le header, à tout moment du scroll.
- **Recherche + tri** : champ de recherche plein texte (description, ville, quartier, catégorie) + tri plus récent/plus ancien.
- **Facettes avec compteurs** : type, catégorie et zone géographique, chacune affichant le nombre de résultats — la liste des zones se construit automatiquement à partir des communes réellement utilisées (aucune ville n'est exclue).
- **Localisation en saisie libre avec suggestions** : autocomplétion via l'API Adresse officielle (Base Adresse Nationale, data.gouv.fr — gratuite, sans clé, aucune inscription), couvre toutes les communes de France. Si l'API est injoignable (hors-ligne), la saisie libre est acceptée telle quelle : la publication n'est jamais bloquée.
- **Pagination** : 8 annonces par page, navigation Précédent/Suivant.
- **Tableau de bord rapide** : compte des offres disponibles et des besoins en attente, mis à jour en direct.
- **Partage** : bouton WhatsApp sur chaque annonce (et proposé automatiquement juste après publication), lien auto-importable.
- **Contact** : appel direct (`tel:`) et copie rapide du numéro.
- **Suppression** : chaque auteur peut supprimer ses propres annonces sur son appareil ; un lien en pied de page permet d'effacer ses informations locales (prénom/téléphone mémorisés).

---

## 💡 Autres innovations possibles (non implémentées)

- **Carte interactive** (Leaflet + OpenStreetMap, gratuit sans clé) pour visualiser les annonces autour de soi.
- **Géolocalisation « autour de moi »** pour trier par distance réelle plutôt que par nom de commune.
- **Statut « pourvu / résolu »** : marquer une annonce comme satisfaite sans la supprimer, pour garder une trace tout en la sortant du fil actif.
- **Génération d'une affiche PDF imprimable** pour les personnes sans smartphone (à coller sur un panneau d'affichage local).
- **Mode hors-ligne (PWA installable)** : Service Worker pour consulter le fil déjà chargé même sans réseau, utile en zone de couverture dégradée.

Ces idées apparaissent aussi directement dans l'app (bloc dépliable « Idées d'évolution possibles » en bas de page) pour que les visiteurs puissent proposer les leurs.

---

## 🔮 Évolution possible (si besoin d'un fil vraiment partagé en temps réel)

Le lien encodé dans l'URL permet une propagation virale sans serveur, mais reste dépendant du partage actif. Si le besoin grandit, l'étape suivante serait de brancher un backend léger et gratuit (Firebase, Supabase) pour que **toutes** les annonces soient visibles par **tous** sans dépendre du partage — je peux le faire en quelques minutes si utile.

Bon courage à toutes les personnes concernées. 🤝
