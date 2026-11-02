import { createLocalStore, resetLocalStoreForTests } from '../local';
import { runStoreContract } from './contract';

runStoreContract({
  name: 'local (memory + files)',
  makeStores: (n) => {
    // One process: every handle is the same store, as every module copy is.
    const store = createLocalStore();
    return Array.from({ length: n }, () => store);
  },
  cleanup: async () => resetLocalStoreForTests(),
});
