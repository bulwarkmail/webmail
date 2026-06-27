import { AurionSession } from 'aurion-crypto-sdk';
import { EmailBodyValue } from '../jmap/types';
import * as openpgp from 'openpgp'; // Nécessaire pour lire les fingerprints locaux

// Le worker gère sa propre session et son searchEngine en RAM
const workerSession = new AurionSession(null); 

self.onmessage = async (event) => {
  const { id, action, data } = event.data;

  // --- ACTIONS D'INITIALISATION ---
  if (action === 'INIT_SESSION') {
    try {
      const { encryptedKeys, saltClient } = data;
      
      if (data.h0) {
        workerSession.h0 = new Uint8Array(data.h0);
      }

      await workerSession.decryptAndLoadPrivateKeys(encryptedKeys, saltClient);

      self.postMessage({ id, success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker Keyring decryption failed: " + errorMessage });
    }
    return;
  }

  // --- TRAITEMENT DU FLUX ENTRANT (GETEMAIL / GETEMAILS) ---
  if (action === 'DECRYPT_BATCH') {
    try {
      const { emails } = data;
      const processedEmails = [];
      const indexUpdates = []; // Pour notifier l'UI des nouveaux tokens extraits

      for (const email of emails) {
        const processedEmail = { ...email };
        let clearTextBody: string | null = null;

        // 1. Déchiffrement du corps des messages (getEmail)
        if (processedEmail.bodyValues) {
          const updatedBodyValues: Record<string, EmailBodyValue> = { ...processedEmail.bodyValues };
          let isDecrypted = false;

          for (const partId in updatedBodyValues) {
            const bodyValue = updatedBodyValues[partId];
            
            if (bodyValue && bodyValue.value.includes('-----BEGIN PGP MESSAGE-----')) {
              clearTextBody = await workerSession.decryptCiphertext(bodyValue.value, processedEmail.accountLabel);
              
              updatedBodyValues[partId] = {
                ...bodyValue,
                value: clearTextBody,
                isTruncated: false
              };
              isDecrypted = true;
            } else if (bodyValue && !bodyValue.value.includes('-----BEGIN PGP MESSAGE-----')) {
              // Gère le cas où le mail est déjà en clair (re-consultation)
              clearTextBody = bodyValue.value;
            }
          }
          
          if (isDecrypted) {
            processedEmail.bodyValues = updatedBodyValues;
            const bodyParts = Object.values(updatedBodyValues) as EmailBodyValue[];
            const mainTextPart = bodyParts[0]?.value || '';
            processedEmail.preview = mainTextPart.slice(0, 200).replace(/\s+/g, ' ') + '...';
          }
        }

        // 💡 ALIMENTATION DE L'INDEX LOCAL DU WORKER SI UN TEXTE CLAIR EST DISPONIBLE
        if (clearTextBody) {
          // Indexation en RAM côté Worker
          workerSession.searchEngine.indexMail(processedEmail.id, [], clearTextBody);
          
          // On prépare le token payload pour le remonter à l'UI
          const tokens = workerSession.extractSearchTokens(clearTextBody);
          indexUpdates.push({ id: processedEmail.id, tokens });
        }

        // 2. Déchiffrement des métadonnées de liste (preview / subject)
        if (processedEmail.preview && processedEmail.preview.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            processedEmail.preview = await workerSession.decryptCiphertext(processedEmail.preview, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.preview = "[Message Chiffré]";
          }
        }
        
        if (processedEmail.subject && processedEmail.subject.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            processedEmail.subject = await workerSession.decryptCiphertext(processedEmail.subject, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.subject = "[Sujet Chiffré]";
          }
        }

        processedEmails.push(processedEmail);
      }

      // On renvoie les emails déchiffrés ET les structures de tokens à l'UI
      self.postMessage({ 
        id, 
        success: true, 
        data: { 
          emails: processedEmails, 
          indexUpdates 
        } 
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker decryption batch failed: " + errorMessage });
    }
    return;
  }

  // --- ⚡ INDEXATION GLOBALE INITIALE OU EN ARRIÈRE-PLAN ---
  if (action === 'INDEX_BATCH_SILENT') {
    try {
      const { encryptedMails } = data; // Contient un tableau de { id, body }
      const indexUpdates = [];

      for (const mail of encryptedMails) {
        if (mail.body && mail.body.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            const clearTextBody = await workerSession.decryptCiphertext(mail.body);
            
            // Indexation locale au Worker
            workerSession.searchEngine.indexMail(mail.id, [], clearTextBody);
            
            // Extraction pour l'UI
            const tokens = workerSession.extractSearchTokens(clearTextBody);
            indexUpdates.push({ id: mail.id, tokens });
          } catch (e) {
            console.warn(`[Worker Index] Impossible de déchiffrer le mail ${mail.id} pour indexation:`, e);
          }
        }
      }

      self.postMessage({ id, success: true, data: { indexUpdates } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker silent indexing failed: " + errorMessage });
    }
    return;
  
  }



// aurion-worker.ts

if (action === 'GENERATE_AND_SHARE_KEYS') {
  try {
    const { identityId, email, members } = data; // members: Array<{ user_id, public_key }>

    // Utilisation de la méthode adaptée qui prend les ID utilisateurs
    const groupMaterial = await workerSession.generateGroupKeys(email, members);

    // On renvoie directement le payload prêt à être consommé par l'API Go
    self.postMessage({
      id,
      success: true,
      data: {
        identity_id: identityId,
        armored_public_key: groupMaterial.groupPublicKeyArmored,
        shares: groupMaterial.shares
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    self.postMessage({ 
      id, // 💡 CORRECTION : On passe le vrai 'id' reçu, pas le booléen 'false'
      success: false, 
      error: "Worker SDK key generation failed: " + errorMessage 
    });
  }
  return;
}
};