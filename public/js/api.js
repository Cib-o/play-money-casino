export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code; // doubles as an i18n key (err_*)
  }
}

/** JSON fetch wrapper. Throws ApiError with a translatable code. */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'err_network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'err_generic');
  return data;
}
