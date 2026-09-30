import { ConnectorClient } from '@/components/connector/connector-client';
import { TARGET_NAMES } from '@/lib/connector/registry';
import { IS_LITE } from '@/lib/lite';

// Where a connector link lands: /connector/<target>?<params>, resolved to a
// real path inside the app by lib/connector/registry.ts.
//
// Outside [locale], like /protocol and /admin, so a published link never
// carries a locale it has no business choosing. Next matches the static
// `connector` segment before the `[locale]` one, and proxy.ts keeps next-intl
// from rewriting it.
//
// The target segment is all the server sees. The parameters are read from the
// address bar in the client, which is also what makes this work in the static
// Lite export, where there is no server to read them.
export const generateStaticParams = IS_LITE
  ? () => TARGET_NAMES.map((target) => ({ target }))
  : undefined;

export default async function ConnectorRoute({
  params,
}: {
  params: Promise<{ target: string }>;
}) {
  const { target } = await params;
  return <ConnectorClient target={target} />;
}
