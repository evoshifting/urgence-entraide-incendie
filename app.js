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
let analytics = null;

// Utilitaire de log sécurisé : n'échoue jamais, même si Analytics n'a pas
// pu s'initialiser (bloqueur de pub...) — un simple no-op dans ce cas.
function logEvent(name, params) {
  try {
    if (analytics) analytics.logEvent(name, params);
  } catch (err) { /* silencieux, volontairement */ }
}
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
// Fenêtre de temps dans laquelle une annonce/un message locale(e) peut
// encore être considéré(e) comme "en attente de synchronisation" plutôt
// que "supprimé(e) intentionnellement depuis" (voir garde-fous plus bas).
const MIGRATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
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
    // joignable est renvoyée vers le fil partagé.
    //
    // ⚠️ GARDE-FOUS CRITIQUES (bug corrigé le 27/07) : sans restriction,
    // cette migration ressuscitait n'importe quelle annonce supprimée par
    // un modérateur, dès qu'un appareil ayant encore l'ancienne version en
    // cache local rechargeait la page — le sondage ne la trouvait plus sur
    // le serveur, la prenait pour une "orpheline jamais synchronisée", et
    // la renvoyait. On ne migre donc désormais QUE les annonces qui sont
    // À LA FOIS (a) marquées "mienne" sur CET appareil (publiées ici, pas
    // juste vues) ET (b) créées très récemment — le vrai scénario legitime
    // étant "je viens de publier hors-ligne, ça n'a pas encore synchronisé".
    // Une annonce plus ancienne, même absente du serveur, est supposée
    // avoir été supprimée intentionnellement, jamais réinjectée.
    if (!migrated) {
      migrated = true;
      const knownIds = new Set(cache.map(a => a.id));
      const mineIds = getMineIds();
      const orphans = localBeforeSync.filter(a =>
        !knownIds.has(a.id) && mineIds.has(a.id) && (Date.now() - a.createdAt) < MIGRATION_WINDOW_MS
      );
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

    // Analytics est optionnel et fréquemment bloqué (bloqueurs de pub,
    // navigateurs orientés vie privée) — on l'active "en bonus", sans
    // jamais laisser un échec ici perturber le reste du site (annonces,
    // synchronisation...), qui doit continuer à fonctionner sans lui.
    try {
      if (typeof firebase.analytics === 'function' && cfg.measurementId) {
        analytics = firebase.analytics();
      }
    } catch (err) {
      console.warn('[UEI] Analytics indisponible (bloqueur de pub ?), pas grave, le reste du site continue', err);
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
  logEvent('annonce_publiee', { type: annonce.type, categorie: annonce.categorie });
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
   "GÉRER UNE ANNONCE" — retrouve la gestion (statut/suppression) d'une
   annonce publiée depuis un autre appareil, ou une fenêtre de navigation
   privée entre-temps fermée (la liste "mes annonces" est alors perdue,
   irrémédiablement, puisqu'elle vit dans le stockage local de cette
   fenêtre-là uniquement). Vérification par numéro de téléphone : c'est
   déjà la donnée publique affichée sur l'annonce elle-même, donc ça
   n'expose rien de nouveau — simplement pratique, pas une authentification
   forte.
===================================================================== */

const btnManageMine = el('btn-manage-mine');
const manageModalBackdrop = el('manage-modal-backdrop');
const btnCloseManageModal = el('btn-close-manage-modal');
const manageForm = el('manage-form');
const manageTelInput = el('manage-tel');
const manageError = el('manage-error');

function openManageModal() {
  manageForm.reset();
  manageError.classList.add('hidden');
  manageModalBackdrop.classList.remove('hidden');
}
function closeManageModal() { manageModalBackdrop.classList.add('hidden'); }

btnManageMine.addEventListener('click', openManageModal);
btnCloseManageModal.addEventListener('click', closeManageModal);
manageModalBackdrop.addEventListener('click', (e) => { if (e.target === manageModalBackdrop) closeManageModal(); });

manageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const target = cleanTel(manageTelInput.value);
  if (!target) return;
  const matches = cache.filter(a => cleanTel(a.contactTel) === target);
  if (!matches.length) {
    manageError.classList.remove('hidden');
    return;
  }
  manageError.classList.add('hidden');
  matches.forEach(a => markMine(a.id));
  closeManageModal();
  renderFeed();
  showToast(`${matches.length} annonce${matches.length > 1 ? 's' : ''} retrouvée${matches.length > 1 ? 's' : ''} — gérable${matches.length > 1 ? 's' : ''} depuis le fil`);
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
   CHARGEMENT À LA DEMANDE (Leaflet) — pour ne pas alourdir le premier
   chargement de la page avec une bibliothèque dont la plupart des
   visiteurs ne se serviront jamais (carte).
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
  const cat = (CATEGORIES[a.categorie] || { label: a.categorie }).label;
  const action = a.type === 'besoin' ? 'Recherche' : 'Offre';
  const link = buildShareLink(a);
  return `[Urgence Entraide Incendie] ${action} · ${cat}\n${a.description}\n— ${a.contactPrenom}, ${lieuComplet(a)} · 📞 ${a.contactTel}\n👉 ${link}`;
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

function renderFacets(all, searchFiltered) {
  // -- Type --
  const byType = filteredExcept(searchFiltered, 'type');
  const cBesoin = byType.filter(a => a.type === 'besoin').length;
  const cOffre = byType.filter(a => a.type === 'offre').length;
  facetType.innerHTML =
    facetRow('Tout', byType.length, filterType === 'all', `data-filter-type="all"`) +
    facetRow('🆘 Cherche', cBesoin, filterType === 'besoin', `data-filter-type="besoin"`) +
    facetRow('🤝 Propose', cOffre, filterType === 'offre', `data-filter-type="offre"`);

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
}

/* =====================================================================
   TABLEAU DE BORD
===================================================================== */

function renderStats(all) {
  const actives = all.filter(a => (a.statut || 'ouvert') === 'ouvert');
  const offres = actives.filter(a => a.type === 'offre').length;
  const besoins = actives.filter(a => a.type === 'besoin').length;
  statsBar.innerHTML = `
    <div class="bg-solid-light rounded-2xl py-3">
      <p class="text-2xl font-black text-solid-dark leading-none">${offres}</p>
      <p class="text-xs font-bold uppercase tracking-wide text-emerald-700/80 mt-1">offre${offres > 1 ? 's' : ''} disponible${offres > 1 ? 's' : ''}</p>
    </div>
    <div class="bg-urgent-light rounded-2xl py-3">
      <p class="text-2xl font-black text-urgent-dark leading-none">${besoins}</p>
      <p class="text-xs font-bold uppercase tracking-wide text-orange-700/80 mt-1">besoin${besoins > 1 ? 's' : ''} en attente</p>
    </div>`;
}

/* =====================================================================
   CARTES
===================================================================== */

function cardHTML(a) {
  const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '❔' };
  const isBesoin = a.type === 'besoin';
  const badgeClass = isBesoin ? 'badge-cherche' : 'badge-propose';
  const badgeLabel = isBesoin ? 'Cherche' : 'Propose';
  const statutKey = a.statut || 'ouvert';
  const statut = STATUTS[statutKey] || STATUTS.ouvert;
  const inactiveClass = statutKey !== 'ouvert' ? 'card-annonce--inactive' : '';
  const mine = getMineIds().has(a.id);
  const telClean = cleanTel(a.contactTel);
  const distLabel = (userPos && hasCoords(a))
    ? ` · ${distanceKm(userPos.lat, userPos.lon, a.lat, a.lon).toFixed(1)} km`
    : '';

  const statutButtons = mine ? `
    <div class="flex items-center flex-wrap gap-1.5 mt-3 pt-3 border-t border-gray-100">
      <span class="text-xs font-bold uppercase text-gray-500 mr-1">Statut :</span>
      ${Object.entries(STATUTS).map(([key, s]) =>
        `<button data-set-statut="${a.id}" data-statut-value="${key}" class="statut-btn" data-active="${statutKey === key}">${s.icon} ${s.label}</button>`
      ).join('')}
    </div>` : '';

  return `
  <article class="card-enter card-annonce ${inactiveClass} bg-white border border-gray-100 rounded-[18px] shadow-sm px-[22px] py-5">
    <div class="flex items-start justify-between gap-2 mb-2.5">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[11.5px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-lg ${badgeClass}">${badgeLabel}</span>
        <span class="text-[13px] text-gray-500">${cat.icon} ${cat.label}</span>
        <span class="text-xs font-semibold px-2 py-0.5 rounded-full statut-badge--${statutKey}">${statut.icon} ${statut.label}</span>
      </div>
      <span class="text-xs text-gray-400 shrink-0">${timeAgo(a.createdAt)}${distLabel}</span>
    </div>

    <p class="text-[16.5px] text-gray-800 leading-[1.6] tracking-[-0.005em]">${escapeHTML(a.description)}</p>

    <p class="text-sm text-gray-500 mt-2.5">
      📍 <strong class="text-gray-700 font-semibold">${escapeHTML(lieuComplet(a))}</strong>
      <span class="text-gray-400">· ${escapeHTML(a.contactPrenom)}</span>
      <button data-copy="${escapeHTML(a.contactTel)}" class="btn-copy underline decoration-gray-300 hover:text-gray-700">Copier n°</button>
    </p>

    <div class="flex items-center gap-2.5 mt-4 pt-4 border-t border-gray-100">
      <a href="tel:${telClean}" class="flex-1 min-h-[42px] inline-flex items-center justify-center gap-1.5 text-[15px] font-semibold bg-gray-100 hover:bg-gray-200 active:scale-[.97] transition text-gray-900 rounded-xl">📞 Appeler</a>
      <a href="${whatsappLink(a)}" target="_blank" rel="noopener" class="flex-1 min-h-[42px] inline-flex items-center justify-center gap-1.5 text-[15px] font-semibold bg-wa hover:bg-wa-dark active:scale-[.97] transition text-white rounded-xl">💬 Partager</a>
      ${mine ? `<button data-delete="${a.id}" class="btn-delete min-h-[42px] min-w-[42px] text-sm font-semibold text-gray-400 hover:text-urgent shrink-0" aria-label="Supprimer mon annonce">🗑️</button>` : ''}
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
      <button id="page-prev" ${currentPage === 1 ? 'disabled' : ''} class="min-h-[44px] px-4 py-2 rounded-xl border border-sand text-xs font-bold uppercase tracking-wide disabled:opacity-30 bg-white">← Précédent</button>
      <span class="font-semibold text-xs text-gray-500">Page ${currentPage} / ${totalPages}</span>
      <button id="page-next" ${currentPage === totalPages ? 'disabled' : ''} class="min-h-[44px] px-4 py-2 rounded-xl border border-sand text-xs font-bold uppercase tracking-wide disabled:opacity-30 bg-white">Suivant →</button>`;
    el('page-prev')?.addEventListener('click', () => { currentPage--; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
    el('page-next')?.addEventListener('click', () => { currentPage++; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
  } else {
    pagination.classList.add('hidden');
  }
}

feed.addEventListener('click', async (e) => {
  const telLink = e.target.closest('a[href^="tel:"]');
  if (telLink) logEvent('appel_clique', {});
  const waLink = e.target.closest('a[href*="wa.me"]');
  if (waLink) logEvent('partage_clique', {});

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

// Centre + zoom couvrant toute la zone touchée par l'incendie (au nord de
// Lacanau, au sud de Biscarrosse, à l'ouest et au sud de Bordeaux) — pas
// seulement le Bassin d'Arcachon, pour ne pas paraître arbitrairement
// zoomé sur un seul secteur au chargement initial.
const DEFAULT_MAP_CENTER = [44.72, -1.0];
const DEFAULT_MAP_ZOOM = 9;
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
    leafletMap = L.map(mapContainer).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
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
    const color = a.type === 'besoin' ? '#EA580C' : '#059669';
    const marker = L.circleMarker([a.lat, a.lon], {
      radius: 9, color: '#111827', weight: 1.5, fillColor: color, fillOpacity: 0.9,
    });
    marker.bindPopup(`
      <strong>${a.type === 'besoin' ? '🆘 Cherche' : '🤝 Propose'} — ${escapeHTML(cat.label)}</strong><br>
      📍 ${escapeHTML(lieuComplet(a))}<br>
      ${escapeHTML(a.description)}<br>
      <a href="tel:${cleanTel(a.contactTel)}">📞 ${escapeHTML(a.contactTel)}</a>
    `);
    marker.addTo(leafletMarkersLayer);
  });
  if (withCoords.length === 1) {
    // Un seul point : fitBounds sur un point unique zoomerait au maximum
    // (zone quasi nulle), donnant l'impression très rapprochée observée.
    // On centre plutôt avec un zoom raisonnable, cohérent avec l'échelle
    // régionale de la zone d'incendie.
    leafletMap.setView([withCoords[0].lat, withCoords[0].lon], 12);
  } else if (withCoords.length > 1) {
    leafletMap.fitBounds(withCoords.map(a => [a.lat, a.lon]), { padding: [40, 40], maxZoom: 12 });
  } else {
    leafletMap.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
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
    // On utilise l'API Découpage administratif (geo.api.gouv.fr), pas l'API
    // Adresse (api-adresse.data.gouv.fr) : cette dernière ne renvoie qu'UN
    // SEUL code postal par ville, même pour les villes qui en ont plusieurs
    // (Bordeaux, Toulouse, Nantes, Lille...) — limite documentée de cette
    // API, confirmée par le forum officiel Etalab. geo.api.gouv.fr renvoie
    // en revanche la liste complète des codes postaux par commune
    // (`codesPostaux`), ce qui permet de proposer "Bordeaux 33000",
    // "Bordeaux 33100", "Bordeaux 33300"... séparément, comme sur les
    // sites d'annonces grand public.
    // `boost=population` fait remonter les grandes villes en premier
    // (évite qu'un hameau homonyme perdu dans un autre département sorte
    // avant la vraie ville recherchée).
    const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}&boost=population&limit=6&fields=nom,codesPostaux,centre`, { signal: communeAbort.signal });
    if (!res.ok) throw new Error('bad response');
    const communes = await res.json();
    if (!Array.isArray(communes) || !communes.length) { hideCommuneSuggestions(); return; }
    // Développe chaque commune en une ligne par code postal.
    const rows = [];
    communes.forEach(c => {
      const [lon, lat] = c.centre?.coordinates || [];
      const postcodes = (c.codesPostaux && c.codesPostaux.length) ? c.codesPostaux : [''];
      postcodes.forEach(cp => rows.push({ nom: c.nom, postcode: cp, lat, lon }));
    });
    const limited = rows.slice(0, 14);
    communeSuggestions.innerHTML = limited.map(r => {
      const value = r.postcode ? `${r.nom} ${r.postcode}` : r.nom;
      return `<li data-value="${escapeHTML(value)}" data-lat="${r.lat ?? ''}" data-lon="${r.lon ?? ''}" class="px-3 py-2.5 hover:bg-warm-100 cursor-pointer text-sm border-b border-sand/30 last:border-0 flex items-center justify-between gap-2">
        <span>${escapeHTML(r.nom)}</span><span class="font-semibold text-xs text-gray-500 shrink-0">${escapeHTML(r.postcode)}</span>
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
   AUTOCOMPLÉTION DU QUARTIER — API Adresse (api-adresse.data.gouv.fr),
   contrairement au champ Ville : ici on VEUT la précision rue/quartier
   que cette API donne bien (elle n'est mauvaise que pour les recherches
   de simples noms de ville, à cause de son classement par pertinence
   textuelle plutôt que par importance — pas un souci quand on tape déjà
   un nom de quartier précis). La recherche est biaisée autour de la
   ville déjà choisie (paramètres lat/lon) pour prioriser les résultats
   proches plutôt qu'un homonyme à l'autre bout de la France.
   Sélectionner une suggestion ici AFFINE les coordonnées GPS de
   l'annonce (elles remplacent celles, plus approximatives, de la ville
   seule) — la carte devient donc plus précise, sans rien casser côté
   filtre "Zone" qui continue de se baser sur le champ Ville.
===================================================================== */

const quartierInput = el('f-quartier');
const quartierSuggestions = el('f-quartier-suggestions');
let quartierDebounce, quartierAbort;

function hideQuartierSuggestions() {
  quartierSuggestions.classList.add('hidden');
  quartierSuggestions.innerHTML = '';
}

async function fetchQuartierSuggestions(q) {
  quartierAbort?.abort();
  quartierAbort = new AbortController();
  try {
    let url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6`;
    if (communeLat.value && communeLon.value) {
      url += `&lat=${encodeURIComponent(communeLat.value)}&lon=${encodeURIComponent(communeLon.value)}`;
    }
    const res = await fetch(url, { signal: quartierAbort.signal });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    const features = data.features || [];
    if (!features.length) { hideQuartierSuggestions(); return; }
    quartierSuggestions.innerHTML = features.map(f => {
      const label = f.properties.label;
      const [lon, lat] = f.geometry?.coordinates || [];
      return `<li data-value="${escapeHTML(f.properties.name || label)}" data-lat="${lat ?? ''}" data-lon="${lon ?? ''}" class="px-3 py-2.5 hover:bg-warm-100 cursor-pointer text-sm border-b border-sand/30 last:border-0">
        ${escapeHTML(label)}
      </li>`;
    }).join('');
    quartierSuggestions.classList.remove('hidden');
  } catch (err) {
    if (err.name !== 'AbortError') hideQuartierSuggestions(); // API indisponible : le champ reste un simple texte libre
  }
}

quartierInput.addEventListener('input', () => {
  const q = quartierInput.value.trim();
  clearTimeout(quartierDebounce);
  if (q.length < 3) { hideQuartierSuggestions(); return; }
  quartierDebounce = setTimeout(() => fetchQuartierSuggestions(q), 250);
});
quartierSuggestions.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-value]');
  if (!li) return;
  quartierInput.value = li.getAttribute('data-value');
  const lat = li.getAttribute('data-lat');
  const lon = li.getAttribute('data-lon');
  // On affine les coordonnées de l'annonce SEULEMENT si la suggestion en
  // fournit — sinon on garde celles, plus larges, de la ville.
  if (lat && lon) { communeLat.value = lat; communeLon.value = lon; }
  hideQuartierSuggestions();
});
quartierInput.addEventListener('blur', () => setTimeout(hideQuartierSuggestions, 150));
document.addEventListener('click', (e) => {
  if (!quartierInput.contains(e.target) && !quartierSuggestions.contains(e.target)) hideQuartierSuggestions();
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
  hideQuartierSuggestions();
  descriptionCharCount.textContent = '0';
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
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true; // +33 suivi de 9 chiffres (sans le 0 initial) = 10 chiffres au total
  const digitsOnly = cleaned.replace(/^\+/, '').replace(/\D/g, '');
  // Exactement 10 chiffres (format français standard 0X XX XX XX XX) —
  // pas "au moins 10" : un numéro à 11 chiffres ou plus est bien invalide,
  // pas juste "un peu long".
  return digitsOnly.length === 10;
}

const telInput = el('f-tel');
const telError = el('f-tel-error');
telInput.addEventListener('input', () => telError.classList.add('hidden'));

const descriptionInput = el('f-description');
const descriptionCharCount = el('description-char-count');
descriptionInput.addEventListener('input', () => {
  descriptionCharCount.textContent = String(descriptionInput.value.length);
});

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
  replayLogoAnimation(headerLogoSvg);
  openConfirmationOverlay(() => openShareModal(annonce));
});

/* =====================================================================
   ANIMATION DE VALIDATION — logo "braise vivante" + confirmation plein
   écran chaleureuse, jouée à chaque publication d'annonce réussie
   (demande ou offre). Jamais en boucle au repos, jamais anxiogène.
===================================================================== */

const headerLogoSvg = el('header-logo-svg');

// Rejoue l'animation CSS d'un SVG en repartant de zéro (retire la classe,
// force un reflow, la remet) — sans ce forçage, réappliquer la même
// classe ne redéclenche rien si elle était déjà présente.
function replayLogoAnimation(svgEl) {
  if (!svgEl) return;
  svgEl.classList.remove('uei-anim');
  void svgEl.getBoundingClientRect(); // force le reflow
  svgEl.classList.add('uei-anim');
}

// Même structure que le logo du header, avec des identifiants de
// dégradé/filtre distincts (des ids dupliqués entre deux <svg> présents
// simultanément dans le DOM casseraient le rendu de l'un des deux).
function overlayLogoSvgMarkup() {
  return `<svg id="overlay-logo-svg" width="88" height="88" viewBox="0 0 64 64" style="overflow:visible" class="mx-auto mb-4" aria-hidden="true">
    <defs>
      <linearGradient id="uei-tile-ovl" x1="10" y1="6" x2="54" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FF9D5C"/><stop offset=".52" stop-color="#F26D2B"/><stop offset="1" stop-color="#E14B10"/>
      </linearGradient>
      <linearGradient id="uei-sheen-ovl" x1="32" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <filter id="uei-shadow-ovl" x="-30%" y="-25%" width="160%" height="165%">
        <feDropShadow dx="0" dy="2.5" stdDeviation="3.5" flood-color="#C63E08" flood-opacity=".26"/>
      </filter>
    </defs>
    <g filter="url(#uei-shadow-ovl)">
      <path fill="url(#uei-tile-ovl)" d="M22 4h20c8.5 0 12.8 0 15.4 2.6C60 9.2 60 13.5 60 22v20c0 8.5 0 12.8-2.6 15.4C54.8 60 50.5 60 42 60H22c-8.5 0-12.8 0-15.4-2.6C4 54.8 4 50.5 4 42V22c0-8.5 0-12.8 2.6-15.4C9.2 4 13.5 4 22 4Z"/>
      <path fill="url(#uei-sheen-ovl)" d="M22 4h20c8.5 0 12.8 0 15.4 2.6C60 9.2 60 13.5 60 22v6H4v-6c0-8.5 0-12.8 2.6-15.4C9.2 4 13.5 4 22 4Z"/>
    </g>
    <g transform="translate(8 12) scale(2)" style="overflow:visible">
      <circle class="uei-glow" cx="12" cy="12" r="10" fill="none" stroke="#FDBA74" stroke-width="1.4"/>
      <g class="uei-flame">
        <path fill="#fff" fill-rule="evenodd" clip-rule="evenodd" d="M12 2.3c3.4 3.5 5.6 6.6 5.6 10.4a5.6 5.6 0 0 1-11.2 0c0-1.6.5-3 1-4 .6 1.2 1.4 1.8 2.4 1.9-1.5-3.3.4-6.5 2.2-8.3Zm0 14.6c-2-1.5-3.4-2.8-3.4-4.4a1.75 1.75 0 0 1 3.4-.5 1.75 1.75 0 0 1 3.4.5c0 1.6-1.4 2.9-3.4 4.4Z"/>
      </g>
      <circle class="uei-ember e1" cx="10.5" cy="20" r=".7" fill="#FFD9A8"/>
      <circle class="uei-ember e2" cx="13.5" cy="20" r=".5" fill="#FFD9A8"/>
      <circle class="uei-ember e3" cx="12" cy="20" r=".6" fill="#FFD9A8"/>
    </g>
  </svg>`;
}

let confirmationOverlayEl = null;
let confirmationTimer = null;

// Confirmation chaleureuse plein écran : s'auto-ferme après ~2,2s ou au
// clic, jamais empilée (une nouvelle validation remplace la précédente
// et réinitialise le minuteur). onClose() s'exécute une seule fois,
// qu'elle que soit la façon dont l'overlay se ferme.
function openConfirmationOverlay(onClose) {
  closeConfirmationOverlay(); // jamais deux overlays en même temps

  const overlay = document.createElement('div');
  overlay.className = 'uei-overlay';
  overlay.setAttribute('role', 'presentation');
  overlay.innerHTML = `
    <div class="uei-card" role="status" aria-live="polite">
      ${overlayLogoSvgMarkup()}
      <div style="font-size:20px;font-weight:800;color:#111827;">Annonce publiée !</div>
      <p style="margin-top:8px;font-size:15px;color:#6B7280;line-height:1.5;">Merci pour votre entraide. Votre annonce est maintenant visible par la communauté.</p>
    </div>`;
  document.body.appendChild(overlay);
  confirmationOverlayEl = overlay;

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    closeConfirmationOverlay();
    if (onClose) onClose();
  };

  overlay.addEventListener('click', finish);
  confirmationTimer = setTimeout(finish, 2200);

  // Rejoue l'animation du logo à l'intérieur de l'overlay dès qu'il est
  // dans le DOM (double rAF : laisse le navigateur peindre l'état initial
  // avant d'ajouter la classe, sinon l'animation "saute" son départ).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    replayLogoAnimation(el('overlay-logo-svg'));
  }));
}

function closeConfirmationOverlay() {
  clearTimeout(confirmationTimer);
  if (confirmationOverlayEl) {
    confirmationOverlayEl.remove();
    confirmationOverlayEl = null;
  }
}

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
  const base = location.origin + location.pathname;
  // Si Firestore est connecté (cas normal aujourd'hui que la synchronisation
  // est fiable), l'annonce est déjà visible pour quiconque ouvre le site —
  // pas besoin d'un lien à rallonge qui a l'air suspect dans WhatsApp.
  // On ne revient à l'ancien mécanisme (données encodées dans l'URL) que
  // si Firestore est indisponible : c'est alors le SEUL moyen pour
  // l'annonce de circuler malgré tout.
  if (!db) {
    const payload = {
      id: a.id, type: a.type, categorie: a.categorie, commune: a.commune,
      quartier: a.quartier || '', description: a.description,
      contactPrenom: a.contactPrenom, contactTel: a.contactTel, createdAt: a.createdAt,
      statut: a.statut || 'ouvert', lat: a.lat ?? null, lon: a.lon ?? null,
    };
    const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
    return `${base}?a=${encoded}`;
  }
  return base;
}

function tryImportFromURL() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('a');
  if (!raw) return;
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
    const payload = JSON.parse(json);
    // ⚠️ Même garde-fou que pour la migration ascendante (voir pollFirestore,
    // bug corrigé le 27/07) : un vieux lien de partage (WhatsApp, historique
    // du navigateur, favori...) contient les données de l'annonce telles
    // qu'au moment du partage. Sans restriction, le rouvrir des jours après
    // réinjecterait l'annonce même si elle a été supprimée entre-temps par
    // un modérateur. On n'importe donc que les liens partagés récemment.
    const isRecent = payload && payload.createdAt && (Date.now() - payload.createdAt) < MIGRATION_WINDOW_MS;
    if (payload && payload.id && payload.type && payload.description && isRecent) {
      const added = importAnnonce(payload);
      if (added) {
        importBanner.classList.remove('hidden');
        setTimeout(() => importBanner.classList.add('hidden'), 6000);
      }
    } else if (payload && payload.id && !isRecent) {
      console.info('[UEI] Lien de partage trop ancien (>30 min), ignoré pour éviter de réinjecter une annonce potentiellement supprimée depuis.');
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
   MUR DE SOUTIEN — bandeau de remerciement aux forces engagées (ordre
   mélangé une fois par chargement) + mur de messages libres des
   visiteurs, avec likes. Messages stockés dans une collection Firestore
   séparée ("soutien"). Même stratégie de sondage périodique que pour les
   annonces (la seule méthode dont on a la preuve qu'elle fonctionne dans
   cet environnement).
===================================================================== */

const FORCES = {
  "Sapeurs-pompiers & secours au sol": [
    'Sapeurs-pompiers (SDIS 33)', 'Colonnes de renfort inter-départementales',
    'Sapeurs-pompiers volontaires', 'SAMU / SMUR', 'Protection civile', 'Croix-Rouge française',
  ],
  "Soignants & professionnels de santé": [
    'Hôpitaux & CHU', 'Cliniques', 'Infirmiers & infirmières', 'Aides-soignants', 'Ambulanciers',
    'EHPAD & personnels', 'Médecins & urgentistes', 'Paramédicaux', 'Pharmaciens',
    'Psychologues & cellules de soutien',
  ],
  "Moyens aériens": [
    'Canadair', 'Dash 8', 'Hélicoptères bombardiers d\'eau', 'Pilotes de la Sécurité civile',
    'Avions de reconnaissance',
  ],
  "Forces de l'État & militaires": [
    'Sécurité civile', 'UIISC (ForMiSC)', 'Gendarmerie nationale', 'Police nationale & municipale',
    'Préfecture de la Gironde', 'Armée & réservistes',
  ],
  "Forêt, réseaux & environnement": [
    'Office national des forêts (ONF)', 'DFCI Aquitaine', 'ENEDIS & techniciens réseaux',
    'Agriculteurs (citernes, tracteurs)', 'Vétérinaires & secours animaliers',
  ],
  "Solidarité citoyenne": [
    'Bénévoles & réserves communales', 'Associations agréées de sécurité civile',
    'Communes & mairies', 'Restaurateurs & commerçants', 'Donateurs & don du sang (EFS)',
    'Hébergeurs solidaires',
  ],
};

const AVATAR_COLORS = [
  { bg: '#FFF7ED', fg: '#EA580C' }, { bg: '#ECFDF5', fg: '#059669' },
  { bg: '#EEF2FF', fg: '#4338CA' }, { bg: '#FEF2F2', fg: '#DC2626' },
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Mélange une seule fois par chargement de page (pas à chaque render) :
// aucun organisme ne doit sembler "en tête" ou prioritaire par rapport
// aux autres. Les catégories ne servent que de source : à l'affichage,
// tout est aplati en un seul rang mélangé (bandeau défilant compact).
const SHUFFLED_FORCES = shuffle(Object.values(FORCES).flat());

function renderForcesBanner() {
  const pills = SHUFFLED_FORCES.map(name => `<span class="forces__pill">${escapeHTML(name)}</span>`).join('');
  // Dupliqué deux fois : l'animation translate à -50% boucle ainsi sans
  // saut visible. Le 2ᵉ jeu est décoratif (même contenu), masqué aux
  // lecteurs d'écran.
  el('forces-track').innerHTML = pills + `<span aria-hidden="true" style="display:inline-flex;gap:8px;">${pills}</span>`;
}

/* =====================================================================
   BANDEAU DÉFILANT (TICKER) — trois sources mélangées : remerciements
   fixes, messages de soutien des visiteurs, actualités RSS France Info.

   ⚠️ Le flux RSS (franceinfo) est cross-origin : un fetch direct depuis
   le navigateur est bloqué par CORS, et ce site est 100% statique (pas
   de serveur). RSS_ENDPOINT pointe donc vers une route qui n'existe pas
   encore ("/api/rss-incendies") — tant qu'aucune fonction serveur n'est
   déployée (Cloudflare Worker, fonction Netlify/Vercel...), fetchInfoItems()
   échoue et se dégrade proprement : le ticker tourne quand même, juste
   sans les puces 🔴 INFO. C'est le comportement prévu, pas un bug.
===================================================================== */

const RSS_ENDPOINT = '/api/rss-incendies';

const TICKER_THANKS = [
  'Merci aux pompiers venus en renfort de toute la France 🧡',
  'Courage aux familles évacuées, on pense à vous',
  'Bravo aux bénévoles mobilisés au parc des expositions',
  'Merci aux soignants qui veillent sur les plus fragiles',
  'Merci à ceux qui ouvrent leur porte à des inconnus',
];

async function fetchInfoItems(limit = 6) {
  try {
    const res = await fetch(RSS_ENDPOINT, { cache: 'no-store' });
    if (!res.ok) throw new Error('endpoint indisponible');
    const xmlText = await res.text();
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('RSS invalide');
    return [...xml.querySelectorAll('item')]
      .slice(0, limit)
      .map(item => (item.querySelector('title')?.textContent || '').trim())
      .filter(Boolean)
      .map(title => ({ kind: 'info', text: title }));
  } catch (e) {
    // Dégradation gracieuse voulue : pas d'endpoint serveur disponible
    // pour l'instant sur ce site statique. Le ticker continue sans INFO.
    return [];
  }
}

function tickerChipHTML(it) {
  if (it.kind === 'info') {
    return `<span class="ticker-item"><span class="badge-info">🔴 INFO</span><span style="color:#F3F4F6;font-weight:500;">${escapeHTML(it.text)}</span></span>`;
  }
  if (it.kind === 'support') {
    return `<span class="ticker-item"><span style="color:#FDBA74;">💬</span><span style="color:#E5E7EB;">“${escapeHTML(it.text)}”</span><span style="color:#9CA3AF;font-weight:600;">— ${escapeHTML(it.name)}</span></span>`;
  }
  return `<span class="ticker-item"><span style="color:#FB923C;">🧡</span><span style="color:#E5E7EB;">${escapeHTML(it.text)}</span></span>`;
}

async function renderTicker() {
  const track = el('ticker-track');
  const supportItems = soutienCache
    .filter(m => m.message)
    .map(m => ({ kind: 'support', text: m.message, name: m.pseudo || 'Anonyme' }));
  const items = [
    ...TICKER_THANKS.map(t => ({ kind: 'thanks', text: t })),
    ...supportItems,
    ...(await fetchInfoItems()),
  ];
  if (!items.length) return;
  const mixed = shuffle(items);
  const html = mixed.map(tickerChipHTML).join('');
  // Contenu dupliqué deux fois : l'animation translate à -50% boucle
  // ainsi sans saut visible.
  track.innerHTML = html + html;
}

const SOUTIEN_STORAGE_KEY = 'uei_soutien_v1';
const SOUTIEN_LIKES_KEY = 'uei_soutien_likes_v1'; // ids likés depuis CET appareil, anti double-like
let soutienCache = [];
let soutienMigrated = false;

function loadSoutienLocal() {
  try { return JSON.parse(localStorage.getItem(SOUTIEN_STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveSoutienLocal(items) {
  try { localStorage.setItem(SOUTIEN_STORAGE_KEY, JSON.stringify(items)); } catch {}
}
function getLikedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SOUTIEN_LIKES_KEY)) || []); }
  catch { return new Set(); }
}
function saveLikedIds(set) {
  try { localStorage.setItem(SOUTIEN_LIKES_KEY, JSON.stringify([...set])); } catch {}
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
      // Même garde-fou que pour les annonces (voir pollFirestore) : ne
      // migrer que les messages très récents, jamais un vieux message en
      // cache qui pourrait avoir été supprimé intentionnellement depuis.
      const orphans = localBefore.filter(m => !knownIds.has(m.id) && (Date.now() - m.createdAt) < MIGRATION_WINDOW_MS);
      if (orphans.length) {
        soutienCache = [...orphans, ...soutienCache].sort((a, b) => b.createdAt - a.createdAt);
        saveSoutienLocal(soutienCache);
        orphans.forEach(m => db.collection('soutien').doc(m.id).set(m, { merge: true }).catch(() => {}));
      }
    }
    renderSoutienWall();
  } catch (err) {
    console.warn('[UEI] Échec sondage soutien', err);
  }
}

function addSoutienMessage(message, pseudo, lieu) {
  const m = { id: makeId(), message, pseudo: pseudo || null, lieu: lieu || null, likes: 0, createdAt: Date.now() };
  soutienCache = [m, ...soutienCache];
  saveSoutienLocal(soutienCache);
  renderSoutienWall();
  renderTicker();
  logEvent('soutien_publie', {});
  if (db) {
    db.collection('soutien').doc(m.id).set(m).catch((err) => {
      console.warn('[UEI] Échec envoi message de soutien, restera local seulement', err);
    });
  }
  return m;
}

function toggleLike(id) {
  const liked = getLikedIds();
  const isLiked = liked.has(id);
  const delta = isLiked ? -1 : 1;
  if (isLiked) liked.delete(id); else liked.add(id);
  saveLikedIds(liked);

  soutienCache = soutienCache.map(m => m.id === id ? { ...m, likes: Math.max(0, (m.likes || 0) + delta) } : m);
  saveSoutienLocal(soutienCache);
  renderSoutienWall();

  if (db) {
    // Nécessite que les règles Firestore autorisent la mise à jour du champ
    // "likes" (voir firebase-config.js). Incrément atomique côté serveur
    // pour rester correct même si plusieurs visiteurs likent en même temps.
    db.collection('soutien').doc(id).update({ likes: firebase.firestore.FieldValue.increment(delta) })
      .catch((err) => console.warn('[UEI] Échec synchronisation du like (règles Firestore à mettre à jour ?)', err));
  }
}

function renderSoutienWall() {
  el('soutien-count').textContent = soutienCache.length ? `${soutienCache.length} message${soutienCache.length > 1 ? 's' : ''}` : '';
  if (!soutienCache.length) {
    soutienWall.innerHTML = '';
    soutienEmpty.classList.remove('hidden');
    return;
  }
  soutienEmpty.classList.add('hidden');
  const liked = getLikedIds();
  soutienWall.innerHTML = soutienCache.map((m, i) => {
    const name = escapeHTML(m.pseudo || 'Anonyme');
    const initial = (m.pseudo || 'A').trim().charAt(0).toUpperCase();
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const isLiked = liked.has(m.id);
    const likeCount = m.likes || 0;
    // Taille variable selon la longueur du message, pour un rythme organique
    // dans la grille maçonnée plutôt qu'une typographie uniforme et rigide.
    const fontSize = m.message.length > 80 ? '18px' : '16px';
    return `
    <article class="soutien-card">
      <p style="font-size:${fontSize};">${escapeHTML(m.message)}</p>
      <div class="soutien-footer">
        <div class="soutien-avatar" style="background:${color.bg};color:${color.fg};">${escapeHTML(initial)}</div>
        <div class="soutien-who">
          <div class="soutien-name">${name}</div>
          ${m.lieu ? `<div class="soutien-lieu">${escapeHTML(m.lieu)}</div>` : ''}
        </div>
        <button class="soutien-like" data-like="${escapeHTML(m.id)}" data-liked="${isLiked}">${isLiked ? '🧡' : '🤍'} ${likeCount}</button>
      </div>
    </article>`;
  }).join('');

  soutienWall.querySelectorAll('[data-like]').forEach(btn => {
    btn.addEventListener('click', () => toggleLike(btn.getAttribute('data-like')));
  });
}

const btnSoutien = el('btn-soutien');
const soutienModalBackdrop = el('soutien-modal-backdrop');
const btnCloseSoutienModal = el('btn-close-soutien-modal');
const soutienForm = el('soutien-form');
const soutienMessageInput = el('soutien-message');
const soutienPseudoInput = el('soutien-pseudo');
const soutienLieuInput = el('soutien-lieu');
const soutienCharCount = el('soutien-char-count');
const soutienWall = el('soutien-wall');
const soutienEmpty = el('soutien-empty');

// Affiche déjà le bandeau des forces engagées avant même toute connexion réseau
renderForcesBanner();

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
  const lieu = soutienLieuInput.value.trim();
  if (!message) return;
  addSoutienMessage(message.slice(0, 200), pseudo.slice(0, 30), lieu.slice(0, 40));
  closeSoutienModal();
  showToast('Merci pour ce message 🧡');
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
  renderSoutienWall();
  renderTicker();
  const tickerInterval = setInterval(renderTicker, 5 * 60 * 1000); // rafraîchit les INFO toutes les 5 min
  if (typeof tickerInterval.unref === 'function') tickerInterval.unref();
  if (db) {
    pollSoutien(true);
    const t = setInterval(() => pollSoutien(false), POLL_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }
}
init();
