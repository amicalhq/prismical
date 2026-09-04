// Vite `?raw` imports of drizzle-generated migration SQL (operational-db, product-db).
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
