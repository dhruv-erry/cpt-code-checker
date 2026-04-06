import snowflake from "snowflake-sdk";
import { createPool, Pool } from "generic-pool";

let _pool: Pool<snowflake.Connection> | null = null;

export async function createSnowflakePool() {
  const pool = createPool(
    {
      create: () =>
        new Promise<snowflake.Connection>((resolve, reject) => {
          const connection = snowflake.createConnection({
            account: process.env.SNOWFLAKE_ACCOUNT ?? "",
            application: "config-manager",
            authenticator: "SNOWFLAKE_JWT",
            username: process.env.SNOWFLAKE_USERNAME ?? "",
            role: process.env.SNOWFLAKE_ROLE ?? "",
            privateKey: process.env.SNOWFLAKE_PRIVATE_KEY ?? "",
            warehouse: process.env.SNOWFLAKE_WAREHOUSE ?? "",
            database: process.env.SNOWFLAKE_DATABASE ?? "",
          });

          connection.connect((err, conn) => {
            if (err) {
              reject(err);
            } else {
              resolve(conn);
            }
          });
        }),
      destroy: (connection) =>
        new Promise<void>((resolve, reject) => {
          connection.destroy((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }),
    },
    {
      max: 10,
      min: 0,
    }
  );
  return pool;
}

export async function getSnowflakePool() {
  if (!_pool) {
    _pool = await createSnowflakePool();
  }
  return _pool;
}

/**
 * Runs a snowflake query using the snowflake pool(JWT authentication).
 * @param query - The query to run
 * @param args - The arguments to bind to the query
 * @returns The result of the query
 */
export async function runSnowflakeQuery(
  query: string,
  args?: unknown[],
): Promise<unknown[]> {
  const snowflakePool = await getSnowflakePool();
  const baseConnection = await snowflakePool.acquire();
  
  try {
    if (!baseConnection.isUp()) {
      throw new Error("Snowflake connection is invalid");
    }
    
    const result = await new Promise<unknown[]>((resolve, reject) => {
      baseConnection.execute({
        sqlText: query,
        binds: args as snowflake.Binds,
        complete: function (err, stmt, rows) {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        },
      });
    });
    return result;
  } finally {
    await snowflakePool.release(baseConnection);
  }
}
