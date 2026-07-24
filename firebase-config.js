/* =====================================================================
   CONFIGURATION FIREBASE — à remplacer par tes propres clés
   =====================================================================

   Sans ce fichier configuré, le site fonctionne quand même (mode local
   de secours), mais CHAQUE VISITEUR NE VOIT QUE SES PROPRES ANNONCES.
   Pour que tout le monde voie les mêmes annonces en temps réel, il faut
   connecter un projet Firebase gratuit (5 minutes, aucune carte bancaire) :

   ⚠️ SI TU AS DÉJÀ CONFIGURÉ FIREBASE AUPARAVANT : la fonctionnalité de
   statut (ouvert / en pause / pourvu) nécessite une mise à jour des
   règles de sécurité (étape 4 ci-dessous a changé). Retourne dans
   Firestore → onglet "Règles" et republie la version ci-dessous, sinon
   les changements de statut resteront uniquement locaux (pas de blocage,
   juste pas de synchronisation entre visiteurs pour cette fonctionnalité
   précise).

   1. Va sur https://console.firebase.google.com
   2. "Ajouter un projet" → donne-lui un nom (ex: urgence-entraide-incendie) → crée-le
   3. Dans le menu de gauche : Build → Firestore Database → "Créer une base de données"
      → choisis une région proche (ex: eur3, Europe) → démarre en "mode test"
      (Firestore proposera par défaut des règles qui expirent après 30 jours ;
      remplace-les tout de suite par les règles ci-dessous, qui n'expirent pas)
   4. Dans Firestore → onglet "Règles", colle ceci puis clique "Publier" :

        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /annonces/{id} {
              allow read: if true;
              allow create: if request.resource.data.keys().hasAll(
                ['id','type','categorie','commune','description','contactPrenom','contactTel','createdAt']
              );
              allow delete: if true;
              // Seul le champ "statut" peut être modifié après publication
              // (pour permettre à un auteur de marquer son annonce en pause
              // ou pourvue sans la supprimer) — tout le reste est immuable.
              allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['statut'])
                            && request.resource.data.statut in ['ouvert', 'pause', 'pourvu'];
            }
          }
        }

      ⚠️ Ces règles sont volontairement ouvertes (comme un panneau d'affichage
      public, sans compte utilisateur) pour rester simples en urgence. N'importe
      qui peut publier ou supprimer une annonce. C'est un choix pragmatique pour
      une situation de crise à court terme, pas une architecture à conserver
      pour un usage permanent.

   5. Dans le menu de gauche : ⚙️ Paramètres du projet → fait défiler jusqu'à
      "Vos applications" → clique l'icône "</>" (Web) → donne un nom → "Enregistrer"
      Firebase affiche alors un objet `firebaseConfig` : copie-le et remplace
      l'objet ci-dessous par le tien.
   6. Recharge le site : le badge en haut doit passer à "🟢 Partagé en temps réel".

===================================================================== */

window.UEI_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCJ7F4ZHHaQWtQxyMutQCDQfiWVgK9O_SQ",
  authDomain: "urgence-entraide-incendie.firebaseapp.com",
  projectId: "urgence-entraide-incendie",
  storageBucket: "urgence-entraide-incendie.firebasestorage.app",
  messagingSenderId: "917306061922",
  appId: "1:917306061922:web:b763dd23b7a7bfdefb4d3b"
};
