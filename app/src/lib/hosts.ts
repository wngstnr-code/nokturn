export const SITE_HOST = "nokturn.xyz";
export const APP_HOST = "app.nokturn.xyz";

// Every route the app serves. The landing page sends these to APP_HOST.
export const APP_PATHS = ["/trade", "/batch", "/session", "/allowlist", "/netting", "/auction"];

// In development the app and the landing page share localhost, so links stay relative.
export const APP_ORIGIN = process.env.NODE_ENV === "production" ? `https://${APP_HOST}` : "";

export const appUrl = (path: string) => `${APP_ORIGIN}${path}`;
