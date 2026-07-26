/* =====================================================================
   URGENCE ENTRAIDE INCENDIE — app.js
   - Les annonces sont stockées dans une base partagée (Firebase Firestore)
     configurée dans firebase-config.js : TOUS les visiteurs voient TOUTES
     les annonces en temps réel, sans rien faire de spécial.
   - Si firebase-config.js n'est pas configuré (ou si la connexion échoue,
     ex : réseau très dégradé), le site continue de fonctionner en mode
     local de secours (localStorage), comme avant — mais dans ce cas
     chaque appareil ne voit que ses propres annonces + celles reçues par
     lien. Un badge en haut du site indique l'état de la connexion.
   - Le bouton "Partager sur WhatsApp" reste disponible pour donner de la
     visibilité en dehors du site (groupes WhatsApp, etc.), en plus du
     partage automatique via Firestore.
   - Le fil est visible publiquement dès l'arrivée sur le site : aucune
     identification n'est requise pour consulter les annonces. Le
     prénom + téléphone ne sont demandés que dans le formulaire de
     publication (et mémorisés localement pour préremplir la prochaine
     fois).
===================================================================== */

const STORAGE_KEY = 'uei_annonces_v1';
const MINE_KEY = 'uei_mine_v1';
const PAGE_SIZE = 8;

const CATEGORIES = {
  logement:     { label: 'Logement entier', icon: '🏠' },
  chambre:      { label: "Chambre d'amis", icon: '🛏️' },
  accueil_jour: { label: 'Accueil de jour', icon: '☕' },
  nourriture:   { label: 'Nourriture / eau', icon: '🍽️' },
  materiel:     { label: "Matériel d'urgence", icon: '📦' },
  transport:    { label: 'Transport', icon: '🚗' },
  autre:        { label: 'Autre', icon: '❔' },
};

const STATUTS = {
  // Clé interne "pourvu" conservée pour rester compatible avec les règles de
  // sécurité Firestore déjà publiées (qui autorisent explicitement cette
  // valeur) — seul le libellé affiché change, en "Clôturé" plus clair.
  ouvert: { label: 'Ouvert', icon: '🟢' },
  pause:  { label: 'En pause', icon: '⏸️' },
  pourvu: { label: 'Clôturé', icon: '🔒' },
};

/* =====================================================================
   STOCKAGE : Firestore partagé, avec repli local automatique
===================================================================== */

let cache = [];          // liste actuellement affichée (source de vérité pour le rendu)
let db = null;
let firebaseReady = false;

function loadLocalCache() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveLocalCache(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
}
function readAll() { return cache; }

function getMineIds() {
  try { return new Set(JSON.parse(localStorage.getItem(MINE_KEY)) || []); }
  catch { return new Set(); }
}
function markMine(id) {
  const s = getMineIds();
  s.add(id);
  localStorage.setItem(MINE_KEY, JSON.stringify([...s]));
}
function makeId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function setSyncStatus(state) {
  const status = el('sync-status');
  const map = {
    connecting:   '🟡 Connexion au fil partagé…',
    online:       '🟢 Partagé (vérification toutes les 12s) avec tous les visiteurs',
    error:        '🟠 Fil partagé indisponible pour le moment — nouvelle tentative automatique en cours',
    'offline-local': '⚪ Mode local uniquement — configure firebase-config.js pour partager les annonces avec tout le monde',
  };
  status.textContent = map[state] || '';
}

const POLL_INTERVAL_MS = 12000;
let pollTimer = null;
let migrated = false;
let localBeforeSync = [];

// =====================================================================
// SONDAGE PÉRIODIQUE (remplace l'ancienne écoute temps réel onSnapshot)
// -----------------------------------------------------------------------
// Diagnostic établi le 24/07 : une lecture ponctuelle (.get()) obtient
// systématiquement une confirmation du serveur (en ~25-30s selon le
// réseau), alors que l'écoute persistante (.onSnapshot()) ne s'est JAMAIS
// confirmée sur aucun appareil testé (Mac/iPhone, Chrome/Safari, wifi/4G),
// avec ou sans réglage de transport particulier. Plutôt que de continuer à
// deviner pourquoi les connexions persistantes échouent dans cet
// environnement, on s'appuie sur ce qui est prouvé fonctionner : des
// lectures ponctuelles répétées. Contrepartie assumée : ce n'est plus du
// vrai "temps réel" (délai de quelques secondes à ~12s), et le coût en
// lectures Firestore est plus élevé qu'un vrai listener à grande échelle.
// =====================================================================

async function pollFirestore(isFirstPoll) {
  try {
    const snap = await db.collection('annonces').orderBy('createdAt', 'desc').limit(200).get();
    console.info(`[UEI][debug] sondage reçu : ${snap.docs.length} document(s), fromCache=${snap.metadata.fromCache}`);
    cache = snap.docs.map(d => d.data());
    saveLocalCache(cache);
    firebaseReady = true;
    setSyncStatus('online');

    // Migration ascendante (une seule fois, après le tout premier sondage
    // réussi) : toute annonce créée localement avant que Firestore ne soit
    // joignable est renvoyée vers le fil partagé. set(...,{merge:true}) est
    // idempotent par id, donc sans risque même si l'annonce existe déjà.
    if (!migrated) {
      migrated = true;
      const knownIds = new Set(cache.map(a => a.id));
      const orphans = localBeforeSync.filter(a => !knownIds.has(a.id));
      if (orphans.length) {
        console.info(`[UEI] ${orphans.length} annonce(s) locale(s) migrée(s) vers le fil partagé.`);
        cache = [...orphans, ...cache].sort((a, b) => b.createdAt - a.createdAt);
        saveLocalCache(cache);
        orphans.forEach(a => {
          db.collection('annonces').doc(a.id).set(a, { merge: true })
            .catch((err) => console.warn('[UEI] Échec migration annonce locale', a.id, err));
        });
      }
    }

    renderFeed();
    return true;
  } catch (err) {
    console.warn('[UEI] Échec de synchronisation Firestore (nouvelle tentative au prochain sondage)', err);
    if (!firebaseReady) setSyncStatus('error');
    return false;
  }
}

function initSync() {
  return new Promise((resolve) => {
    cache = loadLocalCache();
    localBeforeSync = cache; // conservé pour la migration ascendante
    renderFeed();

    const cfg = window.UEI_FIREBASE_CONFIG;
    const isConfigured = cfg && cfg.apiKey && cfg.apiKey !== 'REMPLACE_MOI';
    if (!isConfigured || typeof firebase === 'undefined') {
      setSyncStatus('offline-local');
      resolve();
      return;
    }

    setSyncStatus('connecting');
    try {
      firebase.initializeApp(cfg);
      db = firebase.firestore();
    } catch (err) {
      console.warn('[UEI] Firebase indisponible, mode local de secours', err);
      setSyncStatus('offline-local');
      resolve();
      return;
    }

    // Premier sondage : on attend son résultat (max 4s, le contenu local
    // est déjà affiché entre-temps) avant de laisser l'app continuer,
    // pour pouvoir importer un lien partagé une fois qu'on sait si on est
    // en ligne ou non.
    let settled = false;
    const settleOnce = () => { if (!settled) { settled = true; clearTimeout(fallbackTimeoutId); resolve(); } };
    const fallbackTimeoutId = setTimeout(settleOnce, 4000);
    if (typeof fallbackTimeoutId.unref === 'function') fallbackTimeoutId.unref();
    pollFirestore(true).finally(settleOnce);

    // Sondage périodique en arrière-plan.
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollFirestore(false), POLL_INTERVAL_MS);
    // .unref() : en Node.js (tests automatisés), un setInterval actif
    // empêche le process de se terminer naturellement — sans incidence en
    // navigateur, où cette méthode n'existe pas (d'où la vérification).
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  });
}

function scheduleQuickSync() {
  // Après une écriture, on redemande un sondage un peu plus tôt que le
  // prochain cycle automatique (12s), pour que la mise à jour se
  // propage plus vite sans pour autant spammer Firestore de requêtes.
  if (db) {
    const t = setTimeout(() => pollFirestore(false), 3000);
    if (typeof t.unref === 'function') t.unref();
  }
}

function addAnnonce(data) {
  const annonce = { id: makeId(), createdAt: Date.now(), statut: 'ouvert', ...data };
  // Affichage optimiste immédiat, avant même la confirmation du serveur
  cache = [annonce, ...cache];
  saveLocalCache(cache);
  renderFeed();
  // On tente l'écriture dès que `db` existe (Firebase configuré) : une
  // écriture .set() ponctuelle s'est révélée fiable dans nos tests
  // (contrairement à l'écoute temps réel), même si elle peut prendre
  // plusieurs secondes à se confirmer sur certains réseaux.
  if (db) {
    db.collection('annonces').doc(annonce.id).set(annonce).then(scheduleQuickSync).catch((err) => {
      console.warn('[UEI] Échec de publication partagée, restera visible localement seulement', err);
      showToast("Publiée localement (connexion au fil partagé indisponible)");
    });
  }
  return annonce;
}
function setStatut(id, statut) {
  cache = cache.map(a => a.id === id ? { ...a, statut } : a);
  saveLocalCache(cache);
  renderFeed();
  if (db) {
    // Nécessite que les règles Firestore autorisent la mise à jour du
    // champ "statut" (voir firebase-config.js). Si les règles n'ont pas
    // été mises à jour, cet appel échoue silencieusement et le nouveau
    // statut reste affiché localement seulement — pas de blocage.
    db.collection('annonces').doc(id).update({ statut }).then(scheduleQuickSync).catch((err) => {
      console.warn('[UEI] Échec mise à jour du statut côté serveur (règles Firestore à mettre à jour ?)', err);
    });
  }
}
function deleteAnnonce(id) {
  cache = cache.filter(a => a.id !== id);
  saveLocalCache(cache);
  if (db) {
    db.collection('annonces').doc(id).delete().then(scheduleQuickSync)
      .catch((err) => console.warn('[UEI] Échec suppression partagée', err));
  }
}
function importAnnonce(annonce) {
  if (cache.some(a => a.id === annonce.id)) return false; // déjà connue
  cache = [annonce, ...cache];
  saveLocalCache(cache);
  if (db) {
    db.collection('annonces').doc(annonce.id).set(annonce, { merge: true }).then(scheduleQuickSync)
      .catch((err) => console.warn('[UEI] Échec import partagé', err));
  }
  return true;
}

/* =====================================================================
   ÉTAT
===================================================================== */

let filterType = 'all';
let filterCat = 'all';
let filterZone = 'all';
let searchQuery = '';
let sortOrder = 'recent';
let currentPage = 1;
let pendingShareData = null;
let viewMode = 'feed'; // 'feed' | 'map'
let hideResolved = false;
let userPos = null; // { lat, lon } une fois la géolocalisation acceptée
let leafletMap = null;
let leafletMarkersLayer = null;

const el = (id) => {
  const found = document.getElementById(id);
  if (found) return found;
  // Élément introuvable : on log clairement (aide au diagnostic) et on renvoie
  // un élément factice jamais inséré dans le DOM, pour que les .addEventListener /
  // .classList / .value appelés dessus ne fassent PAS planter tout le script.
  // Sans ce filet, un seul id manquant (ex: cache navigateur obsolète après une
  // mise à jour) casserait TOUS les boutons de la page, pas seulement celui
  // concerné — c'est le bug le plus probable derrière un "plus rien ne marche".
  console.warn(`[Urgence Entraide Incendie] Élément #${id} introuvable dans la page. Si tu viens de mettre à jour le site, fais un rechargement forcé (Ctrl/Cmd + Maj + R) pour vider le cache du navigateur.`);
  return document.createElement('div');
};

const importBanner = el('import-banner');
const statsBar = el('stats-bar');

/* =====================================================================
   DÉTECTION NAVIGATEUR INTÉGRÉ (WhatsApp, Instagram, Facebook, LINE...)
   -----------------------------------------------------------------------
   Diagnostic établi le 24/07 : Firestore ne fonctionne pas de façon
   fiable dans ces navigateurs bridés (webviews d'applications), même
   quand Safari/Chrome classiques fonctionnent normalement sur le même
   appareil — confirmé en testant depuis le navigateur intégré de
   WhatsApp (visible via "◀ WhatsApp" en haut de l'écran) : aucune
   confirmation serveur obtenue, même après 20+ secondes, alors que la
   même page dans Safari classique finit par réussir. Comme le site est
   volontairement partagé via WhatsApp, ce cas n'est PAS un cas limite —
   c'est le chemin d'arrivée principal pour beaucoup de visiteurs, d'où
   cette bannière plutôt qu'un correctif silencieux (qui n'existe pas :
   il n'y a pas d'API JS pour forcer l'ouverture du vrai navigateur
   depuis une webview iOS/Android).
===================================================================== */

function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  // Signatures connues et fiables (Android inclut le nom de l'appli dans l'UA)
  if (/\b(WhatsApp|FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|TikTok)\b/i.test(ua)) return true;
  // Heuristique iOS : les navigateurs légitimes (Safari, Chrome iOS, Firefox
  // iOS) ont toujours un jeton distinctif dans l'UA (Safari/, CriOS/, FxiOS/,
  // EdgiOS/) ; beaucoup de webviews d'applications (dont WhatsApp iOS) ne
  // l'ont pas, tout en se présentant comme un iPhone/iPad WebKit classique.
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const hasKnownBrowserToken = /Safari\/|CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\//.test(ua);
  if (isIOS && !hasKnownBrowserToken) return true;
  return false;
}

function initInAppBannerCheck() {
  const KEY = 'uei_inapp_banner_dismissed';
  if (!detectInAppBrowser() || sessionStorage.getItem(KEY) === '1') return;
  const banner = el('inapp-banner');
  banner.classList.remove('hidden');
  el('btn-close-inapp-banner').addEventListener('click', () => {
    banner.classList.add('hidden');
    try { sessionStorage.setItem(KEY, '1'); } catch {}
  });
}
initInAppBannerCheck();

const btnDemander = el('btn-demander');
const btnProposer = el('btn-proposer');
const modalBackdrop = el('modal-backdrop');
const modalTitle = el('modal-title');
const btnCloseModal = el('btn-close-modal');
const annonceForm = el('annonce-form');
const formError = el('form-error');

const shareModalBackdrop = el('share-modal-backdrop');
const btnShareWhatsappNow = el('btn-share-whatsapp-now');
const btnCloseShareModal = el('btn-close-share-modal');

const searchBox = el('search-box');
const sortSelect = el('sort-select');
const facetType = el('facet-type');
const facetCat = el('facet-cat');
const facetZone = el('facet-zone');

const feed = el('feed');
const emptyState = el('empty-state');
const resultCount = el('result-count');
const pagination = el('pagination');
const toast = el('toast');
const btnForgetMe = el('btn-forget-me');

const btnViewFeed = el('btn-view-feed');
const btnViewMap = el('btn-view-map');
const mapView = el('map-view');
const mapContainer = el('map-container');
const btnGeoloc = el('btn-geoloc');
const chkHideResolved = el('chk-hide-resolved');

/* =====================================================================
   PANNEAU DE FILTRES (menu latéral façon site marchand)
===================================================================== */

const btnOpenFilters = el('btn-open-filters');
const btnCloseFilters = el('btn-close-filters');
const filtersDrawer = el('filters-drawer');
const filtersBackdrop = el('filters-backdrop');
const btnResetFilters = el('btn-reset-filters');
const filtersActiveCount = el('filters-active-count');

function openFiltersDrawer() {
  filtersDrawer.classList.remove('hidden');
  filtersBackdrop.classList.remove('hidden');
  requestAnimationFrame(() => filtersDrawer.classList.add('drawer-open'));
}
function closeFiltersDrawer() {
  filtersDrawer.classList.remove('drawer-open');
  setTimeout(() => {
    filtersDrawer.classList.add('hidden');
    filtersBackdrop.classList.add('hidden');
  }, 250);
}
btnOpenFilters.addEventListener('click', openFiltersDrawer);
btnCloseFilters.addEventListener('click', closeFiltersDrawer);
filtersBackdrop.addEventListener('click', closeFiltersDrawer);
btnResetFilters.addEventListener('click', () => {
  filterType = 'all'; filterCat = 'all'; filterZone = 'all';
  currentPage = 1;
  renderFeed();
});

/* =====================================================================
   IDENTITÉ (mémorisée pour préremplir le formulaire, jamais bloquante)
===================================================================== */

function getIdentity() {
  const prenom = localStorage.getItem('uei_prenom');
  const tel = localStorage.getItem('uei_tel');
  return prenom && tel ? { prenom, tel } : null;
}
function setIdentity(prenom, tel) {
  localStorage.setItem('uei_prenom', prenom);
  localStorage.setItem('uei_tel', tel);
}

btnForgetMe.addEventListener('click', () => {
  if (!confirm("Effacer ton prénom/téléphone mémorisés et l'historique de tes propres annonces sur cet appareil ? (Tes annonces déjà publiées resteront visibles dans le fil, mais tu ne pourras plus les supprimer depuis cet appareil.)")) return;
  localStorage.removeItem('uei_prenom');
  localStorage.removeItem('uei_tel');
  localStorage.removeItem(MINE_KEY);
  showToast('Informations locales effacées');
  renderFeed();
});

/* =====================================================================
   UTILITAIRES
===================================================================== */

function timeAgo(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "à l'instant";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  return `il y a ${Math.floor(diffH / 24)} j`;
}
function cleanTel(tel) { return (tel || '').replace(/[^\d+]/g, ''); }
function escapeHTML(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function lieuComplet(a) {
  return a.quartier ? `${a.commune} — ${a.quartier}` : a.commune;
}

/* =====================================================================
   CHARGEMENT À LA DEMANDE (Leaflet, jsPDF) — pour ne pas alourdir le
   premier chargement de la page avec des bibliothèques dont la plupart
   des visiteurs ne se serviront jamais (carte, affiche PDF).
===================================================================== */

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Échec chargement ${src}`));
    document.head.appendChild(s);
  });
}
function loadStylesheetOnce(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => reject(new Error(`Échec chargement ${href}`));
    document.head.appendChild(l);
  });
}
function hasCoords(a) {
  return typeof a.lat === 'number' && typeof a.lon === 'number';
}
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =====================================================================
   WHATSAPP
===================================================================== */

function whatsappMessage(a) {
  const cat = (CATEGORIES[a.categorie] || { label: a.categorie }).label.toUpperCase();
  const action = a.type === 'besoin' ? 'RECHERCHE' : 'PROPOSITION';
  const link = buildShareLink(a);
  return `🚨 URGENCE INCENDIE - ${action} ${cat} à ${lieuComplet(a)}\n\n${a.description}\n\n📞 Contact : ${a.contactPrenom} au ${a.contactTel}\n\n👉 Voir / relayer l'annonce : ${link}`;
}
function whatsappLink(a) {
  return `https://wa.me/?text=${encodeURIComponent(whatsappMessage(a))}`;
}

/* =====================================================================
   FACETTES : type / catégorie / zone, avec comptage dynamique
   (comptage "à l'exclusion de la dimension courante", comme un vrai
   moteur de recherche à facettes : chaque compteur reflète le nombre
   de résultats qu'on obtiendrait EN CHOISISSANT cette option, compte
   tenu des AUTRES filtres déjà actifs).
===================================================================== */

/* =====================================================================
   RECHERCHE — tolérance aux fautes de frappe façon Algolia/Elasticsearch
   -----------------------------------------------------------------------
   Règles appliquées (approximation légère, sans vrai moteur de recherche
   côté serveur puisque le site est 100% statique) :
   1. Insensible aux accents et à la casse ("café" trouve "cafe").
   2. Recherche par mot : chaque mot tapé doit correspondre à AU MOINS un
      mot de l'annonce (description, ville, quartier, catégorie).
   3. Correspondance exacte en sous-chaîne toujours acceptée en priorité
      ("chambre" trouve "chambres").
   4. Tolérance aux fautes de frappe pour les mots de 4 lettres ou plus :
      1 caractère d'écart toléré (ajout/suppression/substitution) pour les
      mots de 4 à 7 lettres, 2 caractères pour les mots plus longs — ce
      sont exactement les seuils par défaut d'Algolia (typoTolerance).
      Les mots de moins de 4 lettres n'ont aucune tolérance (trop de
      faux positifs sinon, ex. "lit" ↔ "lot").
===================================================================== */

function normalizeText(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function wordMatchesFuzzy(hayWord, qWord) {
  if (hayWord.includes(qWord)) return true;
  if (qWord.length < 4) return false;
  const maxDist = qWord.length <= 7 ? 1 : 2;
  if (Math.abs(hayWord.length - qWord.length) <= maxDist && levenshtein(hayWord, qWord) <= maxDist) return true;
  return false;
}

function matchesSearch(a, q) {
  if (!q) return true;
  const hay = normalizeText(`${a.description} ${a.commune} ${a.quartier || ''} ${(CATEGORIES[a.categorie] || {}).label || ''}`);
  const qWords = normalizeText(q).split(/[^a-z0-9]+/).filter(Boolean);
  if (!qWords.length) return true;
  const hayWords = hay.split(/[^a-z0-9]+/).filter(Boolean);
  return qWords.every(qw => hay.includes(qw) || hayWords.some(hw => wordMatchesFuzzy(hw, qw)));
}

function filteredExcept(list, exceptDim) {
  return list.filter(a => {
    if (exceptDim !== 'type' && filterType !== 'all' && a.type !== filterType) return false;
    if (exceptDim !== 'cat' && filterCat !== 'all' && a.categorie !== filterCat) return false;
    if (exceptDim !== 'zone' && filterZone !== 'all' && a.commune !== filterZone) return false;
    return true;
  });
}

function facetRow(label, count, active, attrs) {
  return `<button ${attrs} class="facet-row" data-active="${active}">
    <span>${label}</span><span class="facet-count">${count}</span>
  </button>`;
}

function updateFiltersActiveBadge() {
  const n = (filterType !== 'all' ? 1 : 0) + (filterCat !== 'all' ? 1 : 0) + (filterZone !== 'all' ? 1 : 0);
  if (n > 0) { filtersActiveCount.textContent = n; filtersActiveCount.classList.remove('hidden'); }
  else { filtersActiveCount.classList.add('hidden'); }
}

function renderFacets(all, searchFiltered) {
  // -- Type --
  const byType = filteredExcept(searchFiltered, 'type');
  const cBesoin = byType.filter(a => a.type === 'besoin').length;
  const cOffre = byType.filter(a => a.type === 'offre').length;
  facetType.innerHTML =
    facetRow('Tout', byType.length, filterType === 'all', `data-filter-type="all"`) +
    facetRow('🆘 Cherche', cBesoin, filterType === 'besoin', `data-filter-type="besoin"`) +
    facetRow('🏡 Propose', cOffre, filterType === 'offre', `data-filter-type="offre"`);

  // -- Catégorie --
  const byCat = filteredExcept(searchFiltered, 'cat');
  facetCat.innerHTML =
    facetRow('Toutes catégories', byCat.length, filterCat === 'all', `data-filter-cat="all"`) +
    Object.entries(CATEGORIES).map(([key, c]) =>
      facetRow(`${c.icon} ${c.label}`, byCat.filter(a => a.categorie === key).length, filterCat === key, `data-filter-cat="${key}"`)
    ).join('');

  // -- Zone (dynamique, construite à partir des communes réellement utilisées) --
  const byZone = filteredExcept(searchFiltered, 'zone');
  const zones = [...new Set(all.map(a => a.commune))].sort((a, b) => a.localeCompare(b, 'fr'));
  facetZone.innerHTML =
    facetRow('📍 Toutes zones', byZone.length, filterZone === 'all', `data-filter-zone="all"`) +
    zones.map(z => facetRow(escapeHTML(z), byZone.filter(a => a.commune === z).length, filterZone === z, `data-filter-zone="${escapeHTML(z)}"`)).join('');

  facetType.querySelectorAll('[data-filter-type]').forEach(btn => {
    btn.addEventListener('click', () => { filterType = btn.getAttribute('data-filter-type'); currentPage = 1; renderFeed(); });
  });
  facetCat.querySelectorAll('[data-filter-cat]').forEach(btn => {
    btn.addEventListener('click', () => { filterCat = btn.getAttribute('data-filter-cat'); currentPage = 1; renderFeed(); });
  });
  facetZone.querySelectorAll('[data-filter-zone]').forEach(btn => {
    btn.addEventListener('click', () => { filterZone = btn.getAttribute('data-filter-zone'); currentPage = 1; renderFeed(); });
  });

  updateFiltersActiveBadge();
}

/* =====================================================================
   TABLEAU DE BORD
===================================================================== */

function renderStats(all) {
  const actives = all.filter(a => (a.statut || 'ouvert') === 'ouvert');
  const offres = actives.filter(a => a.type === 'offre').length;
  const besoins = actives.filter(a => a.type === 'besoin').length;
  statsBar.innerHTML = `
    <div class="bg-solid-light rounded-md py-2.5">
      <p class="text-2xl font-black text-solid-dark leading-none">${offres}</p>
      <p class="text-[10px] font-mono uppercase tracking-wide text-solid-dark/80 mt-1">offre${offres > 1 ? 's' : ''} disponible${offres > 1 ? 's' : ''}</p>
    </div>
    <div class="bg-urgent-light rounded-md py-2.5">
      <p class="text-2xl font-black text-urgent-dark leading-none">${besoins}</p>
      <p class="text-[10px] font-mono uppercase tracking-wide text-urgent-dark/80 mt-1">besoin${besoins > 1 ? 's' : ''} en attente</p>
    </div>`;
}

/* =====================================================================
   CARTES
===================================================================== */

function cardHTML(a) {
  const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '❔' };
  const isBesoin = a.type === 'besoin';
  const badgeClass = isBesoin ? 'bg-urgent text-white' : 'bg-solid text-white';
  const badgeLabel = isBesoin ? '🆘 Cherche' : '🏡 Propose';
  const statutKey = a.statut || 'ouvert';
  const statut = STATUTS[statutKey] || STATUTS.ouvert;
  const spineClass = isBesoin ? 'card-annonce--besoin' : 'card-annonce--offre';
  const inactiveClass = statutKey !== 'ouvert' ? 'card-annonce--inactive' : '';
  const mine = getMineIds().has(a.id);
  const telClean = cleanTel(a.contactTel);
  const distLabel = (userPos && hasCoords(a))
    ? `<span class="font-mono text-[10px] text-ink/40 shrink-0">${distanceKm(userPos.lat, userPos.lon, a.lat, a.lon).toFixed(1)} km</span>`
    : '';

  const statutButtons = mine ? `
    <div class="flex items-center gap-1 mt-2 pt-2 border-t border-sand/40">
      <span class="text-[10px] font-mono uppercase text-ink/40 mr-1">Statut :</span>
      ${Object.entries(STATUTS).map(([key, s]) =>
        `<button data-set-statut="${a.id}" data-statut-value="${key}" class="statut-btn" data-active="${statutKey === key}">${s.icon} ${s.label}</button>`
      ).join('')}
    </div>` : '';

  return `
  <article class="card-enter card-annonce ${spineClass} ${inactiveClass} bg-white border border-sand/50 rounded-md p-4 shadow-sm">
    <div class="flex items-start justify-between gap-2 mb-2">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ${badgeClass}">${badgeLabel}</span>
        <span class="text-[11px] font-semibold px-2 py-0.5 rounded bg-warm-100 text-ink/60">${cat.icon} ${cat.label}</span>
        <span class="text-[11px] font-semibold px-2 py-0.5 rounded statut-badge--${statutKey}">${statut.icon} ${statut.label}</span>
      </div>
      <div class="flex flex-col items-end gap-1 shrink-0">
        <span class="font-mono text-[10px] text-ink/40">${timeAgo(a.createdAt)}</span>
        ${distLabel}
      </div>
    </div>

    <p class="text-sm font-bold text-ink mb-1">📍 ${escapeHTML(lieuComplet(a))}</p>
    <p class="text-sm text-ink/80 mb-3 leading-snug">${escapeHTML(a.description)}</p>

    <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-sand/50">
      <p class="font-mono text-[11px] text-ink/50 truncate">${escapeHTML(a.contactPrenom)}</p>
      <div class="flex items-center gap-2 shrink-0 flex-wrap">
        <button data-copy="${escapeHTML(a.contactTel)}" class="btn-copy text-xs font-bold bg-warm-100 hover:bg-sand/50 text-ink/70 rounded px-3 py-1.5">Copier n°</button>
        <a href="tel:${telClean}" class="text-xs font-bold bg-urgent hover:bg-urgent-dark text-white rounded px-3 py-1.5">📞 Appeler</a>
        <a href="${whatsappLink(a)}" target="_blank" rel="noopener" class="text-xs font-bold bg-wa hover:bg-wa-dark text-white rounded px-3 py-1.5">📲 Partager</a>
        <button data-pdf="${a.id}" class="btn-pdf text-xs font-bold bg-warm-100 hover:bg-sand/50 text-ink/70 rounded px-3 py-1.5" aria-label="Générer une affiche PDF">🖨️ Affiche</button>
        ${mine ? `<button data-delete="${a.id}" class="btn-delete text-xs font-semibold text-ink/30 hover:text-urgent px-1" aria-label="Supprimer mon annonce">🗑️</button>` : ''}
      </div>
    </div>
    ${statutButtons}
  </article>`;
}

/* =====================================================================
   RENDU DU FIL (recherche → facettes → tri → pagination)
===================================================================== */

function renderFeed() {
  const all = readAll();
  renderStats(all);

  const searchFiltered = all.filter(a => matchesSearch(a, searchQuery));
  renderFacets(all, searchFiltered);

  let result = filteredExcept(searchFiltered, null);
  if (hideResolved) result = result.filter(a => (a.statut || 'ouvert') === 'ouvert');

  if (sortOrder === 'distance' && userPos) {
    result = result.slice().sort((a, b) => {
      const da = hasCoords(a) ? distanceKm(userPos.lat, userPos.lon, a.lat, a.lon) : Infinity;
      const db_ = hasCoords(b) ? distanceKm(userPos.lat, userPos.lon, b.lat, b.lon) : Infinity;
      return da - db_;
    });
  } else {
    result = result.sort((a, b) => sortOrder === 'recent' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  }

  renderMap(result);

  const totalPages = Math.max(1, Math.ceil(result.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageItems = result.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  resultCount.textContent = result.length ? `${result.length} annonce${result.length > 1 ? 's' : ''}` : '';

  if (viewMode === 'map') return; // le fil/pagination restent masqués, la carte a déjà été mise à jour ci-dessus

  if (result.length === 0) {
    feed.innerHTML = '';
    emptyState.classList.remove('hidden');
    pagination.classList.add('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  feed.innerHTML = pageItems.map(cardHTML).join('');

  if (totalPages > 1) {
    pagination.classList.remove('hidden');
    pagination.innerHTML = `
      <button id="page-prev" ${currentPage === 1 ? 'disabled' : ''} class="px-4 py-2 rounded-md border border-sand text-xs font-bold uppercase tracking-wide disabled:opacity-30 bg-white">← Précédent</button>
      <span class="font-mono text-xs text-ink/50">Page ${currentPage} / ${totalPages}</span>
      <button id="page-next" ${currentPage === totalPages ? 'disabled' : ''} class="px-4 py-2 rounded-md border border-sand text-xs font-bold uppercase tracking-wide disabled:opacity-30 bg-white">Suivant →</button>`;
    el('page-prev')?.addEventListener('click', () => { currentPage--; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
    el('page-next')?.addEventListener('click', () => { currentPage++; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
  } else {
    pagination.classList.add('hidden');
  }
}

feed.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.btn-copy');
  if (copyBtn) {
    const tel = copyBtn.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(tel); showToast('Numéro copié ✓'); }
    catch { showToast(tel); }
    return;
  }
  const delBtn = e.target.closest('.btn-delete');
  if (delBtn) {
    const id = delBtn.getAttribute('data-delete');
    if (confirm('Supprimer cette annonce ?')) {
      deleteAnnonce(id);
      renderFeed();
      showToast('Annonce supprimée');
    }
    return;
  }
  const statutBtn = e.target.closest('[data-set-statut]');
  if (statutBtn) {
    const id = statutBtn.getAttribute('data-set-statut');
    const statut = statutBtn.getAttribute('data-statut-value');
    setStatut(id, statut);
    showToast(`Statut mis à jour : ${(STATUTS[statut] || {}).label || statut}`);
    return;
  }
  const pdfBtn = e.target.closest('.btn-pdf');
  if (pdfBtn) {
    const id = pdfBtn.getAttribute('data-pdf');
    const annonce = cache.find(a => a.id === id);
    if (annonce) generatePosterPDF(annonce);
  }
});

/* =====================================================================
   RECHERCHE / TRI
===================================================================== */

let searchDebounce;
searchBox.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchBox.value.trim();
    currentPage = 1;
    renderFeed();
  }, 200);
});
sortSelect.addEventListener('change', () => {
  sortOrder = sortSelect.value;
  renderFeed();
});

/* =====================================================================
   VUE CARTE (Leaflet / OpenStreetMap, gratuit, sans clé)
===================================================================== */

const BASSIN_ARCACHON_CENTER = [44.66, -1.15];
let leafletLoadPromise = null;

function ensureLeafletLoaded() {
  if (typeof L !== 'undefined') return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = Promise.all([
    loadStylesheetOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'),
    loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'),
  ]).catch((err) => console.warn('[UEI] Impossible de charger la carte (Leaflet)', err));
  return leafletLoadPromise;
}

function renderMap(list) {
  if (typeof L === 'undefined') return; // pas encore chargé (ou CDN bloqué) : la vue carte reste simplement inactive
  if (!leafletMap) {
    leafletMap = L.map(mapContainer).setView(BASSIN_ARCACHON_CENTER, 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(leafletMap);
    leafletMarkersLayer = L.layerGroup().addTo(leafletMap);
  }
  leafletMarkersLayer.clearLayers();
  const withCoords = list.filter(hasCoords);
  withCoords.forEach(a => {
    const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '❔' };
    const color = a.type === 'besoin' ? '#D6451B' : '#1E4B3C';
    const marker = L.circleMarker([a.lat, a.lon], {
      radius: 9, color: '#22262A', weight: 1.5, fillColor: color, fillOpacity: 0.9,
    });
    marker.bindPopup(`
      <strong>${a.type === 'besoin' ? '🆘 Cherche' : '🏡 Propose'} — ${escapeHTML(cat.label)}</strong><br>
      📍 ${escapeHTML(lieuComplet(a))}<br>
      ${escapeHTML(a.description)}<br>
      <a href="tel:${cleanTel(a.contactTel)}">📞 ${escapeHTML(a.contactTel)}</a>
    `);
    marker.addTo(leafletMarkersLayer);
  });
  if (withCoords.length) {
    leafletMap.fitBounds(withCoords.map(a => [a.lat, a.lon]), { padding: [30, 30], maxZoom: 14 });
  }
}

function setViewMode(mode) {
  viewMode = mode;
  btnViewFeed.setAttribute('data-active', mode === 'feed');
  btnViewMap.setAttribute('data-active', mode === 'map');
  if (mode === 'map') {
    feed.classList.add('hidden');
    emptyState.classList.add('hidden');
    pagination.classList.add('hidden');
    mapView.classList.remove('hidden');
    ensureLeafletLoaded().then(() => {
      setTimeout(() => leafletMap?.invalidateSize(), 50); // la carte a besoin d'un conteneur visible pour se dimensionner correctement
      renderFeed(); // redessine la carte une fois Leaflet chargé
    });
  } else {
    mapView.classList.add('hidden');
    feed.classList.remove('hidden');
  }
  renderFeed();
}
btnViewFeed.addEventListener('click', () => setViewMode('feed'));
btnViewMap.addEventListener('click', () => setViewMode('map'));

/* =====================================================================
   GÉOLOCALISATION « AUTOUR DE MOI »
===================================================================== */

btnGeoloc.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    showToast("Géolocalisation non disponible sur cet appareil");
    return;
  }
  btnGeoloc.textContent = '📍 Localisation…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      btnGeoloc.textContent = '📍 Autour de moi ✓';
      const distOption = sortSelect.querySelector('option[value="distance"]');
      if (distOption) distOption.disabled = false;
      sortSelect.value = 'distance';
      sortOrder = 'distance';
      showToast('Position obtenue — tri par distance activé');
      renderFeed();
    },
    (err) => {
      btnGeoloc.textContent = '📍 Autour de moi';
      showToast("Localisation refusée ou indisponible");
      console.warn('[UEI] Géolocalisation refusée/indisponible', err);
    },
    { enableHighAccuracy: false, timeout: 8000 }
  );
});

/* =====================================================================
   MASQUER LES ANNONCES POURVUES / EN PAUSE
===================================================================== */

chkHideResolved.addEventListener('change', () => {
  hideResolved = chkHideResolved.checked;
  currentPage = 1;
  renderFeed();
});

/* =====================================================================
   AFFICHE PDF IMPRIMABLE (jsPDF, pour les annonces sans smartphone)
===================================================================== */

let jspdfLoadPromise = null;
function ensureJsPDFLoaded() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (jspdfLoadPromise) return jspdfLoadPromise;
  jspdfLoadPromise = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .catch((err) => console.warn('[UEI] Impossible de charger jsPDF', err));
  return jspdfLoadPromise;
}

async function generatePosterPDF(a) {
  await ensureJsPDFLoaded();
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast("Génération PDF indisponible (script non chargé)");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '' };
  const pageW = 210;
  let y = 22;

  doc.setFillColor(34, 38, 42);
  doc.rect(0, 0, pageW, 14, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('URGENCE ENTRAIDE INCENDIE', pageW / 2, 9.5, { align: 'center' });

  doc.setTextColor(214, 69, 27);
  doc.setFontSize(26);
  doc.text(a.type === 'besoin' ? 'RECHERCHE D\'AIDE' : "PROPOSITION D'AIDE", pageW / 2, y + 10, { align: 'center' });
  y += 24;

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(18);
  doc.text(`${cat.label}`, pageW / 2, y, { align: 'center' });
  y += 12;

  doc.setDrawColor(201, 185, 149);
  doc.line(20, y, pageW - 20, y);
  y += 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.text(`📍 Lieu : ${lieuComplet(a)}`, 20, y);
  y += 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  const descLines = doc.splitTextToSize(a.description, pageW - 40);
  doc.text(descLines, 20, y);
  y += descLines.length * 7 + 10;

  doc.setDrawColor(201, 185, 149);
  doc.line(20, y, pageW - 20, y);
  y += 16;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(30, 75, 60);
  doc.text(`Contact : ${a.contactPrenom}`, pageW / 2, y, { align: 'center' });
  y += 14;
  doc.setFontSize(28);
  doc.text(a.contactTel, pageW / 2, y, { align: 'center' });
  y += 16;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text('Site citoyen d\'entraide, non affilié aux services officiels.', pageW / 2, 280, { align: 'center' });
  doc.text('Danger immédiat : 18 (pompiers) ou 112.', pageW / 2, 285, { align: 'center' });

  doc.save(`annonce-${a.id}.pdf`);
}

/* =====================================================================
   AUTOCOMPLÉTION D'ADRESSE (API Adresse — Base Adresse Nationale,
   data.gouv.fr : gratuite, publique, sans clé). Dégrade proprement en
   saisie libre si hors-ligne ou si l'API ne répond pas.
===================================================================== */

const communeInput = el('f-commune-input');
const communeHidden = el('f-commune');
const communeLat = el('f-lat');
const communeLon = el('f-lon');
const communeSuggestions = el('f-commune-suggestions');
let communeDebounce, communeAbort;

function hideCommuneSuggestions() {
  communeSuggestions.classList.add('hidden');
  communeSuggestions.innerHTML = '';
}

async function fetchCommuneSuggestions(q) {
  communeAbort?.abort();
  communeAbort = new AbortController();
  try {
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&type=municipality&limit=6`, { signal: communeAbort.signal });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    const features = data.features || [];
    if (!features.length) { hideCommuneSuggestions(); return; }
    communeSuggestions.innerHTML = features.map(f => {
      const label = f.properties.label;
      const postcode = f.properties.postcode || '';
      const [lon, lat] = f.geometry?.coordinates || [];
      return `<li data-value="${escapeHTML(label)}" data-lat="${lat ?? ''}" data-lon="${lon ?? ''}" class="px-3 py-2.5 hover:bg-warm-100 cursor-pointer text-sm border-b border-sand/30 last:border-0 flex items-center justify-between gap-2">
        <span>${escapeHTML(label)}</span><span class="font-mono text-[10px] text-ink/40 shrink-0">${escapeHTML(postcode)}</span>
      </li>`;
    }).join('');
    communeSuggestions.classList.remove('hidden');
  } catch (err) {
    if (err.name !== 'AbortError') hideCommuneSuggestions(); // API indisponible : on laisse la saisie libre faire foi
  }
}

communeInput.addEventListener('input', () => {
  communeHidden.value = '';
  communeLat.value = '';
  communeLon.value = '';
  const q = communeInput.value.trim();
  clearTimeout(communeDebounce);
  if (q.length < 2) { hideCommuneSuggestions(); return; }
  communeDebounce = setTimeout(() => fetchCommuneSuggestions(q), 250);
});
communeSuggestions.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-value]');
  if (!li) return;
  const value = li.getAttribute('data-value');
  communeInput.value = value;
  communeHidden.value = value;
  communeLat.value = li.getAttribute('data-lat') || '';
  communeLon.value = li.getAttribute('data-lon') || '';
  hideCommuneSuggestions();
});
communeInput.addEventListener('blur', () => {
  setTimeout(() => {
    hideCommuneSuggestions();
    if (!communeHidden.value) communeHidden.value = communeInput.value.trim(); // repli : saisie libre acceptée
  }, 150);
});
document.addEventListener('click', (e) => {
  if (!communeInput.contains(e.target) && !communeSuggestions.contains(e.target)) hideCommuneSuggestions();
});

/* =====================================================================
   MODALE / PUBLICATION
===================================================================== */

function openModal(presetType) {
  annonceForm.reset();
  communeHidden.value = '';
  communeLat.value = '';
  communeLon.value = '';
  hideCommuneSuggestions();
  const identity = getIdentity();
  if (identity) {
    el('f-prenom').value = identity.prenom;
    el('f-tel').value = identity.tel;
  }
  if (presetType) {
    const radio = annonceForm.querySelector(`input[name="type"][value="${presetType}"]`);
    if (radio) radio.checked = true;
    modalTitle.textContent = presetType === 'besoin' ? "Je cherche de l'aide" : "Je propose de l'aide";
  } else {
    modalTitle.textContent = 'Publier une annonce';
  }
  formError.classList.add('hidden');
  modalBackdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  modalBackdrop.classList.add('hidden');
  document.body.style.overflow = '';
}
btnDemander.addEventListener('click', () => openModal('besoin'));
btnProposer.addEventListener('click', () => openModal('offre'));
btnCloseModal.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

function validatePhone(raw) {
  const cleaned = (raw || '').trim().replace(/[\s.\-()]/g, '');
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true; // +33 suivi de 9 chiffres (sans le 0 initial)
  const digitsOnly = cleaned.replace(/^\+/, '').replace(/\D/g, '');
  return digitsOnly.length >= 10;
}

const telInput = el('f-tel');
const telError = el('f-tel-error');
telInput.addEventListener('input', () => telError.classList.add('hidden'));

annonceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const type = annonceForm.querySelector('input[name="type"]:checked')?.value;
  const categorie = el('f-categorie').value;
  const commune = communeHidden.value || communeInput.value.trim();
  const quartier = el('f-quartier').value.trim();
  const description = el('f-description').value.trim();
  const contactPrenom = el('f-prenom').value.trim();
  const contactTel = el('f-tel').value.trim();
  const lat = communeLat.value ? parseFloat(communeLat.value) : null;
  const lon = communeLon.value ? parseFloat(communeLon.value) : null;

  if (!type || !categorie || !commune || !description || !contactPrenom || !contactTel) {
    formError.textContent = 'Merci de remplir tous les champs obligatoires.';
    formError.classList.remove('hidden');
    return;
  }

  if (!validatePhone(contactTel)) {
    telError.classList.remove('hidden');
    telInput.focus();
    return;
  }
  telError.classList.add('hidden');

  setIdentity(contactPrenom, contactTel);
  const annonce = addAnnonce({ type, categorie, commune, quartier, description, contactPrenom, contactTel, lat, lon });
  markMine(annonce.id);
  closeModal();
  currentPage = 1;
  renderFeed();
  openShareModal(annonce);
});

/* =====================================================================
   MODALE DE PARTAGE APRÈS PUBLICATION
===================================================================== */

function openShareModal(annonce) {
  pendingShareData = annonce;
  btnShareWhatsappNow.href = whatsappLink(annonce);
  shareModalBackdrop.classList.remove('hidden');
}
function closeShareModal() {
  shareModalBackdrop.classList.add('hidden');
  pendingShareData = null;
}
btnCloseShareModal.addEventListener('click', closeShareModal);
shareModalBackdrop.addEventListener('click', (e) => { if (e.target === shareModalBackdrop) closeShareModal(); });
btnShareWhatsappNow.addEventListener('click', () => {
  showToast('Ouverture de WhatsApp…');
  setTimeout(closeShareModal, 400);
});

/* =====================================================================
   LIEN DE PARTAGE : encode l'annonce dans l'URL pour import automatique
===================================================================== */

function buildShareLink(a) {
  const payload = {
    id: a.id, type: a.type, categorie: a.categorie, commune: a.commune,
    quartier: a.quartier || '', description: a.description,
    contactPrenom: a.contactPrenom, contactTel: a.contactTel, createdAt: a.createdAt,
    statut: a.statut || 'ouvert', lat: a.lat ?? null, lon: a.lon ?? null,
  };
  const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
  const base = location.origin + location.pathname;
  return `${base}?a=${encoded}`;
}

function tryImportFromURL() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('a');
  if (!raw) return;
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
    const payload = JSON.parse(json);
    if (payload && payload.id && payload.type && payload.description) {
      const added = importAnnonce(payload);
      if (added) {
        importBanner.classList.remove('hidden');
        setTimeout(() => importBanner.classList.add('hidden'), 6000);
      }
    }
  } catch (err) {
    console.warn('Lien de partage invalide', err);
  } finally {
    const url = new URL(location.href);
    url.searchParams.delete('a');
    history.replaceState({}, '', url.pathname + url.search);
  }
}

/* =====================================================================
   MUR DE SOUTIEN — messages libres (pas de statut, pas de contact requis),
   stockés dans une collection Firestore séparée ("soutien"). Même
   stratégie de sondage périodique que pour les annonces (la seule
   méthode dont on a la preuve qu'elle fonctionne dans cet environnement).
===================================================================== */

const FIXED_THANKS = [
  '👏 Merci aux pompiers', '👏 Merci aux personnels médicaux et paramédicaux',
  '👏 Merci aux responsables et personnels des EHPAD', '👏 Merci à la sécurité civile',
  '👏 Merci aux forces de l\'ordre et corps d\'état mobilisés', '👏 Merci aux bénévoles',
  '👏 Merci aux donateurs', '👏 Merci aux citoyens solidaires', '👏 Une pensée pour les victimes',
];

const SOUTIEN_STORAGE_KEY = 'uei_soutien_v1';
let soutienCache = [];
let soutienMigrated = false;

function loadSoutienLocal() {
  try { return JSON.parse(localStorage.getItem(SOUTIEN_STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveSoutienLocal(items) {
  try { localStorage.setItem(SOUTIEN_STORAGE_KEY, JSON.stringify(items)); } catch {}
}

async function pollSoutien(isFirst) {
  if (!db) return;
  try {
    const snap = await db.collection('soutien').orderBy('createdAt', 'desc').limit(150).get();
    soutienCache = snap.docs.map(d => d.data());
    saveSoutienLocal(soutienCache);
    if (isFirst && !soutienMigrated) {
      soutienMigrated = true;
      const localBefore = loadSoutienLocal();
      const knownIds = new Set(soutienCache.map(m => m.id));
      const orphans = localBefore.filter(m => !knownIds.has(m.id));
      if (orphans.length) {
        soutienCache = [...orphans, ...soutienCache].sort((a, b) => b.createdAt - a.createdAt);
        saveSoutienLocal(soutienCache);
        orphans.forEach(m => db.collection('soutien').doc(m.id).set(m, { merge: true }).catch(() => {}));
      }
    }
    renderTicker();
    renderSoutienWall();
  } catch (err) {
    console.warn('[UEI] Échec sondage soutien', err);
  }
}

function addSoutienMessage(message, pseudo) {
  const m = { id: makeId(), message, pseudo: pseudo || null, createdAt: Date.now() };
  soutienCache = [m, ...soutienCache];
  saveSoutienLocal(soutienCache);
  renderTicker();
  renderSoutienWall();
  if (db) {
    db.collection('soutien').doc(m.id).set(m).catch((err) => {
      console.warn('[UEI] Échec envoi message de soutien, restera local seulement', err);
    });
  }
  return m;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderTicker() {
  const liveItems = soutienCache.slice(0, 30).map(m =>
    `<span class="ticker-item">💬 ${escapeHTML(m.message)} <span class="ticker-pseudo">— ${escapeHTML(m.pseudo || 'Anonyme')}</span></span>`
  );
  const fixedItems = FIXED_THANKS.map(t => `<span class="ticker-item">${t}</span>`);
  // Mélange des deux listes (remerciements fixes + messages postés), en boucle
  const merged = [];
  const maxLen = Math.max(fixedItems.length, liveItems.length);
  for (let i = 0; i < maxLen; i++) {
    if (fixedItems[i]) merged.push(fixedItems[i]);
    if (liveItems[i]) merged.push(liveItems[i]);
  }
  if (!merged.length) return;
  // Le contenu est dupliqué deux fois : l'animation CSS translate -50%
  // crée ainsi une boucle parfaitement continue, sans saut visible.
  tickerTrack.innerHTML = merged.join('') + merged.join('');
}

function renderSoutienWall() {
  if (!soutienCache.length) {
    soutienWall.innerHTML = '';
    soutienEmpty.classList.remove('hidden');
    return;
  }
  soutienEmpty.classList.add('hidden');
  const shown = shuffle(soutienCache).slice(0, 24);
  soutienWall.innerHTML = shown.map(m => `
    <div class="soutien-card">
      “${escapeHTML(m.message)}”
      <span class="soutien-pseudo">${escapeHTML(m.pseudo || 'Anonyme')}</span>
    </div>`).join('');
}

const btnSoutien = el('btn-soutien');
const soutienModalBackdrop = el('soutien-modal-backdrop');
const btnCloseSoutienModal = el('btn-close-soutien-modal');
const soutienForm = el('soutien-form');
const soutienMessageInput = el('soutien-message');
const soutienPseudoInput = el('soutien-pseudo');
const soutienCharCount = el('soutien-char-count');
const soutienWall = el('soutien-wall');
const soutienEmpty = el('soutien-empty');
const tickerTrack = el('ticker-track');

// Affiche déjà les remerciements fixes avant même toute connexion réseau
renderTicker();

function openSoutienModal() {
  soutienForm.reset();
  soutienCharCount.textContent = '0';
  soutienModalBackdrop.classList.remove('hidden');
}
function closeSoutienModal() { soutienModalBackdrop.classList.add('hidden'); }

btnSoutien.addEventListener('click', openSoutienModal);
btnCloseSoutienModal.addEventListener('click', closeSoutienModal);
soutienModalBackdrop.addEventListener('click', (e) => { if (e.target === soutienModalBackdrop) closeSoutienModal(); });
soutienMessageInput.addEventListener('input', () => {
  soutienCharCount.textContent = String(soutienMessageInput.value.length);
});
soutienForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = soutienMessageInput.value.trim();
  const pseudo = soutienPseudoInput.value.trim();
  if (!message) return;
  addSoutienMessage(message.slice(0, 200), pseudo.slice(0, 30));
  closeSoutienModal();
  showToast('Merci pour ce message 💛');
});

/* =====================================================================
   TOAST
===================================================================== */

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

/* =====================================================================
   INIT — le fil est visible immédiatement (rendu local), la connexion
   au fil partagé se fait ensuite en arrière-plan sans bloquer l'UI.
===================================================================== */

async function init() {
  await initSync();          // on attend de savoir si on est connecté (max 4s)
  tryImportFromURL();        // ...avant d'importer un lien reçu, pour qu'il soit bien partagé si on est en ligne
  renderFeed();               // affiche l'annonce importée le cas échéant

  soutienCache = loadSoutienLocal();
  renderTicker();
  renderSoutienWall();
  if (db) {
    pollSoutien(true);
    const t = setInterval(() => pollSoutien(false), POLL_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }
}
init();
