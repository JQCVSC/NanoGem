const TOKEN_STORAGE_KEY = "nanogem_api_token";

type UnauthorizedListener = () => void;
const listeners = new Set<UnauthorizedListener>();

export function getStoredApiToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredApiToken(token: string): void {
  try {
    if (token.trim()) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getStoredApiToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    listeners.forEach((cb) => cb());
  }
  return res;
}
