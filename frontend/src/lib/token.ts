// In-memory access-token store. The access token is intentionally NOT persisted
// (XSS-safety); it is restored on reload via the httpOnly refresh cookie.
let accessToken: string | null = null;

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => {
    accessToken = t;
  },
  clear: () => {
    accessToken = null;
  },
};
