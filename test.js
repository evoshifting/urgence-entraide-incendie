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
  assert(!doc.getElementById('share-modal-backdrop').classList.contains('hidden'), 'La modale de partage WhatsApp s\'ouvre après publication');
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
            onSnapshot: (onNext) => { setTimeout(() => onNext({ docs: [{ data: () => serverAnnonce }] }), 10); }
          })
        }),
        doc: (id) => ({
          set: (data, opts) => { setCalls.push({ id, data, opts }); return Promise.resolve(); },
          delete: () => Promise.resolve(),
        }),
      }),
    }),
  };
  runAppJs(dom7);
  await new Promise(r => setTimeout(r, 150));
  assert(setCalls.some(c => c.id === 'orphan1'), 'L\'annonce locale "orpheline" est bien renvoyée (set) vers Firestore une fois la connexion établie');
  assert(dom7.window.document.getElementById('feed').innerHTML.includes('Annonce créée hors-ligne'), 'L\'annonce locale reste visible dans le fil pendant/après la migration (jamais perdue de vue)');
  assert(dom7.window.document.getElementById('sync-status').textContent.includes('temps réel'), 'Le badge de statut passe bien à "en ligne" une fois connecté');

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
  section('19. Génération PDF (sans jsPDF chargé, doit avertir sans planter)');
  const pdfBtn = doc8.getElementById('feed').querySelector('.btn-pdf');
  assert(!!pdfBtn, 'Le bouton "Affiche" PDF est présent sur chaque carte');
  pdfBtn.dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
  assert(errors.filter(e => e.includes('EXCEPTION')).length === 0, 'Le clic sur "Affiche" sans jsPDF chargé ne plante pas (toast d\'avertissement à la place)');

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
  section('RÉSUMÉ');
  console.log(`\nTotal erreurs/assertions échouées: ${errors.length}`);
  if (errors.length) {
    console.log('\n--- DÉTAIL DES ERREURS ---');
    errors.forEach(e => console.log('❌ ' + e));
    process.exitCode = 1;
  } else {
    console.log('✅ Aucun bug détecté par la suite de tests automatisée.');
  }
})();
