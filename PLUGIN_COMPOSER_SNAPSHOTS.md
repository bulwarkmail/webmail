# Composer snapshots and conditional edits

These methods operate on a composer id handed to a plugin by a native composer action or slot. They do not discover other composers or grant permission to send a message.

| Method | Permission | Result |
| --- | --- | --- |
| `composer.getSnapshot(composerId)` | `compose:read` | Authored text, subject, To/Cc/Bcc, ready attachment metadata, pending state and an opaque revision. |
| `composer.readAttachment(composerId, attachmentId)` | `email:blob-read` | Bytes of an attachment in that composer's snapshot, at most 25 MiB. |
| `composer.replaceBody(composerId, content, { expectedRevision })` | `compose:write` | One native editor transaction, rejected with `composer_changed` when the revision differs. |

Snapshot text excludes the signature and quoted history. The opaque revision covers authored content, recipients, subject, attachment metadata, pending state, account and identity. Account and identity markers stay host-side. Snapshot arrays are copies.

Attachment ids are composer-local opaque handles, not server blob ids. Two logins with the same blob id do not collide. The native composer uses the attachment's owning client. Metadata and actual bytes are limited separately, and bytes are discarded if the composer closes or its revision changes during the read.

`expectedRevision` is optional, preserving existing unconditional edits. When supplied it is checked immediately before the synchronous editor transaction. Existing native Undo, signature, quote and inline-image behavior remains in use.

```js
const draft = await api.composer.getSnapshot(composerId);
const text = await prepareText(draft.text);
await api.composer.replaceBody(composerId, { text }, {
  expectedRevision: draft.revision,
});
```

This change is the composer SDK portion approved in [#1369](https://github.com/bulwarkmail/webmail/issues/1369#issuecomment-6506321971). Quick-reply registration and toolbar actions are a separate change. No product route, companion authentication, service configuration or dependency is introduced. Lite's existing plugin policy is unchanged.

작성창의 읽기 권한과 발송 권한을 분리하고, 처리 중 변경된 초안을 덮어쓰지 않도록 리비전을 검사합니다. 제품의 모델 호출·설정·인증은 플러그인이 소유합니다.
