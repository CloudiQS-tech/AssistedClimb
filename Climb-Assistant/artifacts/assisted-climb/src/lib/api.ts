import { setPreviewSessionTokenGetter } from "@workspace/api-client-react";

let previewSessionToken: string | null = null;
setPreviewSessionTokenGetter(() => previewSessionToken);

export const STUDENT_RECOVERY_ERROR_CODE = "STUDENT_RECOVERY_PERIOD";
const STUDENT_RECOVERY_NOTICE_KEY = "studentRecoveryNotice";

type ApiError = Error & {
  status: number;
  code?: string;
  warning?: string;
};

function publicApiErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return publicApiErrorMessage(JSON.parse(trimmed));
      } catch {
        // Keep the original string when it is not a JSON envelope.
      }
    }
    if (/high demand|temporarily|overload|rate limit|too many requests|timed out|timeout|unavailable/i.test(trimmed)) {
      return "The AI service is temporarily busy. Please wait a moment and try again.";
    }
    return trimmed;
  }
  if (value && typeof value === "object") {
    const record = value as { error?: unknown; message?: unknown };
    if (record.error !== undefined) return publicApiErrorMessage(record.error);
    if (record.message !== undefined) return publicApiErrorMessage(record.message);
  }
  return "An error occurred";
}

function redirectsAuthenticatedStudentRecovery(path: string): boolean {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedPath.startsWith("/student/")
    && normalizedPath !== "/student/check-join"
    && normalizedPath !== "/student/join";
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (previewSessionToken && !headers.has("X-Assisted-Climb-Preview-Session")) {
    headers.set("X-Assisted-Climb-Preview-Session", previewSessionToken);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type");
  const isJson = contentType && contentType.includes("application/json");
  
  let data;
  if (isJson) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorMsg = isJson && data.error
      ? publicApiErrorMessage(data.error)
      : (typeof data === "string" ? publicApiErrorMessage(data) : response.statusText);
    const error = new Error(errorMsg || "An error occurred") as ApiError;
    error.status = response.status;
    if (isJson && data && typeof data === "object") {
      error.code = data.code;
      error.warning = data.warning;
    }
    if (
      error.code === STUDENT_RECOVERY_ERROR_CODE
      && redirectsAuthenticatedStudentRecovery(path)
    ) {
      rememberStudentRecoveryNotice();
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
      window.location.assign(`${basePath}/join`);
    }
    throw error;
  }

  return data;
}

export async function apiFetchBlob(path: string, options: RequestInit = {}) {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/pdf, application/json");
  }
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (previewSessionToken && !headers.has("X-Assisted-Climb-Preview-Session")) {
    headers.set("X-Assisted-Climb-Preview-Session", previewSessionToken);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    const error = new Error(
      typeof data === "object" && data && "error" in data
        ? publicApiErrorMessage(data.error)
        : publicApiErrorMessage(data),
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function isStudentRecoveryError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === STUDENT_RECOVERY_ERROR_CODE,
  );
}

export function rememberStudentRecoveryNotice(): void {
  sessionStorage.setItem(STUDENT_RECOVERY_NOTICE_KEY, "1");
}

export function consumeStudentRecoveryNotice(): boolean {
  const hasNotice = sessionStorage.getItem(STUDENT_RECOVERY_NOTICE_KEY) === "1";
  sessionStorage.removeItem(STUDENT_RECOVERY_NOTICE_KEY);
  return hasNotice;
}

export function setStudentSession(id: number, nonce?: string, previewToken?: string) {
  // Session identity lives in the server-side Express session. Clear legacy
  // browser-stored fallback credentials rather than retaining a timeout bypass.
  void id;
  void nonce;
  clearStudentSession();
  setPreviewSessionToken(previewToken);
}

export function clearStudentSession() {
  previewSessionToken = null;
  sessionStorage.removeItem("studentSessionId");
  sessionStorage.removeItem("studentNonce");
  localStorage.removeItem("studentSessionId");
  localStorage.removeItem("studentNonce");
}

export function setTeacherToken(token: string) {
  // Retained for API compatibility with older login responses; login authority
  // is the short-lived server session, never a browser-stored bearer token.
  void token;
  clearTeacherToken();
}

export function setPreviewSessionToken(token: string | undefined) {
  // This bridge is used only by the Replit development webview. It stays in
  // JavaScript memory (not sessionStorage/localStorage) and is absent in
  // production responses.
  previewSessionToken = typeof token === "string" && token.length >= 40 ? token : null;
}

export function clearTeacherToken() {
  previewSessionToken = null;
  sessionStorage.removeItem("teacherToken");
  localStorage.removeItem("teacherToken");
}
