'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
// `injected` comes from wagmi's main entry rather than 'wagmi/connectors':
// that barrel also pulls in the third-party connectors, one of which imports a
// module that does not resolve and fails the build. We only want injected
// wallets anyway, and this avoids shipping the rest of them to the browser.
import { createConfig, injected, unstable_connector, WagmiProvider } from 'wagmi';
import { mainnet } from 'wagmi/chains';

/**
 * Injected wallets only, on purpose.
 *
 * WalletConnect would mean the page opening connections to a third-party relay,
 * which breaks `connect-src 'self'` and hands a visitor's presence to another
 * party. Injected wallets need neither.
 *
 * Reads go through the **connected wallet's own RPC**, not through this server.
 *
 * A server-side RPC proxy would share one upstream node with the server-rendered
 * page. Connected wallets poll on a 12s interval, so a few hundred visitors is a
 * few hundred requests/sec from a single origin IP; being throttled there would
 * break `getProtocolState()` and take the front page down for everyone,
 * including visitors who never connected a wallet.
 *
 * Routing reads through the wallet avoids that coupling: load lands on whatever
 * node the user already trusts and scales with users. Everything indexable comes
 * from Ponder instead, so the page makes no outbound chain request of its own,
 * which is also why `connect-src 'self'` holds — the wallet is reached through
 * the injected provider, not the network.
 *
 * Consequence to respect: with no HTTP transport, a read attempted while
 * disconnected has nowhere to go. Every client-side read must therefore stay
 * gated on `isConnected`, and anything a disconnected visitor needs to see has
 * to come from the server render.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: { [mainnet.id]: unstable_connector(injected) },
  ssr: true,
});

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
