import { AurionSession } from 'aurion-crypto-sdk';
import { Email } from '../jmap/types';

class CryptoWorkerBridge {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void }> = new Map();
  public isInitialized: boolean = false;
  private aurionSession: AurionSession | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.worker = new Worker(new URL('./aurion-worker.ts', import.meta.url), {
        type: 'module',
      });
      
      this.worker.onmessage = (event) => {
        const { id, success, data, error } = event.data;
        const promise = this.pendingRequests.get(id);
        
        if (promise) {
          if (success) {
            // 💡 SYNCHRONISATION DYNAMIQUE DE L'INDEX UI
            // Si le worker renvoie des mises à jour d'index (tokens), on les injecte dans la session UI
            if (data && data.indexUpdates && Array.isArray(data.indexUpdates)) {
              this.applyTokensToUISession(data.indexUpdates);
            }

            // On résout la promesse avec la donnée attendue (le tableau d'emails ou le statut d'indexation)
            // Si l'action était DECRYPT_BATCH, la structure finale attendue par l'app est data.emails
            if (data && data.emails) {
              promise.resolve(data.emails);
            } else {
              promise.resolve(data);
            }
          } else {
            promise.reject(new Error(error));
          }
          this.pendingRequests.delete(id);
        }
      };
    }
  }

  /**
   * Helper privé pour injecter les tokens calculés par le worker dans l'index MiniSearch principal
   */
  private applyTokensToUISession(indexUpdates: Array<{ id: string, tokens: string[] }>) {
    if (typeof this.aurionSession !== 'undefined' && this.aurionSession && this.aurionSession.isUnlocked()) {
      for (const update of indexUpdates) {
        // Si l'email n'est pas déjà dans l'index principal, on l'ajoute directement avec ses tokens pré-calculés
        if (!this.aurionSession.searchEngine.hasDocument(update.id)) {
          // Astuce : on simule le clearText en passant les tokens re-joints par des espaces
          this.aurionSession.searchEngine.indexMail(update.id, [], update.tokens.join(' '));
        }
      }
      // Sauvegarde silencieuse de l'index sur disque si nécessaire
      this.aurionSession.saveSearchIndexToStorage();
    }
  }
/**
   * Initialise le Worker en lui passant les clés chiffrées et le matériel de dérivation
   */
  public async initWorkerSession(
    session: AurionSession,
    encryptedKeys: Array<{ encrypted_private_key: string; identity_email?: string }>, 
    saltClient: string,
    h0: Uint8Array | null
  ): Promise<void> {
    if (!this.worker) return;
    this.aurionSession = session;

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, {
        resolve: () => {
          this.isInitialized = true;
          resolve();
        },
        reject
      });

      this.worker!.postMessage({
        id: requestId,
        action: 'INIT_SESSION',
        data: { 
          encryptedKeys, 
          saltClient,
          h0: h0 ? h0.buffer : null 
        }
      });
    });
  }

  /**
   * Appelé lors du flux standard (Lazy loading) : déchiffre ET indexe en tâche de fond
   */
  public async processMailBatchAsync(emails: Email[]): Promise<Email[]> {
    if (!this.worker || !this.isInitialized || emails.length === 0) return emails;

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, { resolve, reject });

      this.worker!.postMessage({
        id: requestId,
        action: 'DECRYPT_BATCH',
        data: { emails }
      });
    });
  }

  /**
   * Appelé pour l'indexation globale (Initialisation ou bouton de reconstruction)
   * Envoie uniquement les payloads minimums à traiter pour économiser les clones de contexte
   */
  public async indexMailBatchAsync(encryptedMails: Array<{ id: string; body: string }>): Promise<void> {
    if (!this.worker || !this.isInitialized || encryptedMails.length === 0) return;

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, { 
        resolve: () => resolve(), 
        reject 
      });

      this.worker!.postMessage({
        id: requestId,
        action: 'INDEX_BATCH_SILENT',
        data: { encryptedMails }
      });
    });
  }
  /**
   * Envoie une demande de génération de clés et de chiffrement croisé pour les membres d'un groupe/alias au Worker.
   * Retourne le payload prêt à être expédié à l'API Go.
   */
  public async generateAndShareIdentityKeysAsync(data: {
    identityId: string;
    email: string;
    members: Array<{ user_id: string; public_key: string }>;
  }): Promise<{
    identity_id: string;
    armored_public_key: string;
    shares: Array<{ user_id: string; encrypted_private_key: string }>;
  }> {
    // Sécurité : On s'assure que le Worker est instancié et a ses clés maîtresse chargées
    if (!this.worker || !this.isInitialized) {
      throw new Error("CryptoWorkerBridge is not initialized or worker is unavailable");
    }

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      
      // Enregistrement de la promesse en attente du retour du worker
      this.pendingRequests.set(requestId, { 
        resolve, 
        reject 
      });

      // Envoi du signal au Worker
      this.worker!.postMessage({
        id: requestId,
        action: 'GENERATE_AND_SHARE_KEYS',
        data
      });
    });
  }
}

export const cryptoWorkerBridge = new CryptoWorkerBridge();