const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

const errors = [];
const logs = [];

function freshDom(url = 'https://example.github.io/urgence-entraide-incendie/') {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    resources: 'usable',
  });
  const { window } = dom;

  // Stub fetch (réseau non disponible dans ce bac à sable de test)
  window.fetch = async () => { throw new Error('network disabled in test'); };

  // Stub clipboard
  window.navigator.clipboard = { writeText: async () => {} };

  // Stub confirm/alert to always accept
  window.confirm = () => true;
  window.alert = () => {};

  window.onerror = (msg, src, line, col, err) => {
    errors.push(`window.onerror: ${msg} (line ${line}:${col})`);
  };

  // Remove the external tailwind + real app.js script tags (we'll eval app.js ourselves)
  dom.window.console.log = (...args) => logs.push(args.join(' '));
  dom.window.console.warn = (...args) => logs.push('[warn] ' + args.join(' '));
  dom.window.console.error = (...args) => errors.push('[console.error] ' + args.join(' '));

  return dom;
}

function runAppJs(dom) {
  try {
    dom.window.eval(appJs);
  } catch (err) {
    errors.push(`EXCEPTION lors du chargement de app.js: ${err.message}\n${err.stack}`);
  }
  return dom;
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function assert(cond, msg) {
  if (!cond) {
    errors.push(`ASSERTION ÉCHOUÉE: ${msg}`);
    console.log(`❌ ${msg}`);
  } else {
    console.log(`✅ ${msg}`);
  }
}

(async () => {
  // ---------------------------------------------------------------
  section('1. Chargement initial (aucune donnée)');
  let dom = freshDom();
  runAppJs(dom);
  let doc = dom.window.document;

  assert(!doc.getElementById('empty-state').classList.contains('hidden'), "L'état vide s'affiche quand il n'y a aucune annonce");
  assert(doc.getElementById('feed').innerHTML.trim() === '', 'Le fil est vide au premier chargement');
  assert(doc.getElementById('stats-bar').innerHTML.includes('0'), 'Le tableau de bord affiche bien 0/0 au départ');
  assert(!doc.getElementById('modal-backdrop').classList.contains('hidden') === false, 'La modale annonce est fermée par défaut');
  assert(doc.getElementById('btn-demander') && doc.getElementById('btn-proposer'), 'Les boutons Demander/Proposer existent dans le header');

  // ---------------------------------------------------------------
  section('2. Ouverture modale via CTA header');
  doc.getElementById('btn-demander').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert(!doc.getElementById('modal-backdrop').classList.contains('hidden'), 'La modale s\'ouvre au clic sur "Demander"');
  assert(doc.querySelector('input[name="type"][value="besoin"]').checked, 'Le type "besoin" est présélectionné');
  doc.getElementById('btn-close-modal').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert(doc.getElementById('modal-backdrop').classList.contains('hidden'), 'La modale se ferme au clic sur ×');

  // ---------------------------------------------------------------
  section('3. Publication d\'une annonce via le formulaire (simulateur réel)');
  doc.getElementById('btn-proposer').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  doc.getElementById('f-categorie').value = 'logement';
  // simulate address autocomplete: user types then blurs without clicking suggestion (fallback)
  const communeInput = doc.getElementById('f-commune-input');
  communeInput.value = 'Mérignac';
  communeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  communeInput.dispatchEvent(new dom.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300)); // laisse le debounce + fallback blur s'exécuter
  doc.getElementById('f-quartier').value = 'Centre-ville';
  doc.getElementById('f-description').value = 'Studio disponible pour 1 personne';
  doc.getElementById('f-prenom').value = 'Alex';
  doc.getElementById('f-tel').value = '0600000000';
  doc.getElementById('annonce-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  assert(doc.getElementById('f-commune').value === 'Mérignac' || communeInput.value === 'Mérignac', "La commune saisie en repli (sans clic sur suggestion) est bien prise en compte");
  const stored = JSON.parse(dom.window.localStorage.getItem('uei_annonces_v1') || '[]');
  assert(stored.length === 1, 'Une annonce a bien été enregistrée dans le localStorage après soumission');
  if (stored[0]) {
    assert(stored[0].commune === 'Mérignac', `La commune enregistrée est correcte (obtenu: "${stored[0].commune}")`);
    assert(stored[0].type === 'offre', 'Le type "offre" est bien enregistré');
  }
  const overlay = doc.querySelector('.uei-overlay');
  assert(!!overlay, "L'overlay de confirmation chaleureuse (\"Annonce publiée !\") apparaît juste après publication");
  assert(overlay.querySelector('#overlay-logo-svg'), "L'overlay contient bien le logo animé");
  assert(doc.getElementById('share-modal-backdrop').classList.contains('hidden'), 'La modale de partage WhatsApp n\'apparaît PAS immédiatement (elle attend la fermeture de l\'overlay)');
  overlay.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // ferme l'overlay au clic, comme un vrai visiteur
  assert(!doc.querySelector('.uei-overlay'), "L'overlay se ferme bien au clic");
  assert(!doc.getElementById('share-modal-backdrop').classList.contains('hidden'), 'La modale de partage WhatsApp s\'ouvre juste après, en enchaînement');
  doc.getElementById('btn-close-share-modal').dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  assert(doc.getElementById('empty-state').classList.contains('hidden'), "L'état vide disparaît une fois une annonce publiée");
  assert(doc.getElementById('feed').innerHTML.includes('Mérignac'), 'La nouvelle annonce apparaît dans le fil avec sa commune');

  // ---------------------------------------------------------------
  section('4. Facettes et compteurs avec plusieurs annonces');
  // Injecter directement plusieurs annonces variées pour tester facettes/pagination
  const seed = [];
  const villes = ['Bordeaux', 'Mérignac', 'Pessac', 'Biscarrosse', 'Arcachon', 'Talence', 'Bègles', 'Andernos-les-Bains'];
  const cats = ['logement', 'chambre', 'materiel'];
  const types = ['besoin', 'offre'];
  for (let i = 0; i < 15; i++) {
    seed.push({
      id: 'seed' + i,
      createdAt: Date.now() - i * 1000,
      type: types[i % 2],
      categorie: cats[i % 3],
      commune: villes[i % villes.length],
      quartier: '',
      description: `Annonce test numéro ${i}`,
      contactPrenom: 'Testeur' + i,
      contactTel: '060000000' + (i % 10),
    });
  }
  seed.forEach(a => dom.window.importAnnonce(a)); // `stored` (l'annonce du formulaire, étape 3) est déjà en cache via addAnnonce, inutile de la re-seeder
  dom.window.renderFeed();

  assert(doc.getElementById('facet-zone').querySelectorAll('button').length === villes.length + 1, `Le facet zone liste bien toutes les communes distinctes + "Toutes zones" (Mérignac déjà présent dans le seed ; attendu ${villes.length + 1}, obtenu ${doc.getElementById('facet-zone').querySelectorAll('button').length})`);
  const catCount = 7; // logement, chambre, accueil_jour, nourriture, materiel, transport, autre
  assert(doc.getElementById('facet-cat').querySelectorAll('button').length === catCount + 1, `Le facet catégorie liste toutes les catégories (${catCount}) + "Toutes cat." (obtenu ${doc.getElementById('facet-cat').querySelectorAll('button').length})`);

  // Clic réel sur un chip de zone : vérifie que le filtrage fonctionne bout-en-bout
  const bordeauxBtn = [...doc.getElementById('facet-zone').querySelectorAll('button')].find(b => b.getAttribute('data-filter-zone') === 'Bordeaux');
  assert(!!bordeauxBtn, 'Le chip "Bordeaux" existe bien dans le facet zone');
  bordeauxBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const cardsBordeaux = [...doc.getElementById('feed').querySelectorAll('article')];
  assert(cardsBordeaux.every(c => c.innerHTML.includes('📍 Bordeaux')), 'Le clic sur le chip "Bordeaux" filtre bien le fil sur cette seule commune');
  const toutesZonesBtn = [...doc.getElementById('facet-zone').querySelectorAll('button')].find(b => b.getAttribute('data-filter-zone') === 'all');
  toutesZonesBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  // ---------------------------------------------------------------
  section('5. Pagination (16 annonces, PAGE_SIZE=8)');
  assert(!doc.getElementById('pagination').classList.contains('hidden'), 'La pagination apparaît avec plus de 8 annonces');
  const cardsPage1 = doc.getElementById('feed').querySelectorAll('article').length;
  assert(cardsPage1 === 8, `La page 1 affiche bien 8 annonces (obtenu: ${cardsPage1})`);
  const nextBtn = doc.getElementById('page-next');
  assert(!!nextBtn, 'Le bouton "Suivant" existe');
  nextBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const cardsPage2 = doc.getElementById('feed').querySelectorAll('article').length;
  assert(cardsPage2 === 8, `La page 2 affiche les annonces restantes (obtenu: ${cardsPage2}, attendu 8 car 16 au total)`);
  const prevBtn = doc.getElementById('page-prev');
  assert(!prevBtn.disabled, 'Le bouton "Précédent" est actif en page 2');

  // ---------------------------------------------------------------
  section('6. Filtres facettes (clic)');
  doc.getElementById('page-prev').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const besoinBtn = [...doc.getElementById('facet-type').querySelectorAll('button')].find(b => b.getAttribute('data-filter-type') === 'besoin');
  besoinBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const cardsAfterFilter = doc.getElementById('feed').querySelectorAll('article');
  const badgesOK = [...cardsAfterFilter].every(c => c.innerHTML.includes('🆘 Cherche'));
  assert(badgesOK, 'Après filtre "Cherche", seules des annonces de type besoin sont affichées');

  // reset filter
  const toutBtn = [...doc.getElementById('facet-type').querySelectorAll('button')].find(b => b.getAttribute('data-filter-type') === 'all');
  toutBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  // ---------------------------------------------------------------
  section('7. Recherche plein texte');
  const searchBox = doc.getElementById('search-box');
  searchBox.value = 'numéro 3';
  searchBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const feedAfterSearch = doc.getElementById('feed').innerHTML;
  assert(feedAfterSearch.includes('numéro 3') && !feedAfterSearch.includes('numéro 5'), 'La recherche plein texte filtre correctement le fil');
  searchBox.value = '';
  searchBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));

  // ---------------------------------------------------------------
  section('8. Tri');
  const sortSelect = doc.getElementById('sort-select');
  sortSelect.value = 'ancien';
  sortSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const firstCardDesc = doc.getElementById('feed').querySelector('article').innerHTML;
  assert(firstCardDesc.includes('14') || firstCardDesc.includes('Mérignac'), 'Le tri "plus ancien" change bien l\'ordre du fil');
  sortSelect.value = 'recent';
  sortSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  // ---------------------------------------------------------------
  section('9. Copier numéro / Suppression (annonce "mienne")');
  const myCard = [...doc.getElementById('feed').querySelectorAll('article')].find(c => c.innerHTML.includes('Mérignac'));
  assert(!!myCard, 'La carte de l\'annonce publiée par le testeur est bien retrouvée');
  const delBtn = myCard ? myCard.querySelector('[data-delete]') : null;
  assert(!!delBtn, 'Le bouton supprimer est visible uniquement sur SA PROPRE annonce');
  const otherCard = [...doc.getElementById('feed').querySelectorAll('article')].find(c => !c.innerHTML.includes('Mérignac'));
  assert(otherCard && !otherCard.querySelector('[data-delete]'), 'Aucun bouton supprimer sur les annonces des autres');

  // ---------------------------------------------------------------
  section('10. Lien de partage : encodage / décodage (round-trip)');
  const shareLinkMatch = appJs.match(/function buildShareLink/);
  assert(!!shareLinkMatch, 'buildShareLink existe toujours dans le code');
  const testAnnonce = seed[0];
  const link = dom.window.eval(`buildShareLink(${JSON.stringify(testAnnonce)})`);
  assert(link.includes('?a='), 'Le lien de partage contient bien le paramètre ?a=');
  // Simuler l'ouverture du lien par un autre visiteur (nouveau DOM propre)
  let dom2 = freshDom(link);
  runAppJs(dom2);
  await new Promise(r => setTimeout(r, 100)); // laisse le temps à init() (async) de traiter tryImportFromURL()
  const importedAfter = JSON.parse(dom2.window.localStorage.getItem('uei_annonces_v1') || '[]');
  assert(importedAfter.some(a => a.id === testAnnonce.id), 'Un visiteur qui ouvre le lien partagé importe bien l\'annonce dans son propre fil');
  assert(!dom2.window.document.getElementById('import-banner').classList.contains('hidden'), 'La bannière de confirmation d\'import s\'affiche');

  // ---------------------------------------------------------------
  section('11. Sécurité : échappement HTML (anti-XSS) dans les champs libres');
  let dom3 = freshDom();
  runAppJs(dom3);
  const xssAnnonce = {
    id: 'xss1', createdAt: Date.now(), type: 'besoin', categorie: 'materiel',
    commune: '<img src=x onerror=alert(1)>', quartier: '"><svg onload=alert(2)>',
    description: '<script>alert(3)</script>', contactPrenom: '<b>Hacker</b>', contactTel: '0600000000'
  };
  dom3.window.importAnnonce(xssAnnonce);
  dom3.window.renderFeed();
  const feedHTML = dom3.window.document.getElementById('feed').innerHTML;
  assert(!feedHTML.includes('<script>alert(3)'), 'La description est échappée (pas de <script> brut injecté)');
  assert(!feedHTML.includes('<img src=x onerror'), 'Le nom de commune est échappé (pas d\'onerror brut injecté)');
  assert(!feedHTML.includes('<b>Hacker</b>'), 'Le prénom de contact est échappé');

  // Cas limite : commune avec apostrophe/esperluette dans le nom (ex: adresses réelles françaises)
  let dom3b = freshDom();
  runAppJs(dom3b);
  const specialAnnonce = {
    id: 'special1', createdAt: Date.now(), type: 'offre', categorie: 'chambre',
    commune: "L'Isle-Adam & Cie", quartier: '', description: 'Test caractères spéciaux',
    contactPrenom: 'Marie-Ève', contactTel: '0600000000'
  };
  dom3b.window.importAnnonce(specialAnnonce);
  dom3b.window.renderFeed();
  const zoneBtns = dom3b.window.document.getElementById('facet-zone').querySelectorAll('button');
  const specialBtn = [...zoneBtns].find(b => b.getAttribute('data-filter-zone') === "L'Isle-Adam & Cie");
  assert(!!specialBtn, 'Un nom de commune avec apostrophe et esperluette est correctement géré dans les facettes (pas de rupture d\'attribut HTML)');
  if (specialBtn) {
    specialBtn.dispatchEvent(new dom3b.window.Event('click', { bubbles: true }));
    const filteredHTML = dom3b.window.document.getElementById('feed').innerHTML;
    assert(filteredHTML.includes('Test caractères spéciaux'), 'Le filtrage fonctionne correctement même avec des caractères spéciaux dans le nom de commune');
  }

  // ---------------------------------------------------------------
  section('12. "Effacer mes informations" (bouton forget-me)');
  let dom4 = freshDom();
  runAppJs(dom4);
  dom4.window.localStorage.setItem('uei_prenom', 'Alex');
  dom4.window.localStorage.setItem('uei_tel', '0600000000');
  dom4.window.localStorage.setItem('uei_mine_v1', JSON.stringify(['abc']));
  dom4.window.document.getElementById('btn-forget-me').dispatchEvent(new dom4.window.Event('click', { bubbles: true }));
  assert(dom4.window.localStorage.getItem('uei_prenom') === null, 'Le prénom mémorisé est bien effacé');
  assert(dom4.window.localStorage.getItem('uei_mine_v1') === null, 'La liste "mes annonces" est bien effacée');

  // ---------------------------------------------------------------
  section('13. Formulaire : validation des champs obligatoires');
  let dom5 = freshDom();
  runAppJs(dom5);
  const doc5 = dom5.window.document;
  doc5.getElementById('btn-demander').dispatchEvent(new dom5.window.Event('click', { bubbles: true }));
  // Ne rien remplir et soumettre
  doc5.getElementById('annonce-form').dispatchEvent(new dom5.window.Event('submit', { bubbles: true, cancelable: true }));
  const stored5 = JSON.parse(dom5.window.localStorage.getItem('uei_annonces_v1') || '[]');
  assert(stored5.length === 0, 'Le formulaire vide ne publie pas d\'annonce (bloqué par required + JS)');

  // ---------------------------------------------------------------
  section('14. Autocomplétion : dégradation propre quand l\'API échoue (réseau coupé)');
  let dom6 = freshDom();
  runAppJs(dom6);
  const doc6 = dom6.window.document;
  const ci = doc6.getElementById('f-commune-input');
  ci.value = 'Bord';
  ci.dispatchEvent(new dom6.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  assert(doc6.getElementById('f-commune-suggestions').classList.contains('hidden'), 'Aucune suggestion affichée quand fetch échoue (pas de plantage)');
  assert(errors.filter(e => e.includes('EXCEPTION')).length === 0, 'Aucune exception JS n\'a été levée pendant tout le test');

  // ---------------------------------------------------------------
  section('15. Migration ascendante : une annonce locale (créée avant que Firestore soit joignable) est renvoyée vers le fil partagé dès la connexion');
  let dom7 = freshDom();
  const orphan = {
    id: 'orphan1', createdAt: Date.now(), type: 'besoin', categorie: 'nourriture',
    commune: 'Andernos-les-Bains', quartier: '', description: 'Annonce créée hors-ligne',
    contactPrenom: 'Test', contactTel: '0600000000'
  };
  const serverAnnonce = {
    id: 'server1', createdAt: Date.now() - 5000, type: 'offre', categorie: 'logement',
    commune: 'Arcachon', quartier: '', description: 'Déjà sur le fil partagé',
    contactPrenom: 'Autre', contactTel: '0600000001'
  };
  dom7.window.localStorage.setItem('uei_annonces_v1', JSON.stringify([orphan]));
  const setCalls = [];
  dom7.window.UEI_FIREBASE_CONFIG = { apiKey: 'fake-key-for-test' }; // "configuré"
  dom7.window.firebase = {
    initializeApp: () => {},
    firestore: () => ({
      settings: () => {},
      collection: () => ({
        orderBy: () => ({
          limit: () => ({
            get: () => Promise.resolve({ docs: [{ data: () => serverAnnonce }], metadata: { fromCache: false } })
          })
        }),
        doc: (id) => ({
          set: (data, opts) => { setCalls.push({ id, data, opts }); return Promise.resolve(); },
          update: (data) => { setCalls.push({ id, data }); return Promise.resolve(); },
          delete: () => Promise.resolve(),
        }),
      }),
    }),
  };
  runAppJs(dom7);
  await new Promise(r => setTimeout(r, 150));
  assert(setCalls.some(c => c.id === 'orphan1'), 'L\'annonce locale "orpheline" est bien renvoyée (set) vers Firestore une fois la connexion établie');
  assert(dom7.window.document.getElementById('feed').innerHTML.includes('Annonce créée hors-ligne'), 'L\'annonce locale reste visible dans le fil pendant/après la migration (jamais perdue de vue)');
  assert(dom7.window.document.getElementById('sync-status').textContent.includes('Partagé'), 'Le badge de statut passe bien à "en ligne" une fois connecté');

  // ---------------------------------------------------------------
  section('16. Statut des annonces (ouvert / pause / pourvu)');
  let dom8 = freshDom();
  runAppJs(dom8);
  const doc8 = dom8.window.document;
  doc8.getElementById('btn-proposer').dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  doc8.getElementById('f-categorie').value = 'logement';
  const ci8 = doc8.getElementById('f-commune-input');
  ci8.value = 'Gujan-Mestras'; ci8.dispatchEvent(new dom8.window.Event('input', { bubbles: true }));
  ci8.dispatchEvent(new dom8.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  doc8.getElementById('f-description').value = 'Test statut';
  doc8.getElementById('f-prenom').value = 'StatutTest';
  doc8.getElementById('f-tel').value = '0611111111';
  doc8.getElementById('annonce-form').dispatchEvent(new dom8.window.Event('submit', { bubbles: true, cancelable: true }));
  const created8 = JSON.parse(dom8.window.localStorage.getItem('uei_annonces_v1') || '[]')[0];
  assert(created8 && created8.statut === 'ouvert', 'Une nouvelle annonce a bien le statut "ouvert" par défaut');
  assert(doc8.getElementById('feed').innerHTML.includes('statut-badge--ouvert'), 'Le badge de statut "ouvert" est affiché sur la carte');
  assert(doc8.getElementById('stats-bar').innerHTML.includes('>1<'), 'Le compteur "offre disponible" compte bien l\'annonce ouverte');

  const pourvuBtn = [...doc8.getElementById('feed').querySelectorAll('[data-set-statut]')].find(b => b.getAttribute('data-statut-value') === 'pourvu');
  assert(!!pourvuBtn, 'Le bouton pour passer au statut "Pourvu" est visible (annonce = la mienne)');
  pourvuBtn.dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  const afterStatut = JSON.parse(dom8.window.localStorage.getItem('uei_annonces_v1') || '[]')[0];
  assert(afterStatut.statut === 'pourvu', 'Le statut est bien passé à "pourvu" après le clic');
  assert(doc8.getElementById('feed').innerHTML.includes('card-annonce--inactive'), 'La carte est visuellement estompée une fois pourvue');
  assert(doc8.getElementById('stats-bar').innerHTML.includes('>0<'), 'Le compteur "offre disponible" repasse à 0 une fois l\'annonce pourvue (elle n\'est plus active)');

  // ---------------------------------------------------------------
  section('17. Masquer les annonces pourvues/en pause');
  const chk = doc8.getElementById('chk-hide-resolved');
  chk.checked = true;
  chk.dispatchEvent(new dom8.window.Event('change', { bubbles: true }));
  assert(!doc8.getElementById('feed').innerHTML.includes('Test statut'), 'L\'annonce pourvue est bien masquée quand la case est cochée');
  chk.checked = false;
  chk.dispatchEvent(new dom8.window.Event('change', { bubbles: true }));
  assert(doc8.getElementById('feed').innerHTML.includes('Test statut'), 'Elle réapparaît quand la case est décochée');

  // ---------------------------------------------------------------
  section('18. Vue carte (sans Leaflet chargé, doit rester silencieuse)');
  doc8.getElementById('btn-view-map').dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  assert(!doc8.getElementById('map-view').classList.contains('hidden'), 'La vue carte s\'affiche au clic sur "Carte"');
  assert(doc8.getElementById('feed').classList.contains('hidden'), 'Le fil est masqué en vue carte');
  assert(errors.filter(e => e.includes('EXCEPTION')).length === 0, 'Aucune exception JS même sans Leaflet chargé (dégradation silencieuse)');
  doc8.getElementById('btn-view-feed').dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  assert(!doc8.getElementById('feed').classList.contains('hidden'), 'Retour à la vue fil fonctionne');

  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  section('20. Géolocalisation "autour de moi"');
  dom8.window.navigator.geolocation = {
    getCurrentPosition: (success) => success({ coords: { latitude: 44.6, longitude: -1.1 } }),
  };
  doc8.getElementById('btn-geoloc').dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  assert(doc8.getElementById('sort-select').value === 'distance', 'Le tri "Plus proche" est automatiquement sélectionné après géolocalisation');
  assert(!doc8.getElementById('sort-select').querySelector('option[value="distance"]').disabled, 'L\'option de tri par distance est activée après géolocalisation');

  // ---------------------------------------------------------------
  section('21. Coordonnées GPS capturées via l\'autocomplétion');
  let dom9 = freshDom();
  runAppJs(dom9);
  const doc9 = dom9.window.document;
  doc9.getElementById('btn-demander').dispatchEvent(new dom9.window.Event('click', { bubbles: true }));
  const sugg = doc9.getElementById('f-commune-suggestions');
  sugg.innerHTML = `<li data-value="Biscarrosse" data-lat="44.4" data-lon="-1.17">Biscarrosse</li>`;
  sugg.querySelector('li').dispatchEvent(new dom9.window.Event('click', { bubbles: true }));
  assert(doc9.getElementById('f-lat').value === '44.4' && doc9.getElementById('f-lon').value === '-1.17', 'Les coordonnées GPS sont bien capturées dans les champs cachés au clic sur une suggestion');

  // ---------------------------------------------------------------
  section('21b. Une ville à plusieurs codes postaux propose bien chaque code postal séparément');
  let dom9b = freshDom();
  dom9b.window.fetch = async (url) => {
    if (String(url).includes('geo.api.gouv.fr')) {
      return {
        ok: true,
        json: async () => ([
          { nom: 'Bordeaux', codesPostaux: ['33000', '33100', '33200', '33300', '33800'], centre: { coordinates: [-0.58, 44.84] } },
        ]),
      };
    }
    throw new Error('unexpected fetch');
  };
  runAppJs(dom9b);
  const doc9b = dom9b.window.document;
  doc9b.getElementById('btn-demander').dispatchEvent(new dom9b.window.Event('click', { bubbles: true }));
  const ci9b = doc9b.getElementById('f-commune-input');
  ci9b.value = 'Bordeaux';
  ci9b.dispatchEvent(new dom9b.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const rows9b = [...doc9b.getElementById('f-commune-suggestions').querySelectorAll('li')];
  assert(rows9b.length === 5, `Bordeaux (5 codes postaux) propose bien 5 suggestions distinctes (obtenu : ${rows9b.length})`);
  assert(rows9b.some(li => li.getAttribute('data-value') === 'Bordeaux 33300'), '"Bordeaux 33300" est bien une suggestion sélectionnable à part entière');
  assert(rows9b.every(li => li.getAttribute('data-lat') === '44.84'), 'Chaque code postal reprend les coordonnées du centre de la commune (limite acceptée, documentée)');

  // ---------------------------------------------------------------
  section('21c. Le mécanisme est générique : pas propre à Bordeaux, marche pour n\'importe quelle ville tapée');
  let dom9c = freshDom();
  dom9c.window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geo.api.gouv.fr')) {
      // Simule la vraie API : elle renvoie ce qui correspond à la recherche
      // envoyée par le code, pas une valeur figée — la ville "Toulouse" ici
      // n'a jamais été mentionnée nulle part dans app.js, ce qui prouve que
      // le comportement dépend uniquement de la saisie de l'utilisateur.
      if (u.includes('Toulouse')) {
        return { ok: true, json: async () => ([
          { nom: 'Toulouse', codesPostaux: ['31000', '31100', '31200', '31300', '31400', '31500'], centre: { coordinates: [1.44, 43.6] } },
        ])};
      }
      if (u.includes('Andernos')) {
        return { ok: true, json: async () => ([
          { nom: 'Andernos-les-Bains', codesPostaux: ['33510'], centre: { coordinates: [-1.1, 44.74] } },
        ])};
      }
      return { ok: true, json: async () => ([]) };
    }
    throw new Error('unexpected fetch');
  };
  runAppJs(dom9c);
  const doc9c = dom9c.window.document;
  doc9c.getElementById('btn-demander').dispatchEvent(new dom9c.window.Event('click', { bubbles: true }));
  const ci9c = doc9c.getElementById('f-commune-input');

  ci9c.value = 'Toulouse';
  ci9c.dispatchEvent(new dom9c.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const rowsToulouse = [...doc9c.getElementById('f-commune-suggestions').querySelectorAll('li')];
  assert(rowsToulouse.length === 6, `Toulouse (6 codes postaux) propose bien 6 suggestions distinctes, sans rien de spécifique à Bordeaux dans le code (obtenu : ${rowsToulouse.length})`);

  ci9c.value = 'Andernos';
  ci9c.dispatchEvent(new dom9c.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const rowsAndernos = [...doc9c.getElementById('f-commune-suggestions').querySelectorAll('li')];
  assert(rowsAndernos.length === 1 && rowsAndernos[0].getAttribute('data-value') === 'Andernos-les-Bains 33510', 'Une ville à un seul code postal (cas de 98% des communes françaises) propose bien une seule suggestion, sans doublon artificiel');

  // ---------------------------------------------------------------
  section('21d. Autocomplétion du quartier : affine les coordonnées GPS de la ville');
  let dom9d = freshDom();
  dom9d.window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geo.api.gouv.fr')) {
      return { ok: true, json: async () => ([
        { nom: 'Bordeaux', codesPostaux: ['33000', '33300'], centre: { coordinates: [-0.58, 44.84] } },
      ])};
    }
    if (u.includes('api-adresse.data.gouv.fr')) {
      assert(u.includes('lat=44.84') && u.includes('lon=-0.58'), 'La recherche de quartier est bien biaisée autour de la ville déjà choisie (paramètres lat/lon transmis)');
      return { ok: true, json: async () => ({ features: [
        { properties: { name: 'Bacalan', label: 'Bacalan, 33300 Bordeaux' }, geometry: { coordinates: [-0.57, 44.87] } },
      ]})};
    }
    throw new Error('unexpected fetch: ' + u);
  };
  runAppJs(dom9d);
  const doc9d = dom9d.window.document;
  doc9d.getElementById('btn-demander').dispatchEvent(new dom9d.window.Event('click', { bubbles: true }));

  const ci9d = doc9d.getElementById('f-commune-input');
  ci9d.value = 'Bordeaux';
  ci9d.dispatchEvent(new dom9d.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  doc9d.getElementById('f-commune-suggestions').querySelector('li[data-value="Bordeaux 33300"]').dispatchEvent(new dom9d.window.Event('click', { bubbles: true }));
  assert(doc9d.getElementById('f-lat').value === '44.84', 'Les coordonnées de la ville sont bien posées en premier');

  const qi9d = doc9d.getElementById('f-quartier');
  qi9d.value = 'Bacalan';
  qi9d.dispatchEvent(new dom9d.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const quartierRows = [...doc9d.getElementById('f-quartier-suggestions').querySelectorAll('li')];
  assert(quartierRows.length === 1 && quartierRows[0].textContent.includes('Bacalan'), 'Une suggestion de quartier apparaît bien après 3 caractères');
  quartierRows[0].dispatchEvent(new dom9d.window.Event('click', { bubbles: true }));
  assert(doc9d.getElementById('f-quartier').value === 'Bacalan', 'Le champ quartier est bien rempli au clic sur la suggestion');
  assert(doc9d.getElementById('f-lat').value === '44.87' && doc9d.getElementById('f-lon').value === '-0.57', 'Les coordonnées GPS sont bien affinées par le quartier (remplacent celles, plus larges, de la ville)');

  // ---------------------------------------------------------------
  section('22. Détection du navigateur intégré (WhatsApp, etc.)');
  const dom10 = new JSDOM(html, { url: 'https://example.github.io/urgence-entraide-incendie/', runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom10.window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.24', configurable: true
  });
  runAppJs(dom10);
  assert(!dom10.window.document.getElementById('inapp-banner').classList.contains('hidden'), 'La bannière s\'affiche bien quand l\'UA contient "WhatsApp"');

  const dom11 = new JSDOM(html, { url: 'https://example.github.io/urgence-entraide-incendie/', runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom11.window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', configurable: true
  });
  runAppJs(dom11);
  assert(dom11.window.document.getElementById('inapp-banner').classList.contains('hidden'), 'La bannière reste masquée dans un vrai Safari (UA avec jeton Safari/)');

  // ---------------------------------------------------------------
  section('23. Validation du numéro de téléphone');
  let dom12 = freshDom();
  runAppJs(dom12);
  const doc12 = dom12.window.document;
  doc12.getElementById('btn-demander').dispatchEvent(new dom12.window.Event('click', { bubbles: true }));
  doc12.getElementById('f-categorie').value = 'autre';
  const ci12 = doc12.getElementById('f-commune-input');
  ci12.value = 'Arcachon'; ci12.dispatchEvent(new dom12.window.Event('input', { bubbles: true }));
  ci12.dispatchEvent(new dom12.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  doc12.getElementById('f-description').value = 'Test tel';
  doc12.getElementById('f-prenom').value = 'Testeur';
  doc12.getElementById('f-tel').value = '0612';
  doc12.getElementById('annonce-form').dispatchEvent(new dom12.window.Event('submit', { bubbles: true, cancelable: true }));
  assert(!doc12.getElementById('f-tel-error').classList.contains('hidden'), 'Un numéro trop court (4 chiffres) est bien rejeté avec un message visible');
  assert(JSON.parse(dom12.window.localStorage.getItem('uei_annonces_v1') || '[]').length === 0, 'Aucune annonce publiée tant que le téléphone est invalide');

  doc12.getElementById('f-tel').value = '06 12 34 56 78';
  doc12.getElementById('annonce-form').dispatchEvent(new dom12.window.Event('submit', { bubbles: true, cancelable: true }));
  assert(JSON.parse(dom12.window.localStorage.getItem('uei_annonces_v1') || '[]').length === 1, 'Un numéro à 10 chiffres (avec espaces) est bien accepté');

  let dom13 = freshDom();
  runAppJs(dom13);
  const doc13 = dom13.window.document;
  doc13.getElementById('btn-demander').dispatchEvent(new dom13.window.Event('click', { bubbles: true }));
  doc13.getElementById('f-categorie').value = 'autre';
  const ci13 = doc13.getElementById('f-commune-input');
  ci13.value = 'Arcachon'; ci13.dispatchEvent(new dom13.window.Event('input', { bubbles: true }));
  ci13.dispatchEvent(new dom13.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  doc13.getElementById('f-description').value = 'Test tel +33';
  doc13.getElementById('f-prenom').value = 'Testeur';
  doc13.getElementById('f-tel').value = '+33612345678';
  doc13.getElementById('annonce-form').dispatchEvent(new dom13.window.Event('submit', { bubbles: true, cancelable: true }));
  assert(JSON.parse(dom13.window.localStorage.getItem('uei_annonces_v1') || '[]').length === 1, 'Un numéro au format +33 est bien accepté');

  let dom13b = freshDom();
  runAppJs(dom13b);
  const doc13b = dom13b.window.document;
  doc13b.getElementById('btn-demander').dispatchEvent(new dom13b.window.Event('click', { bubbles: true }));
  doc13b.getElementById('f-categorie').value = 'autre';
  const ci13b = doc13b.getElementById('f-commune-input');
  ci13b.value = 'Arcachon'; ci13b.dispatchEvent(new dom13b.window.Event('input', { bubbles: true }));
  ci13b.dispatchEvent(new dom13b.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  doc13b.getElementById('f-description').value = 'Test 11 chiffres';
  doc13b.getElementById('f-prenom').value = 'Testeur';
  doc13b.getElementById('f-tel').value = '06123456789'; // 11 chiffres, invalide
  doc13b.getElementById('annonce-form').dispatchEvent(new dom13b.window.Event('submit', { bubbles: true, cancelable: true }));
  assert(!doc13b.getElementById('f-tel-error').classList.contains('hidden'), 'Un numéro à 11 chiffres est bien rejeté (pas juste "au moins 10")');
  assert(JSON.parse(dom13b.window.localStorage.getItem('uei_annonces_v1') || '[]').length === 0, 'Aucune annonce publiée avec un numéro à 11 chiffres');

  // ---------------------------------------------------------------
  section('24. Facettes en ligne (flex-wrap, sans panneau)');
  assert(!doc.getElementById('btn-open-filters'), 'Le bouton "Filtres" (panneau latéral) n\'existe plus, remplacé par des facettes en ligne');
  assert(doc.getElementById('facet-type').querySelectorAll('button').length > 0, 'Les facettes type sont bien affichées directement dans le flux (pas dans un panneau caché)');
  assert(doc.getElementById('facet-type').className.includes('flex-wrap'), 'Les rangées de facettes utilisent flex-wrap (jamais tronquées)');

  // ---------------------------------------------------------------
  section('25. Recherche tolérante aux fautes de frappe');
  let dom14 = freshDom();
  runAppJs(dom14);
  const typoAnnonce = {
    id: 'typo1', createdAt: Date.now(), type: 'offre', categorie: 'chambre',
    commune: 'Andernos-les-Bains', quartier: '', description: 'Chambre disponible avec matelas',
    contactPrenom: 'Test', contactTel: '0600000000', statut: 'ouvert'
  };
  dom14.window.importAnnonce(typoAnnonce);
  dom14.window.renderFeed();
  const searchBox14 = dom14.window.document.getElementById('search-box');
  searchBox14.value = 'matelass'; // faute de frappe (1 lettre en trop)
  searchBox14.dispatchEvent(new dom14.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  assert(dom14.window.document.getElementById('feed').innerHTML.includes('Chambre disponible'), 'Une faute de frappe à 1 lettre sur un mot de 7 lettres trouve bien le résultat');
  searchBox14.value = 'xyzqwph'; // mot totalement différent, même longueur
  searchBox14.dispatchEvent(new dom14.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  assert(!dom14.window.document.getElementById('feed').innerHTML.includes('Chambre disponible'), 'Un mot complètement différent ne remonte pas de faux positif');

  // ---------------------------------------------------------------
  section('26. Bandeau des forces engagées');
  let dom15 = freshDom();
  runAppJs(dom15);
  await new Promise(r => setTimeout(r, 50)); // laisse init() (async) initialiser le mur de soutien
  const doc15 = dom15.window.document;

  const forcesHTML = doc15.getElementById('forces-groups').innerHTML;
  assert(forcesHTML.includes('Sapeurs-pompiers'), 'Le bandeau affiche bien la catégorie Sapeurs-pompiers dès le chargement, avant toute connexion');
  assert(forcesHTML.includes('Soignants') || forcesHTML.includes('Infirmiers'), 'La catégorie Soignants & professionnels de santé est bien présente (exigée par les consignes)');
  assert(forcesHTML.includes('EHPAD'), 'EHPAD & personnels est bien listé');
  assert(doc15.getElementById('soutien-empty') && !doc15.getElementById('soutien-empty').classList.contains('hidden'), 'Le mur affiche "aucun message" tant que rien n\'est publié');

  // Vérifie que l'ordre est mélangé UNE fois (stable), pas remélangé à chaque appel
  const firstRender = doc15.getElementById('forces-groups').innerHTML;
  dom15.window.renderForcesBanner();
  const secondRender = doc15.getElementById('forces-groups').innerHTML;
  assert(firstRender === secondRender, 'L\'ordre des forces reste stable entre deux rendus (mélangé une seule fois par chargement, pas à chaque render)');

  section('27. Publication et affichage d\'un message de soutien');
  doc15.getElementById('btn-soutien').dispatchEvent(new dom15.window.Event('click', { bubbles: true }));
  assert(!doc15.getElementById('soutien-modal-backdrop').classList.contains('hidden'), 'La modale de soutien s\'ouvre au clic');

  doc15.getElementById('soutien-message').value = '<script>alert(1)</script>Merci à tous !';
  doc15.getElementById('soutien-pseudo').value = '<b>Marie</b>';
  doc15.getElementById('soutien-lieu').value = 'Bordeaux';
  doc15.getElementById('soutien-form').dispatchEvent(new dom15.window.Event('submit', { bubbles: true, cancelable: true }));

  assert(doc15.getElementById('soutien-modal-backdrop').classList.contains('hidden'), 'La modale se ferme après envoi');
  assert(doc15.getElementById('soutien-empty').classList.contains('hidden'), 'Le message "aucun message" disparaît une fois un message publié');
  const wallHTML = doc15.getElementById('soutien-wall').innerHTML;
  assert(wallHTML.includes('Merci à tous'), 'Le message publié apparaît bien dans le mur');
  assert(wallHTML.includes('Bordeaux'), 'Le lieu facultatif est bien affiché sur la carte');
  assert(!wallHTML.includes('<script>alert(1)') && !wallHTML.includes('<b>Marie</b>'), 'Le message, le pseudo et le lieu sont bien échappés (anti-XSS)');
  assert(doc15.getElementById('soutien-count').textContent.includes('1'), 'Le compteur "N messages" est bien mis à jour');
  const stored15 = JSON.parse(dom15.window.localStorage.getItem('uei_soutien_v1') || '[]');
  assert(stored15.length === 1 && stored15[0].likes === 0, 'Le message est bien sauvegardé avec 0 like par défaut');

  // Message anonyme (pseudo vide)
  doc15.getElementById('btn-soutien').dispatchEvent(new dom15.window.Event('click', { bubbles: true }));
  doc15.getElementById('soutien-message').value = 'Courage à tous les évacués';
  doc15.getElementById('soutien-form').dispatchEvent(new dom15.window.Event('submit', { bubbles: true, cancelable: true }));
  assert(doc15.getElementById('soutien-wall').innerHTML.includes('Anonyme'), 'Un message sans pseudo s\'affiche bien comme "Anonyme"');

  section('28. Likes (toggle, sans double-like)');
  const likeBtn = doc15.getElementById('soutien-wall').querySelector('[data-like]');
  assert(!!likeBtn, 'Le bouton like est présent sur chaque carte');
  assert(likeBtn.getAttribute('data-liked') === 'false', 'Une carte n\'est pas likée par défaut');
  const msgId = likeBtn.getAttribute('data-like');
  likeBtn.click();
  const likedBtn = doc15.getElementById('soutien-wall').querySelector(`[data-like="${msgId}"]`);
  assert(likedBtn.getAttribute('data-liked') === 'true', 'Le like s\'active au clic (🧡)');
  assert(likedBtn.textContent.includes('1'), 'Le compteur de likes passe à 1');
  likedBtn.click();
  const unlikedBtn = doc15.getElementById('soutien-wall').querySelector(`[data-like="${msgId}"]`);
  assert(unlikedBtn.getAttribute('data-liked') === 'false', 'Re-cliquer retire le like (toggle)');
  assert(unlikedBtn.textContent.trim().endsWith('0'), 'Le compteur de likes repasse à 0 après un-like');
  const likedIds = JSON.parse(dom15.window.localStorage.getItem('uei_soutien_likes_v1') || '[]');
  assert(likedIds.length === 0, 'La liste des likes locaux est bien vidée après un-like (empêche le double-like)');

  // ---------------------------------------------------------------
  section('29. Nouvelle identité visuelle (logo flamme + cœur)');
  assert(doc.querySelector('svg#header-logo-svg'), 'Le logo SVG inline (animable) est bien utilisé dans le header');
  assert(doc.querySelector('img[src^="logo.svg"]'), 'Le logo statique (logo.svg) est bien utilisé dans le bandeau forces engagées');
  assert(!doc.body.innerHTML.includes('logo-tile'), 'L\'ancienne classe "logo-tile" (carré barré) ne subsiste plus');
  const logoLink = doc.querySelector('a[aria-label="Accueil — Urgence Entraide Incendie"]');
  assert(!!logoLink && logoLink.querySelector('svg#header-logo-svg'), 'Le logo est bien cliquable vers l\'accueil');
  assert(html.includes('favicon.svg') && html.includes('favicon.ico') && html.includes('apple-touch-icon.png'), 'Les balises favicon (SVG + .ico + apple-touch-icon) sont bien présentes');
  assert(html.includes('og:image') && html.includes('og:title') && html.includes('og:url'), 'Les balises Open Graph (aperçu WhatsApp) sont bien présentes');
  assert(!doc.body.innerHTML.includes('🔥'), 'L\'ancien emoji 🔥 ne subsiste plus dans le corps de la page (nouvelle identité uniquement)');

  section('30. Nouveau format du message WhatsApp partagé');
  let dom16 = freshDom();
  runAppJs(dom16);
  const doc16 = dom16.window.document;
  doc16.getElementById('btn-demander').dispatchEvent(new dom16.window.Event('click', { bubbles: true }));
  doc16.getElementById('f-categorie').value = 'chambre';
  const ci16 = doc16.getElementById('f-commune-input');
  ci16.value = 'Arcachon'; ci16.dispatchEvent(new dom16.window.Event('input', { bubbles: true }));
  ci16.dispatchEvent(new dom16.window.Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  doc16.getElementById('f-description').value = 'Chambre dispo ce soir';
  doc16.getElementById('f-prenom').value = 'Julie';
  doc16.getElementById('f-tel').value = '0612345678';
  doc16.getElementById('annonce-form').dispatchEvent(new dom16.window.Event('submit', { bubbles: true, cancelable: true }));
  doc16.querySelector('.uei-overlay').dispatchEvent(new dom16.window.Event('click', { bubbles: true })); // ferme l'overlay pour accéder à la modale de partage
  const waLink = doc16.getElementById('btn-share-whatsapp-now').getAttribute('href');
  const waText = decodeURIComponent(waLink.split('text=')[1]);
  assert(waText.startsWith('[Urgence Entraide Incendie]'), 'Le message WhatsApp suit bien le nouveau gabarit "[Urgence Entraide Incendie] ..."');
  assert(waText.includes('Julie') && waText.includes('0612345678'), 'Le message contient bien le contact');
  assert(!waText.includes('URGENCE INCENDIE -'), 'L\'ancien format de message (majuscules, tirets) ne subsiste plus');

  section('31. Overlay de confirmation : fermeture automatique, non-empilement, rejouabilité');
  let dom17 = freshDom();
  runAppJs(dom17);
  const doc17 = dom17.window.document;

  function publierAnnonceRapide(doc, w, prenom) {
    doc.getElementById('btn-proposer').dispatchEvent(new w.Event('click', { bubbles: true }));
    doc.getElementById('f-categorie').value = 'autre';
    doc.getElementById('f-commune').value = 'Biscarrosse'; // repli direct, pas besoin d'attendre l'autocomplétion
    doc.getElementById('f-commune-input').value = 'Biscarrosse';
    doc.getElementById('f-description').value = 'Annonce test overlay';
    doc.getElementById('f-prenom').value = prenom;
    doc.getElementById('f-tel').value = '0600000000';
    doc.getElementById('annonce-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  }

  publierAnnonceRapide(doc17, dom17.window, 'Test1');
  assert(doc17.querySelectorAll('.uei-overlay').length === 1, 'Une seule confirmation à l\'écran après une publication');
  assert(doc17.getElementById('header-logo-svg').classList.contains('uei-anim'), 'Le logo du header porte bien la classe d\'animation après publication');

  // Fermeture automatique après ~2,2s, sans action de l'utilisateur
  await new Promise(r => setTimeout(r, 2400));
  assert(!doc17.querySelector('.uei-overlay'), 'La confirmation se ferme bien toute seule après ~2,2s, sans clic');
  assert(!doc17.getElementById('share-modal-backdrop').classList.contains('hidden'), 'La modale de partage s\'ouvre bien après la fermeture automatique');
  doc17.getElementById('btn-close-share-modal').dispatchEvent(new dom17.window.Event('click', { bubbles: true }));

  // Rejouable + jamais empilée : une deuxième publication ne laisse pas deux overlays
  publierAnnonceRapide(doc17, dom17.window, 'Test2');
  publierAnnonceRapide(doc17, dom17.window, 'Test3'); // publication rapprochée, sans attendre la fermeture de la précédente
  assert(doc17.querySelectorAll('.uei-overlay').length === 1, 'Deux publications rapprochées ne créent jamais deux overlays empilés — la nouvelle remplace l\'ancienne');

  section('32. Lien de partage : propre (sans données encodées) quand Firestore est connecté');
  let dom18 = new JSDOM(html, { url: 'https://example.github.io/urgence-entraide-incendie/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom18.window.fetch = async () => { throw new Error('no fetch'); };
  dom18.window.UEI_FIREBASE_CONFIG = { apiKey: 'fake-key-for-test' };
  dom18.window.firebase = {
    initializeApp: () => {},
    firestore: () => ({
      settings: () => {},
      collection: () => ({
        orderBy: () => ({ limit: () => ({ get: () => Promise.resolve({ docs: [], metadata: { fromCache: false } }) }) }),
        doc: () => ({ set: () => Promise.resolve(), update: () => Promise.resolve(), delete: () => Promise.resolve() }),
      }),
    }),
  };
  runAppJs(dom18);
  await new Promise(r => setTimeout(r, 200)); // laisse initSync() établir la connexion simulée
  const doc18 = dom18.window.document;
  doc18.getElementById('btn-demander').dispatchEvent(new dom18.window.Event('click', { bubbles: true }));
  doc18.getElementById('f-categorie').value = 'autre';
  doc18.getElementById('f-commune').value = 'Biscarrosse';
  doc18.getElementById('f-commune-input').value = 'Biscarrosse';
  doc18.getElementById('f-description').value = 'Test lien propre';
  doc18.getElementById('f-prenom').value = 'Test';
  doc18.getElementById('f-tel').value = '0600000000';
  doc18.getElementById('annonce-form').dispatchEvent(new dom18.window.Event('submit', { bubbles: true, cancelable: true }));
  doc18.querySelector('.uei-overlay').dispatchEvent(new dom18.window.Event('click', { bubbles: true }));
  const waLink18 = doc18.getElementById('btn-share-whatsapp-now').getAttribute('href');
  const waText18 = decodeURIComponent(waLink18.split('text=')[1]);
  assert(!waText18.includes('?a='), 'Le message partagé ne contient plus le lien encodé à rallonge quand Firestore est connecté');
  assert(waText18.includes('https://example.github.io/urgence-entraide-incendie/'), 'Le message contient bien le lien simple et propre vers le site');

  // ---------------------------------------------------------------
  section('RÉSUMÉ');
  console.log(`\nTotal erreurs/assertions échouées: ${errors.length}`);
  if (errors.length) {
    console.log('\n--- DÉTAIL DES ERREURS ---');
    errors.forEach(e => console.log('❌ ' + e));
  } else {
    console.log('✅ Aucun bug détecté par la suite de tests automatisée.');
  }
  process.exit(errors.length ? 1 : 0); // sortie explicite : le nouveau sondage périodique (setInterval) peut laisser des minuteurs actifs entre différentes fenêtres jsdom du test
})();
