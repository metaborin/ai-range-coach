// Vite supplies the same project path to assets, the manifest, and this helper.
export const APP_BASE_PATH = import.meta.env.BASE_URL
export const appPath = (path: string) => `${APP_BASE_PATH}${path}`
