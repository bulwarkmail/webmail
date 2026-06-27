import { AurionApiClient, AurionSession } from 'aurion-crypto-sdk';
import { AurionIndexedDBDriver } from 'aurion-crypto-sdk/';
import { cryptoWorkerBridge } from './worker-bridge';

export const aurionApi = new AurionApiClient(
  process.env.AURION_SERVER_URL || 'https://api.aurion.com'
);

// On exporte le driver pour pouvoir faire des getItem / setItem directement dans les stores de l'app
export const aurionStorage = new AurionIndexedDBDriver();

export const aurionSession = new AurionSession(aurionStorage);

/**
 * Lance l'indexation globale et chirurgicale de la boîte mail en arrière-plan.
 * Récupère uniquement les couples {id, body} par lots pour nourrir MiniSearch via le Worker.
 */
export async function runInitialIndexing(client: any, targetAccountId: string): Promise<void> {
  // Est-ce que le coffre-fort UI est bien déverrouillé ?
  if (!aurionSession || !aurionSession.isUnlocked()) {
    console.warn("[Index Initial] Annulation : La session Aurion est verrouillée.");
    return;
  }

  //  Est-ce que le Worker est prêt à déchiffrer ?
  if (!cryptoWorkerBridge || !cryptoWorkerBridge.isInitialized) {
    console.warn("[Index Initial] Annulation : Le CryptoWorker n'est pas initialisé ou indisponible.");
    return;
  }

  const batchSize = 100;
  let position = 0;
  let hasMore = true;

  console.log("[Index Initial] Démarrage de l'extraction en arrière-plan...");

  try {
    while (hasMore) {
      // 1. On demande uniquement la liste des IDs au serveur (très léger)
      const queryResponse = await client.request([
        ["Email/query", {
          accountId: targetAccountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: batchSize,
          position: position,
        }, "0"]
      ]);

      const allIds = (queryResponse.methodResponses?.[0]?.[1]?.ids || []) as string[];
      if (allIds.length === 0) {
        hasMore = false;
        break;
      }

      // 2. On filtre pour ne garder que ceux qui ne sont pas dans l'index de l'UI
      const missingIds = allIds.filter((id: string) => !aurionSession.searchEngine.hasDocument(id));

      if (missingIds.length > 0) {
        // 3. On ne demande STRICTEMENT que l'id et le body chiffré
        const getResponse = await client.request([
          ["Email/get", {
            accountId: targetAccountId,
            ids: missingIds,
            properties: ["id", "body"]
          }, "0"]
        ]);

        const lightMails = (getResponse.methodResponses?.[0]?.[1]?.list || []) as Array<{ id: string, body: string }>;

        // 4. On envoie ce lot minimal au Worker pour déchiffrement + extraction des tokens
        await cryptoWorkerBridge.indexMailBatchAsync(lightMails);
      }

      position += allIds.length;
      hasMore = allIds.length === batchSize;
      
      // Pause de 30ms pour laisser le thread principal respirer
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    // 5. Une fois TOUS les lots traités, on sauvegarde l'index final sur le disque local
    await aurionSession.saveSearchIndexToStorage();
    console.log("[Index Initial] Recherche 100% opérationnelle en local !");

  } catch (error) {
    console.error("[Index Initial] Erreur critique lors de l'indexation globale :", error);
  }
}

/**
 * 
 * Analyse le routage de l'API et génère/ordonnance les clés manquantes via le Worker.
 */
export async function verifyAndSyncRouting(): Promise<void> {
  // 1. Vérifications initiales d'états
  if (!aurionSession || !aurionSession.isUnlocked()) {
    console.warn('[Routing Sync] Annulation : La session locale est verrouillée.');
    return;
  }
  if (!cryptoWorkerBridge || !cryptoWorkerBridge.isInitialized) {
    console.warn('[Routing Sync] Annulation : Le CryptoWorker n\'est pas prêt.');
    return;
  }

  try {
    console.log('[Routing Sync] Analyse de l\'état des alias et groupes...');
    const syncState = await aurionApi.syncRouting();
    let hasGeneratedKeys = false;
    for (const identity of syncState.identities) {
      
      // Une identité demande la génération d'une nouvelle paire de clés (Nouveau groupe / Nouvel alias)
      if (identity.needs_key_gen) {
        console.log(`[Routing Sync] Génération de clés requise pour l'identité : ${identity.email}`);

        // Préparation de la liste des destinataires cryptographiques (soi-même + les membres)
        // Le serveur nous renvoie la liste complète des clés publiques des personnes devant avoir accès au groupe
        const targetMembers = identity.members || [];
        if (targetMembers.length === 0) {
          console.warn(`[Routing Sync] L'identité partagée ${identity.email} n'a aucun membre listé.`);
          continue;
        }

        // On délègue la génération lourde et les chiffrements asymétriques croisés au Worker
        const uploadPayload = await cryptoWorkerBridge.generateAndShareIdentityKeysAsync({
          identityId: identity.identity_id,
          email: identity.email,
          members: targetMembers
        });

        // Envoi des enveloppes générées à l'API Go
        await aurionApi.uploadSynchronizedKeys(uploadPayload);
        console.log(`[Routing Sync] Clés partagées et publiées avec succès pour : ${identity.email}`);
        hasGeneratedKeys = true;
      }
    }
    // 3. Si au moins une clé a été générée, on notifie l'application
    if (hasGeneratedKeys) {
        // Option B : Direct, brutal et efficace si tu ne veux pas t'embêter avec un état d'UI
        alert("De nouveaux alias ou groupes ont été configurés. L'application va redémarrer pour activer le chiffrement.");
        window.location.reload();
    }

  } catch (error) {
    console.error('[Routing Sync] Échec de la synchronisation du routage :', error);
  }
}