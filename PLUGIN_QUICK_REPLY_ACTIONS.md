# Quick-reply composer actions

Quick reply offers the existing `composer-toolbar-actions` surface while the draft's action row is visible. Each message/account context gets its own composer id. Loading another message, hiding quick reply, clearing it or closing the viewer unregisters the old capability.

Actions receive the same `composerId` contract as the full composer. They can read authored text, selection and metadata, or edit through the browser's native textarea transaction. `replaceSelection(..., { below: true })` inserts after the selection without replacing it. Conditional body edits use the snapshot revision supplied by the composer SDK.

No attachment read or upload is added to the plain-text quick reply. Actions do not send mail; the existing Send button, organisation confirmations and draft flushing keep their native paths. Buttons remain visible in the wrapping toolbar at phone width and long labels truncate.

The child component owns registration and preallocates its capability id, avoiding an additional reader render. The existing render/request performance budgets are not changed.

This is the quick-reply portion of the [approved proposal #1369](https://github.com/bulwarkmail/webmail/issues/1369#issuecomment-6506321971), stacked on the separate composer SDK PR. Lite's existing plugin policy remains unchanged.

간단 답장은 기존 작성창 작업 표면을 재사용합니다. 메시지·계정별 핸들을 분리하고 화면이 사라지면 해제하며, 본문 편집은 네이티브 Undo 경로를 사용합니다.
