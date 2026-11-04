# Host APIs for the AI assistant (2.2)

Host calls the assistant plugin needs, one set of files per area, so the
areas can be built side by side without editing the same lines:

| Area | What | Files |
| --- | --- | --- |
| b | More context: attachment text and images, threads, the list selection | `b.types.ts`, `b.ts`, `b.runtime.ts` |
| c | More actions: invitations, filters, batches, out-of-office, settings | `c.types.ts`, `c.ts`, `c.runtime.ts` |
| d | Files: find, read, attach, save, create | `d.types.ts`, `d.ts`, `d.runtime.ts` |
| f | The panel in every view | `f.types.ts`, `f.ts`, `f.runtime.ts` |

Each area fills its own three files:

- `<area>.types.ts` (pure, no imports from the app): `PERMISSIONS`, the
  permissions the area adds (they join `ALL_PERMISSIONS`), and
  `<Area>HostFeatures`, the flags it adds to `api.host.features`.
- `<area>.ts` (host side): `PERMS` (method → permission, joins
  `PERM_PER_METHOD`), `dispatch(plugin, method, args)` (returns `NOT_MINE`
  for methods it doesn't own) and `features()` (its flags right now).
- `<area>.runtime.ts` (inside the sandbox): `runtime(callApi)`, the methods
  it adds to the plugin's `api`, by namespace (`{ email: { getThread } }`).

`index.ts`, `runtime.ts` and `types.ts` merge the areas; host-api.ts,
host-features.ts, runtime.tsx and plugin-types.ts read only those. A new
permission needs a check (a method in `PERMS`, a slot or a hook), its texts
in every locale under `plugins.permissions.<key>`, and docs.
