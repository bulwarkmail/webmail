import type { StoreArea } from '../area';
import { MAIL_METHODS } from './methods';
import { MAIL_MIGRATIONS } from './schema';
import { SEARCH_MIGRATIONS } from './search-schema';
import { mailSyncer } from './sync';

export const mailArea: StoreArea = {
  name: 'mail',
  migrations: [...MAIL_MIGRATIONS, ...SEARCH_MIGRATIONS],
  methods: MAIL_METHODS,
  syncers: [mailSyncer],
};
