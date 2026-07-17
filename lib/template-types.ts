export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  isHTML?: boolean;
  category: string;
  defaultRecipients?: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
  };
  identityId?: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceholderVariable {
  name: string;
  value: string;
}

export const BUILT_IN_PLACEHOLDERS = [
  'recipient_name',
  'company',
  'date',
  'day_of_week',
  'sender_name',
] as const;

export type BuiltInPlaceholder = (typeof BUILT_IN_PLACEHOLDERS)[number];
