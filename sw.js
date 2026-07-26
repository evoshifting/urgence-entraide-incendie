/* =====================================================================
   SERVICE WORKER — met en cache uniquement le "squelette" de l'app
   (HTML/JS/CSS/icônes) pour qu'elle reste consultable sans réseau.
   Les données elles-mêmes (annonces) restent gérées par app.js via
   localStorage (déjà synchronisées à chaque connexion Firestore
   réussie), donc pas besoin de les mettre en cache ici.

   Tout ce qui n'est PAS un fichier du squelette (Firestore, API Adresse,
   CDN Tailwind/Firebase/Leaflet/jsPDF) part directement au réseau, sans
   interception — on ne veut jamais servir une version périmée d'un
   script tiers, ni gêner la synchronisation en temps réel.
===================================================================== */

const CACHE_NAME = 'uei-shell-v20';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js?v=15',
  './style.css?v=4',
  './tailwind-built.css?v=4',
  './firebase-config.js?v=1',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Uniquement les requêtes GET vers notre propre origine (le squelette).
  // Tout le reste (Firestore, API Adresse, CDN) part directement au réseau.
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Navigation (ouverture/rechargement de page) : réseau d'abord, repli
  // sur la version en cache si hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Fichiers du squelette : cache d'abord (rapide, fonctionne hors-ligne),
  // mise à jour du cache en arrière-plan si le réseau répond.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
