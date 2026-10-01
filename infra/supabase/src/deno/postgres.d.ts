// The part of postgres.js (npm:postgres, Unlicense) the relay's Deno entry uses. The module is
// loaded by Deno at run time and never bundled (scripts/bundle-functions.mjs).
declare module 'npm:postgres@3.4.7' {
  interface TransactionSql {
    unsafe(query: string, parameters?: unknown[]): Promise<object[]>;
  }
  interface Sql {
    begin<T>(work: (tx: TransactionSql) => Promise<T>): Promise<T>;
  }
  interface Options {
    prepare?: boolean;
    max?: number;
    idle_timeout?: number;
    connect_timeout?: number;
  }
  export default function postgres(url: string, options?: Options): Sql;
}
