export async function apiFetch(path: string, options: RequestInit = {}) {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  // Student session fallback: when cookies are blocked in the Replit preview iframe,
  // send the student session ID and nonce as headers instead.
  const storedStudentSessionId = localStorage.getItem("studentSessionId");
  if (storedStudentSessionId) {
    headers.set("X-Student-Session-Id", storedStudentSessionId);
  }
  const storedStudentNonce = localStorage.getItem("studentNonce");
  if (storedStudentNonce) {
    headers.set("X-Student-Nonce", storedStudentNonce);
  }

  // Teacher auth fallback: same approach — send the login token as a header.
  const teacherToken = localStorage.getItem("teacherToken");
  if (teacherToken) {
    headers.set("X-Teacher-Token", teacherToken);
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
    const errorMsg = isJson && data.error ? data.error : (typeof data === "string" ? data : response.statusText);
    throw new Error(errorMsg || "An error occurred");
  }

  return data;
}

export function setStudentSession(id: number, nonce?: string) {
  localStorage.setItem("studentSessionId", String(id));
  if (nonce) localStorage.setItem("studentNonce", nonce);
}

export function clearStudentSession() {
  localStorage.removeItem("studentSessionId");
  localStorage.removeItem("studentNonce");
}

export function setTeacherToken(token: string) {
  localStorage.setItem("teacherToken", token);
}

export function clearTeacherToken() {
  localStorage.removeItem("teacherToken");
}
