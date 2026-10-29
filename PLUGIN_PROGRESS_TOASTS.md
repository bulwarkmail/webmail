# Plugin progress toasts

`api.toast.progress(message): Promise<string>` displays an indeterminate progress toast until it is dismissed or its sandbox frame is destroyed. It stays beyond the ordinary five-second timeout. No additional manifest permission is required; Lite's existing plugin policy remains unchanged.

`api.toast.dismiss(id): Promise<void>` removes only a progress handle created by the same plugin **and frame**. Repeated dismissal, unknown handles and handles from another frame are no-ops. Native application notices are not dismissible through this API. Closing a notice does not cancel the underlying task or recreate the notice.

```js
const id = await api.toast.progress('Preparing the document…');
try {
  await prepareDocument();
} finally {
  await api.toast.dismiss(id);
}
```

Progress starts share the ordinary **five starts per ten seconds per plugin** budget. At most **five progress notices per plugin** may remain outstanding across frames. A refused start rejects its promise. Messages are capped at **300 characters**. Dismissal and frame-destruction cleanup are never rate-limited.

The plugin owns task completion, failure, cancellation and terminal messages. The host owns display, frame-scoped handles and cleanup. Every `SandboxInstance` owns a dedicated `toastLifetime` AbortController, passed to dispatch and aborted by `destroy()`. Slot closure, navigation away, failed activation and plugin deactivation use that existing destruction path. The API adds no backend, credentials or product processing.

진행 알림은 명시적 종료 또는 프레임 종료까지 유지됩니다. 플러그인은 작업의 성공·실패·취소를, 호스트는 프레임별 표시·소유권·정리를 담당합니다.
