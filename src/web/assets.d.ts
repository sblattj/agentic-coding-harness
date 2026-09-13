// Ambient module declarations for static assets imported as text
// (`await import("./x.html", { with: { type: "text" } })`, embedded by
// `bun build` so the single-file bundle can serve them without sibling
// files on disk). The disk copy wins at runtime when present; these
// loaders are the bundle-only fallback. No real .js module in src/ is
// ever imported this way, so the wildcard cannot shadow a typed import.
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
declare module "*LICENSE" {
  const content: string;
  export default content;
}
