// JSON-RPC client that backs off on HTTP 429. Public devnet endpoints
// rate-limit bursts (dashboard polling + the dev oracle's pushes), and a
// thrown 429 mid-flow would otherwise surface as a failed action.
import {
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
} from '@solana/kit';

const RETRIES = 6;

export function createRpc(url: string): Rpc<SolanaRpcApi> {
  const inner = createDefaultRpcTransport({ url });
  const transport = (async (req) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(req);
      } catch (e) {
        const limited = isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
        if (!limited || attempt >= RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      }
    }
  }) as RpcTransport;
  return createSolanaRpcFromTransport(transport);
}
