type BeforeLogoutHandler = () => void | Promise<void>;

const handlers = new Set<BeforeLogoutHandler>();

export function registerBeforeLogout(handler: BeforeLogoutHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export async function flushBeforeLogout(timeoutMs = 3000): Promise<void> {
  const pending = [...handlers].map((handler) => Promise.resolve().then(handler));
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
  ]);
}