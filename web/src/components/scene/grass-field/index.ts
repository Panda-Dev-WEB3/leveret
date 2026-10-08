// 📖 Docs: obsidian/frontend/components/scene.md

// Only the lazy wrapper and types leave this folder. Re-exporting `GrassField`
// (or anything that imports `three`) from here pulled the whole three.js chunk
// into the page's first-load JS — every visitor, bots included, downloaded and
// evaluated ~630 KB before hydration.
export { LazyGrassField } from "./lazy-grass-field";
export type { GrassFieldProps } from "./grass-field";
